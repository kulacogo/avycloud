import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import {
  fetchOrders as fetchOrdersApi,
  syncOrders,
  syncMarketplaceOrders,
  buildImageProxyUrl,
  bulkTransitionOrders,
  printAddressLabels,
} from "../api/client";
import { Order, OrderStatus, getOrderStatus } from "../types";
import { EmptyState } from "./ui/EmptyState";
import { exportToCsv } from "../utils/csv-export";
import { SyncIcon } from "./icons/Icons";
import { OrderDetail } from "./OrderDetail";

/* ─── Status filter config ─── */
type StatusFilter = "all" | OrderStatus;

const STATUS_FILTERS: { key: StatusFilter; labelKey: string; tone: string }[] = [
  { key: "all", labelKey: "orders.filter.all", tone: "bg-app-elevated text-txt-primary" },
  { key: "new", labelKey: "orders.filter.new", tone: "bg-info-dim text-info" },
  { key: "picking", labelKey: "orders.filter.picking", tone: "bg-warning-dim text-warning" },
  { key: "picked", labelKey: "orders.filter.picked", tone: "bg-accent-dim text-accent" },
  { key: "packed", labelKey: "orders.filter.packed", tone: "bg-success-dim text-success" },
  { key: "shipped", labelKey: "orders.filter.shipped", tone: "bg-success-dim text-success" },
  { key: "other", labelKey: "orders.filter.other", tone: "bg-app-elevated text-txt-secondary" },
];

/* ─── OMS Status Labels ─── */
const OMS_STATUS_LABELS: Record<string, string> = {
  pending: "Neu", confirmed: "Bestätigt", picking: "Kommissionierung",
  picked: "Kommissioniert", packing: "Verpackung", packed: "Verpackt",
  shipped: "Versendet", delivered: "Zugestellt", cancelled: "Storniert",
  returned: "Retoure", on_hold: "Pausiert", refunded: "Erstattet",
};

/* ─── Status badge styling ─── */
const statusBadge = (status: string) => {
  switch (status) {
    case "new":
    case "pending":
    case "confirmed":
      return "bg-info-dim text-info border-info/20";
    case "picking":
    case "packing":
      return "bg-warning-dim text-warning border-warning/20";
    case "picked":
    case "packed":
      return "bg-accent-dim text-accent border-accent/20";
    case "shipped":
    case "delivered":
      return "bg-success-dim text-success border-success/20";
    case "cancelled":
    case "returned":
    case "refunded":
      return "bg-danger-dim text-danger border-danger/20";
    case "on_hold":
      return "bg-warning-dim text-warning border-warning/20";
    default:
      return "bg-app-elevated text-txt-secondary border-app-border";
  }
};

/* ─── Source badge ─── */
const sourceBadge = (source?: string | null) => {
  if (!source) return null;
  const s = source.toLowerCase();
  if (s.includes("ebay")) return { label: "eBay", cls: "bg-warning-dim text-warning border-warning/20" };
  if (s.includes("kaufland")) return { label: "Kaufland", cls: "bg-danger-dim text-danger border-danger/20" };
  if (s.includes("amazon")) return { label: "Amazon", cls: "bg-info-dim text-info border-info/20" };
  if (s === "otto") return { label: "Otto", cls: "bg-app-elevated text-txt-secondary border-app-border" };
  if (s === "shopify") return { label: "Shopify", cls: "bg-success-dim text-success border-success/20" };
  // Unknown source — don't render a badge (backend should have resolved this)
  return null;
};

/* ─── KPI Card ─── */
const KpiCard: React.FC<{
  label: string;
  value: string | number;
  sub?: string;
  tone?: string;
}> = ({ label, value, sub, tone = "text-txt-primary" }) => (
  <div className="rounded-2xl border border-app-border bg-app-surface p-4 flex flex-col gap-1">
    <span className="text-xs font-medium text-txt-muted uppercase tracking-wider">{label}</span>
    <span className={`text-2xl font-bold ${tone}`}>{value}</span>
    {sub && <span className="text-xs text-txt-muted">{sub}</span>}
  </div>
);

/* ─── OMS Pipeline Stages ─── */
const PIPELINE_STAGES: { key: string; label: string; color: string; dotColor: string }[] = [
  { key: "pending",   label: "Neu",           color: "bg-info-dim text-info",    dotColor: "bg-info" },
  { key: "confirmed", label: "Bestätigt",     color: "bg-info-dim text-info",    dotColor: "bg-info" },
  { key: "picking",   label: "Kommission.",   color: "bg-warning-dim text-warning", dotColor: "bg-warning" },
  { key: "picked",    label: "Kommissioniert", color: "bg-accent-dim text-accent", dotColor: "bg-accent" },
  { key: "packing",   label: "Verpackung",    color: "bg-warning-dim text-warning", dotColor: "bg-warning" },
  { key: "packed",    label: "Verpackt",      color: "bg-success-dim text-success", dotColor: "bg-success" },
  { key: "shipped",   label: "Versendet",     color: "bg-success-dim text-success", dotColor: "bg-success" },
];

/* ─── Main Component ─── */
const OrdersView: React.FC = () => {
  const { t } = useI18n();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncingMp, setSyncingMp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [sortField, setSortField] = useState<"createdAt" | "totalAmount" | "status">("createdAt");
  const [sortAsc, setSortAsc] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  // BUG-071: Pipeline counts computed from local orders to match tab counts
  // Previously fetched from separate backend endpoint which had different filtering.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const [rowsPerPage, setRowsPerPage] = useState(50);
  const [currentPage, setCurrentPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState("");
  const [datePreset, setDatePreset] = useState<"all" | "today" | "7d" | "30d" | "90d">("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [marketplaceFilter, setMarketplaceFilter] = useState<"all" | "ebay" | "kaufland">("all");
  const [carrierFilter, setCarrierFilter] = useState<"all" | "dhl" | "dpd" | "other">("all");
  const [backfillDays, setBackfillDays] = useState(140);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);

  /* ─── Fetch ─── */
  const loadOrders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchOrdersApi(500);
      setOrders(data);
    } catch (err: any) {
      setError(err?.message || "Failed to load orders");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const data = await syncOrders();
      setOrders(data);
    } catch (err: any) {
      setError(err?.message || "Sync failed");
    } finally {
      setSyncing(false);
    }
  }, []);

  const handleMarketplaceSync = useCallback(async () => {
    setSyncingMp(true);
    setError(null);
    try {
      await syncMarketplaceOrders();
      await loadOrders();
    } catch (err: any) {
      setError(err?.message || "Marketplace sync failed");
    } finally {
      setSyncingMp(false);
    }
  }, [loadOrders]);

  /* ─── Pipeline counts (BUG-071: computed from same orders array as tabs) ─── */
  const omsCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const stage of PIPELINE_STAGES) counts[stage.key] = 0;
    for (const o of orders) {
      const s = getOrderStatus(o);
      if (s in counts) counts[s]++;
      // "confirmed" in OMS maps to "pending"+"confirmed" — also count "new"
      else if (s === 'new') counts['pending'] = (counts['pending'] || 0) + 1;
    }
    return counts;
  }, [orders]);

  /* ─── KPIs ─── */
  const kpis = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    const openCount = orders.filter((o) => { const s = getOrderStatus(o); return s === "new" || s === "pending" || s === "picking"; }).length;
    const pickedToday = orders.filter(
      (o) => o.pickedAt && new Date(o.pickedAt).getTime() >= todayStart
    ).length;
    const packedCount = orders.filter((o) => getOrderStatus(o) === "packed").length;

    // Avg processing time: from createdAt to pickedAt for picked/packed orders
    const processedOrders = orders.filter((o) => o.pickedAt && o.createdAt);
    let avgHours = 0;
    if (processedOrders.length > 0) {
      const totalMs = processedOrders.reduce((sum, o) => {
        return sum + (new Date(o.pickedAt!).getTime() - new Date(o.createdAt).getTime());
      }, 0);
      avgHours = Math.round(totalMs / processedOrders.length / (1000 * 60 * 60) * 10) / 10;
    }

    return { openCount, pickedToday, packedCount, avgHours, total: orders.length };
  }, [orders]);

  /* ─── Backfill ─── */
  const handleBackfill = useCallback(async () => {
    setBackfilling(true);
    setBackfillResult(null);
    try {
      const result = await syncMarketplaceOrders({ lookbackDays: backfillDays });
      const total = result.totalSynced ?? 0;
      const ebayErr = result.results?.ebay?.error;
      const kauflandErr = result.results?.kaufland?.error;
      const errs = [ebayErr, kauflandErr].filter(Boolean).join("; ");
      setBackfillResult(errs ? `${total} importiert. Fehler: ${errs}` : `${total} Bestellungen importiert (${backfillDays} Tage)`);
      await loadOrders();
    } catch (err: any) {
      setBackfillResult(`Fehler: ${err?.message || "Unbekannt"}`);
    } finally {
      setBackfilling(false);
    }
  }, [backfillDays, loadOrders]);

  /* ─── Carrier detection ─── */
  const detectCarrier = useCallback((order: Order): string => {
    const raw = String((order as any).carrier || (order as any).shippingService || order.shippingService || "").toLowerCase();
    if (raw.includes("dhl")) return "dhl";
    if (raw.includes("dpd")) return "dpd";
    const tracking = String(order.trackingNumber || "").toLowerCase();
    if (tracking.startsWith("00340") || tracking.startsWith("jd")) return "dhl";
    return raw ? "other" : "none";
  }, []);

  /* ─── Filter + Sort ─── */
  const filteredOrders = useMemo(() => {
    let list: Order[];
    if (filter === "all") {
      list = orders;
    } else if (filter === "new") {
      list = orders.filter((o) => ["pending", "confirmed", "new"].includes(getOrderStatus(o)));
    } else if (filter === "picking") {
      list = orders.filter((o) => ["picking", "packing"].includes(getOrderStatus(o)));
    } else if (filter === "other") {
      const covered = new Set(["pending", "confirmed", "new", "picking", "packing", "picked", "packed", "shipped", "delivered"]);
      list = orders.filter((o) => !covered.has(getOrderStatus(o)));
    } else {
      list = orders.filter((o) => getOrderStatus(o) === filter);
    }

    // Date filter — custom range overrides preset
    if (dateFrom || dateTo) {
      const fromMs = dateFrom ? new Date(dateFrom).getTime() : 0;
      const toMs = dateTo ? new Date(dateTo + "T23:59:59").getTime() : Infinity;
      list = list.filter((o) => {
        const t = new Date(o.createdAt).getTime();
        return t >= fromMs && t <= toMs;
      });
    } else if (datePreset !== "all") {
      const now = Date.now();
      const cutoff = datePreset === "today"
        ? new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime()
        : datePreset === "7d" ? now - 7 * 86400000
        : datePreset === "30d" ? now - 30 * 86400000
        : now - 90 * 86400000;
      list = list.filter((o) => new Date(o.createdAt).getTime() >= cutoff);
    }

    // Marketplace filter
    if (marketplaceFilter !== "all") {
      list = list.filter((o) => {
        const src = String((o as any).marketplace || (o as any).orderSource || (o as any).source || "").toLowerCase();
        return src.includes(marketplaceFilter);
      });
    }

    // Carrier filter
    if (carrierFilter !== "all") {
      list = list.filter((o) => detectCarrier(o) === carrierFilter);
    }

    // Search filter (order ID, customer name, SKU, marketplace order ID)
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter((o) => {
        const orderId = (o.orderId || o.number || o.id || "").toLowerCase();
        const customerName = (o.customer?.name || "").toLowerCase();
        const marketplaceId = ((o as any).marketplaceOrderId || (o as any).externalOrderId || "").toLowerCase();
        const skus = (o.items || []).map((i) => (i.sku || "").toLowerCase()).join(" ");
        return orderId.includes(q) || customerName.includes(q) || marketplaceId.includes(q) || skus.includes(q);
      });
    }

    list = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortField === "createdAt") {
        cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      } else if (sortField === "totalAmount") {
        cmp = (a.totalAmount || 0) - (b.totalAmount || 0);
      } else if (sortField === "status") {
        cmp = a.status.localeCompare(b.status);
      }
      return sortAsc ? cmp : -cmp;
    });

    return list;
  }, [orders, filter, sortField, sortAsc, searchQuery, datePreset, dateFrom, dateTo, marketplaceFilter, carrierFilter, detectCarrier]);

  const totalPages = Math.max(1, Math.ceil(filteredOrders.length / rowsPerPage));
  const paginatedOrders = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage;
    return filteredOrders.slice(start, start + rowsPerPage);
  }, [filteredOrders, currentPage, rowsPerPage]);

  // Reset page when filter changes
  useEffect(() => { setCurrentPage(1); }, [filter, rowsPerPage, searchQuery, datePreset, dateFrom, dateTo, marketplaceFilter, carrierFilter]);

  const handleSort = (field: typeof sortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  const sortIcon = (field: typeof sortField) => {
    if (sortField !== field) return null;
    return (
      <svg className="w-3 h-3 inline ml-0.5" viewBox="0 0 12 12" fill="currentColor">
        {sortAsc ? (
          <path d="M6 2L10 8H2L6 2Z" />
        ) : (
          <path d="M6 10L2 4H10L6 10Z" />
        )}
      </svg>
    );
  };

  /* ─── Selection helpers ─── */
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (prev.size === filteredOrders.length) return new Set();
      return new Set(filteredOrders.map((o) => o.id));
    });
  }, [filteredOrders]);

  const handleBulkTransition = useCallback(async (toStatus: string) => {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    setBulkResult(null);
    try {
      const result = await bulkTransitionOrders(Array.from(selectedIds), toStatus);
      const failedCount = result.total - result.success;
      if (failedCount > 0) {
        const failedDetails = result.results.filter((r) => !r.ok).map((r) => `${r.orderId}: ${r.error}`).join('; ');
        setBulkResult(`${result.success}/${result.total} erfolgreich. Fehler: ${failedDetails}`);
      } else {
        setBulkResult(`${result.success} Aufträge → ${OMS_STATUS_LABELS[toStatus] || toStatus}`);
      }
      setSelectedIds(new Set());
      await loadOrders();
    } catch (err: any) {
      setBulkResult(`Fehler: ${err?.message || 'Unbekannter Fehler'}`);
    } finally {
      setBulkBusy(false);
    }
  }, [selectedIds, loadOrders]);

  // Clear selection when filter changes
  useEffect(() => { setSelectedIds(new Set()); }, [filter]);

  /* ─── Status counts for filter pills ─── */
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: orders.length, new: 0, picking: 0, picked: 0, packed: 0, shipped: 0, other: 0 };
    const newStatuses = new Set(["pending", "confirmed", "new"]);
    const pickingStatuses = new Set(["picking", "packing"]);
    const coveredStatuses = new Set(["pending", "confirmed", "new", "picking", "packing", "picked", "packed", "shipped", "delivered"]);
    for (const o of orders) {
      const s = getOrderStatus(o);
      if (newStatuses.has(s)) counts.new++;
      else if (pickingStatuses.has(s)) counts.picking++;
      else if (s === "picked") counts.picked++;
      else if (s === "packed") counts.packed++;
      else if (s === "shipped" || s === "delivered") counts.shipped++;
      else if (!coveredStatuses.has(s)) counts.other++;
    }
    return counts;
  }, [orders]);

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-txt-primary">{t("orders.title")}</h1>
          <p className="text-sm text-txt-muted">{t("orders.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleMarketplaceSync}
            disabled={syncingMp}
            className="inline-flex items-center gap-2 rounded-xl border border-app-border bg-app-surface text-txt-primary px-4 py-2.5 text-sm font-semibold hover:bg-app-elevated transition disabled:opacity-50"
          >
            <SyncIcon className={`w-4 h-4 ${syncingMp ? "animate-spin" : ""}`} />
            {syncingMp ? "Syncing..." : "Marketplace Sync"}
          </button>
          <button
            type="button"
            onClick={handleSync}
            disabled={syncing}
            className="inline-flex items-center gap-2 rounded-xl bg-accent text-white px-4 py-2.5 text-sm font-semibold hover:bg-accent/80 transition disabled:opacity-50"
          >
            <SyncIcon className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? t("ops.orders.syncing") : t("ops.orders.sync")}
          </button>
          <button
            type="button"
            onClick={() => {
              const headers = ["Bestellnr", "Datum", "Kunde", "Status", "Marketplace", "Betrag"];
              const rows = filteredOrders.map((o) => [
                (o as any).marketplaceOrderId || o.number || o.orderId || o.id,
                o.createdAt ? new Date(o.createdAt).toLocaleDateString("de-DE") : "",
                typeof o.customer === "object" ? (o.customer?.name || "") : "",
                getOrderStatus(o),
                o.marketplace || o.source || "",
                o.totalAmount != null ? o.totalAmount.toFixed(2) : "",
              ]);
              exportToCsv(`bestellungen-${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
            }}
            disabled={filteredOrders.length === 0}
            className="inline-flex items-center gap-2 rounded-xl border border-app-border bg-app-surface text-txt-primary px-4 py-2.5 text-sm font-semibold hover:bg-app-elevated transition disabled:opacity-50"
          >
            CSV Export
          </button>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="rounded-2xl border border-app-border bg-app-surface p-3 space-y-2.5">
        {/* Row 1: Search + dropdowns */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-txt-muted" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Auftragsnr., Kunde, SKU, Marketplace-ID..."
              className="w-full rounded-xl border border-app-border bg-app-elevated text-txt-primary pl-9 pr-8 py-2 text-sm placeholder:text-txt-muted focus:outline-none focus:ring-1 focus:ring-accent/40 focus:border-accent/40"
            />
            {searchQuery && (
              <button type="button" onClick={() => setSearchQuery("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-txt-muted hover:text-txt-primary text-base leading-none">
                ×
              </button>
            )}
          </div>
          <select
            value={marketplaceFilter}
            onChange={(e) => setMarketplaceFilter(e.target.value as "all" | "ebay" | "kaufland")}
            className="rounded-xl border border-app-border bg-app-elevated text-txt-primary text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-accent/40 cursor-pointer"
          >
            <option value="all">Alle Märkte</option>
            <option value="ebay">eBay</option>
            <option value="kaufland">Kaufland</option>
          </select>
          <select
            value={carrierFilter}
            onChange={(e) => setCarrierFilter(e.target.value as "all" | "dhl" | "dpd" | "other")}
            className="rounded-xl border border-app-border bg-app-elevated text-txt-primary text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-accent/40 cursor-pointer"
          >
            <option value="all">Alle Versandarten</option>
            <option value="dhl">DHL</option>
            <option value="dpd">DPD</option>
            <option value="other">Andere</option>
          </select>
        </div>
        {/* Row 2: Date presets + custom range + backfill */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            {([
              { key: "all", label: "Alle" },
              { key: "today", label: "Heute" },
              { key: "7d", label: "7 Tage" },
              { key: "30d", label: "30 Tage" },
              { key: "90d", label: "90 Tage" },
            ] as const).map((dp) => (
              <button
                key={dp.key}
                type="button"
                onClick={() => { setDatePreset(dp.key); setDateFrom(""); setDateTo(""); }}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition border ${
                  datePreset === dp.key && !dateFrom && !dateTo
                    ? "bg-accent text-white border-accent"
                    : "bg-app-elevated text-txt-muted border-app-border hover:border-txt-muted hover:text-txt-primary"
                }`}
              >
                {dp.label}
              </button>
            ))}
            <div className="flex items-center gap-1 ml-1">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => { setDateFrom(e.target.value); setDatePreset("all"); }}
                className={`rounded-lg border text-xs px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent/40 cursor-pointer ${
                  dateFrom ? "border-accent/40 bg-accent/5 text-txt-primary" : "border-app-border bg-app-elevated text-txt-muted"
                }`}
              />
              <span className="text-txt-muted text-xs">–</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => { setDateTo(e.target.value); setDatePreset("all"); }}
                className={`rounded-lg border text-xs px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent/40 cursor-pointer ${
                  dateTo ? "border-accent/40 bg-accent/5 text-txt-primary" : "border-app-border bg-app-elevated text-txt-muted"
                }`}
              />
              {(dateFrom || dateTo) && (
                <button type="button" onClick={() => { setDateFrom(""); setDateTo(""); }} className="rounded-lg border border-app-border bg-app-elevated text-txt-muted px-2 py-1.5 text-xs hover:text-txt-primary transition" title="Zurücksetzen">×</button>
              )}
            </div>
          </div>
          {/* Backfill */}
          <div className="flex items-center gap-1.5">
            <select
              value={backfillDays}
              onChange={(e) => setBackfillDays(Number(e.target.value))}
              className="rounded-lg border border-app-border bg-app-elevated text-txt-secondary text-xs px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent/40 cursor-pointer"
              title="Zeitraum für Verlaufs-Import"
            >
              <option value={30}>30 Tage</option>
              <option value={60}>60 Tage</option>
              <option value={90}>90 Tage (max)</option>
            </select>
            <button
              type="button"
              onClick={handleBackfill}
              disabled={backfilling}
              title={`Alle Bestellungen der letzten ${backfillDays} Tage neu importieren`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-app-border bg-app-elevated text-txt-secondary px-3 py-1.5 text-xs font-medium hover:bg-app-surface hover:text-txt-primary transition disabled:opacity-50"
            >
              <SyncIcon className={`w-3.5 h-3.5 ${backfilling ? "animate-spin" : ""}`} />
              {backfilling ? "Importiere..." : "Verlauf laden"}
            </button>
          </div>
        </div>
        {/* Backfill result inline */}
        {backfillResult && (
          <div className={`rounded-lg px-3 py-2 text-xs border flex items-center justify-between ${
            String(backfillResult).startsWith("Fehler") ? "border-danger/20 bg-danger-dim text-danger" : "border-success/20 bg-success-dim text-success"
          }`}>
            <span>{backfillResult}</span>
            <button type="button" onClick={() => setBackfillResult(null)} className="ml-3 opacity-60 hover:opacity-100 text-base leading-none">×</button>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-danger/20 bg-danger-dim px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label={t("orders.kpi.open")}
          value={kpis.openCount}
          sub={`${kpis.total} ${t("ops.orders.total")}`}
          tone="text-info"
        />
        <KpiCard
          label={t("orders.kpi.pickedToday")}
          value={kpis.pickedToday}
          tone="text-accent"
        />
        <KpiCard
          label={t("orders.kpi.packed")}
          value={kpis.packedCount}
          tone="text-success"
        />
        <KpiCard
          label={t("orders.kpi.avgTime")}
          value={kpis.avgHours > 0 ? `${kpis.avgHours}h` : "—"}
          sub={t("orders.kpi.avgTimeSub")}
          tone="text-warning"
        />
      </div>

      {/* OMS Pipeline */}
      <div className="rounded-2xl border border-app-border bg-app-surface p-4">
        <div className="flex items-center gap-1">
          {PIPELINE_STAGES.map((stage, idx) => {
            const count = omsCounts[stage.key] || 0;
            const isActive = filter === stage.key;
            return (
              <React.Fragment key={stage.key}>
                {idx > 0 && (
                  <svg className="w-4 h-4 text-app-border shrink-0" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
                <button
                  type="button"
                  onClick={() => setFilter(stage.key as StatusFilter)}
                  className={`flex flex-col items-center flex-1 min-w-0 rounded-lg px-2 py-2 transition ${
                    isActive ? `${stage.color} ring-1 ring-current/20` : "hover:bg-app-elevated"
                  }`}
                >
                  <span className={`text-lg font-bold ${isActive ? "" : "text-txt-primary"}`}>
                    {count}
                  </span>
                  <span className={`text-[10px] font-medium truncate w-full text-center ${
                    isActive ? "" : "text-txt-muted"
                  }`}>
                    {stage.label}
                  </span>
                </button>
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Filter Pills */}
      <div className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((sf) => {
          const count = statusCounts[sf.key] || 0;
          const active = filter === sf.key;
          return (
            <button
              key={sf.key}
              type="button"
              onClick={() => setFilter(sf.key)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition border ${
                active
                  ? `${sf.tone} border-current/20 ring-1 ring-current/20`
                  : "bg-app-surface text-txt-muted border-app-border hover:border-txt-muted"
              }`}
            >
              {t(sf.labelKey)}
              <span className={`text-[10px] ${active ? "opacity-80" : "opacity-50"}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Bulk Action Bar */}
      {selectedIds.size > 0 && (
        <div className="rounded-2xl border border-accent/30 bg-accent/5 px-4 py-3 flex items-center gap-3 flex-wrap">
          <span className="text-sm font-semibold text-txt-primary">
            {selectedIds.size} ausgewählt
          </span>
          <div className="h-5 w-px bg-app-border" />
          {["confirmed", "picking", "picked", "packed", "shipped", "cancelled", "on_hold"].map((s) => (
            <button
              key={s}
              type="button"
              disabled={bulkBusy}
              onClick={() => handleBulkTransition(s)}
              className={`inline-flex items-center rounded-lg border px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${statusBadge(s)} hover:opacity-80`}
            >
              {OMS_STATUS_LABELS[s] || s}
            </button>
          ))}
          <div className="h-5 w-px bg-app-border" />
          <button
            type="button"
            disabled={bulkBusy}
            onClick={async () => {
              setBulkBusy(true);
              try {
                await printAddressLabels(Array.from(selectedIds));
              } catch (err: any) {
                setBulkResult(err?.message || 'Fehler beim Drucken');
              } finally {
                setBulkBusy(false);
              }
            }}
            className="inline-flex items-center rounded-lg border border-app-border bg-card px-3 py-1.5 text-xs font-semibold text-txt-primary transition hover:bg-app-hover disabled:opacity-50"
          >
            Empfänger drucken
          </button>
          <div className="ml-auto">
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="text-xs text-txt-muted hover:text-txt-primary transition"
            >
              Auswahl aufheben
            </button>
          </div>
        </div>
      )}

      {/* Bulk Result Feedback */}
      {bulkResult && (
        <div
          className={`rounded-xl px-4 py-3 text-sm border ${
            String(bulkResult).startsWith("Fehler") ? "border-danger/20 bg-danger-dim text-danger" : "border-success/20 bg-success-dim text-success"
          }`}
        >
          {bulkResult}
          <button type="button" onClick={() => setBulkResult(null)} className="ml-3 underline text-xs opacity-70 hover:opacity-100">
            Schließen
          </button>
        </div>
      )}

      {/* Table */}
      <div className="rounded-2xl border border-app-border bg-app-surface overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
          </div>
        ) : filteredOrders.length === 0 ? (
          <EmptyState
            title={filter !== "all" || searchQuery || datePreset !== "all"
              ? "Keine Ergebnisse für diesen Filter."
              : "Noch keine Bestellungen vorhanden."}
            description={filter !== "all" || searchQuery || datePreset !== "all"
              ? "Passe die Filterkriterien an oder setze sie zurück."
              : undefined}
            action={filter !== "all" || searchQuery || datePreset !== "all" ? (
              <button
                type="button"
                onClick={() => { setFilter("all"); setSearchQuery(""); setDatePreset("all"); setDateFrom(""); setDateTo(""); }}
                className="rounded-lg bg-accent text-white px-4 py-2 text-sm font-semibold hover:bg-accent/90 transition"
              >
                Filter zurücksetzen
              </button>
            ) : undefined}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-app-border bg-app-bg/50">
                  <th className="w-10 px-3 py-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.size > 0 && selectedIds.size === filteredOrders.length}
                      ref={(el) => { if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < filteredOrders.length; }}
                      onChange={toggleSelectAll}
                      className="w-4 h-4 rounded border-app-border text-accent focus:ring-accent/30 cursor-pointer"
                    />
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">
                    {t("orders.col.id")}
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">
                    {t("orders.col.customer")}
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">
                    {t("orders.col.items")}
                  </th>
                  <th
                    className="text-right px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider cursor-pointer hover:text-txt-secondary"
                    onClick={() => handleSort("totalAmount")}
                  >
                    {t("orders.col.total")} {sortIcon("totalAmount")}
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">
                    {t("orders.col.source")}
                  </th>
                  <th
                    className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider cursor-pointer hover:text-txt-secondary"
                    onClick={() => handleSort("status")}
                  >
                    {t("orders.col.status")} {sortIcon("status")}
                  </th>
                  <th
                    className="text-right px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider cursor-pointer hover:text-txt-secondary"
                    onClick={() => handleSort("createdAt")}
                  >
                    {t("orders.col.date")} {sortIcon("createdAt")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {paginatedOrders.map((order) => {
                  const src = sourceBadge((order as any).marketplace || order.orderSource || (order as any).source);
                  const itemCount = order.items.reduce((sum, i) => sum + i.quantity, 0);
                  return (
                    <tr
                      key={order.id}
                      onClick={() => setSelectedOrderId(order.id)}
                      className={`border-b border-app-border last:border-b-0 hover:bg-app-elevated/40 transition cursor-pointer ${
                        selectedIds.has(order.id) ? "bg-accent/5" : ""
                      }`}
                    >
                      {/* Checkbox */}
                      <td className="w-10 px-3 py-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(order.id)}
                          onChange={() => toggleSelect(order.id)}
                          className="w-4 h-4 rounded border-app-border text-accent focus:ring-accent/30 cursor-pointer"
                        />
                      </td>
                      {/* Order ID */}
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs text-txt-primary block">
                          {(order as any).marketplaceOrderId && (order as any).marketplaceOrderId !== '-'
                            ? (order as any).marketplaceOrderId
                            : order.orderId || order.number || order.id}
                        </span>
                      </td>
                      {/* Customer */}
                      <td className="px-4 py-3">
                        <div className="text-txt-primary text-sm font-medium truncate max-w-[180px]">
                          {order.customer?.name || "—"}
                        </div>
                        {order.customer?.city && (
                          <div className="text-xs text-txt-muted">
                            {order.customer.city}
                            {order.customer.country ? `, ${order.customer.country}` : ""}
                          </div>
                        )}
                      </td>
                      {/* Items */}
                      <td className="px-4 py-3">
                        {order.items.length > 0 ? (
                          <div className="flex items-center gap-2.5">
                            {(() => {
                              const first = order.items[0];
                              const imgSrc = first.pickHint?.image || null;
                              return (
                                <div className="w-9 h-9 rounded-lg bg-app-elevated border border-app-border overflow-hidden flex items-center justify-center shrink-0">
                                  {imgSrc ? (
                                    <img
                                      src={buildImageProxyUrl(imgSrc)}
                                      alt=""
                                      className="w-full h-full object-cover"
                                      loading="lazy"
                                      onError={(e) => { e.currentTarget.src = ""; e.currentTarget.style.display = "none"; }}
                                    />
                                  ) : (
                                    <span className="text-[9px] text-txt-muted">—</span>
                                  )}
                                </div>
                              );
                            })()}
                            <div className="min-w-0">
                              <div className="text-xs text-txt-primary font-medium truncate max-w-[200px]">
                                {order.items[0].name || "—"}
                              </div>
                              <div className="text-[11px] text-txt-muted truncate max-w-[200px]">
                                {order.items[0].sku ? `SKU ${order.items[0].sku}` : ""}
                                {order.items.length > 1 && (
                                  <span className="ml-1 text-txt-muted">+{order.items.length - 1} weitere</span>
                                )}
                              </div>
                            </div>
                          </div>
                        ) : (
                          <span className="text-xs text-txt-muted">—</span>
                        )}
                      </td>
                      {/* Total */}
                      <td className="px-4 py-3 text-right">
                        <span className="font-semibold text-txt-primary">
                          {order.totalAmount != null
                            ? `${order.totalAmount.toFixed(2)} €`
                            : "—"}
                        </span>
                      </td>
                      {/* Source */}
                      <td className="px-4 py-3">
                        {src ? (
                          <span
                            className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold ${src.cls}`}
                          >
                            {src.label}
                          </span>
                        ) : (
                          <span className="text-xs text-txt-muted">—</span>
                        )}
                      </td>
                      {/* Status */}
                      <td className="px-4 py-3">
                        {(() => {
                          const displayStatus = getOrderStatus(order);
                          const displayLabel = OMS_STATUS_LABELS[displayStatus] || order.statusLabel || displayStatus;
                          return (
                            <span
                              className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold ${statusBadge(displayStatus)}`}
                              aria-label={`Status: ${displayLabel}`}
                            >
                              {displayLabel}
                            </span>
                          );
                        })()}
                      </td>
                      {/* Date */}
                      <td className="px-4 py-3 text-right">
                        <span className="text-xs text-txt-muted whitespace-nowrap">
                          {new Date(order.createdAt).toLocaleDateString("de-DE", {
                            day: "2-digit",
                            month: "2-digit",
                            year: "2-digit",
                          })}
                        </span>
                        <div className="text-[10px] text-txt-muted">
                          {new Date(order.createdAt).toLocaleTimeString("de-DE", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination Footer */}
      {!loading && filteredOrders.length > 0 && (
        <div className="flex items-center justify-between gap-4 text-xs text-txt-muted">
          <div className="flex items-center gap-2">
            <span>Zeilen pro Seite:</span>
            <select
              value={rowsPerPage}
              onChange={(e) => setRowsPerPage(Number(e.target.value))}
              className="rounded-md border border-app-border bg-app-surface text-txt-primary px-2 py-1 text-xs"
            >
              {[25, 50, 100, 200, 500].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3">
            <span>
              {(currentPage - 1) * rowsPerPage + 1}–{Math.min(currentPage * rowsPerPage, filteredOrders.length)} von {filteredOrders.length}
              {filteredOrders.length !== orders.length && ` (${orders.length} gesamt)`}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={currentPage <= 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                className="rounded-md border border-app-border bg-app-surface px-2 py-1 hover:bg-app-elevated disabled:opacity-30 transition"
              >
                &larr;
              </button>
              <span className="px-2 font-medium text-txt-primary">{currentPage} / {totalPages}</span>
              <button
                type="button"
                disabled={currentPage >= totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                className="rounded-md border border-app-border bg-app-surface px-2 py-1 hover:bg-app-elevated disabled:opacity-30 transition"
              >
                &rarr;
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Order Detail Slide-in */}
      {selectedOrderId && (
        <OrderDetail
          orderId={selectedOrderId}
          onClose={() => setSelectedOrderId(null)}
          onStatusChange={() => {
            void loadOrders();
          }}
        />
      )}
    </div>
  );
};

export default OrdersView;
