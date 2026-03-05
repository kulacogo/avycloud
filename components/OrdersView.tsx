import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { fetchOrders as fetchOrdersApi, syncOrders } from "../api/client";
import { Order, OrderStatus } from "../types";
import { SyncIcon } from "./icons/Icons";

/* ─── Status filter config ─── */
type StatusFilter = "all" | OrderStatus;

const STATUS_FILTERS: { key: StatusFilter; labelKey: string; tone: string }[] = [
  { key: "all", labelKey: "orders.filter.all", tone: "bg-app-elevated text-txt-primary" },
  { key: "new", labelKey: "orders.filter.new", tone: "bg-info-dim text-info" },
  { key: "picking", labelKey: "orders.filter.picking", tone: "bg-warning-dim text-warning" },
  { key: "picked", labelKey: "orders.filter.picked", tone: "bg-accent-dim text-accent" },
  { key: "packed", labelKey: "orders.filter.packed", tone: "bg-success-dim text-success" },
  { key: "other", labelKey: "orders.filter.other", tone: "bg-app-elevated text-txt-secondary" },
];

/* ─── Status badge styling ─── */
const statusBadge = (status: OrderStatus) => {
  switch (status) {
    case "new":
      return "bg-info-dim text-info border-info/20";
    case "picking":
      return "bg-warning-dim text-warning border-warning/20";
    case "picked":
      return "bg-accent-dim text-accent border-accent/20";
    case "packed":
      return "bg-success-dim text-success border-success/20";
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

/* ─── Main Component ─── */
const OrdersView: React.FC = () => {
  const { t } = useI18n();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [sortField, setSortField] = useState<"createdAt" | "totalAmount" | "status">("createdAt");
  const [sortAsc, setSortAsc] = useState(false);

  /* ─── Fetch ─── */
  const loadOrders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchOrdersApi(200);
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

  /* ─── KPIs ─── */
  const kpis = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    const openCount = orders.filter((o) => o.status === "new" || o.status === "picking").length;
    const pickedToday = orders.filter(
      (o) => o.pickedAt && new Date(o.pickedAt).getTime() >= todayStart
    ).length;
    const packedCount = orders.filter((o) => o.status === "packed").length;

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
    let list = filter === "all" ? orders : orders.filter((o) => o.status === filter);

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
  }, [orders, filter, sortField, sortAsc]);

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

  /* ─── Status counts for filter pills ─── */
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: orders.length };
    for (const o of orders) {
      counts[o.status] = (counts[o.status] || 0) + 1;
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
                {filteredOrders.map((order) => {
                  const src = sourceBadge(order.orderSource);
                  const itemCount = order.items.reduce((sum, i) => sum + i.quantity, 0);
                  return (
                    <tr
                      key={order.id}
                      className="border-b border-app-border last:border-b-0 hover:bg-app-elevated/40 transition"
                    >
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
                        <span className="inline-flex items-center justify-center min-w-[24px] h-6 rounded-md bg-app-elevated px-1.5 text-xs font-bold text-txt-secondary">
                          {itemCount}
                        </span>
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
                        <span
                          className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold ${statusBadge(
                            order.status
                          )}`}
                        >
                          {order.statusLabel || order.status}
                        </span>
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

      {/* Footer count */}
      {!loading && filteredOrders.length > 0 && (
        <div className="text-xs text-txt-muted text-right">
          {filteredOrders.length} / {orders.length} {t("orders.footer.showing")}
        </div>
      )}
    </div>
  );
};

export default OrdersView;
