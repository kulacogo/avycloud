import { useQuery } from "@tanstack/react-query";
import { fetchEbayLiveListings, fetchKauflandListings } from "../api/client";
import type { EbayListingRow } from "../types";

/**
 * React Query wrapper for eBay listings.
 * - staleTime 5min: listings change infrequently
 * - refetchOnWindowFocus: false (no need to hammer for slow-changing data)
 * - SSE listing sync events invalidate this cache via useSSE hook
 */
export function useEbayListings() {
  return useQuery<EbayListingRow[]>({
    queryKey: ["listings", "ebay"],
    queryFn: () => fetchEbayLiveListings({ limit: 2000, includeInactive: true }),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/**
 * React Query wrapper for Kaufland listings.
 */
export function useKauflandListings(storefront = "de") {
  return useQuery({
    queryKey: ["listings", "kaufland", storefront],
    queryFn: () => fetchKauflandListings(storefront),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
}
