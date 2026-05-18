import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { fetchEbayLiveListings, fetchKauflandListings } from "../api/client";
import { getFirestoreDb } from "../utils/firebase";
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
 *
 * Realtime-aware: subscribes to `system/kaufland-sync-state` in Firestore so any
 * publish/sync that bumps the marker doc (see backend optimistic-upsert path +
 * syncKauflandListingsCache marker write) invalidates this query within <1s.
 * Refetches on window focus to catch UI returning from a tab switch, with a
 * short staleTime so background tab returns still get fresh data.
 */
export function useKauflandListings(storefront = "de") {
  const queryClient = useQueryClient();
  const initialEventRef = useRef(true);

  useEffect(() => {
    // Reset the "skip-first-snapshot" flag whenever storefront changes — the
    // listener re-attaches and Firestore will fire the current state as the
    // first event, which we don't want to count as a change.
    initialEventRef.current = true;
    let unsubscribe: (() => void) | null = null;
    try {
      const db = getFirestoreDb();
      const ref = doc(db, "system", "kaufland-sync-state");
      unsubscribe = onSnapshot(
        ref,
        (snap) => {
          if (initialEventRef.current) {
            initialEventRef.current = false;
            return;
          }
          // Skip echo of local writes (frontend never writes, but safe-guard).
          if (snap.metadata.hasPendingWrites) return;
          queryClient.invalidateQueries({
            queryKey: ["listings", "kaufland", storefront],
          });
        },
        (err) => {
          // Listener errors (permission, network) are non-fatal — manual sync
          // still works. Log once for diagnostics; UI continues to function.
          // eslint-disable-next-line no-console
          console.warn(
            "[useKauflandListings] snapshot listener error:",
            err?.message || err,
          );
        },
      );
    } catch (err) {
      // Firebase not configured / initialization error → realtime is best-effort.
      // eslint-disable-next-line no-console
      console.warn(
        "[useKauflandListings] failed to attach snapshot listener:",
        (err as Error)?.message || err,
      );
    }
    return () => {
      try { unsubscribe?.(); } catch (_e) { /* noop */ }
    };
  }, [storefront, queryClient]);

  return useQuery({
    queryKey: ["listings", "kaufland", storefront],
    queryFn: () => fetchKauflandListings(storefront),
    staleTime: 30_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: true,
  });
}
