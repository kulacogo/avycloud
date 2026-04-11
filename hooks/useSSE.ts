import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getBackendUrl } from "../api/client";
import { useAuth } from "../context/AuthContext";

/**
 * Connects to the backend SSE endpoint (/api/events) and invalidates
 * React Query caches when sync events arrive.
 *
 * Uses the existing ?token=<jwt> query param pattern (index.js middleware
 * copies it into Authorization header for EventSource compatibility).
 *
 * Auto-reconnects with exponential backoff on disconnect.
 */
export function useSSE() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const retryCountRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
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
  }, [user, queryClient]);
}
