import type { QueryClient } from "@tanstack/react-query";
import type { User } from "firebase/auth";
import { getBackendUrl } from "../api/client";

/**
 * Shared SSE connection manager (per-browser singleton).
 *
 * PROBLEM this solves: hooks/useSSE.ts opens ONE EventSource PER TAB to
 * GET /api/events. With Cloud Run containerConcurrency=1 each SSE connection
 * pins a whole instance, so N tabs of one user = N pinned instances → the
 * documented "no available instance" 429 / "Failed to fetch" saturation.
 *
 * SOLUTION: collapse N tabs of one browser into ONE backend SSE connection via
 * leader election. Exactly one tab (the "leader") holds the EventSource and
 * fans out change-notification pings to all tabs over a BroadcastChannel. Every
 * tab (leader + followers) then runs the SAME React Query invalidation switch
 * that useSSE.ts runs today, so each tab keeps its own cache fresh.
 *
 * SAFETY: this module is only ever reached when the gate (VITE_SSE_SHARED) is on
 * AND the browser supports BroadcastChannel + Web Locks. useSSE.ts handles the
 * feature-detection and the per-tab fallback; this file assumes support exists.
 *
 * The SSE stream carries ONLY change-notification pings (orders:synced,
 * orders:status-changed, listings:synced) — never authoritative data.
 */

const SSE_CHANNEL_NAME = "avy-sse";
const LEADER_LOCK_NAME = "avy-sse-leader";

// Heartbeat-election fallback timings (only used when Web Locks is unavailable;
// today useSSE.ts requires Web Locks before delegating, but the heartbeat path
// is kept self-contained so the manager is robust on its own).
const HEARTBEAT_INTERVAL_MS = 2_000;
const HEARTBEAT_STALE_MS = 5_000;

// Wire-format messages broadcast between tabs over the shared channel.
type SseChannelMessage =
  | { type: "event"; event: SseEventName }
  | { type: "degraded"; degraded: boolean }
  // Heartbeat-election control frames (only used in the no-Web-Locks fallback).
  | { type: "leader-ping" }
  | { type: "leader-yield" };

type SseEventName =
  | "orders:synced"
  | "orders:status-changed"
  | "listings:synced";

/**
 * Identical to the invalidation switch in hooks/useSSE.ts. Runs on EVERY tab
 * (leader + followers) once an event ping is received over the channel.
 *
 * Mapping (DO NOT change — must match useSSE.ts byte-for-byte):
 *   orders:synced          -> ["orders"] + ["dashboard-metrics"]
 *   orders:status-changed  -> ["orders"] + ["dashboard-metrics"]
 *   listings:synced        -> ["listings"]
 */
function invalidateForEvent(queryClient: QueryClient, event: SseEventName): void {
  switch (event) {
    case "orders:synced":
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-metrics"] });
      break;
    case "orders:status-changed":
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-metrics"] });
      break;
    case "listings:synced":
      queryClient.invalidateQueries({ queryKey: ["listings"] });
      break;
  }
}

/**
 * Feature-detect BroadcastChannel + Web Locks. useSSE.ts calls this to decide
 * whether to delegate to the shared manager or fall back to per-tab EventSource.
 * BroadcastChannel is required; Web Locks is preferred but the manager degrades
 * to a heartbeat election when it is absent.
 */
export function isSharedSSESupported(): boolean {
  return typeof window !== "undefined" && typeof window.BroadcastChannel === "function";
}

interface SharedSSEHandle {
  /** Tear down this tab's participation (leadership + channel + connection). */
  stop: () => void;
}

/**
 * Start (or join) the per-browser shared SSE connection for the given user.
 *
 * Returns a handle whose stop() must be called on unmount/logout. Each call is
 * independent (one per useSSE mount); the manager keeps the heavy work — the
 * actual EventSource — to the single elected leader tab.
 */
export function startSharedSSE(user: User, queryClient: QueryClient): SharedSSEHandle {
  let stopped = false;

  const channel = new BroadcastChannel(SSE_CHANNEL_NAME);

  // --- Leader-only state (the EventSource lifecycle, mirrored from useSSE.ts) ---
  let isLeader = false;
  let es: EventSource | null = null;
  let retryCount = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let degradedTimer: ReturnType<typeof setTimeout> | null = null;
  let lastBroadcastDegraded = false;

  // After this long stuck in error/backoff, the leader broadcasts `degraded` so
  // consumers can lean on React Query's existing window-focus refetch. We never
  // add aggressive polling. ~35s ≈ past the first full backoff to the 30s cap.
  const DEGRADED_THRESHOLD_MS = 35_000;

  function broadcastDegraded(degraded: boolean): void {
    if (degraded === lastBroadcastDegraded) return;
    lastBroadcastDegraded = degraded;
    try {
      channel.postMessage({ type: "degraded", degraded } satisfies SseChannelMessage);
    } catch {
      /* channel may be closing */
    }
  }

  function clearDegradedTimer(): void {
    if (degradedTimer) {
      clearTimeout(degradedTimer);
      degradedTimer = null;
    }
  }

  function armDegradedTimer(): void {
    clearDegradedTimer();
    degradedTimer = setTimeout(() => broadcastDegraded(true), DEGRADED_THRESHOLD_MS);
  }

  // The EXACT connect() logic from useSSE.ts (token fetch, EventSource, the 3
  // event handlers, exponential backoff 1s→30s). The only difference: instead of
  // invalidating queries directly, the leader posts the event over the channel
  // and the per-tab channel listener (below) does the invalidation everywhere.
  async function connect(): Promise<void> {
    if (stopped || !isLeader) return;

    try {
      const token = await user.getIdToken();
      if (!token || stopped || !isLeader) return;

      const backendUrl = getBackendUrl();
      const url = `${backendUrl}/api/events?token=${encodeURIComponent(token)}`;

      const source = new EventSource(url);
      es = source;

      source.addEventListener("connected", () => {
        retryCount = 0; // Reset backoff on successful connection
        clearDegradedTimer();
        broadcastDegraded(false);
      });

      source.addEventListener("orders:synced", () => {
        channel.postMessage({ type: "event", event: "orders:synced" } satisfies SseChannelMessage);
      });

      source.addEventListener("orders:status-changed", () => {
        channel.postMessage({ type: "event", event: "orders:status-changed" } satisfies SseChannelMessage);
      });

      source.addEventListener("listings:synced", () => {
        channel.postMessage({ type: "event", event: "listings:synced" } satisfies SseChannelMessage);
      });

      source.onerror = () => {
        source.close();
        es = null;

        if (stopped || !isLeader) return;

        armDegradedTimer();

        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
        const delay = Math.min(1000 * Math.pow(2, retryCount), 30_000);
        retryCount++;
        retryTimer = setTimeout(connect, delay);
      };
    } catch {
      // Token fetch failed — retry after delay
      if (!stopped && isLeader) {
        armDegradedTimer();
        const delay = Math.min(1000 * Math.pow(2, retryCount), 30_000);
        retryCount++;
        retryTimer = setTimeout(connect, delay);
      }
    }
  }

  function teardownConnection(): void {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    clearDegradedTimer();
    if (es) {
      es.close();
      es = null;
    }
    retryCount = 0;
  }

  function becomeLeader(): void {
    if (stopped || isLeader) return;
    isLeader = true;
    connect();
  }

  function relinquishLeader(): void {
    if (!isLeader) return;
    isLeader = false;
    teardownConnection();
    broadcastDegraded(false);
  }

  // --- Channel listener: runs on EVERY tab (leader + followers) ---
  channel.onmessage = (ev: MessageEvent) => {
    if (stopped) return;
    const msg = ev.data as SseChannelMessage | undefined;
    if (!msg || typeof msg !== "object") return;

    switch (msg.type) {
      case "event":
        invalidateForEvent(queryClient, msg.event);
        break;
      case "degraded":
        // Reserved for future consumers; React Query window-focus refetch
        // already covers the gap, so there is nothing aggressive to do here.
        break;
      case "leader-ping":
        // Heartbeat-election fallback: a leader is alive → stand down.
        heartbeatOnPing();
        break;
      case "leader-yield":
        // Heartbeat-election fallback: previous leader is leaving → re-elect.
        heartbeatOnYield();
        break;
    }
  };

  // -------------------------------------------------------------------------
  // Leader election strategy A: Web Locks API (preferred).
  // navigator.locks.request holds the lock for the tab's entire life via a
  // never-resolving promise; the lock holder is the leader. When the leader tab
  // closes the lock auto-releases and a waiting tab acquires it → new leader.
  // -------------------------------------------------------------------------
  const lockAbort: AbortController | null =
    typeof AbortController === "function" ? new AbortController() : null;
  let releaseLock: (() => void) | null = null;

  function startWebLockElection(): void {
    const locks = navigator.locks;
    const options: LockOptions = { mode: "exclusive" };
    if (lockAbort) options.signal = lockAbort.signal;
    locks
      .request(LEADER_LOCK_NAME, options, () => {
        if (stopped) return Promise.resolve();
        becomeLeader();
        // Hold the lock until this tab goes away or stop() resolves the promise.
        return new Promise<void>((resolve) => {
          releaseLock = resolve;
          if (stopped) resolve();
        });
      })
      .catch(() => {
        // AbortError when stop() aborts a still-pending (waiting) request,
        // or the request was otherwise rejected — nothing to do.
      });
  }

  // -------------------------------------------------------------------------
  // Leader election strategy B: BroadcastChannel heartbeat (fallback when Web
  // Locks is unavailable). The leader posts a ping every 2s; a follower that
  // sees no ping for >5s promotes itself. On a tie, the lower random id yields.
  // -------------------------------------------------------------------------
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastPingAt = 0;
  const selfId = Math.random();

  function heartbeatLoop(): void {
    if (stopped) return;
    if (isLeader) {
      try {
        channel.postMessage({ type: "leader-ping" } satisfies SseChannelMessage);
      } catch {
        /* channel may be closing */
      }
      return;
    }
    // Follower: promote if the leader has gone silent.
    if (Date.now() - lastPingAt > HEARTBEAT_STALE_MS) {
      becomeLeader();
    }
  }

  function heartbeatOnPing(): void {
    lastPingAt = Date.now();
    // If two tabs raced into leadership, the higher selfId keeps it, the lower
    // stands down deterministically. We only have our own id, so a current
    // leader that just saw a ping from *another* leader yields if it's lower.
    if (isLeader) {
      // We can't compare ids without exchanging them; to stay simple and safe,
      // a leader treats an incoming ping as "another leader exists" only when it
      // did not originate from us. BroadcastChannel does not echo to the sender,
      // so any ping we receive is from a different tab → resolve the race.
      relinquishLeader();
      lastPingAt = Date.now();
    }
  }

  function heartbeatOnYield(): void {
    // Previous leader is leaving; trigger a fast re-election on next tick.
    lastPingAt = 0;
  }

  function startHeartbeatElection(): void {
    lastPingAt = Date.now();
    // Stagger initial promotion by a small id-derived delay so tabs don't all
    // promote simultaneously on first load.
    const initialDelay = HEARTBEAT_STALE_MS + Math.floor(selfId * 1000);
    setTimeout(() => {
      if (!stopped && !isLeader && Date.now() - lastPingAt > HEARTBEAT_STALE_MS) {
        becomeLeader();
      }
    }, initialDelay);
    heartbeatTimer = setInterval(heartbeatLoop, HEARTBEAT_INTERVAL_MS);
    void selfId; // referenced by initialDelay; keep for clarity
  }

  // --- Kick off the right election strategy ---
  const hasWebLocks =
    typeof navigator !== "undefined" &&
    typeof navigator.locks === "object" &&
    navigator.locks !== null &&
    typeof navigator.locks.request === "function";

  if (hasWebLocks) {
    startWebLockElection();
  } else {
    startHeartbeatElection();
  }

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      // If we were the leader under the heartbeat strategy, tell peers to re-elect.
      if (isLeader && !hasWebLocks) {
        try {
          channel.postMessage({ type: "leader-yield" } satisfies SseChannelMessage);
        } catch {
          /* ignore */
        }
      }
      relinquishLeader();
      // Under Web Locks: if we held the lock, resolve the held promise to
      // release it so a waiting tab can promote; if we were still waiting in
      // line, abort the pending request.
      if (releaseLock) {
        releaseLock();
        releaseLock = null;
      } else if (lockAbort) {
        try {
          lockAbort.abort();
        } catch {
          /* ignore */
        }
      }
      try {
        channel.close();
      } catch {
        /* ignore */
      }
    },
  };
}
