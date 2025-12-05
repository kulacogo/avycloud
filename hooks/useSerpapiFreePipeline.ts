import { useState, useCallback } from 'react';
import { ProductEnrichmentRecord, SerpapiFreeMeta } from '../types';
import { runSerpapiFreeEnrichment } from '../api/client';

export const useSerpapiFreePipeline = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [record, setRecord] = useState<ProductEnrichmentRecord | null>(null);
  const [meta, setMeta] = useState<SerpapiFreeMeta | null>(null);

  const execute = useCallback(
    async (files: File[], barcodes: string, locale: string) => {
      setIsLoading(true);
      setError(null);
      setRecord(null);
      setMeta(null);
      const response = await runSerpapiFreeEnrichment(files, barcodes, locale);
      setIsLoading(false);
      if (!response.ok) {
        setError(response.error?.message || 'Enrichment fehlgeschlagen');
        return null;
      }
      setRecord(response.data || null);
      setMeta(response.meta || null);
      return response.data || null;
    },
    []
  );

  const reset = useCallback(() => {
    setError(null);
    setRecord(null);
    setMeta(null);
  }, []);

  return {
    isLoading,
    error,
    record,
    meta,
    run: execute,
    reset,
  };
};

