import React, { useCallback, useEffect, useMemo, useState } from "react";
import { fetchReturns, updateReturn, type ReturnData } from "../../api/client";
import { EmptyState } from "../ui/EmptyState";

/* ─── Config ─── */
const REASON_LABELS: Record<string, { label: string; cls: string }> = {
  defekt: { label: "Defekt", cls: "bg-danger-dim text-danger" },
  falsche_lieferung: { label: "Falsche Lieferung", cls: "bg-warning-dim text-warning" },
  nicht_wie_beschrieben: { label: "Nicht wie beschrieben", cls: "bg-warning-dim text-warning" },
  meinungsaenderung: { label: "Meinungsänderung", cls: "bg-info-dim text-info" },
};

const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  neu: { label: "Neu", cls: "bg-info-dim text-info" },
  in_pruefung: { label: "In Prüfung", cls: "bg-warning-dim text-warning" },
  erstattet: { label: "Erstattet", cls: "bg-success-dim text-success" },
  abgeschlossen: { label: "Abgeschlossen", cls: "bg-app-elevated text-txt-muted" },
  abgelehnt: { label: "Abgelehnt", cls: "bg-danger-dim text-danger" },
};

type TabKey = "alle" | string;

const TABS: { key: TabKey; label: string }[] = [
  { key: "alle", label: "Alle" },
  { key: "neu", label: "Neu eingegangen" },
  { key: "in_pruefung", label: "In Prüfung" },
  { key: "erstattet", label: "Erstattet" },
  { key: "abgeschlossen", label: "Abgeschlossen" },
  { key: "abgelehnt", label: "Abgelehnt" },
];

/* ─── KPI Card ─── */
const KpiCard: React.FC<{ label: string; value: string | number; tone?: string }> = ({
  label,
  value,
  tone = "text-txt-primary",
}) => (
  <div className="rounded-xl border border-app-border bg-app-surface p-4 flex flex-col gap-1">
    <span className="text-xs font-medium text-txt-muted uppercase tracking-wider">{label}</span>
    <span className={`text-2xl font-bold ${tone}`}>{value}</span>
  </div>
);

/* ─── Main Component ─── */
export const ReturnsView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabKey>("alle");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [returns, setReturns] = useState<ReturnData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadReturns = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchReturns({ limit: 200 });
      setReturns(data);
    } catch (err: any) {
      console.error("[ReturnsView] load failed:", err);
      setError(err?.message || "Retouren konnten nicht geladen werden");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadReturns();
  }, [loadReturns]);

  const filtered = useMemo(() => {
    if (activeTab === "alle") return returns;
    return returns.filter((r) => r.status === activeTab);
  }, [returns, activeTab]);

  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = { alle: returns.length };
    for (const r of returns) {
      if (r.status) counts[r.status] = (counts[r.status] || 0) + 1;
    }
    return counts;
  }, [returns]);

  /* KPIs from real data */
  const kpis = useMemo(() => {
    const open = returns.filter((r) => r.status === "neu" || r.status === "in_pruefung").length;
    const refunded = returns.filter((r) => r.status === "erstattet");
    const totalRefunded = refunded.reduce((sum, r) => sum + (r.refundAmount || 0), 0);
    return { open, totalRefunded: totalRefunded.toLocaleString("de-DE", { minimumFractionDigits: 2 }) };
  }, [returns]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((r) => r.id)));
    }
  };

  const handleStatusChange = async (id: string, newStatus: string) => {
    try {
      await updateReturn(id, { status: newStatus });
      setReturns((prev) => prev.map((r) => (r.id === id ? { ...r, status: newStatus } : r)));
    } catch (err: any) {
      console.error("[ReturnsView] status update failed:", err);
      setError(err?.message || "Status konnte nicht geändert werden");
    }
  };

  /* ─── Loading ─── */
  if (loading) {
    return (
      <div className="max-w-7xl mx-auto space-y-5">
        <div>
          <h1 className="text-2xl font-bold text-txt-primary">Retouren</h1>
          <p className="text-sm text-txt-muted">Retouren verwalten, prüfen und erstatten</p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-xl border border-app-border bg-app-surface p-4 h-20 animate-pulse" />
          ))}
        </div>
        <div className="rounded-xl border border-app-border bg-app-surface h-64 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-txt-primary">Retouren</h1>
          <p className="text-sm text-txt-muted">Retouren verwalten, prüfen und erstatten</p>
        </div>
        <button
          type="button"
          onClick={loadReturns}
          className="inline-flex items-center gap-2 rounded-lg bg-app-elevated text-txt-secondary px-4 py-2.5 text-sm font-semibold hover:text-txt-primary transition"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Aktualisieren
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-danger/20 bg-danger-dim px-4 py-3 text-sm text-danger">
          {error.includes("FAILED_PRECONDITION") || error.includes("index")
            ? "Datenbank-Index wird erstellt. Bitte versuche es in wenigen Minuten erneut."
            : error}
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Offene Retouren" value={kpis.open} tone="text-info" />
        <KpiCard label="Gesamt Retouren" value={returns.length} tone="text-warning" />
        <KpiCard label="Erstattungen gesamt" value={`${kpis.totalRefunded} EUR`} tone="text-accent" />
        <KpiCard label="Abgelehnt" value={returns.filter((r) => r.status === "abgelehnt").length} tone="text-danger" />
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2">
        {TABS.map((tab) => {
          const count = tabCounts[tab.key] || 0;
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition border ${
                active
                  ? "bg-accent-dim text-accent border-accent/20 ring-1 ring-accent/20"
                  : "bg-app-surface text-txt-muted border-app-border hover:border-txt-muted"
              }`}
            >
              {tab.label}
              <span className={`text-[10px] ${active ? "opacity-80" : "opacity-50"}`}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* Bulk Actions */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-accent/20 bg-accent-dim px-4 py-2.5">
          <span className="text-sm font-medium text-accent">{selected.size} ausgewählt</span>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="rounded-lg bg-app-elevated text-txt-secondary px-3 py-1.5 text-xs font-semibold hover:text-txt-primary transition"
            >
              Auswahl aufheben
            </button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && returns.length === 0 && !error && (
        <div className="rounded-xl border border-app-border bg-app-surface">
          <EmptyState
            icon={<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-txt-muted"><path d="M9 14l-4 4m0 0l4 4m-4-4h11a4 4 0 000-8h-1" /></svg>}
            title="Keine Retouren vorhanden"
            description="Retouren werden automatisch aus den Marktplätzen synchronisiert oder können manuell angelegt werden."
          />
        </div>
      )}

      {/* Table */}
      {filtered.length > 0 && (
        <div className="rounded-xl border border-app-border bg-app-surface overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-app-border bg-app-bg/50">
                  <th className="px-4 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={selected.size === filtered.length && filtered.length > 0}
                      onChange={toggleAll}
                      className="rounded border-app-border"
                    />
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Retoure-ID</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Auftrag-Ref</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Kunde</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Produkt</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Grund</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Eingang</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Status</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Erstattung</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Aktionen</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((ret) => {
                  const reason = REASON_LABELS[ret.reason || ""] || { label: ret.reason || "—", cls: "bg-app-elevated text-txt-muted" };
                  const status = STATUS_CONFIG[ret.status || ""] || { label: ret.status || "—", cls: "bg-app-elevated text-txt-muted" };
                  return (
                    <tr
                      key={ret.id}
                      className="border-b border-app-border last:border-b-0 hover:bg-app-elevated/40 transition"
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selected.has(ret.id)}
                          onChange={() => toggleSelect(ret.id)}
                          className="rounded border-app-border"
                        />
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-txt-primary font-medium">{ret.id}</td>
                      <td className="px-4 py-3 font-mono text-xs text-txt-secondary">{ret.orderId}</td>
                      <td className="px-4 py-3 text-txt-primary font-medium">{ret.customer || "—"}</td>
                      <td className="px-4 py-3">
                        <span className="text-txt-primary truncate max-w-[180px] inline-block">{ret.product || "—"}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${reason.cls}`}>
                          {reason.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-txt-muted whitespace-nowrap">
                        {ret.createdAt ? new Date(ret.createdAt).toLocaleDateString("de-DE") : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${status.cls}`}>
                          {status.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-txt-primary">
                        {typeof ret.refundAmount === "number"
                          ? `${ret.refundAmount.toLocaleString("de-DE", { minimumFractionDigits: 2 })} EUR`
                          : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          {(ret.status === "neu") && (
                            <button
                              type="button"
                              onClick={() => handleStatusChange(ret.id, "in_pruefung")}
                              className="rounded-lg bg-app-elevated px-2.5 py-1.5 text-xs font-semibold text-txt-secondary hover:text-txt-primary transition"
                            >
                              Prüfen
                            </button>
                          )}
                          {(ret.status === "neu" || ret.status === "in_pruefung") && (
                            <button
                              type="button"
                              onClick={() => handleStatusChange(ret.id, "erstattet")}
                              className="rounded-lg bg-success-dim px-2.5 py-1.5 text-xs font-semibold text-success hover:opacity-80 transition"
                            >
                              Erstatten
                            </button>
                          )}
                          {(ret.status === "neu" || ret.status === "in_pruefung") && (
                            <button
                              type="button"
                              onClick={() => handleStatusChange(ret.id, "abgelehnt")}
                              className="rounded-lg bg-danger-dim px-2.5 py-1.5 text-xs font-semibold text-danger hover:opacity-80 transition"
                            >
                              Ablehnen
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="text-xs text-txt-muted text-right">
        {filtered.length} / {returns.length} Retouren angezeigt
      </div>
    </div>
  );
};

export default ReturnsView;
