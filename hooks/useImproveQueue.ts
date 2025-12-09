import { useState, useCallback, useMemo } from 'react';
import { IdentifyPhase, Product } from '../types';
import { createImproveJobs, pollImproveJob } from '../api/client';

export interface ImproveJobStatus {
  localId: string;
  jobId?: string;
  productId: string;
  label: string;
  phase: IdentifyPhase | 'upload';
  message: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

interface UseImproveQueueOptions {
  onProductImproved?: (product: Product) => void;
  resolveLabel?: (productId: string) => string;
}

const PHASE_MESSAGES: Record<string, string> = {
  queued: 'Verbesserung eingeplant …',
  processing: 'Produkt wird verbessert …',
  complete: 'Verbesserung abgeschlossen.',
  error: 'Verbesserung fehlgeschlagen.',
};

const createLocalId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `improve_${Math.random().toString(36).slice(2, 9)}`;
};

export const useImproveQueue = (options?: UseImproveQueueOptions) => {
  const [jobs, setJobs] = useState<ImproveJobStatus[]>([]);
  const [error, setError] = useState<string | null>(null);

  const updateJob = useCallback((localId: string, patch: Partial<ImproveJobStatus>) => {
    setJobs((prev) =>
      prev.map((job) => (job.localId === localId ? { ...job, ...patch } : job))
    );
  }, []);

  const addJob = useCallback((job: ImproveJobStatus) => {
    setJobs((prev) => [...prev, job]);
  }, []);

  const monitorJob = useCallback((jobId: string, localId: string, productId: string) => {
    (async () => {
      try {
        const improvedProduct = await pollImproveJob(jobId, {
          onStatus: (phase) => {
            const MESSAGES: Record<string, string> = {
              downloading_images: 'Bilder werden heruntergeladen ...',
              identifying: 'Produkt wird identifiziert ...',
              merging: 'Daten werden verarbeitet ...',
              enriching: 'Daten werden angereichert ...',
              reviewing: 'Abschließende Prüfung ...',
              queued: 'Verbesserung eingeplant …',
              processing: 'Produkt wird verbessert …',
            };
            const message = MESSAGES[phase] || MESSAGES.processing;

            updateJob(localId, {
              phase: 'processing', // Keep generic phase for UI color/icon
              message
            });
          },
        });

        updateJob(localId, {
          phase: 'complete',
          message: PHASE_MESSAGES.complete,
          finishedAt: new Date().toISOString(),
        });

        if (improvedProduct) {
          // Update the label to reflect the NEW product name
          const newLabel = improvedProduct.identification ?
            [improvedProduct.identification.brand, improvedProduct.identification.name].filter(Boolean).join(' ')
            : options?.resolveLabel?.(productId);

          if (newLabel) {
            updateJob(localId, { label: newLabel });
          }

          options?.onProductImproved?.(improvedProduct);
        }

        // Auto-dismiss the status window after 4 seconds only on success
        setTimeout(() => {
          setJobs(prev => prev.filter(j => j.localId !== localId));
        }, 4000);

      } catch (err: any) {
        const message =
          err instanceof Error ? err.message : 'Improve-Job fehlgeschlagen.';
        updateJob(localId, {
          phase: 'error',
          message,
          error: message,
          finishedAt: new Date().toISOString(),
        });
        if (typeof setError === 'function') setError(message);
      }
    })();
  }, [options, updateJob]);

  const enqueueImproveJobs = useCallback(
    async (productIds: string[]) => {
      const uniqueIds = [...new Set(productIds.map((id) => String(id || '').trim()))].filter(Boolean);
      if (!uniqueIds.length) {
        setError('Bitte mindestens ein Produkt auswählen.');
        return;
      }

      const creation = await createImproveJobs(uniqueIds);
      if (!creation.ok || !creation.data?.jobs?.length) {
        const message =
          creation.error?.message || 'Improve-Jobs konnten nicht gestartet werden.';
        setError(message);
        return;
      }

      setError(null);
      const timestamp = new Date().toISOString();
      creation.data.jobs.forEach(({ jobId, productId }) => {
        const localId = createLocalId();
        addJob({
          localId,
          jobId,
          productId,
          label: options?.resolveLabel?.(productId) || `Produkt ${productId}`,
          phase: 'queued',
          message: PHASE_MESSAGES.queued,
          startedAt: timestamp,
        });
        monitorJob(jobId, localId, productId);
      });

      if (creation.data.missing?.length) {
        setError(
          `Folgende Produkte wurden nicht gefunden: ${creation.data.missing.join(', ')}`
        );
      }
    },
    [addJob, options, monitorJob]
  );

  const trackJobs = useCallback((jobsToTrack: Array<{ jobId: string, productId: string }>) => {
    const timestamp = new Date().toISOString();
    jobsToTrack.forEach(({ jobId, productId }) => {
      const localId = createLocalId();
      addJob({
        localId,
        jobId,
        productId,
        label: options?.resolveLabel?.(productId) || `Produkt ${productId}`,
        phase: 'queued',
        message: PHASE_MESSAGES.queued,
        startedAt: timestamp,
      });
      monitorJob(jobId, localId, productId);
    });
  }, [addJob, monitorJob, options]);

  const activeProductIds = useMemo(() => {
    return new Set(
      jobs
        .filter((job) => !job.finishedAt && job.phase !== 'error')
        .map((job) => job.productId)
    );
  }, [jobs]);

  const dismissJob = useCallback((localId: string) => {
    setJobs((prev) => prev.filter((job) => job.localId !== localId));
  }, []);

  return {
    enqueueImproveJobs,
    trackJobs,
    jobStatuses: jobs,
    activeProductIds,
    error,
    dismissJob,
    clearError: () => setError(null),
  };
};


