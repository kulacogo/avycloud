import { useEffect, useRef, useCallback } from "react";
import type { User } from "firebase/auth";
import {
  createSessionApi,
  heartbeatSession,
  endSessionApi,
  type SessionClientInfo,
} from "../api/client";

const HEARTBEAT_ACTIVE_MS = 60_000; // 60s when tab is visible
const HEARTBEAT_HIDDEN_MS = 5 * 60_000; // 5 min when tab is hidden

/**
 * Collect all available client-side device/browser information.
 */
function collectClientInfo(): SessionClientInfo {
  const conn = (navigator as any).connection;
  return {
    screenResolution: `${screen.width}x${screen.height}`,
    viewportSize: `${window.innerWidth}x${window.innerHeight}`,
    devicePixelRatio: window.devicePixelRatio ?? 1,
    language: navigator.language || "",
    languages: Array.from(navigator.languages || []),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    referrer: document.referrer || "",
    connectionType: conn?.effectiveType || null,
    connectionDownlink: conn?.downlink ?? null,
    connectionRtt: conn?.rtt ?? null,
    saveData: Boolean(conn?.saveData),
    isPwa: window.matchMedia("(display-mode: standalone)").matches,
    touchPoints: navigator.maxTouchPoints ?? 0,
    cookieEnabled: navigator.cookieEnabled !== false,
    doNotTrack: navigator.doNotTrack || null,
    hardwareConcurrency: (navigator as any).hardwareConcurrency ?? null,
    deviceMemory: (navigator as any).deviceMemory ?? null,
    platform: (navigator as any).platform || "",
    colorScheme: window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    pdfViewerEnabled: (navigator as any).pdfViewerEnabled !== false,
  };
}

/**
 * Hook that tracks user sessions — creates a session on login,
 * sends periodic heartbeats, and ends the session on logout or tab close.
 *
 * Must be used inside AuthProvider (needs the current user).
 */
export function useSessionTracking(user: User | null) {
  const sessionIdRef = useRef<string | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevUserRef = useRef<string | null>(null);

  const clearHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }, []);

  const startHeartbeat = useCallback(
    (intervalMs: number) => {
      clearHeartbeat();
      heartbeatTimerRef.current = setInterval(() => {
        const sid = sessionIdRef.current;
        if (sid) {
          heartbeatSession(sid).catch(() => {
            // Heartbeat failures are non-critical
          });
        }
      }, intervalMs);
    },
    [clearHeartbeat]
  );

  // Handle visibility changes — slow heartbeat when hidden
  useEffect(() => {
    const handleVisibility = () => {
      if (!sessionIdRef.current) return;
      if (document.visibilityState === "hidden") {
        startHeartbeat(HEARTBEAT_HIDDEN_MS);
      } else {
        // Tab became visible again — send immediate heartbeat + resume fast interval
        const sid = sessionIdRef.current;
        if (sid) heartbeatSession(sid).catch(() => {});
        startHeartbeat(HEARTBEAT_ACTIVE_MS);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [startHeartbeat]);

  // Handle beforeunload — best-effort session end
  useEffect(() => {
    const handleUnload = () => {
      const sid = sessionIdRef.current;
      if (sid) {
        // sendBeacon cannot set auth headers, so we use it as best-effort.
        // The stale-session cleanup will handle sessions that don't get properly closed.
        try {
          navigator.sendBeacon(
            `/api/sessions/${encodeURIComponent(sid)}/end`,
            ""
          );
        } catch {
          // Ignore — stale cleanup will handle it
        }
      }
    };
    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, []);

  // Create session when user logs in, end when user changes/logs out
  useEffect(() => {
    const currentUid = user?.uid ?? null;
    const prevUid = prevUserRef.current;

    // User logged out or changed
    if (prevUid && prevUid !== currentUid) {
      const sid = sessionIdRef.current;
      if (sid) {
        endSessionApi(sid).catch(() => {});
        sessionIdRef.current = null;
      }
      clearHeartbeat();
    }

    // User logged in (new session)
    if (currentUid && currentUid !== prevUid) {
      const clientInfo = collectClientInfo();
      createSessionApi(clientInfo)
        .then((result) => {
          if (result.ok && result.sessionId) {
            sessionIdRef.current = result.sessionId;
            startHeartbeat(HEARTBEAT_ACTIVE_MS);
          }
        })
        .catch(() => {
          // Session creation failure is non-critical
        });
    }

    prevUserRef.current = currentUid;
  }, [user?.uid, clearHeartbeat, startHeartbeat]);

  /**
   * Call this before signing out to properly end the session.
   * Returns a promise that resolves when the session end request completes.
   */
  const endCurrentSession = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (sid) {
      clearHeartbeat();
      try {
        await endSessionApi(sid);
      } catch {
        // Non-critical
      }
      sessionIdRef.current = null;
    }
  }, [clearHeartbeat]);

  return { endCurrentSession };
}
