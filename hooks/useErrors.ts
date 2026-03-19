import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchErrors,
  fetchErrorSummary,
  resolveError as apiResolveError,
  OperationalError,
  ErrorSummary,
} from "../api/client";
import { useAuth } from "../context/AuthContext";

const POLL_INTERVAL_MS = 30_000;

export interface ErrorFilters {
  type?: string;
  channel?: string;
  severity?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export function useErrors(filters: ErrorFilters = {}) {
  const { user, loading: authLoading } = useAuth();
  const [errors, setErrors] = useState<OperationalError[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [summary, setSummary] = useState<ErrorSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadErrors = useCallback(async () => {
    if (authLoading || !user) return;
    setLoading(true);
    try {
      const result = await fetchErrors({
        ...filters,
        page: filters.page || page,
        pageSize: filters.pageSize || pageSize,
      });
      setErrors(result.errors);
      setTotal(result.total);
      setPage(result.page);
      setPageSize(result.pageSize);
      setError(null);
    } catch (err: any) {
      console.error("Failed to load errors:", err);
      setError(err?.message || "Fehler konnten nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }, [authLoading, user?.uid, filters.type, filters.channel, filters.severity, filters.status, filters.page, filters.pageSize, page, pageSize]);

  const loadSummary = useCallback(async () => {
    if (authLoading || !user) return;
    try {
      const result = await fetchErrorSummary();
      setSummary(result);
    } catch (err: any) {
      console.error("Failed to load error summary:", err);
    }
  }, [authLoading, user?.uid]);

  const refresh = useCallback(() => {
    loadErrors();
    loadSummary();
  }, [loadErrors, loadSummary]);

  const handleResolve = useCallback(async (errorId: string) => {
    try {
      await apiResolveError(errorId);
      // Optimistic update
      setErrors((prev) =>
        prev.map((e) => (e.id === errorId ? { ...e, status: "resolved" } : e))
      );
      setSummary((prev) =>
        prev
          ? {
              ...prev,
              total: Math.max(0, prev.total - 1),
              byStatus: {
                open: Math.max(0, prev.byStatus.open - 1),
                resolved: prev.byStatus.resolved + 1,
              },
              bySeverity: prev.bySeverity,
              byType: prev.byType,
              byChannel: prev.byChannel,
            }
          : prev
      );
    } catch (err: any) {
      console.error("Failed to resolve error:", err);
      throw err;
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadErrors();
    loadSummary();
  }, [loadErrors, loadSummary]);

  // 30-second polling for badge count
  useEffect(() => {
    if (authLoading || !user) return;
    pollRef.current = setInterval(() => {
      loadSummary();
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [authLoading, user?.uid, loadSummary]);

  return {
    errors,
    total,
    page,
    pageSize,
    summary,
    loading,
    error,
    resolveError: handleResolve,
    refresh,
  };
}
