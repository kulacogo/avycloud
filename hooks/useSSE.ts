import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getBackendUrl } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { isSharedSSESupported, startSharedSSE } from "../utils/sseSharedConnection";

/**
 * KILL SWITCH / gate for the per-browser shared SSE connection.
 *
 * Defaults OFF: unless VITE_SSE_SHARED is exactly the string "true", this hook
 * behaves EXACTLY as it always has (one per-tab EventSource). Shipping this is
 * therefore INERT — the shared-connection path is dead code until the env var is
 * flipped. When ON, we additionally require BroadcastChannel + Web Locks support
 * (isSharedSSESupported); if the browser lacks them we transparently fall back
 * to the unchanged per-tab path below.
 *
 * `import.meta.env` has no index signature in vite-env.d.ts, so we read it via a
 * cast (same pattern as utils/firebase.ts) to avoid a TS "property does not
 * exist" error without editing the env typings.
 */
const SSE_SHARED_ENABLED =
  (import.meta.env as Record<string, string | undefined>).VITE_SSE_SHARED === "true";

/**
 * Connects to the backend SSE endpoint (/api/events) and invalidates
 * React Query caches when sync events arrive.
 *
 * Uses the existing ?token=<jwt> query param pattern (index.js middleware
 * copies it into Authorization header for EventSource compatibility).
 *
 * Auto-reconnects with exponential backoff on disconnect.
 *
 * When SSE_SHARED_ENABLED is on AND the browser supports the required APIs, the
 * EventSource lifecycle is delegated to a per-browser shared-connection manager
 * (one backend SSE connection for the whole browser, regardless of tab count).
 * Otherwise the original per-tab EventSource code path runs unchanged.
 */
export function useSSE() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const retryCountRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Shared-connection path (gated, default OFF; requires API support) ---
  const useShared = SSE_SHARED_ENABLED && isSharedSSESupported();

  useEffect(() => {
    if (!useShared) return;
    if (!user) return;

    const handle = startSharedSSE(user, queryClient);
    return () => {
      handle.stop();
    };
  }, [useShared, user, queryClient]);

  // --- Per-tab path (today's behavior verbatim; the only fallback when the ---
  // --- gate is OFF or the shared APIs are unsupported). -----------------------
  useEffect(() => {
    if (useShared) return;
    if (!user) return;

    let cancelled = false;

    async function connect() {
      if (cancelled) return;

      try {
        // Get fresh token
        const token = await user!.getIdToken();
        if (!token || cancelled) return;

        const backendUrl = getBackendUrl();
        const url = `${backendUrl}/api/events?token=${encodeURIComponent(token)}`;

        const es = new EventSource(url);
        esRef.current = es;

        es.addEventListener("connected", () => {
          retryCountRef.current = 0; // Reset backoff on successful connection
        });

        es.addEventListener("orders:synced", () => {
          queryClient.invalidateQueries({ queryKey: ["orders"] });
          queryClient.invalidateQueries({ queryKey: ["dashboard-metrics"] });
        });

        es.addEventListener("orders:status-changed", () => {
          queryClient.invalidateQueries({ queryKey: ["orders"] });
          queryClient.invalidateQueries({ queryKey: ["dashboard-metrics"] });
        });

        es.addEventListener("listings:synced", () => {
          queryClient.invalidateQueries({ queryKey: ["listings"] });
        });

        es.onerror = () => {
          es.close();
          esRef.current = null;

          if (cancelled) return;

          // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
          const delay = Math.min(1000 * Math.pow(2, retryCountRef.current), 30_000);
          retryCountRef.current++;
          retryTimerRef.current = setTimeout(connect, delay);
        };
      } catch {
        // Token fetch failed — retry after delay
        if (!cancelled) {
          const delay = Math.min(1000 * Math.pow(2, retryCountRef.current), 30_000);
          retryCountRef.current++;
          retryTimerRef.current = setTimeout(connect, delay);
        }
      }
    }

    connect();

    return () => {
      cancelled = true;
      esRef.current?.close();
      esRef.current = null;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [useShared, user, queryClient]);
}
