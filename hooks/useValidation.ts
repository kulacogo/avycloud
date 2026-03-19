import { useState, useCallback } from "react";
import { validateProduct } from "../api/client";
import type { ValidationResults } from "../types";

interface UseValidationState {
  loading: boolean;
  results: ValidationResults | null;
  error: string | null;
}

export function useValidation() {
  const [state, setState] = useState<UseValidationState>({
    loading: false,
    results: null,
    error: null,
  });

  const runValidation = useCallback(
    async (product: any, marketplaces?: string[]) => {
      setState({ loading: true, results: null, error: null });
      try {
        const res = await validateProduct(product, marketplaces);
        if (res.ok && res.results) {
          setState({
            loading: false,
            results: res.results as ValidationResults,
            error: null,
          });
        } else {
          const msg =
            typeof res.error === "string"
              ? res.error
              : res.error?.message || "Validierung fehlgeschlagen";
          setState({ loading: false, results: null, error: msg });
        }
      } catch (err: any) {
        setState({
          loading: false,
          results: null,
          error: err?.message || "Netzwerkfehler",
        });
      }
    },
    []
  );

  const reset = useCallback(() => {
    setState({ loading: false, results: null, error: null });
  }, []);

  return {
    loading: state.loading,
    results: state.results,
    error: state.error,
    runValidation,
    reset,
  };
}
