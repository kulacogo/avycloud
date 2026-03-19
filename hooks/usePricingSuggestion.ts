import { useState, useCallback } from "react";
import { fetchPricingSuggestion } from "../api/client";

export interface PricingSuggestion {
  productId: string;
  currentBuyPrice: number;
  currentSellPrice: number;
  competitorCount: number;
  competitorMin: number | null;
  competitorMax: number | null;
  competitorMedian: number | null;
  suggestedPrice: number | null;
  margin: number | null;
  strategy: string;
  pricingTier: number | null;
  confidence: number;
  matchBasis: string | null;
}

export function usePricingSuggestion() {
  const [suggestion, setSuggestion] = useState<PricingSuggestion | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSuggestion = useCallback(async (productId: string) => {
    setLoading(true);
    setError(null);
    setSuggestion(null);
    try {
      const data = await fetchPricingSuggestion(productId);
      setSuggestion(data as PricingSuggestion);
      return data as PricingSuggestion;
    } catch (err: any) {
      setError(err?.message || "Fehler beim Laden des Preisvorschlags");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const clear = useCallback(() => {
    setSuggestion(null);
    setError(null);
  }, []);

  return { suggestion, loading, error, fetchSuggestion, clear };
}
