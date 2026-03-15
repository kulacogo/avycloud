import React, { useCallback, useEffect, useMemo, useState } from "react";
import { fetchShipments, bulkShipOrders, syncSendCloudParcels, type ShipmentData } from "../../api/client";
import { EmptyState } from "../ui/EmptyState";
import { useToast } from "../../context/ToastContext";

/* ─── Config ─── */
const CARRIER_STYLE: Record<string, { cls: string; initial: string }> = {
  DHL: { cls: "bg-yellow-100 text-yellow-800", initial: "D" },
  DPD: { cls: "bg-red-100 text-red-800", initial: "P" },
  GLS: { cls: "bg-blue-100 text-blue-800", initial: "G" },
};

const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  ausstehend: { label: "Ausstehend", cls: "bg-warning-dim text-warning" },
  in_zustellung: { label: "In Zustellung", cls: "bg-info-dim text-info" },
  zugestellt: { label: "Zugestellt", cls: "bg-success-dim text-success" },
  problem: { label: "Problem", cls: "bg-danger-dim text-danger" },
  storniert: { label: "Storniert", cls: "bg-app-elevated text-txt-muted" },
};

type TabKey = "alle" | "ausstehend" | "in_zustellung" | "zugestellt" | "problem";

const TABS: { key: TabKey; label: string }[] = [
  { key: "alle", label: "Alle" },
  { key: "ausstehend", label: "Ausstehend" },
  { key: "in_zustellung", label: "In Zustellung" },
  { key: "zugestellt", label: "Zugestellt" },
  { key: "problem", label: "Probleme" },
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

/* ─── Tracking URL builder ─── */
function trackingUrl(carrier: string, trackingNr: string): string {
  switch (carrier) {
    case "DHL":
      return `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${trackingNr}`;
    case "DPD":
      return `https://tracking.dpd.de/parcelstatus?query=${trackingNr}`;
    case "GLS":
      return `https://gls-group.com/DE/de/paketverfolgung?match=${trackingNr}`;
    default:
      return "#";
  }
}

/* ─── Main Component ─── */
export const ShippingView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabKey>("alle");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shipments, setShipments] = useState<ShipmentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [labelFormat, setLabelFormat] = useState<string>(() => localStorage.getItem("avycloud_label_format") || "a6");
  const toast = useToast();

  const loadShipments = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchShipments({ limit: 200 });
      // BUG-076: Deduplicate by sendcloudParcelId — keep latest (last) per ID
      const seen = new Map<string, ShipmentData>();
      for (const s of data) {
        const key = s.sendcloudParcelId ? String(s.sendcloudParcelId) : s.id;
        seen.set(key, s);
      }
      setShipments(Array.from(seen.values()));
    } catch (err: any) {
      console.error("[ShippingView] load failed:", err);
      setError(err?.message || "Sendungen konnten nicht geladen werden");
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-sync from SendCloud on mount, then poll every 60s
  useEffect(() => {
    let cancelled = false;
    const initialSync = async () => {
      try {
        setSyncBusy(true);
        await syncSendCloudParcels();
      } catch {
        // silent — background sync
      } finally {
        if (!cancelled) setSyncBusy(false);
      }
      if (!cancelled) loadShipments();
    };
    initialSync();

    const interval = setInterval(() => {
      if (!cancelled) loadShipments();
    }, 60_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [loadShipments]);

  const filtered = useMemo(() => {
    if (activeTab === "alle") return shipments;
    return shipments.filter((s) => s.status === activeTab);
  }, [shipments, activeTab]);

  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = { alle: shipments.length };
    for (const s of shipments) {
      if (s.status) counts[s.status] = (counts[s.status] || 0) + 1;
    }
    return counts;
  }, [shipments]);

  /* KPI computations from real data */
  const kpis = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const shippedToday = shipments.filter((s) => s.shippedAt?.startsWith(today)).length;
    const inTransit = shipments.filter((s) => s.status === "in_zustellung").length;
    const delivered = shipments.filter((s) => s.status === "zugestellt").length;
    const total = shipments.length;
    const deliveryRate = total > 0 ? ((delivered / total) * 100).toFixed(1) : "—";
    const totalCost = shipments.reduce((sum, s) => sum + (s.cost || 0), 0);
    const avgCost = total > 0 ? (totalCost / total).toFixed(2) : "—";
    return { shippedToday, inTransit, deliveryRate, avgCost };
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

  /* ─── Loading / Error ─── */
  if (loading) {
    return (
      <div className="max-w-7xl mx-auto space-y-5">
        <div>
          <h1 className="text-2xl font-bold text-txt-primary">Versand & Labels</h1>
          <p className="text-sm text-txt-muted">Sendungen verfolgen und Versandlabels verwalten</p>
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
          <h1 className="text-2xl font-bold text-txt-primary">Versand & Labels</h1>
          <p className="text-sm text-txt-muted">Sendungen verfolgen und Versandlabels verwalten</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={syncBusy}
            onClick={async () => {
              setSyncBusy(true);
              try {
                const r = await syncSendCloudParcels();
                toast.success(`SendCloud Sync: ${r.matched} zugeordnet, ${r.unmatched} offen, ${r.skipped} übersprungen`);
                loadShipments();
              } catch (err: any) {
                toast.error(err?.message || "SendCloud-Sync fehlgeschlagen");
              } finally {
                setSyncBusy(false);
              }
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-accent text-white px-4 py-2.5 text-sm font-semibold hover:opacity-90 transition disabled:opacity-50"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
            </svg>
            {syncBusy ? "Synchronisiere…" : "SendCloud Sync"}
          </button>
          <button
            type="button"
            onClick={loadShipments}
            className="inline-flex items-center gap-2 rounded-lg bg-app-elevated text-txt-secondary px-4 py-2.5 text-sm font-semibold hover:text-txt-primary transition"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
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
        <KpiCard label="Heute versendet" value={kpis.shippedToday} tone="text-success" />
        <KpiCard label="In Zustellung" value={kpis.inTransit} tone="text-info" />
        <KpiCard label="Zustellquote" value={kpis.deliveryRate === "—" ? "—" : `${kpis.deliveryRate}%`} tone="text-accent" />
        <KpiCard label="Ø Versandkosten" value={kpis.avgCost === "—" ? "—" : `${kpis.avgCost} EUR`} tone="text-txt-primary" />
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
            <select
              value={labelFormat}
              onChange={(e) => {
                setLabelFormat(e.target.value);
                localStorage.setItem("avycloud_label_format", e.target.value);
              }}
              className="rounded-lg border border-app-border bg-app-surface text-txt-primary text-xs px-2 py-1.5 font-medium"
              title="Label-Format"
            >
              <option value="a6">A6 / Thermal</option>
              <option value="a4">A4</option>
            </select>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={async () => {
                const pending = filtered.filter((s) => selected.has(s.id) && s.status === "ausstehend");
                const orderIds = pending.map((s) => s.orderId).filter(Boolean);
                if (orderIds.length === 0) {
                  toast.warning("Keine ausstehenden Sendungen in der Auswahl.");
                  return;
                }
                setBulkBusy(true);
                try {
                  const result = await bulkShipOrders(orderIds, { labelFormat });
                  toast.success(`${result.success}/${result.total} Labels erstellt`);
                  setSelected(new Set());
                  loadShipments();
                } catch (err: any) {
                  toast.error(err?.message || "Bulk-Versand fehlgeschlagen");
                } finally {
                  setBulkBusy(false);
                }
              }}
              className="rounded-lg bg-accent text-white px-3 py-1.5 text-xs font-semibold hover:bg-accent/90 transition disabled:opacity-50"
            >
              {bulkBusy ? "Erstelle Labels…" : "Labels erstellen"}
            </button>
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
      {!loading && shipments.length === 0 && !error && (
        <div className="rounded-xl border border-app-border bg-app-surface">
          <EmptyState
            icon={<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-txt-muted"><rect x="1" y="3" width="15" height="13" /><polygon points="16 8 20 8 23 11 23 16 16 16 16 8" /><circle cx="5.5" cy="18.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" /></svg>}
            title="Keine Sendungen vorhanden"
            description="Versandlabels können über die Auftragsansicht erstellt werden. Sendungen erscheinen hier nach der Erstellung."
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
                  const carrierKey = (shp.carrier || "").toUpperCase().replace("_DE", "");
                  const carrier = CARRIER_STYLE[carrierKey] || { cls: "bg-app-elevated text-txt-muted", initial: carrierKey.charAt(0) || "?" };
                  const status = STATUS_CONFIG[shp.status || ""] || { label: shp.status || "—", cls: "bg-app-elevated text-txt-muted" };
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
                      <td className="px-4 py-3 font-mono text-xs text-txt-primary font-medium">{shp.orderNumber || shp.orderId}</td>
                      <td className="px-4 py-3 text-txt-primary font-medium">{typeof shp.customer === "string" ? shp.customer : shp.customer?.name || "—"}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-semibold ${carrier.cls}`}>
                          <span className="w-4 h-4 rounded-full bg-current/10 flex items-center justify-center text-[9px] font-bold">
                            {carrier.initial}
                          </span>
                          {carrierKey || "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {shp.trackingNumber ? (
                          <a
                            href={trackingUrl(shp.carrier || "", shp.trackingNumber)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-xs text-accent hover:underline"
                          >
                            {shp.trackingNumber}
                          </a>
                        ) : (
                          <span className="text-xs text-txt-muted">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${status.cls}`}>
                          {status.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-txt-muted whitespace-nowrap">
                        {(() => { const d = shp.shippedAt ? new Date(shp.shippedAt) : null; return d && !isNaN(d.getTime()) ? d.toLocaleDateString("de-DE") : "—"; })()}
                      </td>
                      <td className="px-4 py-3 text-xs text-txt-muted whitespace-nowrap">
                        {(() => { const d = shp.deliveredAt ? new Date(shp.deliveredAt) : null; return d && !isNaN(d.getTime()) ? d.toLocaleDateString("de-DE") : "—"; })()}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-txt-primary">
                        {typeof shp.cost === "number" ? `${shp.cost.toLocaleString("de-DE", { minimumFractionDigits: 2 })} EUR` : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          {shp.trackingNumber && (
                            <a
                              href={trackingUrl(shp.carrier || "", shp.trackingNumber)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="rounded-lg bg-app-elevated p-1.5 text-txt-muted hover:text-txt-primary transition"
                              title="Tracking öffnen"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                              </svg>
                            </a>
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
        {filtered.length} / {shipments.length} Sendungen angezeigt
      </div>
    </div>
  );
};

export default ShippingView;
