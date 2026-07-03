import React from "react";
import { adminGetPerformance, type PerformanceRow } from "../../api/client";

type Range = "today" | "week" | "month";

const RANGES: Array<{ id: Range; label: string }> = [
  { id: "today", label: "Heute" },
  { id: "week", label: "Woche" },
  { id: "month", label: "Monat" },
];

const COLUMNS: Array<{ key: keyof PerformanceRow; label: string }> = [
  { key: "erfasst", label: "Erfasst" },
  { key: "eingelagert", label: "Eingelagert" },
  { key: "kommissioniert", label: "Kommissioniert" },
  { key: "verpackt", label: "Verpackt" },
  { key: "angereichert", label: "Angereichert" },
];

export const MitarbeiterLeistung: React.FC = () => {
  const [range, setRange] = React.useState<Range>("week");
  const [rows, setRows] = React.useState<PerformanceRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async (r: Range) => {
    setError(null);
    setLoading(true);
    try {
      const data = await adminGetPerformance(r);
      setRows(data.rows || []);
    } catch (e: any) {
      setError(e?.message || "Leistung konnte nicht geladen werden");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load(range);
  }, [range, load]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Team-Leistung</h2>
          <p className="text-sm text-txt-muted">Wie viel jeder Mitarbeiter geschafft hat — erfasst, eingelagert, kommissioniert, verpackt, angereichert.</p>
        </div>
        <div className="flex items-center gap-1 rounded-xl bg-app-surface p-1">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setRange(r.id)}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
                range === r.id ? "bg-accent text-txt-primary" : "text-txt-secondary hover:bg-white/10"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-danger/20 bg-danger-dim px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <div className="rounded-2xl border border-app-border bg-app-surface p-5">
        {loading ? (
          <div className="text-sm text-txt-muted">Lade…</div>
        ) : rows.length === 0 ? (
          <div className="text-sm text-txt-muted">Für diesen Zeitraum noch keine erfassten Tätigkeiten.</div>
        ) : (
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="text-txt-muted">
                <tr>
                  <th className="text-left py-2 pr-4">Mitarbeiter</th>
                  {COLUMNS.map((c) => (
                    <th key={c.key} className="text-right py-2 px-3 whitespace-nowrap">{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.uid} className="border-t border-white/5">
                    <td className="py-2 pr-4 text-txt-primary font-medium">{row.name}</td>
                    {COLUMNS.map((c) => {
                      const v = Number(row[c.key] || 0);
                      return (
                        <td key={c.key} className={`py-2 px-3 text-right tabular-nums ${v > 0 ? "text-txt-primary" : "text-txt-muted"}`}>
                          {v}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-xs text-txt-muted">
        Hinweis: „Erfasst" und „Eingelagert" werden seit der Einführung dieser Ansicht gezählt — ältere Vorgänge tragen keinen Namen und erscheinen daher nicht rückwirkend. Automatische System-Vorgänge sind ausgeblendet.
      </p>
    </div>
  );
};
