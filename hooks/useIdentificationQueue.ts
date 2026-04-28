import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IdentificationJobStatus, IdentificationJob } from '../types';
import { fetchIdentificationJobs, retryIdentificationJob } from '../api/client';

const DEFAULT_STATUSES: IdentificationJobStatus[] = ['pending', 'processing'];
const AUTO_REFRESH_INTERVAL_MS = 30_000;

interface LoadOptions {
  append?: boolean;
  cursor?: string | null;
}

export const useIdentificationQueue = () => {
  const [jobs, setJobs] = useState<IdentificationJob[]>([]);
  const [statuses, setStatuses] = useState<string[]>(DEFAULT_STATUSES);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  // Keep `nextCursor` out of `loadJobs` dependencies. Including it caused a re-fetch loop:
  // every successful fetch updated nextCursor → re-created loadJobs → re-triggered the mount
  // and auto-refresh effects → another fetch. All callers that need pagination pass `cursor`
  // explicitly via `loadMore`, so the previous `?? nextCursor` fallback was never load-bearing.
  const loadJobs = useCallback(
    async (options: LoadOptions = {}) => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
      const controller = new AbortController();
      abortRef.current = controller;
      setIsLoading(true);
      try {
        const data = await fetchIdentificationJobs({
          statuses: statuses.length ? statuses : undefined,
          limit: 50,
          cursor: options.append ? options.cursor ?? null : null,
          signal: controller.signal,
        });
        setStats(data.stats || {});
        setNextCursor(data.nextCursor);
        setHasMore(Boolean(data.hasMore));
        setJobs((prev) => (options.append ? [...prev, ...data.jobs] : data.jobs));
        setLastUpdated(new Date().toISOString());
        setError(null);
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          return;
        }
        setError(err?.message || 'Queue konnte nicht geladen werden.');
      } finally {
        setIsLoading(false);
      }
    },
    [statuses]
  );

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    if (!autoRefresh) {
      return undefined;
    }
    const id = setInterval(() => {
      loadJobs();
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [autoRefresh, loadJobs]);

  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, []);

  const toggleStatus = useCallback((status: string) => {
    setStatuses((prev) => {
      const exists = prev.includes(status);
      if (exists) {
        return prev.filter((value) => value !== status);
      }
      return [...prev, status];
    });
  }, []);

  const resetStatuses = useCallback(() => {
    setStatuses(DEFAULT_STATUSES);
  }, []);

  const refresh = useCallback(() => loadJobs(), [loadJobs]);

  const loadMore = useCallback(() => {
    if (!hasMore || !nextCursor) {
      return;
    }
    loadJobs({ append: true, cursor: nextCursor });
  }, [hasMore, nextCursor, loadJobs]);

  const retryJob = useCallback(
    async (jobId: string) => {
      const result = await retryIdentificationJob(jobId);
      if (!result.ok) {
        setError(result.error?.message || 'Job konnte nicht neu gestartet werden.');
        return false;
      }
      await loadJobs();
      return true;
    },
    [loadJobs]
  );

  const statusCounts = useMemo(() => {
    return {
      pending: stats.pending || 0,
      processing: stats.processing || 0,
      failed: stats.failed || 0,
      done: stats.done || 0,
      total: stats.total || jobs.length,
    };
  }, [jobs.length, stats]);

  return {
    jobs,
    isLoading,
    error,
    statuses,
    setStatuses,
    toggleStatus,
    resetStatuses,
    refresh,
    loadMore,
    hasMore,
    nextCursor,
    stats: statusCounts,
    autoRefresh,
    setAutoRefresh,
    lastUpdated,
    retryJob,
    clearError: () => setError(null),
  };
};

