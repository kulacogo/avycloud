import React, { useState, useEffect, useCallback } from "react";
import { fetchWarehouseMovements, WarehouseMovement } from "../../api/client";
import { Spinner } from "../Spinner";

const TYPE_LABELS: Record<string, string> = {
  stock_in: "Stock-In",
  stock_out: "Stock-Out",
  bin_assign_product: "Einlagerung",
  bin_remove_product: "Auslagerung",
  order_decrement: "Bestandskorrektur",
  layout_delete: "Layout gelöscht",
};

const TYPE_OPTIONS = [
  { value: "", label: "Alle Typen" },
  { value: "stock_in", label: "Stock-In" },
  { value: "stock_out", label: "Stock-Out" },
  { value: "bin_assign_product", label: "Einlagerung" },
  { value: "bin_remove_product", label: "Auslagerung" },
  { value: "order_decrement", label: "Bestandskorrektur" },
];

const PAGE_SIZE = 30;

const WarehouseMovementsTab: React.FC = () => {
  const [movements, setMovements] = useState<WarehouseMovement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(0);

  // Filters
  const [typeFilter, setTypeFilter] = useState("");
  const [binFilter, setBinFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchWarehouseMovements({
        type: typeFilter || undefined,
        binCode: binFilter.trim() || undefined,
        from: fromDate || undefined,
        to: toDate || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setMovements(result.movements);
      setHasMore(result.hasMore);
    } catch (err: any) {
      setError(err.message || "Bewegungen konnten nicht geladen werden");
    } finally {
      setLoading(false);
    }
  }, [typeFilter, binFilter, fromDate, toDate, page]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Reset page when filters change
  useEffect(() => {
    setPage(0);
  }, [typeFilter, binFilter, fromDate, toDate]);

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" })
      + " " + d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs text-txt-muted mb-1">Typ</label>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="bg-app-surface border border-app-border rounded-lg px-3 py-2 text-sm text-txt-primary focus:outline-none focus:ring-1 focus:ring-accent"
          >
            {TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-txt-muted mb-1">BIN-Code</label>
          <input
            type="text"
            placeholder="z.B. X01GA02A"
            value={binFilter}
            onChange={(e) => setBinFilter(e.target.value.toUpperCase())}
            className="bg-app-surface border border-app-border rounded-lg px-3 py-2 text-sm text-txt-primary w-36 focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-txt-muted"
          />
        </div>
        <div>
          <label className="block text-xs text-txt-muted mb-1">Von</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="bg-app-surface border border-app-border rounded-lg px-3 py-2 text-sm text-txt-primary focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-xs text-txt-muted mb-1">Bis</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="bg-app-surface border border-app-border rounded-lg px-3 py-2 text-sm text-txt-primary focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center h-48">
          <Spinner />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center h-48 gap-3">
          <p className="text-danger text-sm">{error}</p>
          <button
            onClick={loadData}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90"
          >
            Erneut versuchen
          </button>
        </div>
      ) : movements.length === 0 ? (
        <div className="text-center py-16 text-txt-muted text-sm">
          Keine Bewegungen gefunden
        </div>
      ) : (
        <div className="rounded-xl bg-app-surface border border-app-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-app-border text-left">
                  <th className="px-3 py-3 font-medium text-txt-secondary">Datum</th>
                  <th className="px-3 py-3 font-medium text-txt-secondary">Typ</th>
                  <th className="px-3 py-3 font-medium text-txt-secondary">BIN</th>
                  <th className="px-3 py-3 font-medium text-txt-secondary">Produkt</th>
                  <th className="px-3 py-3 font-medium text-txt-secondary text-right">Menge</th>
                  <th className="px-3 py-3 font-medium text-txt-secondary text-right">Bestand</th>
                  <th className="px-3 py-3 font-medium text-txt-secondary">Quelle</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((m) => (
                  <tr key={m.id} className="border-b border-app-border hover:bg-app-elevated/50 transition-colors">
                    <td className="px-3 py-2 text-txt-secondary text-xs whitespace-nowrap">
                      {formatDate(m.createdAt)}
                    </td>
                    <td className="px-3 py-2">
                      <span className="text-xs font-medium px-2 py-0.5 rounded bg-app-elevated text-txt-primary">
                        {TYPE_LABELS[m.type] || m.type}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className="text-xs font-mono text-txt-primary">{m.binCode}</span>
                    </td>
                    <td className="px-3 py-2">
                      <span className="text-txt-primary text-xs">{m.sku || m.productId}</span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span
                        className={`font-bold tabular-nums ${
                          m.delta > 0 ? "text-success" : m.delta < 0 ? "text-danger" : "text-txt-muted"
                        }`}
                      >
                        {m.delta > 0 ? `+${m.delta}` : m.delta}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-txt-secondary tabular-nums">
                      {m.quantityAfter}
                    </td>
                    <td className="px-3 py-2 text-xs text-txt-muted">
                      {m.meta?.source || m.meta?.action || "\u2014"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Pagination */}
      {!loading && movements.length > 0 && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-txt-muted">
            Seite {page + 1}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-3 py-1.5 rounded-lg bg-app-elevated text-txt-secondary text-sm disabled:opacity-40 hover:text-txt-primary transition-colors"
            >
              Zurück
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={!hasMore}
              className="px-3 py-1.5 rounded-lg bg-app-elevated text-txt-secondary text-sm disabled:opacity-40 hover:text-txt-primary transition-colors"
            >
              Weiter
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default WarehouseMovementsTab;
