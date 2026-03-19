import React from "react";
import { OperationalError } from "../../api/client";

interface ErrorRowProps {
  error: OperationalError;
  onResolve: (errorId: string) => void;
  resolving?: boolean;
}

const severityConfig: Record<string, { dot: string; label: string }> = {
  critical: { dot: "bg-danger", label: "Kritisch" },
  warning: { dot: "bg-warning", label: "Warnung" },
  info: { dot: "bg-info", label: "Info" },
};

const channelColors: Record<string, string> = {
  ebay: "bg-info-dim text-info",
  kaufland: "bg-warning-dim text-warning",
  sendcloud: "bg-accent-dim text-accent",
  internal: "bg-app-elevated text-txt-muted",
};

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "-";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "gerade eben";
  if (mins < 60) return `vor ${mins} Min.`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  const days = Math.floor(hours / 24);
  return `vor ${days} Tag${days > 1 ? "en" : ""}`;
}

export const ErrorRow: React.FC<ErrorRowProps> = ({ error, onResolve, resolving }) => {
  const sev = severityConfig[error.severity] || severityConfig.info;
  const chColor = channelColors[error.channel] || channelColors.internal;
  const isResolved = error.status === "resolved";

  const handleEntityClick = () => {
    if (!error.entityId) return;
    if (error.entityType === "product") {
      window.location.hash = `#/sheet/${error.entityId}`;
    } else if (error.entityType === "order") {
      window.location.hash = `#/orders?id=${error.entityId}`;
    }
  };

  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 border-b border-app-border transition-opacity ${
        isResolved ? "opacity-50" : ""
      }`}
    >
      {/* Severity dot */}
      <div className="pt-1.5 shrink-0">
        <div className={`w-2.5 h-2.5 rounded-full ${sev.dot}`} title={sev.label} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Channel badge */}
          <span className={`inline-flex text-[11px] font-medium px-2 py-0.5 rounded-full capitalize ${chColor}`}>
            {error.channel}
          </span>

          {/* Type */}
          <span className="text-[11px] text-txt-muted">
            {error.type?.replace(/_/g, " ")}
          </span>

          {/* Time */}
          <span className="text-[11px] text-txt-muted ml-auto shrink-0">
            {timeAgo(error.createdAt)}
          </span>
        </div>

        {/* Message */}
        <p className="text-sm text-txt-primary mt-1 break-words">
          {error.message}
        </p>

        {/* Fix suggestion */}
        {error.fixSuggestion && (
          <p className="text-xs text-info mt-1">
            {error.fixSuggestion}
          </p>
        )}

        {/* Entity link + source */}
        <div className="flex items-center gap-3 mt-1.5">
          {error.entityId && (
            <button
              type="button"
              onClick={handleEntityClick}
              className="text-xs text-accent hover:underline cursor-pointer"
            >
              {error.entityName || error.entityId}
            </button>
          )}
          <span className="text-[11px] text-txt-muted">
            Quelle: {error.source}
          </span>
        </div>
      </div>

      {/* Resolve button */}
      {!isResolved && (
        <button
          type="button"
          onClick={() => onResolve(error.id)}
          disabled={resolving}
          className="shrink-0 text-xs font-medium px-3 py-1.5 rounded-md bg-app-elevated text-txt-secondary hover:bg-success-dim hover:text-success transition-colors disabled:opacity-50"
        >
          Erledigt
        </button>
      )}

      {isResolved && (
        <span className="shrink-0 text-xs text-success px-3 py-1.5">
          Erledigt
        </span>
      )}
    </div>
  );
};
