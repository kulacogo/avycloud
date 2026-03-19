import React from "react";
import { ErrorSummary } from "../../api/client";

interface ErrorKPIsProps {
  summary: ErrorSummary | null;
  loading: boolean;
}

const Skeleton: React.FC = () => (
  <div className="h-16 bg-app-elevated rounded-md animate-pulse" />
);

export const ErrorKPIs: React.FC<ErrorKPIsProps> = ({ summary, loading }) => {
  if (loading && !summary) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Skeleton />
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </div>
    );
  }

  if (!summary) return null;

  const channelEntries = Object.entries(summary.byChannel || {}).sort(
    (a, b) => b[1] - a[1]
  );

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      {/* Total open */}
      <div className="bg-app-surface border border-app-border rounded-md p-4">
        <div className="text-txt-muted text-xs font-medium uppercase tracking-wide mb-1">
          Offene Fehler
        </div>
        <div className="text-2xl font-bold text-txt-primary">
          {summary.total}
        </div>
      </div>

      {/* Critical */}
      <div className="bg-app-surface border border-app-border rounded-md p-4">
        <div className="text-txt-muted text-xs font-medium uppercase tracking-wide mb-1">
          Kritisch
        </div>
        <div className="text-2xl font-bold text-danger">
          {summary.bySeverity.critical}
        </div>
      </div>

      {/* Warning */}
      <div className="bg-app-surface border border-app-border rounded-md p-4">
        <div className="text-txt-muted text-xs font-medium uppercase tracking-wide mb-1">
          Warnungen
        </div>
        <div className="text-2xl font-bold text-warning">
          {summary.bySeverity.warning}
        </div>
      </div>

      {/* By channel */}
      <div className="bg-app-surface border border-app-border rounded-md p-4">
        <div className="text-txt-muted text-xs font-medium uppercase tracking-wide mb-1">
          Nach Kanal
        </div>
        <div className="flex flex-wrap gap-2 mt-1">
          {channelEntries.length === 0 && (
            <span className="text-sm text-txt-muted">-</span>
          )}
          {channelEntries.map(([ch, count]) => (
            <span
              key={ch}
              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-app-elevated text-txt-secondary"
            >
              <span className="capitalize">{ch}</span>
              <span className="font-semibold">{count}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};
