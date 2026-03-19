import { useState, useCallback } from "react";
import { runListingPipeline, ListingPipelineResult, ChannelListing } from "../api/client";

export interface UseListingPipelineState {
  loading: boolean;
  error: string | null;
  result: ListingPipelineResult | null;
}

export interface UseListingPipelineReturn extends UseListingPipelineState {
  generate: (productId: string, channels?: string[]) => Promise<ListingPipelineResult | null>;
  reset: () => void;
  updateListing: (channel: "ebay" | "kaufland", patch: Partial<ChannelListing>) => void;
}

export function useListingPipeline(): UseListingPipelineReturn {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ListingPipelineResult | null>(null);

  const generate = useCallback(async (productId: string, channels?: string[]) => {
    setLoading(true);
    setError(null);
    try {
      const data = await runListingPipeline(productId, channels);
      setResult(data);
      return data;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Listing-Pipeline fehlgeschlagen";
      setError(msg);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    setLoading(false);
    setError(null);
    setResult(null);
  }, []);

  const updateListing = useCallback(
    (channel: "ebay" | "kaufland", patch: Partial<ChannelListing>) => {
      setResult((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          listings: {
            ...prev.listings,
            [channel]: {
              ...prev.listings[channel],
              ...patch,
            } as ChannelListing,
          },
        };
      });
    },
    []
  );

  return { loading, error, result, generate, reset, updateListing };
}
