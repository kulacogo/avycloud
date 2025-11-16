
import { useState, useCallback, useRef } from 'react';
import { ProductBundle } from '../types';
import { MAX_IDENTIFY_FILES, MAX_IDENTIFY_FILE_BYTES, MAX_IDENTIFY_TOTAL_BYTES } from '../constants';
import { identifyProductApi } from '../api/client';

export const useGemini = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const identifyProducts = useCallback(async (images: File[], barcodes: string, model?: string): Promise<ProductBundle | null> => {
    const totalBytes = images.reduce((acc, file) => acc + file.size, 0);
    if (images.length > MAX_IDENTIFY_FILES) {
      setError(`Maximal ${MAX_IDENTIFY_FILES} Bilder pro Anfrage erlaubt. Bitte reduziere deine Auswahl.`);
      return null;
    }
    if (totalBytes > MAX_IDENTIFY_TOTAL_BYTES) {
      setError(`Uploads sind auf ${(MAX_IDENTIFY_TOTAL_BYTES / (1024 * 1024)).toFixed(1)} MB Gesamtgröße begrenzt, da Cloud Run Anfragen über 32 MB laut https://cloud.google.com/run/quotas#request_size ablehnt.`);
      return null;
    }
    if (images.some((file) => file.size > MAX_IDENTIFY_FILE_BYTES)) {
      setError(`Einzelne Bilder dürfen höchstens ${(MAX_IDENTIFY_FILE_BYTES / (1024 * 1024)).toFixed(1)} MB groß sein.`);
      return null;
    }
    // Cancel any ongoing request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Create new AbortController for this request
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsLoading(true);
    setError(null);

    try {
      const result = await identifyProductApi(images, barcodes, {
        model,
        signal: controller.signal,
      });

      if (!result.ok || !result.data) {
        throw new Error(result.error?.message || 'Backend identification failed.');
      }

      const productBundle = result.data;

      if (!productBundle.products || productBundle.products.length === 0) {
        throw new Error('Backend did not identify any products. Please try with clearer images or valid barcodes.');
      }

      setIsLoading(false);
      abortControllerRef.current = null;
      return productBundle;

    } catch (e: any) {
      // Don't show error if request was cancelled
      if (e?.name !== 'AbortError' && e?.code !== 499) {
        console.error("API Error:", e);
        const errorMessage = e instanceof Error ? e.message : "An unknown error occurred during product identification.";
        setError(`Failed to process request: ${errorMessage}`);
      }
      
      setIsLoading(false);
      abortControllerRef.current = null;
      return null;
    }
  }, []);

  // Cleanup function to cancel request on unmount
  const cancelRequest = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsLoading(false);
    }
  }, []);

  return { identifyProducts, isLoading, error, cancelRequest };
};
