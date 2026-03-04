import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import { Product } from "../types";
import { fetchProducts, getBackendUrl } from "../api/client";
import { useAuth } from "./AuthContext";

interface ProductContextValue {
  products: Product[];
  setProducts: React.Dispatch<React.SetStateAction<Product[]>>;
  productsLoading: boolean;
  productsError: string | null;
  currentProduct: Product | null;
  setCurrentProduct: React.Dispatch<React.SetStateAction<Product | null>>;
  loadProducts: () => Promise<void>;
  updateProduct: (updated: Product) => void;
  findProduct: (id: string) => Product | undefined;
  /** SSE connection status: 'streaming' = live updates, 'polling' = fallback */
  streamStatus: "idle" | "connecting" | "streaming" | "polling" | "error";
}

const ProductContext = createContext<ProductContextValue | null>(null);

const POLL_INTERVAL_MS = 60000;
const SSE_RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 3;

export function ProductProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [currentProduct, setCurrentProduct] = useState<Product | null>(null);
  const [streamStatus, setStreamStatus] = useState<ProductContextValue["streamStatus"]>("idle");
  const productsRef = useRef<Product[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);

  useEffect(() => {
    productsRef.current = products;
  }, [products]);

  const loadProducts = useCallback(async () => {
    setProductsLoading(true);
    try {
      const list = await fetchProducts();
      setProducts(list);
      setProductsError(null);
    } catch (error: any) {
      console.error("Failed to load products:", error);
      setProductsError(error?.message || "Produkte konnten nicht geladen werden");
    } finally {
      setProductsLoading(false);
    }
  }, []);

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

  const startPolling = useCallback(() => {
    if (pollTimerRef.current) return;
    setStreamStatus("polling");
    pollTimerRef.current = setInterval(loadProducts, POLL_INTERVAL_MS);
  }, [loadProducts]);

  // SSE connection for real-time product updates
  useEffect(() => {
    if (!user) {
      cleanup();
      setStreamStatus("idle");
      return;
    }

    // Initial full load
    loadProducts();

    const connectSSE = async () => {
      try {
        const token = await user.getIdToken();
        if (!token) {
          startPolling();
          return;
        }

        cleanup();
        setStreamStatus("connecting");

        const url = `${getBackendUrl()}/api/products/stream?token=${encodeURIComponent(token)}`;
        const es = new EventSource(url);
        eventSourceRef.current = es;

        es.addEventListener("connected", () => {
          setStreamStatus("streaming");
          reconnectAttemptsRef.current = 0;
        });

        es.addEventListener("update", (event) => {
          try {
            const data = JSON.parse((event as MessageEvent).data);
            if (data?.changes?.length) {
              setProducts((prev) => {
                const map = new Map(prev.map((p) => [p.id, p]));
                for (const change of data.changes) {
                  if (change.type === "removed") {
                    map.delete(change.id);
                  } else if (change.data) {
                    map.set(change.id, { id: change.id, ...change.data } as Product);
                  }
                }
                return Array.from(map.values());
              });
            }
          } catch (err) {
            console.warn("[ProductContext] Failed to parse SSE update:", err);
          }
        });

        es.onerror = () => {
          es.close();
          eventSourceRef.current = null;
          reconnectAttemptsRef.current += 1;

          if (reconnectAttemptsRef.current <= MAX_RECONNECT_ATTEMPTS) {
            setStreamStatus("connecting");
            reconnectTimerRef.current = setTimeout(connectSSE, SSE_RECONNECT_DELAY_MS);
          } else {
            console.warn("[ProductContext] SSE failed, falling back to polling");
            startPolling();
          }
        };
      } catch (err) {
        console.warn("[ProductContext] SSE setup failed, using polling:", err);
        startPolling();
      }
    };

    connectSSE();

    return cleanup;
  }, [user, loadProducts, cleanup, startPolling]);

  const updateProduct = useCallback(
    (updated: Product) => {
      setProducts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      setCurrentProduct((prev) => (prev?.id === updated.id ? updated : prev));
    },
    []
  );

  const findProduct = useCallback(
    (id: string) => productsRef.current.find((p) => p.id === id),
    []
  );

  const value: ProductContextValue = {
    products,
    setProducts,
    productsLoading,
    productsError,
    currentProduct,
    setCurrentProduct,
    loadProducts,
    updateProduct,
    findProduct,
    streamStatus,
  };

  return (
    <ProductContext.Provider value={value}>
      {children}
    </ProductContext.Provider>
  );
}

export function useProducts(): ProductContextValue {
  const ctx = useContext(ProductContext);
  if (!ctx) {
    throw new Error("useProducts must be used within a ProductProvider");
  }
  return ctx;
}

export default ProductContext;
