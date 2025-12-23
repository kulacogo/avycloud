
import { useState, useCallback, useRef, useEffect } from 'react';
import { ProductBundle, IdentifyPhase, Product } from '../types';
import { MAX_IDENTIFY_FILES, MAX_IDENTIFY_FILE_BYTES, MAX_IDENTIFY_TOTAL_BYTES } from '../constants';
import {
  createIdentificationJob,
  pollIdentificationJob,
  runSerpapiFreeEnrichment,
  saveProduct,
} from '../api/client';
import { buildProductFromEnrichment } from '../utils/enrichmentRecord';

export interface UploadGroupPayload {
  id: string;
  label: string;
  images: File[];
}

export type IdentifyPipeline = 'legacy' | 'v2';

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

  const persistProduct = useCallback(async (product: Product) => {
    const saveResult = await saveProduct(product);
    if (!saveResult.ok) {
      throw new Error(saveResult.error?.message || 'Produkt konnte nicht gespeichert werden.');
    }
    const now = new Date().toISOString();
    return {
      ...product,
      id: saveResult.data?.id || product.id,
      ops: {
        ...product.ops,
        revision: saveResult.data?.revision ?? product.ops.revision ?? 0,
        last_saved_iso: now,
      },
    };
  }, []);

  const startJobForGroup = useCallback(
    (
      group: UploadGroupPayload,
      barcodes: string,
      model: string | undefined,
      pipeline: IdentifyPipeline,
      inventoryId?: string | null,
      inventoryName?: string | null
    ) => {
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

      (async () => {
        try {
          if (pipeline === 'v2') {
            updateJob(localId, {
              phase: 'processing',
              message: 'Vision/Gemini analysiert das Produkt …',
            });
            const response = await runSerpapiFreeEnrichment(group.images, barcodes, 'de-DE', inventoryId || undefined);
            if (!response.ok || !response.data) {
              throw new Error(response.error?.message || 'SerpAPI-freies Enrichment fehlgeschlagen.');
            }
            const product = buildProductFromEnrichment(response.data, {
              fallbackId: group.id,
              barcodes,
              label: group.label,
              inventoryId: inventoryId || null,
              inventoryName: inventoryName || null,
            });
            const hasName = !!product.identification?.name?.trim();
            const hasDesc = !!product.details?.short_description?.trim();
            const hasImages = Array.isArray(product.details?.images) && product.details.images.length > 0;
            if (!hasName || !hasDesc || !hasImages) {
              throw new Error('Enrichment unvollständig: Name/Beschreibung/Bilder fehlen.');
            }
            const persisted = await persistProduct(product);
            options?.onJobCompleted?.({ products: [persisted] });
            updateJob(localId, {
              phase: 'complete',
              message: PHASE_MESSAGES.complete,
              finishedAt: new Date().toISOString(),
            });
            return;
          }
          const creation = await createIdentificationJob(group.images, barcodes, {
            model,
            signal: controller.signal,
            inventoryId: inventoryId || undefined,
          });
          if (!creation.ok || !creation.jobId) {
            throw new Error(creation.error?.message || 'Job konnte nicht erstellt werden.');
          }
          updateJob(localId, {
            jobId: creation.jobId,
            phase: 'queued',
            message: PHASE_MESSAGES.queued,
          });

          const bundle = await pollIdentificationJob(creation.jobId, {
            signal: controller.signal,
            onStatus: (phase) => {
              const message = PHASE_MESSAGES[phase] || 'Job wird verarbeitet …';
              updateJob(localId, { phase, message });
        },
      });

          if (!bundle?.products?.length) {
            throw new Error('Job abgeschlossen, aber keine Produkte erhalten.');
      }

          options?.onJobCompleted?.(bundle);
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
        } finally {
          jobControllersRef.current.delete(localId);
        }
      })();
    },
    [addJob, options?.onJobCompleted, persistProduct, updateJob]
  );

  const enqueueIdentification = useCallback(
    async (
      groups: UploadGroupPayload[],
      barcodes: string,
      model: string | undefined,
      pipeline: IdentifyPipeline = 'legacy',
      inventoryId?: string | null,
      inventoryName?: string | null
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
      groupsToProcess.forEach((group) => {
        startJobForGroup(group, barcodes, model, pipeline, inventoryId, inventoryName);
      });
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
