import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
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

// Creating + monitoring hundreds of improve jobs must not DDOS our own backend.
// - We create jobs in small batches (backend allows more, but this is safer for Cloud Run timeouts).
// - We monitor only a few jobs concurrently. The rest stay "queued" in the UI.
const IMPROVE_CREATE_BATCH_SIZE = 50;
const IMPROVE_MONITOR_CONCURRENCY = 3;
const IMPROVE_JOB_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes per monitored job

const createLocalId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `improve_${Math.random().toString(36).slice(2, 9)}`;
};

export const useImproveQueue = (options?: UseImproveQueueOptions) => {
  const [jobs, setJobs] = useState<ImproveJobStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const jobsCountRef = useRef(0);
  const monitorQueueRef = useRef<Array<{ jobId: string; localId: string; productId: string }>>([]);
  const activeMonitorsRef = useRef(0);

  const updateJob = useCallback((localId: string, patch: Partial<ImproveJobStatus>) => {
    setJobs((prev) =>
      prev.map((job) => (job.localId === localId ? { ...job, ...patch } : job))
    );
  }, []);

  const addJob = useCallback((job: ImproveJobStatus) => {
    setJobs((prev) => [...prev, job]);
  }, []);

  useEffect(() => {
    jobsCountRef.current = jobs.length;
  }, [jobs.length]);

  const monitorJob = useCallback(
    async (jobId: string, localId: string, productId: string) => {
      try {
        const improvedProduct = await pollImproveJob(jobId, {
          timeoutMs: IMPROVE_JOB_TIMEOUT_MS,
          onStatus: (phase) => {
            const MESSAGES: Record<string, string> = {
              downloading_images: 'Bilder werden heruntergeladen ...',
              identifying: 'Produkt wird identifiziert ...',
              merging: 'Daten werden verarbeitet ...',
              pricing: 'Preis wird geprüft ...',
              enriching: 'Daten werden angereichert ...',
              reviewing: 'Abschließende Prüfung ...',
              queued: 'Verbesserung eingeplant …',
              processing: 'Produkt wird verbessert …',
            };
            const message = MESSAGES[phase] || MESSAGES.processing;

            updateJob(localId, {
              phase: 'processing', // Keep generic phase for UI color/icon
              message,
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
          const newLabel = improvedProduct.identification
            ? [improvedProduct.identification.brand, improvedProduct.identification.name].filter(Boolean).join(' ')
            : options?.resolveLabel?.(productId);

          if (newLabel) {
            updateJob(localId, { label: newLabel });
          }

          options?.onProductImproved?.(improvedProduct);
        }

        // Auto-dismiss only for small job sessions (bulk should remain visible).
        if (jobsCountRef.current <= 10) {
          setTimeout(() => {
            setJobs((prev) => prev.filter((j) => j.localId !== localId));
          }, 6000);
        }
      } catch (err: any) {
        const message =
          err instanceof Error ? err.message : 'Improve-Job fehlgeschlagen.';
        updateJob(localId, {
          phase: 'error',
          message,
          error: message,
          finishedAt: new Date().toISOString(),
        });
        // Do not spam global alerts for bulk runs; errors are visible per job.
      }
    },
    [options, updateJob]
  );

  const drainMonitorQueue = useCallback(() => {
    while (
      activeMonitorsRef.current < IMPROVE_MONITOR_CONCURRENCY &&
      monitorQueueRef.current.length > 0
    ) {
      const next = monitorQueueRef.current.shift();
      if (!next) break;
      activeMonitorsRef.current += 1;
      monitorJob(next.jobId, next.localId, next.productId)
        .catch((err) => {
          console.warn('Improve monitor failed:', err?.message || err);
        })
        .finally(() => {
          activeMonitorsRef.current = Math.max(0, activeMonitorsRef.current - 1);
          // Continue draining
          drainMonitorQueue();
        });
    }
  }, [monitorJob]);

  const enqueueMonitor = useCallback((jobId: string, localId: string, productId: string) => {
    monitorQueueRef.current.push({ jobId, localId, productId });
    drainMonitorQueue();
  }, [drainMonitorQueue]);

  const chunk = (list: string[], size: number) => {
    const out: string[][] = [];
    for (let i = 0; i < list.length; i += size) {
      out.push(list.slice(i, i + size));
    }
    return out;
  };

  const enqueueImproveJobs = useCallback(
    async (productIds: string[]) => {
      const uniqueIds = [...new Set(productIds.map((id) => String(id || '').trim()))].filter(Boolean);
      if (!uniqueIds.length) {
        setError('Bitte mindestens ein Produkt auswählen.');
        return;
      }
      const batches = chunk(uniqueIds, IMPROVE_CREATE_BATCH_SIZE);
      const timestamp = new Date().toISOString();
      const allMissing: string[] = [];

      setError(null);

      for (const batchIds of batches) {
        const creation = await createImproveJobs(batchIds);
        if (!creation.ok || !creation.data?.jobs?.length) {
          const message =
            creation.error?.message || 'Improve-Jobs konnten nicht gestartet werden.';
          setError(message);
          return;
        }

        if (creation.data.missing?.length) {
          allMissing.push(...creation.data.missing);
        }

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
          enqueueMonitor(jobId, localId, productId);
        });
      }

      if (allMissing.length) {
        setError(`Folgende Produkte wurden nicht gefunden: ${Array.from(new Set(allMissing)).join(', ')}`);
      }
    },
    [addJob, enqueueMonitor, options]
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
      enqueueMonitor(jobId, localId, productId);
    });
  }, [addJob, enqueueMonitor, options]);

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


