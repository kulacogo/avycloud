
import { useState, useCallback, useRef, useEffect } from 'react';
import { ProductBundle, IdentifyPhase, Product } from '../types';
import { MAX_IDENTIFY_FILES, MAX_IDENTIFY_FILE_BYTES, MAX_IDENTIFY_TOTAL_BYTES } from '../constants';
import {
  runSerpapiFreeEnrichment,
  refreshPrice,
  saveProduct,
  resolveIntakeExisting,
} from '../api/client';
import { buildProductFromEnrichment } from '../utils/enrichmentRecord';

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
          const hasName =
            !!product.identification?.name?.trim() && !isPlaceholderIdentifiedName(product.identification?.name);
          const hasDesc = !!product.details?.short_description?.trim();
          const hasImages = Array.isArray(product.details?.images) && product.details.images.length > 0;

          if (!hasName || !hasDesc || !hasImages) {
            const ranked = Array.isArray(response.meta?.barcodeInsights?.ranked)
              ? response.meta.barcodeInsights.ranked
              : [];
            const valid = ranked
              .filter((entry: any) => entry && entry.isValid && entry.code)
              .map((entry: any) => String(entry.code))
              .filter(Boolean);
            const uniqueValid = Array.from(new Set(valid)).slice(0, 6);
            const bestGuess = Array.isArray(response.meta?.ocr?.web?.bestGuessLabels)
              ? response.meta.ocr.web.bestGuessLabels.filter(Boolean).slice(0, 3)
              : [];
            const llmError = response.meta?.llm?.error ? String(response.meta.llm.error) : '';

            if (uniqueValid.length >= 2) {
              throw new Error(
                `Mehrere Produkte in einem Upload erkannt (mehrere Barcodes: ${uniqueValid.join(
                  ', '
                )}). Bitte pro Produkt eine Gruppe anlegen und die Bilder trennen.`
              );
            }
            if (uniqueValid.length === 1) {
              throw new Error(
                `Barcode erkannt (${uniqueValid[0]}), aber Titel/Marke konnten nicht sicher abgeleitet werden. Bitte ein schärferes Frontfoto/Label hochladen oder Barcode separat scannen.`
              );
            }
            if (bestGuess.length) {
              throw new Error(
                `Identifikation unsicher (Vision-Hinweis: ${bestGuess.join(
                  ' | '
                )}).${llmError ? ` (LLM: ${llmError})` : ''} Bitte bessere Fotos/Barcode liefern oder pro Produkt eine eigene Gruppe nutzen.`
              );
            }
            throw new Error(
              `Identifikation unsicher.${llmError ? ` (LLM: ${llmError})` : ''} Bitte bessere Fotos/Barcode liefern oder pro Produkt eine eigene Gruppe nutzen.`
            );
          }

          // HARD SAFETY: if product already exists (EAN/GTIN/SKU), never overwrite the datasheet.
          updateJob(localId, {
            phase: 'enriching',
            message: 'Bestand prüfen …',
          });
          try {
            const lookup = await resolveIntakeExisting({
              barcodes,
              sku: product.identification?.sku || product.details?.identifiers?.sku || null,
              inventoryId: inventoryId || null,
            });
            if (lookup.ok && lookup.data?.matched && lookup.data.product) {
              const existing = lookup.data.product;
              options?.onJobCompleted?.({ products: [existing] });
              updateJob(localId, {
                phase: 'complete',
                message: PHASE_MESSAGES.complete,
                finishedAt: new Date().toISOString(),
              });
              return;
            }
          } catch (lookupErr) {
            console.warn(
              'Intake resolve failed (continuing with new product):',
              (lookupErr as any)?.message || lookupErr
            );
          }

          const persisted = await persistProduct(product);
          let pricedProduct = persisted;
          try {
            updateJob(localId, {
              phase: 'enriching',
              message: 'Preis wird recherchiert …',
            });
            const priceResult = await refreshPrice(persisted.id);
            if (priceResult.ok && priceResult.data) {
              pricedProduct = {
                ...persisted,
                details: {
                  ...persisted.details,
                  pricing: {
                    ...(persisted.details?.pricing || {}),
                    ...priceResult.data,
                  },
                },
              };
            }
          } catch (priceError) {
            console.warn('Price enrichment failed:', (priceError as any)?.message || priceError);
          }
          options?.onJobCompleted?.({ products: [pricedProduct] });
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
        startJobForGroup(group, barcodes, inventoryId, inventoryName);
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
