import React, { useState, useCallback } from "react";
import { useErrors, ErrorFilters } from "../hooks/useErrors";
import { ErrorKPIs } from "./error-dashboard/ErrorKPIs";
import { ErrorList } from "./error-dashboard/ErrorList";

export const ErrorDashboard: React.FC = () => {
  const [filters, setFilters] = useState<{
    type?: string;
    channel?: string;
    severity?: string;
    status?: string;
  }>({});
  const [currentPage, setCurrentPage] = useState(1);

  const queryFilters: ErrorFilters = {
    ...filters,
    page: currentPage,
    pageSize: 50,
  };

  const {
    errors,
    total,
    page,
    pageSize,
    summary,
    loading,
    error,
    resolveError,
    refresh,
  } = useErrors(queryFilters);

  const handleFiltersChange = useCallback(
    (next: { type?: string; channel?: string; severity?: string; status?: string }) => {
      setFilters(next);
      setCurrentPage(1);
    },
    []
  );

  const handlePageChange = useCallback((newPage: number) => {
    setCurrentPage(newPage);
  }, []);

  const handleResolve = useCallback(
    async (errorId: string) => {
      await resolveError(errorId);
      // Refresh after a short delay to pick up the updated list
      setTimeout(() => refresh(), 300);
    },
    [resolveError, refresh]
  );

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-txt-primary">Fehler-Dashboard</h1>
          <p className="text-sm text-txt-muted mt-0.5">
            Alle operativen Fehler und Sync-Probleme
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="text-xs font-medium px-3 py-1.5 rounded-md bg-app-elevated border border-app-border text-txt-secondary hover:text-txt-primary transition-colors disabled:opacity-50"
        >
          Aktualisieren
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-4 px-4 py-3 rounded-md bg-danger-dim text-danger text-sm">
          {error}
        </div>
      )}

      {/* KPI tiles */}
      <ErrorKPIs summary={summary} loading={loading} />

      {/* Error list with filters */}
      <ErrorList
        errors={errors}
        total={total}
        page={page}
        pageSize={pageSize}
        loading={loading}
        onResolve={handleResolve}
        onPageChange={handlePageChange}
        onFiltersChange={handleFiltersChange}
        filters={filters}
      />
    </div>
  );
};

export default ErrorDashboard;
