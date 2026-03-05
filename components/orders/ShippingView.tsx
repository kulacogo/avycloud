import React, { useMemo, useState } from "react";

/* ─── Types ─── */
type ShipmentStatus = "ausstehend" | "in_zustellung" | "zugestellt" | "problem";
type Carrier = "DHL" | "DPD" | "GLS";

interface Shipment {
  id: string;
  orderId: string;
  customer: string;
  carrier: Carrier;
  trackingNumber: string;
  status: ShipmentStatus;
  shippedAt: string | null;
  deliveredAt: string | null;
  cost: number;
}

/* ─── Config ─── */
const CARRIER_STYLE: Record<Carrier, { cls: string; initial: string }> = {
  DHL: { cls: "bg-yellow-100 text-yellow-800", initial: "D" },
  DPD: { cls: "bg-red-100 text-red-800", initial: "P" },
  GLS: { cls: "bg-blue-100 text-blue-800", initial: "G" },
};

const STATUS_CONFIG: Record<ShipmentStatus, { label: string; cls: string }> = {
  ausstehend: { label: "Ausstehend", cls: "bg-warning-dim text-warning" },
  in_zustellung: { label: "In Zustellung", cls: "bg-info-dim text-info" },
  zugestellt: { label: "Zugestellt", cls: "bg-success-dim text-success" },
  problem: { label: "Problem", cls: "bg-danger-dim text-danger" },
};

type TabKey = "ausstehend" | "in_zustellung" | "zugestellt" | "problem";

const TABS: { key: TabKey | "alle"; label: string }[] = [
  { key: "ausstehend", label: "Ausstehend" },
  { key: "in_zustellung", label: "In Zustellung" },
  { key: "zugestellt", label: "Zugestellt" },
  { key: "problem", label: "Probleme" },
];

/* ─── Mock Data ─── */
const MOCK_SHIPMENTS: Shipment[] = [
  {
    id: "SHP-0041",
    orderId: "ORD-2026-1210",
    customer: "Markus Braun",
    carrier: "DHL",
    trackingNumber: "00340434161094042557",
    status: "in_zustellung",
    shippedAt: "2026-03-04",
    deliveredAt: null,
    cost: 4.99,
  },
  {
    id: "SHP-0040",
    orderId: "ORD-2026-1208",
    customer: "Sabine Keller",
    carrier: "DPD",
    trackingNumber: "01529014884329",
    status: "zugestellt",
    shippedAt: "2026-03-03",
    deliveredAt: "2026-03-04",
    cost: 5.49,
  },
  {
    id: "SHP-0039",
    orderId: "ORD-2026-1205",
    customer: "Florian Mayer",
    carrier: "DHL",
    trackingNumber: "00340434161094042564",
    status: "ausstehend",
    shippedAt: null,
    deliveredAt: null,
    cost: 4.99,
  },
  {
    id: "SHP-0038",
    orderId: "ORD-2026-1203",
    customer: "Katharina Wolf",
    carrier: "GLS",
    trackingNumber: "GLS82941723847",
    status: "in_zustellung",
    shippedAt: "2026-03-03",
    deliveredAt: null,
    cost: 4.49,
  },
  {
    id: "SHP-0037",
    orderId: "ORD-2026-1199",
    customer: "Stefan Richter",
    carrier: "DHL",
    trackingNumber: "00340434161094042571",
    status: "problem",
    shippedAt: "2026-03-02",
    deliveredAt: null,
    cost: 6.99,
  },
  {
    id: "SHP-0036",
    orderId: "ORD-2026-1195",
    customer: "Anna Schmitt",
    carrier: "DPD",
    trackingNumber: "01529014884336",
    status: "zugestellt",
    shippedAt: "2026-03-01",
    deliveredAt: "2026-03-03",
    cost: 3.99,
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
export const ShippingView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabKey | "alle">("ausstehend");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // TODO: fetch shipments from API — GET /api/orders/shipments
  const shipments = MOCK_SHIPMENTS;

  const filtered = useMemo(() => {
    if (activeTab === "alle") return shipments;
    return shipments.filter((s) => s.status === activeTab);
  }, [shipments, activeTab]);

  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of shipments) {
      counts[s.status] = (counts[s.status] || 0) + 1;
    }
    return counts;
  }, [shipments]);

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
      setSelected(new Set(filtered.map((s) => s.id)));
    }
  };

  const handlePrintLabel = (_id: string) => {
    // TODO: POST /api/orders/shipments/:id/label — open print window
  };

  const handleCreateLabel = () => {
    // TODO: open create-label modal / POST /api/orders/shipments/create-label
  };

  const handleBulkPrint = () => {
    // TODO: POST /api/orders/shipments/bulk-labels { ids: [...selected] }
  };

  const handleBulkChangeCarrier = () => {
    // TODO: open carrier-change modal for selected shipments
  };

  const trackingUrl = (carrier: Carrier, trackingNr: string): string => {
    // TODO: generate real tracking URLs per carrier
    switch (carrier) {
      case "DHL":
        return `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${trackingNr}`;
      case "DPD":
        return `https://tracking.dpd.de/parcelstatus?query=${trackingNr}`;
      case "GLS":
        return `https://gls-group.com/DE/de/paketverfolgung?match=${trackingNr}`;
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-txt-primary">Versand & Labels</h1>
          <p className="text-sm text-txt-muted">Sendungen verfolgen und Versandlabels verwalten</p>
        </div>
        <button
          type="button"
          onClick={handleCreateLabel}
          className="inline-flex items-center gap-2 rounded-lg bg-accent text-white px-4 py-2.5 text-sm font-semibold hover:bg-accent/80 transition"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Versandlabel erstellen
        </button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Heute versendet" value={18} tone="text-success" />
        <KpiCard label="In Zustellung" value={42} tone="text-info" />
        <KpiCard label="Zustellquote" value="96,8%" tone="text-accent" />
        <KpiCard label="Oe Versandkosten" value="4,85 EUR" tone="text-txt-primary" />
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
              onClick={handleBulkPrint}
              className="rounded-lg bg-accent text-white px-3 py-1.5 text-xs font-semibold hover:bg-accent/80 transition"
            >
              Labels drucken
            </button>
            <button
              type="button"
              onClick={handleBulkChangeCarrier}
              className="rounded-lg bg-app-elevated text-txt-secondary px-3 py-1.5 text-xs font-semibold hover:text-txt-primary transition"
            >
              Carrier aendern
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
                <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Auftrag-ID</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Kunde</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Carrier</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Tracking-Nr</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Status</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Versanddatum</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Zustelldatum</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Kosten</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((shp) => {
                const carrier = CARRIER_STYLE[shp.carrier];
                const status = STATUS_CONFIG[shp.status];
                return (
                  <tr
                    key={shp.id}
                    className="border-b border-app-border last:border-b-0 hover:bg-app-elevated/40 transition"
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(shp.id)}
                        onChange={() => toggleSelect(shp.id)}
                        className="rounded border-app-border"
                      />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-txt-primary font-medium">{shp.orderId}</td>
                    <td className="px-4 py-3 text-txt-primary font-medium">{shp.customer}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-semibold ${carrier.cls}`}>
                        <span className="w-4 h-4 rounded-full bg-current/10 flex items-center justify-center text-[9px] font-bold">
                          {carrier.initial}
                        </span>
                        {shp.carrier}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <a
                        href={trackingUrl(shp.carrier, shp.trackingNumber)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-xs text-accent hover:underline"
                      >
                        {shp.trackingNumber}
                      </a>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${status.cls}`}>
                        {status.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-txt-muted whitespace-nowrap">
                      {shp.shippedAt ? new Date(shp.shippedAt).toLocaleDateString("de-DE") : "\u2014"}
                    </td>
                    <td className="px-4 py-3 text-xs text-txt-muted whitespace-nowrap">
                      {shp.deliveredAt ? new Date(shp.deliveredAt).toLocaleDateString("de-DE") : "\u2014"}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-txt-primary">
                      {shp.cost.toLocaleString("de-DE", { minimumFractionDigits: 2 })} EUR
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => handlePrintLabel(shp.id)}
                          className="rounded-lg bg-app-elevated p-1.5 text-txt-muted hover:text-txt-primary transition"
                          title="Label drucken"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                          </svg>
                        </button>
                        <a
                          href={trackingUrl(shp.carrier, shp.trackingNumber)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded-lg bg-app-elevated p-1.5 text-txt-muted hover:text-txt-primary transition"
                          title="Tracking oeffnen"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </a>
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
        {filtered.length} / {shipments.length} Sendungen angezeigt
      </div>
    </div>
  );
};

export default ShippingView;
