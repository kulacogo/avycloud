import React from "react";
import type { BulkUpdateDiffEntry } from "../../api/client";

interface BulkDiffPreviewProps {
  diff: BulkUpdateDiffEntry[];
  maxRows?: number;
}

const FIELD_LABELS: Record<string, string> = {
  "identification.name": "Name",
  "identification.brand": "Marke",
  "identification.category": "Kategorie",
  "details.pricing.sellPrice": "Verkaufspreis",
  "details.pricing.buyPrice": "Einkaufspreis",
  "details.pricing.lowest_price.amount": "Preis",
  "details.attributes.condition": "Zustand",
  "ops.readiness": "Readiness",
};

function formatValue(value: any): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return value.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return String(value);
}

const StatusBadge: React.FC<{ status: string; reason?: string }> = ({ status, reason }) => {
  const styles: Record<string, string> = {
    ready: "bg-success-dim text-success",
    skipped: "bg-warning-dim text-warning",
    error: "bg-danger-dim text-danger",
  };
  const labels: Record<string, string> = {
    ready: "OK",
    skipped: "Übersprungen",
    error: "Fehler",
  };
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${styles[status] || "bg-app-elevated text-txt-muted"}`}
      title={reason || undefined}
    >
      {labels[status] || status}
    </span>
  );
};

const BulkDiffPreview: React.FC<BulkDiffPreviewProps> = ({ diff, maxRows = 50 }) => {
  const shown = diff.slice(0, maxRows);
  const remaining = diff.length - shown.length;
  const readyCount = diff.filter((d) => d.status === "ready").length;
  const skippedCount = diff.filter((d) => d.status === "skipped").length;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-sm">
        <span className="text-txt-secondary">
          <span className="font-semibold text-txt-primary">{readyCount}</span> Änderungen
        </span>
        {skippedCount > 0 && (
          <span className="text-txt-muted">
            {skippedCount} übersprungen
          </span>
        )}
      </div>

      <div className="max-h-[400px] overflow-auto rounded-lg border border-app-border">
        <table className="w-full text-sm">
          <thead className="bg-app-surface sticky top-0">
            <tr>
              <th className="p-2 text-left text-xs font-semibold text-txt-secondary">Produkt</th>
              <th className="p-2 text-left text-xs font-semibold text-txt-secondary">Feld</th>
              <th className="p-2 text-left text-xs font-semibold text-txt-secondary">Aktuell</th>
              <th className="p-2 text-left text-xs font-semibold text-txt-secondary">Neu</th>
              <th className="p-2 text-left text-xs font-semibold text-txt-secondary">Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((entry) => {
              if (entry.changes.length === 0) {
                return (
                  <tr key={entry.productId} className="border-t border-app-border/50">
                    <td className="p-2 text-txt-primary truncate max-w-[200px]">{entry.productName}</td>
                    <td className="p-2 text-txt-muted" colSpan={3}>Keine Änderung</td>
                    <td className="p-2"><StatusBadge status={entry.status} reason={entry.reason} /></td>
                  </tr>
                );
              }
              return entry.changes.map((change, i) => (
                <tr key={`${entry.productId}-${change.field}-${i}`} className="border-t border-app-border/50">
                  {i === 0 && (
                    <td className="p-2 text-txt-primary truncate max-w-[200px]" rowSpan={entry.changes.length}>
                      {entry.productName}
                    </td>
                  )}
                  <td className="p-2 text-txt-secondary text-xs">{FIELD_LABELS[change.field] || change.field}</td>
                  <td className="p-2 text-txt-muted line-through">{formatValue(change.oldValue)}</td>
                  <td className="p-2 text-accent font-semibold">{formatValue(change.newValue)}</td>
                  {i === 0 && (
                    <td className="p-2" rowSpan={entry.changes.length}>
                      <StatusBadge status={entry.status} reason={entry.reason} />
                    </td>
                  )}
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>

      {remaining > 0 && (
        <p className="text-xs text-txt-muted text-center">
          und {remaining} weitere...
        </p>
      )}
    </div>
  );
};

export default BulkDiffPreview;
