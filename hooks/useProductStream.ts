import { useEffect, useRef, useState, useCallback } from "react";
import { Product } from "../types";
import { getBackendUrl, fetchProducts } from "../api/client";

/** How often to poll as a fallback when SSE is unavailable (ms). */
const POLL_INTERVAL_MS = 60000;
/** How long to wait before reconnecting SSE after a disconnect (ms). */
const SSE_RECONNECT_DELAY_MS = 5000;
/** Max reconnect attempts before falling back to polling permanently. */
const MAX_RECONNECT_ATTEMPTS = 3;

type StreamStatus = "idle" | "connecting" | "streaming" | "polling" | "error";

interface UseProductStreamOptions {
  /** Firebase ID token for SSE auth. */
  token: string | null;
  /** Whether the stream is enabled (default: true). */
  enabled?: boolean;
  /** Override default poll interval (ms). */
  pollIntervalMs?: number;
}

interface ProductStreamChange {
  type: "added" | "modified" | "removed";
  id: string;
  data?: Record<string, unknown>;
}

/**
 * Streams real-time product updates via SSE, with polling fallback.
 *
 * On mount, loads products via REST. Then opens an SSE connection to
 * /api/products/stream for incremental updates. If SSE fails, falls
 * back to periodic polling.
 *
 * Usage:
 * ```tsx
 * const { products, loading, error, status } = useProductStream({ token });
 * ```
 */
export function useProductStream(options: UseProductStreamOptions) {
  const { token, enabled = true, pollIntervalMs = POLL_INTERVAL_MS } = options;
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StreamStatus>("idle");

  const eventSourceRef = useRef<EventSource | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  // Apply incremental changes from SSE to the products state
  const applyChanges = useCallback((changes: ProductStreamChange[]) => {
    setProducts((prev) => {
      const map = new Map(prev.map((p) => [p.id, p]));
      for (const change of changes) {
        if (change.type === "removed") {
          map.delete(change.id);
        } else if (change.data) {
          map.set(change.id, { id: change.id, ...change.data } as Product);
        }
      }
      return Array.from(map.values());
    });
  }, []);

  // Full reload via REST
  const loadProducts = useCallback(async () => {
    setLoading(true);
    try {
      const list = await fetchProducts();
      setProducts(list);
      setError(null);
    } catch (err: any) {
      console.error("[useProductStream] Failed to load products:", err);
      setError(err?.message || "Produkte konnten nicht geladen werden");
    } finally {
      setLoading(false);
    }
  }, []);

  // Start polling fallback
  const startPolling = useCallback(() => {
    if (pollTimerRef.current) return;
    setStatus("polling");
    pollTimerRef.current = setInterval(loadProducts, pollIntervalMs);
  }, [loadProducts, pollIntervalMs]);

  // Connect SSE
  const connectSSE = useCallback(() => {
    if (!token) return;
    cleanup();
    setStatus("connecting");

    const url = `${getBackendUrl()}/api/products/stream?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.addEventListener("connected", () => {
      setStatus("streaming");
      reconnectAttemptsRef.current = 0;
    });

    es.addEventListener("update", (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data?.changes?.length) {
          applyChanges(data.changes);
        }
      } catch (err) {
        console.warn("[useProductStream] Failed to parse SSE update:", err);
      }
    });

    es.addEventListener("error", () => {
      console.warn("[useProductStream] SSE error, attempting reconnect...");
    });

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;

      reconnectAttemptsRef.current += 1;
      if (reconnectAttemptsRef.current <= MAX_RECONNECT_ATTEMPTS) {
        setStatus("connecting");
        reconnectTimerRef.current = setTimeout(connectSSE, SSE_RECONNECT_DELAY_MS);
      } else {
        console.warn("[useProductStream] Max reconnect attempts reached, falling back to polling");
        startPolling();
      }
    };
  }, [token, cleanup, applyChanges, startPolling]);

  // Main effect: initial load + connect SSE or poll
  useEffect(() => {
    if (!enabled) {
      cleanup();
      setStatus("idle");
      return;
    }

    // Initial full load
    loadProducts();

    if (token) {
      connectSSE();
    } else {
      // No token — poll only
      startPolling();
    }

    return cleanup;
  }, [enabled, token, connectSSE, loadProducts, startPolling, cleanup]);

  const updateProduct = useCallback((updated: Product) => {
    setProducts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }, []);

  const findProduct = useCallback(
    (id: string) => products.find((p) => p.id === id),
    [products]
  );

  return {
    products,
    setProducts,
    loading,
    error,
    status,
    loadProducts,
    updateProduct,
    findProduct,
  };
}
