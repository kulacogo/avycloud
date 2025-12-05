import { useState, useCallback } from 'react';
import { ProductEnrichmentRecord } from '../types';
import { runSerpapiFreeEnrichment } from '../api/client';

export const useSerpapiFreePipeline = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [record, setRecord] = useState<ProductEnrichmentRecord | null>(null);

  const execute = useCallback(
    async (files: File[], barcodes: string, locale: string) => {
      setIsLoading(true);
      setError(null);
      setRecord(null);
      const response = await runSerpapiFreeEnrichment(files, barcodes, locale);
      setIsLoading(false);
      if (!response.ok) {
        setError(response.error?.message || 'Enrichment fehlgeschlagen');
        return null;
      }
      setRecord(response.data || null);
      return response.data || null;
    },
    []
  );

  const reset = useCallback(() => {
    setError(null);
    setRecord(null);
  }, []);

  return {
    isLoading,
    error,
    record,
    run: execute,
    reset,
  };
};

