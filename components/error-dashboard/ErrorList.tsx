import React, { useState } from "react";
import { OperationalError } from "../../api/client";
import { ErrorRow } from "./ErrorRow";

interface ErrorListProps {
  errors: OperationalError[];
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
  onResolve: (errorId: string) => void;
  onPageChange: (page: number) => void;
  onFiltersChange: (filters: {
    type?: string;
    channel?: string;
    severity?: string;
    status?: string;
  }) => void;
  filters: {
    type?: string;
    channel?: string;
    severity?: string;
    status?: string;
  };
}

const typeOptions = [
  { value: "", label: "Alle Typen" },
  { value: "sync_failure", label: "Sync-Fehler" },
  { value: "api_error", label: "API-Fehler" },
  { value: "job_failure", label: "Job-Fehler" },
  { value: "validation_error", label: "Validierung" },
  { value: "webhook_error", label: "Webhook" },
];

const channelOptions = [
  { value: "", label: "Alle Kanäle" },
  { value: "ebay", label: "eBay" },
  { value: "kaufland", label: "Kaufland" },
  { value: "sendcloud", label: "SendCloud" },
  { value: "internal", label: "Intern" },
];

const severityOptions = [
  { value: "", label: "Alle Stufen" },
  { value: "critical", label: "Kritisch" },
  { value: "warning", label: "Warnung" },
  { value: "info", label: "Info" },
];

const statusOptions = [
  { value: "", label: "Alle Status" },
  { value: "open", label: "Offen" },
  { value: "resolved", label: "Erledigt" },
];

export const ErrorList: React.FC<ErrorListProps> = ({
  errors,
  total,
  page,
  pageSize,
  loading,
  onResolve,
  onPageChange,
  onFiltersChange,
  filters,
}) => {
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const handleResolve = async (errorId: string) => {
    setResolvingId(errorId);
    try {
      await onResolve(errorId);
    } finally {
      setResolvingId(null);
    }
  };

  const totalPages = Math.ceil(total / pageSize);

  const handleFilterChange = (key: string, value: string) => {
    onFiltersChange({ ...filters, [key]: value || undefined });
  };

  return (
    <div className="bg-app-surface border border-app-border rounded-md overflow-hidden">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-app-border">
        <select
          value={filters.type || ""}
          onChange={(e) => handleFilterChange("type", e.target.value)}
          className="text-xs bg-app-elevated border border-app-border text-txt-primary rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent"
        >
          {typeOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <select
          value={filters.channel || ""}
          onChange={(e) => handleFilterChange("channel", e.target.value)}
          className="text-xs bg-app-elevated border border-app-border text-txt-primary rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent"
        >
          {channelOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <select
          value={filters.severity || ""}
          onChange={(e) => handleFilterChange("severity", e.target.value)}
          className="text-xs bg-app-elevated border border-app-border text-txt-primary rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent"
        >
          {severityOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <select
          value={filters.status || ""}
          onChange={(e) => handleFilterChange("status", e.target.value)}
          className="text-xs bg-app-elevated border border-app-border text-txt-primary rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent"
        >
          {statusOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <span className="text-xs text-txt-muted ml-auto">
          {total} Fehler
        </span>
      </div>

      {/* Loading skeleton */}
      {loading && errors.length === 0 && (
        <div className="px-4 py-8">
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 bg-app-elevated rounded-md animate-pulse" />
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && errors.length === 0 && (
        <div className="px-4 py-12 text-center">
          <div className="text-3xl mb-3">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto text-success">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </div>
          <div className="text-txt-primary font-medium">Alles in Ordnung</div>
          <div className="text-sm text-txt-muted mt-1">Keine Fehler gefunden.</div>
        </div>
      )}

      {/* Error rows */}
      {errors.length > 0 && (
        <div>
          {errors.map((err) => (
            <ErrorRow
              key={err.id}
              error={err}
              onResolve={handleResolve}
              resolving={resolvingId === err.id}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-app-border">
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            className="text-xs font-medium px-3 py-1.5 rounded-md bg-app-elevated text-txt-secondary hover:text-txt-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Zurück
          </button>
          <span className="text-xs text-txt-muted">
            Seite {page} von {totalPages}
          </span>
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            className="text-xs font-medium px-3 py-1.5 rounded-md bg-app-elevated text-txt-secondary hover:text-txt-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Weiter
          </button>
        </div>
      )}
    </div>
  );
};
