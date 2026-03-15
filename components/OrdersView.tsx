import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import {
  fetchOrders as fetchOrdersApi,
  syncOrders,
  fetchOrderStatuses,
  syncMarketplaceOrders,
  buildImageProxyUrl,
  bulkTransitionOrders,
} from "../api/client";
import { Order, OrderStatus } from "../types";
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
  if (s.includes("ebay")) return { label: "eBay", cls: "bg-amber-600/15 text-amber-400 border-amber-500/20" };
  if (s.includes("kaufland")) return { label: "Kaufland", cls: "bg-danger-dim text-danger border-danger/20" };
  if (s.includes("amazon")) return { label: "Amazon", cls: "bg-info-dim text-info border-info/20" };
  return { label: source, cls: "bg-app-elevated text-txt-secondary border-app-border" };
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
  const [omsCounts, setOmsCounts] = useState<Record<string, number>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const [rowsPerPage, setRowsPerPage] = useState(50);
  const [currentPage, setCurrentPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState("");
  const [datePreset, setDatePreset] = useState<"all" | "today" | "7d" | "30d" | "90d">("all");

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

  /* ─── Load OMS status counts ─── */
  const loadOmsCounts = useCallback(async () => {
    try {
      const data = await fetchOrderStatuses();
      setOmsCounts(data.counts || {});
    } catch {
      // non-critical, pipeline just shows zeros
    }
  }, []);

  useEffect(() => {
    void loadOmsCounts();
  }, [loadOmsCounts]);

  /* ─── KPIs ─── */
  const kpis = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    const getStatus = (o: Order) => (o as any).omsStatus || o.status;
    const openCount = orders.filter((o) => { const s = getStatus(o); return s === "new" || s === "pending" || s === "picking"; }).length;
    const pickedToday = orders.filter(
      (o) => o.pickedAt && new Date(o.pickedAt).getTime() >= todayStart
    ).length;
    const packedCount = orders.filter((o) => getStatus(o) === "packed").length;

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

  /* ─── Filter + Sort ─── */
  const filteredOrders = useMemo(() => {
    const getOmsStatus = (o: Order) => (o as any).omsStatus || o.status;
    let list: Order[];
    if (filter === "all") {
      list = orders;
    } else if (filter === "new") {
      list = orders.filter((o) => ["pending", "confirmed", "new"].includes(getOmsStatus(o)));
    } else if (filter === "picking") {
      list = orders.filter((o) => ["picking", "packing"].includes(getOmsStatus(o)));
    } else if (filter === "other") {
      const covered = new Set(["pending", "confirmed", "new", "picking", "packing", "picked", "packed", "shipped", "delivered"]);
      list = orders.filter((o) => !covered.has(getOmsStatus(o)));
    } else {
      list = orders.filter((o) => getOmsStatus(o) === filter);
    }

    // Date filter
    if (datePreset !== "all") {
      const now = Date.now();
      const cutoff = datePreset === "today"
        ? new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime()
        : datePreset === "7d" ? now - 7 * 86400000
        : datePreset === "30d" ? now - 30 * 86400000
        : now - 90 * 86400000;
      list = list.filter((o) => new Date(o.createdAt).getTime() >= cutoff);
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
  }, [orders, filter, sortField, sortAsc, searchQuery, datePreset]);

  const totalPages = Math.max(1, Math.ceil(filteredOrders.length / rowsPerPage));
  const paginatedOrders = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage;
    return filteredOrders.slice(start, start + rowsPerPage);
  }, [filteredOrders, currentPage, rowsPerPage]);

  // Reset page when filter changes
  useEffect(() => { setCurrentPage(1); }, [filter, rowsPerPage, searchQuery, datePreset]);

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
      await loadOmsCounts();
    } catch (err: any) {
      setBulkResult(`Fehler: ${err?.message || 'Unbekannter Fehler'}`);
    } finally {
      setBulkBusy(false);
    }
  }, [selectedIds, loadOrders, loadOmsCounts]);

  // Clear selection when filter changes
  useEffect(() => { setSelectedIds(new Set()); }, [filter]);

  /* ─── Status counts for filter pills ─── */
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: orders.length, new: 0, picking: 0, picked: 0, packed: 0, shipped: 0, other: 0 };
    const newStatuses = new Set(["pending", "confirmed", "new"]);
    const pickingStatuses = new Set(["picking", "packing"]);
    const coveredStatuses = new Set(["pending", "confirmed", "new", "picking", "packing", "picked", "packed", "shipped", "delivered"]);
    for (const o of orders) {
      const s = (o as any).omsStatus || o.status;
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
        </div>
      </div>

      {/* Search + Date Filter */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-txt-muted" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Suche: Auftragsnr., Kunde, SKU, Marketplace-ID..."
            className="w-full rounded-xl border border-app-border bg-app-surface text-txt-primary pl-9 pr-3 py-2 text-sm placeholder:text-txt-muted focus:outline-none focus:ring-1 focus:ring-accent/40 focus:border-accent/40"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-txt-muted hover:text-txt-primary text-xs"
            >
              &times;
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
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
              onClick={() => setDatePreset(dp.key)}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                datePreset === dp.key
                  ? "bg-accent text-white"
                  : "bg-app-surface text-txt-muted border border-app-border hover:bg-app-elevated"
              }`}
            >
              {dp.label}
            </button>
          ))}
        </div>
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
            bulkResult.startsWith("Fehler") ? "border-danger/20 bg-danger-dim text-danger" : "border-success/20 bg-success-dim text-success"
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
          <div className="text-center py-16 text-txt-muted text-sm">
            {t("ops.orders.none")}
          </div>
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
                        <span className="font-mono text-xs text-txt-primary">
                          {order.number || order.id}
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
                                    <img src={buildImageProxyUrl(imgSrc)} alt="" className="w-full h-full object-cover" loading="lazy" />
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
                          const displayStatus = (order as any).omsStatus || order.status;
                          const displayLabel = OMS_STATUS_LABELS[displayStatus] || order.statusLabel || displayStatus;
                          return (
                            <span
                              className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold ${statusBadge(displayStatus)}`}
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
            void loadOmsCounts();
          }}
        />
      )}
    </div>
  );
};

export default OrdersView;
