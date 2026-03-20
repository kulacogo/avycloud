import React from "react";
import { EmptyState } from "../ui/EmptyState";

interface Change {
  productId: string;
  productName: string;
  field: string;
  oldValue: any;
  newValue: any;
}

interface Props {
  changes: Change[];
  matchCount?: number;
  mode?: "dry_run" | "execute";
}

export const RulePreview: React.FC<Props> = ({ changes, matchCount, mode = "dry_run" }) => {
  if (changes.length === 0) {
    return (
      <EmptyState
        title="Keine Änderungen"
        description="Die Regel hat keine Auswirkungen auf die aktuellen Produkte."
      />
    );
  }

  const uniqueProducts = new Set(changes.map((c) => c.productId)).size;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 text-sm">
        <span className="text-txt-muted">
          {matchCount ?? uniqueProducts} Produkte, {changes.length} Änderungen
        </span>
        {mode === "dry_run" && (
          <span className="inline-flex items-center rounded-md bg-warning-dim text-warning px-2 py-0.5 text-xs font-semibold">
            Vorschau
          </span>
        )}
      </div>

      <div className="rounded-xl border border-app-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-app-border bg-app-bg/50">
              <th className="text-left px-4 py-2 text-xs font-semibold text-txt-muted uppercase">Produkt</th>
              <th className="text-left px-4 py-2 text-xs font-semibold text-txt-muted uppercase">Feld</th>
              <th className="text-left px-4 py-2 text-xs font-semibold text-txt-muted uppercase">Alter Wert</th>
              <th className="text-left px-4 py-2 text-xs font-semibold text-txt-muted uppercase">Neuer Wert</th>
            </tr>
          </thead>
          <tbody>
            {changes.slice(0, 100).map((c, i) => (
              <tr key={i} className="border-b border-app-border last:border-0">
                <td className="px-4 py-2 text-txt-primary truncate max-w-[200px]">{c.productName}</td>
                <td className="px-4 py-2 text-txt-muted font-mono text-xs">{c.field}</td>
                <td className="px-4 py-2 text-danger line-through truncate max-w-[150px]">{String(c.oldValue ?? "—")}</td>
                <td className="px-4 py-2 text-success truncate max-w-[150px]">{String(c.newValue ?? "—")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
