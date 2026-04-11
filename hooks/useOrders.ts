import { useQuery } from "@tanstack/react-query";
import { fetchOrders as fetchOrdersApi } from "../api/client";
import type { Order } from "../types";

/**
 * React Query wrapper for orders.
 * - staleTime 60s: data considered fresh for 1 minute
 * - refetchOnWindowFocus: re-fetches when user tabs back
 * - SSE events invalidate this cache via useSSE hook
 */
export function useOrders(limit = 500) {
  return useQuery<Order[]>({
    queryKey: ["orders", limit],
    queryFn: () => fetchOrdersApi(limit),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
}
