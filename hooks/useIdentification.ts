
import { useState, useCallback, useRef, useEffect } from 'react';
import { ProductBundle, IdentifyPhase, Product } from '../types';
import { MAX_IDENTIFY_FILES, MAX_IDENTIFY_FILE_BYTES, MAX_IDENTIFY_TOTAL_BYTES } from '../constants';
import {
  identifyProductV2,
  refreshPrice,
} from '../api/client';

export interface UploadGroupPayload {
  id: string;
  label: string;
  images: File[];
}

export interface IdentificationJobStatus {
  localId: string;
  jobId?: string;
  label: string;
  phase: IdentifyPhase | 'upload';
  message: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

interface UseIdentificationOptions {
  onJobCompleted?: (bundle: ProductBundle) => void;
}

const PHASE_MESSAGES: Record<string, string> = {
  upload: 'Upload läuft …',
  queued: 'Job wurde eingereiht …',
  processing: 'AI identifiziert das Produkt …',
  enriching: 'Produktdaten werden angereichert …',
  complete: 'Fertig – Produktdaten gespeichert.',
  cancelled: 'Upload wurde abgebrochen.',
};

const isPlaceholderIdentifiedName = (value?: string | null) => {
  const v = String(value || '').trim();
  if (!v) return true;
  // Bare generic placeholders
  if (/^(artikel|produkt|product|item)$/i.test(v)) return true;
  if (/^unbekannt(es)? produkt/i.test(v)) return true;
  // "Produkt 1", "Ürün 1", ...
  if (/^(produkt|product|ürün|urun|artikel)\s*#?\s*\d+\b/i.test(v)) return true;
  return false;
};

const createLocalId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `job_${Math.random().toString(36).slice(2, 9)}`;
};

export const useIdentification = (options?: UseIdentificationOptions) => {
  const [jobs, setJobs] = useState<IdentificationJobStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const jobControllersRef = useRef<Map<string, AbortController>>(new Map());

  const updateJob = useCallback((localId: string, patch: Partial<IdentificationJobStatus>) => {
    setJobs((prev) =>
      prev.map((job) => (job.localId === localId ? { ...job, ...patch } : job))
    );
  }, []);

  const addJob = useCallback((job: IdentificationJobStatus) => {
    setJobs((prev) => [...prev, job]);
  }, []);

  const validateGroup = useCallback((group: UploadGroupPayload) => {
    if (group.images.length > MAX_IDENTIFY_FILES) {
      throw new Error(`Gruppe "${group.label}" enthält zu viele Bilder (max. ${MAX_IDENTIFY_FILES}).`);
    }
    const totalBytes = group.images.reduce((acc, file) => acc + file.size, 0);
    if (totalBytes > MAX_IDENTIFY_TOTAL_BYTES) {
      throw new Error(
        `Die Bilder von "${group.label}" überschreiten das ${(MAX_IDENTIFY_TOTAL_BYTES / (1024 * 1024)).toFixed(
          1
        )} MB Limit pro Upload.`
      );
    }
    if (group.images.some((file) => file.size > MAX_IDENTIFY_FILE_BYTES)) {
      throw new Error(
        `Einzelne Bilder in "${group.label}" sind größer als ${(MAX_IDENTIFY_FILE_BYTES / (1024 * 1024)).toFixed(
          1
        )} MB.`
      );
    }
  }, []);

  // Persisting is handled server-side by /api/v2/identify (includes stock protection + review).

  const startJobForGroup = useCallback(
    async (
      group: UploadGroupPayload,
      barcodes: string,
      inventoryId?: string | null,
      inventoryName?: string | null,
      paletteCode?: string | null
    ): Promise<void> => {
      const localId = createLocalId();
      const startedAt = new Date().toISOString();
      addJob({
        localId,
        label: group.label,
        phase: 'upload',
        message: PHASE_MESSAGES.upload,
        startedAt,
      });

      const controller = new AbortController();
      jobControllersRef.current.set(localId, controller);

      try {
        updateJob(localId, {
          phase: 'processing',
          message: 'Vision/Gemini analysiert das Produkt …',
        });
        updateJob(localId, {
          phase: 'enriching',
          message: 'Datenblatt wird erstellt …',
        });
        const identifyResult = await identifyProductV2(group.images, barcodes, 'de-DE', inventoryId || undefined, paletteCode || undefined);
        if (!identifyResult.ok || !identifyResult.data) {
          throw new Error(identifyResult.error?.message || 'Identify (v2) fehlgeschlagen.');
        }

        const finalProduct: Product = identifyResult.data;
        const hasName =
          !!finalProduct.identification?.name?.trim() &&
          !isPlaceholderIdentifiedName(finalProduct.identification?.name);
        const hasDesc = !!finalProduct.details?.short_description?.trim();
        const hasImages =
          Array.isArray(finalProduct.details?.images) && finalProduct.details.images.length > 0;
        const requireImages = group.images.length > 0;
        const missing: string[] = [];
        if (!hasName) missing.push('Titel');
        if (!hasDesc) missing.push('Beschreibung');
        if (requireImages && !hasImages) missing.push('Bilder');
        if (missing.length) {
          throw new Error(
            `Identify hat ein unvollständiges Datenblatt geliefert (${missing.join(', ')} fehlt). Bitte erneut versuchen.`
          );
        }

        try {
          updateJob(localId, {
            phase: 'enriching',
            message: 'Preis wird geprüft …',
          });
          const priceResult = await refreshPrice(finalProduct.id);
          if (priceResult.ok && priceResult.data) {
            const withPrice: Product = {
              ...finalProduct,
              details: {
                ...finalProduct.details,
                pricing: {
                  ...(finalProduct.details?.pricing || {}),
                  ...priceResult.data,
                },
              },
            };
            options?.onJobCompleted?.({ products: [withPrice] });
          } else {
            options?.onJobCompleted?.({ products: [finalProduct] });
          }
        } catch (priceError) {
          console.warn('Price enrichment failed:', (priceError as any)?.message || priceError);
          options?.onJobCompleted?.({ products: [finalProduct] });
        }
        updateJob(localId, {
          phase: 'complete',
          message: PHASE_MESSAGES.complete,
          finishedAt: new Date().toISOString(),
        });
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          updateJob(localId, {
            phase: 'cancelled',
            message: PHASE_MESSAGES.cancelled,
            finishedAt: new Date().toISOString(),
            error: 'Abgebrochen',
          });
        } else {
          const message =
            err instanceof Error ? err.message : 'Unbekannter Fehler bei der Produktidentifikation.';
          console.error('Identification job failed:', err);
          updateJob(localId, {
            phase: 'error',
            message,
            finishedAt: new Date().toISOString(),
            error: message,
          });
          setError(message);
        }
        // Do NOT rethrow — continue with next group in sequential processing
      } finally {
        jobControllersRef.current.delete(localId);
      }
    },
    [addJob, options?.onJobCompleted, updateJob]
  );

  const enqueueIdentification = useCallback(
    async (
      groups: UploadGroupPayload[],
      barcodes: string,
      inventoryId?: string | null,
      inventoryName?: string | null,
      paletteCode?: string | null
    ) => {
      const prepared = groups.filter((group) => group.images.length > 0);
      const hasBarcodes = Boolean(barcodes && barcodes.trim());
      const groupsToProcess =
        prepared.length > 0
          ? prepared
          : hasBarcodes
          ? [
              {
                id: 'barcode-only',
                label: 'Barcode-Identifikation',
                images: [],
              },
            ]
          : [];
      if (!groupsToProcess.length) {
        setError('Bitte ordne mindestens einer Produktgruppe Bilder zu.');
        return;
      }

      try {
        groupsToProcess.forEach((group) => validateGroup(group));
      } catch (validationError: any) {
        const message =
          validationError instanceof Error
            ? validationError.message
            : 'Upload konnte nicht validiert werden.';
        setError(message);
        return;
      }

      setError(null);

      // Sequential processing — avoids Gemini rate-limiting and ensures all products are saved
      for (const group of groupsToProcess) {
        await startJobForGroup(group, barcodes, inventoryId, inventoryName, paletteCode);
      }
    },
    [startJobForGroup, validateGroup]
  );

  const cancelJob = useCallback((localId: string) => {
    const controller = jobControllersRef.current.get(localId);
    if (controller) {
      controller.abort();
    }
  }, []);

  const dismissJob = useCallback((localId: string) => {
    setJobs((prev) => prev.filter((job) => job.localId !== localId));
  }, []);

  useEffect(() => {
    return () => {
      jobControllersRef.current.forEach((controller) => controller.abort());
      jobControllersRef.current.clear();
    };
  }, []);

  const isLoading = jobs.some(
    (job) =>
      !job.finishedAt &&
      job.phase !== 'error' &&
      job.phase !== 'cancelled'
  );

  return {
    enqueueIdentification,
    jobStatuses: jobs,
    isLoading,
    error,
    cancelJob,
    dismissJob,
    clearError: () => setError(null),
  };
};
