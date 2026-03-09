import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchReturns,
  updateReturn,
  syncReturns,
  processReturn,
  issueReturnRefund,
  closeReturn,
  type ReturnData,
} from "../../api/client";
import { EmptyState } from "../ui/EmptyState";
import { useToast } from "../../context/ToastContext";

/* ─── Config ─── */
const REASON_LABELS: Record<string, { label: string; cls: string }> = {
  defekt: { label: "Defekt", cls: "bg-danger-dim text-danger" },
  falsche_lieferung: { label: "Falsche Lieferung", cls: "bg-warning-dim text-warning" },
  nicht_wie_beschrieben: { label: "Nicht wie beschrieben", cls: "bg-warning-dim text-warning" },
  zu_spaet: { label: "Zu spät", cls: "bg-warning-dim text-warning" },
  meinungsaenderung: { label: "Meinungsänderung", cls: "bg-info-dim text-info" },
  doppelbestellung: { label: "Doppelbestellung", cls: "bg-info-dim text-info" },
  sonstiges: { label: "Sonstiges", cls: "bg-app-elevated text-txt-muted" },
};

const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  eingegangen: { label: "Eingegangen", cls: "bg-info-dim text-info" },
  neu: { label: "Neu", cls: "bg-info-dim text-info" },
  in_pruefung: { label: "In Prüfung", cls: "bg-warning-dim text-warning" },
  erstattet: { label: "Erstattet", cls: "bg-success-dim text-success" },
  teilweise_erstattet: { label: "Teilerstattung", cls: "bg-success-dim text-success" },
  abgelehnt: { label: "Abgelehnt", cls: "bg-danger-dim text-danger" },
  abgeschlossen: { label: "Abgeschlossen", cls: "bg-app-elevated text-txt-muted" },
};

const MARKETPLACE_BADGE: Record<string, { label: string; cls: string }> = {
  ebay: { label: "eBay", cls: "bg-blue-100 text-blue-800" },
  kaufland: { label: "Kaufland", cls: "bg-red-100 text-red-800" },
};

type TabKey = "alle" | string;

const TABS: { key: TabKey; label: string }[] = [
  { key: "alle", label: "Alle" },
  { key: "eingegangen", label: "Eingegangen" },
  { key: "in_pruefung", label: "In Prüfung" },
  { key: "erstattet", label: "Erstattet" },
  { key: "abgelehnt", label: "Abgelehnt" },
  { key: "abgeschlossen", label: "Abgeschlossen" },
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

/* ─── Process Dialog ─── */
const ProcessDialog: React.FC<{
  ret: ReturnData;
  onClose: () => void;
  onDone: () => void;
}> = ({ ret, onClose, onDone }) => {
  const [condition, setCondition] = useState<string>("a_ware");
  const [refundType, setRefundType] = useState<string>("full");
  const [amount, setAmount] = useState<string>(String(ret.refundAmount || "0"));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const handleSubmit = async () => {
    setBusy(true);
    try {
      await processReturn(ret.id, {
        itemCondition: condition,
        refundType,
        refundAmount: parseFloat(amount) || 0,
        note,
      });
      toast.success("Retoure verarbeitet");
      onDone();
    } catch (err: any) {
      toast.error(err?.message || "Fehler bei Verarbeitung");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-app-surface rounded-xl border border-app-border shadow-xl w-full max-w-md p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-bold text-txt-primary">Retoure verarbeiten</h3>
        <p className="text-sm text-txt-muted">
          Warenprüfung und Erstattungsentscheidung für Retoure{" "}
          <span className="font-mono">{ret.id.slice(0, 8)}</span>
        </p>

        {/* Item condition */}
        <div>
          <label className="text-xs font-semibold text-txt-muted block mb-1.5">Warenzustand</label>
          <div className="flex gap-2">
            {[
              { key: "a_ware", label: "A-Ware", desc: "Neuwertig → Wiederverkauf" },
              { key: "b_ware", label: "B-Ware", desc: "Gebraucht → Reduziert" },
              { key: "c_ware", label: "C-Ware", desc: "Defekt → Entsorgung" },
            ].map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setCondition(opt.key)}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                  condition === opt.key
                    ? "bg-accent-dim text-accent border-accent/30 ring-1 ring-accent/20"
                    : "bg-app-bg text-txt-muted border-app-border hover:border-txt-muted"
                }`}
              >
                <div>{opt.label}</div>
                <div className="font-normal opacity-70 mt-0.5">{opt.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Refund decision */}
        <div>
          <label className="text-xs font-semibold text-txt-muted block mb-1.5">Erstattung</label>
          <div className="flex gap-2">
            {[
              { key: "full", label: "Voll" },
              { key: "partial", label: "Teilweise" },
              { key: "none", label: "Keine" },
            ].map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setRefundType(opt.key)}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                  refundType === opt.key
                    ? "bg-accent-dim text-accent border-accent/30 ring-1 ring-accent/20"
                    : "bg-app-bg text-txt-muted border-app-border hover:border-txt-muted"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Refund amount (editable for partial) */}
        {refundType !== "none" && (
          <div>
            <label className="text-xs font-semibold text-txt-muted block mb-1.5">Erstattungsbetrag (EUR)</label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={refundType === "full"}
              className="w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-txt-primary disabled:opacity-50"
            />
          </div>
        )}

        {/* Note */}
        <div>
          <label className="text-xs font-semibold text-txt-muted block mb-1.5">Notiz (optional)</label>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Bemerkung zur Warenprüfung…"
            className="w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-txt-primary"
          />
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-app-elevated px-4 py-2 text-sm font-semibold text-txt-secondary hover:text-txt-primary transition"
          >
            Abbrechen
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={handleSubmit}
            className="rounded-lg bg-accent text-white px-4 py-2 text-sm font-semibold hover:bg-accent/90 transition disabled:opacity-50"
          >
            {busy ? "Verarbeite…" : "Bestätigen"}
          </button>
        </div>
      </div>
    </div>
  );
};

/* ─── Helper: extract display name from customer field ─── */
function customerName(customer: ReturnData["customer"]): string {
  if (!customer) return "—";
  if (typeof customer === "string") return customer;
  return customer.name || "—";
}

function productName(product: ReturnData["product"]): string {
  if (!product) return "—";
  if (typeof product === "string") return product;
  return product.name || product.sku || "—";
}

/* ─── Main Component ─── */
export const ReturnsView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabKey>("alle");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [returns, setReturns] = useState<ReturnData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [processTarget, setProcessTarget] = useState<ReturnData | null>(null);
  const toast = useToast();

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

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await syncReturns();
      const total =
        (result?.ebay?.synced || 0) + (result?.kaufland?.synced || 0);
      toast.success(`${total} neue Retouren synchronisiert`);
      loadReturns();
    } catch (err: any) {
      toast.error(err?.message || "Sync fehlgeschlagen");
    } finally {
      setSyncing(false);
    }
  };

  const filtered = useMemo(() => {
    if (activeTab === "alle") return returns;
    // Map "neu" tab to both "neu" and "eingegangen"
    if (activeTab === "eingegangen") {
      return returns.filter((r) => r.status === "eingegangen" || r.status === "neu");
    }
    return returns.filter((r) => r.status === activeTab);
  }, [returns, activeTab]);

  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = { alle: returns.length };
    for (const r of returns) {
      const st = r.status === "neu" ? "eingegangen" : (r.status || "eingegangen");
      counts[st] = (counts[st] || 0) + 1;
    }
    return counts;
  }, [returns]);

  const kpis = useMemo(() => {
    const open = returns.filter(
      (r) => r.status === "neu" || r.status === "eingegangen" || r.status === "in_pruefung"
    ).length;
    const refunded = returns.filter(
      (r) => r.status === "erstattet" || r.status === "teilweise_erstattet"
    );
    const totalRefunded = refunded.reduce((sum, r) => sum + (r.refundAmount || 0), 0);
    const returnRate =
      returns.length > 0
        ? ((returns.filter((r) => r.status !== "abgelehnt").length / returns.length) * 100).toFixed(1)
        : "—";
    return {
      open,
      totalRefunded: totalRefunded.toLocaleString("de-DE", { minimumFractionDigits: 2 }),
      returnRate,
    };
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
      setReturns((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status: newStatus } : r))
      );
      toast.success("Status aktualisiert");
    } catch (err: any) {
      toast.error(err?.message || "Status konnte nicht geändert werden");
    }
  };

  const handleRefund = async (ret: ReturnData) => {
    try {
      await issueReturnRefund(ret.id);
      toast.success("Erstattung an Marktplatz übermittelt");
      loadReturns();
    } catch (err: any) {
      toast.error(err?.message || "Erstattung fehlgeschlagen");
    }
  };

  const handleClose = async (id: string) => {
    try {
      await closeReturn(id);
      setReturns((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status: "abgeschlossen" } : r))
      );
      toast.success("Retoure abgeschlossen");
    } catch (err: any) {
      toast.error(err?.message || "Abschließen fehlgeschlagen");
    }
  };

  /* ─── Loading ─── */
  if (loading) {
    return (
      <div className="max-w-7xl mx-auto space-y-5">
        <div>
          <h1 className="text-2xl font-bold text-txt-primary">Retouren</h1>
          <p className="text-sm text-txt-muted">
            Retouren verwalten, prüfen und erstatten
          </p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="rounded-xl border border-app-border bg-app-surface p-4 h-20 animate-pulse"
            />
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
          <p className="text-sm text-txt-muted">
            Retouren verwalten, prüfen und erstatten
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={syncing}
            onClick={handleSync}
            className="inline-flex items-center gap-2 rounded-lg bg-accent text-white px-4 py-2.5 text-sm font-semibold hover:bg-accent/90 transition disabled:opacity-50"
          >
            <svg
              className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            {syncing ? "Synchronisiere…" : "Marktplatz-Sync"}
          </button>
          <button
            type="button"
            onClick={loadReturns}
            className="inline-flex items-center gap-2 rounded-lg bg-app-elevated text-txt-secondary px-4 py-2.5 text-sm font-semibold hover:text-txt-primary transition"
          >
            Aktualisieren
          </button>
        </div>
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
        <KpiCard label="Gesamt" value={returns.length} tone="text-warning" />
        <KpiCard
          label="Erstattungen"
          value={`${kpis.totalRefunded} EUR`}
          tone="text-accent"
        />
        <KpiCard
          label="Erstattungsquote"
          value={kpis.returnRate === "—" ? "—" : `${kpis.returnRate}%`}
          tone="text-txt-primary"
        />
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
              <span className={`text-[10px] ${active ? "opacity-80" : "opacity-50"}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Bulk Actions */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-accent/20 bg-accent-dim px-4 py-2.5">
          <span className="text-sm font-medium text-accent">
            {selected.size} ausgewählt
          </span>
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
            icon={
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-txt-muted"
              >
                <path d="M9 14l-4 4m0 0l4 4m-4-4h11a4 4 0 000-8h-1" />
              </svg>
            }
            title="Keine Retouren vorhanden"
            description='Retouren werden über "Marktplatz-Sync" automatisch aus eBay und Kaufland importiert.'
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
                      checked={
                        selected.size === filtered.length && filtered.length > 0
                      }
                      onChange={toggleAll}
                      className="rounded border-app-border"
                    />
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">
                    Retoure
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">
                    Marktplatz
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">
                    Kunde
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">
                    Produkt
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">
                    Grund
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">
                    Eingang
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">
                    Status
                  </th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">
                    Betrag
                  </th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">
                    Aktionen
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((ret) => {
                  const reason =
                    REASON_LABELS[ret.reason || ""] || {
                      label: ret.reason || "—",
                      cls: "bg-app-elevated text-txt-muted",
                    };
                  const st = ret.status === "neu" ? "eingegangen" : (ret.status || "eingegangen");
                  const status =
                    STATUS_CONFIG[st] || {
                      label: st,
                      cls: "bg-app-elevated text-txt-muted",
                    };
                  const mp = MARKETPLACE_BADGE[(ret.marketplace || "").toLowerCase()];
                  const isOpen = st === "eingegangen" || st === "in_pruefung";
                  const isRefunded = st === "erstattet" || st === "teilweise_erstattet";

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
                      <td className="px-4 py-3 font-mono text-xs text-txt-primary font-medium">
                        {ret.id.slice(0, 8)}…
                      </td>
                      <td className="px-4 py-3">
                        {mp ? (
                          <span
                            className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${mp.cls}`}
                          >
                            {mp.label}
                          </span>
                        ) : (
                          <span className="text-xs text-txt-muted">Manuell</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-txt-primary font-medium">
                        {customerName(ret.customer)}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-txt-primary truncate max-w-[180px] inline-block">
                          {productName(ret.product)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${reason.cls}`}
                        >
                          {reason.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-txt-muted whitespace-nowrap">
                        {ret.createdAt
                          ? new Date(ret.createdAt).toLocaleDateString("de-DE")
                          : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${status.cls}`}
                        >
                          {status.label}
                        </span>
                        {ret.itemCondition && (
                          <span className="ml-1 inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-medium bg-app-elevated text-txt-muted">
                            {ret.itemCondition === "a_ware"
                              ? "A"
                              : ret.itemCondition === "b_ware"
                                ? "B"
                                : "C"}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-txt-primary">
                        {typeof ret.refundAmount === "number"
                          ? `${ret.refundAmount.toLocaleString("de-DE", {
                              minimumFractionDigits: 2,
                            })} EUR`
                          : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          {st === "eingegangen" && (
                            <button
                              type="button"
                              onClick={() => handleStatusChange(ret.id, "in_pruefung")}
                              className="rounded-lg bg-app-elevated px-2.5 py-1.5 text-xs font-semibold text-txt-secondary hover:text-txt-primary transition"
                            >
                              Prüfen
                            </button>
                          )}
                          {isOpen && (
                            <button
                              type="button"
                              onClick={() => setProcessTarget(ret)}
                              className="rounded-lg bg-accent-dim px-2.5 py-1.5 text-xs font-semibold text-accent hover:opacity-80 transition"
                            >
                              Verarbeiten
                            </button>
                          )}
                          {isRefunded && ret.marketplace && !ret.marketplaceRefundStatus && (
                            <button
                              type="button"
                              onClick={() => handleRefund(ret)}
                              className="rounded-lg bg-success-dim px-2.5 py-1.5 text-xs font-semibold text-success hover:opacity-80 transition"
                            >
                              Erstatten
                            </button>
                          )}
                          {(isRefunded || st === "abgelehnt") && (
                            <button
                              type="button"
                              onClick={() => handleClose(ret.id)}
                              className="rounded-lg bg-app-elevated px-2.5 py-1.5 text-xs font-semibold text-txt-muted hover:text-txt-primary transition"
                            >
                              Schließen
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

      {/* Process Dialog */}
      {processTarget && (
        <ProcessDialog
          ret={processTarget}
          onClose={() => setProcessTarget(null)}
          onDone={() => {
            setProcessTarget(null);
            loadReturns();
          }}
        />
      )}
    </div>
  );
};

export default ReturnsView;
