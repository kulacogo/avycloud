import React, { useMemo, useState } from "react";

/* ─── Types ─── */
type ReturnReason = "defekt" | "falsche_lieferung" | "nicht_wie_beschrieben" | "meinungsaenderung";
type ReturnStatus = "neu" | "in_pruefung" | "erstattet" | "abgeschlossen" | "abgelehnt";

interface ReturnItem {
  id: string;
  orderId: string;
  customer: string;
  product: string;
  thumbnail: string;
  reason: ReturnReason;
  receivedAt: string;
  status: ReturnStatus;
  refundAmount: number;
}

/* ─── Config ─── */
const REASON_LABELS: Record<ReturnReason, { label: string; cls: string }> = {
  defekt: { label: "Defekt", cls: "bg-danger-dim text-danger" },
  falsche_lieferung: { label: "Falsche Lieferung", cls: "bg-warning-dim text-warning" },
  nicht_wie_beschrieben: { label: "Nicht wie beschrieben", cls: "bg-warning-dim text-warning" },
  meinungsaenderung: { label: "Meinungsaenderung", cls: "bg-info-dim text-info" },
};

const STATUS_CONFIG: Record<ReturnStatus, { label: string; cls: string }> = {
  neu: { label: "Neu", cls: "bg-info-dim text-info" },
  in_pruefung: { label: "In Pruefung", cls: "bg-warning-dim text-warning" },
  erstattet: { label: "Erstattet", cls: "bg-success-dim text-success" },
  abgeschlossen: { label: "Abgeschlossen", cls: "bg-app-elevated text-txt-muted" },
  abgelehnt: { label: "Abgelehnt", cls: "bg-danger-dim text-danger" },
};

type TabKey = "alle" | ReturnStatus;

const TABS: { key: TabKey; label: string }[] = [
  { key: "alle", label: "Alle" },
  { key: "neu", label: "Neu eingegangen" },
  { key: "in_pruefung", label: "In Pruefung" },
  { key: "erstattet", label: "Erstattet" },
  { key: "abgeschlossen", label: "Abgeschlossen" },
  { key: "abgelehnt", label: "Abgelehnt" },
];

/* ─── Mock Data ─── */
const MOCK_RETURNS: ReturnItem[] = [
  {
    id: "RET-2026-0087",
    orderId: "ORD-2026-1204",
    customer: "Maximilian Huber",
    product: "Samsung Galaxy S24 Ultra 256GB",
    thumbnail: "https://placehold.co/40x40/1a1a2e/ffffff?text=S24",
    reason: "defekt",
    receivedAt: "2026-03-03",
    status: "neu",
    refundAmount: 1149.0,
  },
  {
    id: "RET-2026-0086",
    orderId: "ORD-2026-1198",
    customer: "Lena Schneider",
    product: "Apple AirPods Pro 2. Generation",
    thumbnail: "https://placehold.co/40x40/1a1a2e/ffffff?text=AP",
    reason: "falsche_lieferung",
    receivedAt: "2026-03-02",
    status: "in_pruefung",
    refundAmount: 279.0,
  },
  {
    id: "RET-2026-0085",
    orderId: "ORD-2026-1190",
    customer: "Thomas Wagner",
    product: "Dyson V15 Detect Absolute",
    thumbnail: "https://placehold.co/40x40/1a1a2e/ffffff?text=DY",
    reason: "nicht_wie_beschrieben",
    receivedAt: "2026-03-01",
    status: "erstattet",
    refundAmount: 649.0,
  },
  {
    id: "RET-2026-0084",
    orderId: "ORD-2026-1185",
    customer: "Julia Becker",
    product: "Sony WH-1000XM5 Kopfhoerer",
    thumbnail: "https://placehold.co/40x40/1a1a2e/ffffff?text=XM",
    reason: "meinungsaenderung",
    receivedAt: "2026-02-28",
    status: "abgeschlossen",
    refundAmount: 329.0,
  },
  {
    id: "RET-2026-0083",
    orderId: "ORD-2026-1170",
    customer: "Andreas Fischer",
    product: "Nintendo Switch OLED",
    thumbnail: "https://placehold.co/40x40/1a1a2e/ffffff?text=NS",
    reason: "defekt",
    receivedAt: "2026-02-27",
    status: "abgelehnt",
    refundAmount: 349.0,
  },
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

  // TODO: fetch returns from API — GET /api/orders/returns
  const returns = MOCK_RETURNS;

  const filtered = useMemo(() => {
    if (activeTab === "alle") return returns;
    return returns.filter((r) => r.status === activeTab);
  }, [returns, activeTab]);

  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = { alle: returns.length };
    for (const r of returns) {
      counts[r.status] = (counts[r.status] || 0) + 1;
    }
    return counts;
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

  const handleRefund = (_id: string) => {
    // TODO: POST /api/orders/returns/:id/refund
  };

  const handleReview = (_id: string) => {
    // TODO: PATCH /api/orders/returns/:id { status: 'in_pruefung' }
  };

  const handleBulkRefund = () => {
    // TODO: POST /api/orders/returns/bulk-refund { ids: [...selected] }
  };

  const handleBulkReject = () => {
    // TODO: POST /api/orders/returns/bulk-reject { ids: [...selected] }
  };

  const handleBulkMarkReviewed = () => {
    // TODO: POST /api/orders/returns/bulk-review { ids: [...selected] }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-txt-primary">Retouren</h1>
        <p className="text-sm text-txt-muted">Retouren verwalten, pruefen und erstatten</p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Offene Retouren" value={12} tone="text-info" />
        <KpiCard label="Retourenquote" value="4,2%" tone="text-warning" />
        <KpiCard label="Erstattungen diese Woche" value="847,00 EUR" tone="text-accent" />
        <KpiCard label="Oe Bearbeitungszeit" value="2,3 Tage" tone="text-txt-primary" />
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
          <span className="text-sm font-medium text-accent">{selected.size} ausgewaehlt</span>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={handleBulkRefund}
              className="rounded-lg bg-success-dim text-success px-3 py-1.5 text-xs font-semibold hover:opacity-80 transition"
            >
              Erstatten
            </button>
            <button
              type="button"
              onClick={handleBulkReject}
              className="rounded-lg bg-danger-dim text-danger px-3 py-1.5 text-xs font-semibold hover:opacity-80 transition"
            >
              Ablehnen
            </button>
            <button
              type="button"
              onClick={handleBulkMarkReviewed}
              className="rounded-lg bg-warning-dim text-warning px-3 py-1.5 text-xs font-semibold hover:opacity-80 transition"
            >
              Als geprueft markieren
            </button>
          </div>
        </div>
      )}

      {/* Table */}
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
                const reason = REASON_LABELS[ret.reason];
                const status = STATUS_CONFIG[ret.status];
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
                    <td className="px-4 py-3 text-txt-primary font-medium">{ret.customer}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <img
                          src={ret.thumbnail}
                          alt=""
                          className="w-8 h-8 rounded-lg object-cover bg-app-elevated flex-shrink-0"
                        />
                        <span className="text-txt-primary truncate max-w-[180px]">{ret.product}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${reason.cls}`}>
                        {reason.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-txt-muted whitespace-nowrap">
                      {new Date(ret.receivedAt).toLocaleDateString("de-DE")}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${status.cls}`}>
                        {status.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-txt-primary">
                      {ret.refundAmount.toLocaleString("de-DE", { minimumFractionDigits: 2 })} EUR
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleReview(ret.id)}
                          className="rounded-lg bg-app-elevated px-2.5 py-1.5 text-xs font-semibold text-txt-secondary hover:text-txt-primary transition"
                        >
                          Pruefen
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRefund(ret.id)}
                          className="rounded-lg bg-success-dim px-2.5 py-1.5 text-xs font-semibold text-success hover:opacity-80 transition"
                        >
                          Erstatten
                        </button>
                        <button
                          type="button"
                          className="rounded-lg bg-app-elevated p-1.5 text-txt-muted hover:text-txt-primary transition"
                          title="Details"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Footer */}
      <div className="text-xs text-txt-muted text-right">
        {filtered.length} / {returns.length} Retouren angezeigt
      </div>
    </div>
  );
};

export default ReturnsView;
