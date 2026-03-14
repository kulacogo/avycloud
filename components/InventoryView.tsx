import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Product } from "../types";
import { fetchProducts } from "../api/client";
import { Spinner } from "./Spinner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InventoryViewProps {
  onNavigate?: (view: string) => void;
  onSelectProduct?: (product: Product) => void;
}

type QuickFilterKey = "all" | "low" | "nobin" | "stale";
type SortField = "name" | "sku" | "quantity" | "available" | "buyPrice" | "value" | "binCode";
type SortDir = "asc" | "desc";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const primaryImage = (product: Product): string | null => {
  const img = (product.details?.images || []).find(
    (i) => i.url_or_base64?.startsWith("http")
  );
  return img?.url_or_base64 || null;
};

const getBinCode = (product: Product): string | null => {
  if (product.storage?.binCode) return product.storage.binCode;
  if (Array.isArray(product.storageBins) && product.storageBins.length) {
    const withStock = product.storageBins.find((b) => (b.quantity || 0) > 0);
    return withStock?.code || product.storageBins[0]?.code || null;
  }
  return null;
};

const getBinZone = (product: Product): string | null => {
  if (product.storage?.zone) return product.storage.zone;
  if (Array.isArray(product.storageBins) && product.storageBins.length) {
    return product.storageBins[0]?.zone || null;
  }
  return null;
};

const zoneColor = (zone: string | null): string => {
  switch (zone) {
    case "XS":
      return "bg-info-dim text-info";
    case "S":
      return "bg-success-dim text-success";
    case "M":
      return "bg-accent-dim text-accent";
    case "L":
      return "bg-warning-dim text-warning";
    case "XL":
      return "bg-danger-dim text-danger";
    case "X":
      return "bg-app-elevated text-txt-secondary";
    default:
      return "bg-app-elevated text-txt-muted";
  }
};

const isLowStock = (product: Product): boolean => {
  const qty = product.inventory?.quantity ?? 0;
  return qty > 0 && qty < 5;
};

const isNoBin = (product: Product): boolean => {
  return !getBinCode(product);
};

const isStale = (product: Product): boolean => {
  const bins = product.storageBins;
  if (!Array.isArray(bins) || bins.length === 0) return true;
  const lastUpdated = bins[0]?.lastUpdatedAt;
  if (!lastUpdated) return true;
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return new Date(lastUpdated).getTime() < thirtyDaysAgo;
};

const formatCurrency = (value: number): string => {
  return value.toLocaleString("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const KpiCard: React.FC<{
  label: string;
  value: string | number;
  icon: "package" | "layers" | "euro" | "alert";
  tone?: "default" | "warn";
}> = ({ label, value, icon, tone = "default" }) => {
  const iconColor = tone === "warn" ? "text-warning" : "text-txt-muted";

  const renderIcon = () => {
    switch (icon) {
      case "package":
        return (
          <svg className={`w-5 h-5 ${iconColor}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
        );
      case "layers":
        return (
          <svg className={`w-5 h-5 ${iconColor}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.429 9.75L2.25 12l4.179 2.25m0-4.5l5.571 3 5.571-3m-11.142 0L2.25 7.5 12 2.25l9.75 5.25-4.179 2.25m0 0L12 12.75 6.429 9.75m11.142 0l4.179 2.25-4.179 2.25m0 0L12 17.25l-5.571-3m11.142 0l4.179 2.25L12 21.75l-9.75-5.25 4.179-2.25" />
          </svg>
        );
      case "euro":
        return (
          <svg className={`w-5 h-5 ${iconColor}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.25 7.756a4.5 4.5 0 100 8.488M7.5 10.5H5.25m2.25 3H5.25m6.75-6.75h-3m3 3h-3m3 3h-3" />
          </svg>
        );
      case "alert":
        return (
          <svg className={`w-5 h-5 ${iconColor}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
        );
    }
  };

  return (
    <div className="rounded-xl bg-app-surface border border-app-border p-4">
      <div className="flex items-center gap-2 mb-2">
        {renderIcon()}
        <span className="text-xs text-txt-muted uppercase tracking-wide">{label}</span>
      </div>
      <div className="text-2xl font-bold text-txt-primary">{value}</div>
    </div>
  );
};

const QuickFilter: React.FC<{
  label: string;
  active: boolean;
  onClick: () => void;
  count?: number;
  tone?: "default" | "warn";
}> = ({ label, active, onClick, count, tone = "default" }) => {
  const baseClass = active
    ? "bg-accent text-white"
    : "bg-app-elevated text-txt-secondary hover:text-txt-primary";

  const badgeClass = active
    ? "bg-white/20 text-white"
    : tone === "warn"
      ? "bg-warning-dim text-warning"
      : "bg-app-surface text-txt-muted";

  return (
    <button
      onClick={onClick}
      className={`${baseClass} rounded-lg px-3 py-1.5 text-sm font-medium inline-flex items-center gap-1.5 transition-colors`}
    >
      {label}
      {count !== undefined && (
        <span className={`${badgeClass} text-xs px-1.5 py-0.5 rounded-full min-w-[1.25rem] text-center`}>
          {count}
        </span>
      )}
    </button>
  );
};

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

const InventoryView: React.FC<InventoryViewProps> = ({ onNavigate, onSelectProduct }) => {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [quickFilter, setQuickFilter] = useState<QuickFilterKey>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // ---- Data loading ----
  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchProducts();
      setProducts(list);
    } catch (err: any) {
      console.error("[InventoryView] Failed to load products:", err);
      setError(err.message || "Produkte konnten nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ---- KPI calculations ----
  const kpis = useMemo(() => {
    const withStock = products.filter((p) => (p.inventory?.quantity ?? 0) > 0);
    const totalProducts = withStock.length;
    const totalUnits = products.reduce((sum, p) => sum + (p.inventory?.quantity ?? 0), 0);
    const totalValue = products.reduce((sum, p) => {
      const qty = p.inventory?.quantity ?? 0;
      const buyPrice = p.details?.pricing?.buyPrice ?? 0;
      return sum + qty * buyPrice;
    }, 0);
    const lowStockCount = products.filter(isLowStock).length;
    const noBinCount = products.filter((p) => (p.inventory?.quantity ?? 0) > 0 && isNoBin(p)).length;
    const staleCount = products.filter((p) => (p.inventory?.quantity ?? 0) > 0 && isStale(p)).length;

    return { totalProducts, totalUnits, totalValue, lowStockCount, noBinCount, staleCount };
  }, [products]);

  // ---- Filtering ----
  const filteredProducts = useMemo(() => {
    let list = products;

    // Quick filter
    switch (quickFilter) {
      case "low":
        list = list.filter(isLowStock);
        break;
      case "nobin":
        list = list.filter((p) => isNoBin(p));
        break;
      case "stale":
        list = list.filter((p) => (p.inventory?.quantity ?? 0) > 0 && isStale(p));
        break;
    }

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter((p) => {
        const name = (p.identification?.name || "").toLowerCase();
        const sku = (p.identification?.sku || "").toLowerCase();
        const ean = (p.details?.identifiers?.ean || "").toLowerCase();
        return name.includes(q) || sku.includes(q) || ean.includes(q);
      });
    }

    // Sort
    list = [...list].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "name":
          cmp = (a.identification?.name || "").localeCompare(b.identification?.name || "", "de");
          break;
        case "sku":
          cmp = (a.identification?.sku || "").localeCompare(b.identification?.sku || "", "de");
          break;
        case "quantity":
          cmp = (a.inventory?.quantity ?? 0) - (b.inventory?.quantity ?? 0);
          break;
        case "available":
          cmp = (a.inventory?.availableQuantity ?? 0) - (b.inventory?.availableQuantity ?? 0);
          break;
        case "buyPrice":
          cmp = (a.details?.pricing?.buyPrice ?? 0) - (b.details?.pricing?.buyPrice ?? 0);
          break;
        case "value":
          cmp =
            (a.inventory?.quantity ?? 0) * (a.details?.pricing?.buyPrice ?? 0) -
            (b.inventory?.quantity ?? 0) * (b.details?.pricing?.buyPrice ?? 0);
          break;
        case "binCode":
          cmp = (getBinCode(a) || "zzz").localeCompare(getBinCode(b) || "zzz", "de");
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

    return list;
  }, [products, quickFilter, searchQuery, sortField, sortDir]);

  // ---- Sort handler ----
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const SortIcon: React.FC<{ field: SortField }> = ({ field }) => {
    if (sortField !== field) {
      return (
        <svg className="w-3.5 h-3.5 text-txt-muted opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l4-4 4 4m0 6l-4 4-4-4" />
        </svg>
      );
    }
    return sortDir === "asc" ? (
      <svg className="w-3.5 h-3.5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
      </svg>
    ) : (
      <svg className="w-3.5 h-3.5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
    );
  };

  // ---- Render ----

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <p className="text-danger text-sm">{error}</p>
        <button
          onClick={loadData}
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
        >
          Erneut versuchen
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Gesamtartikel" value={kpis.totalProducts.toLocaleString("de-DE")} icon="package" />
        <KpiCard label="Einheiten" value={kpis.totalUnits.toLocaleString("de-DE")} icon="layers" />
        <KpiCard
          label="Bestandswert"
          value={`\u20AC${formatCurrency(kpis.totalValue)}`}
          icon="euro"
        />
        <KpiCard label="Niedrig-Bestand" value={kpis.lowStockCount} icon="alert" tone="warn" />
      </div>

      {/* Quick Filters + Search */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
        <div className="flex gap-2 flex-wrap">
          <QuickFilter label="Alle" active={quickFilter === "all"} onClick={() => setQuickFilter("all")} />
          <QuickFilter
            label="Niedrig-Bestand"
            active={quickFilter === "low"}
            onClick={() => setQuickFilter("low")}
            count={kpis.lowStockCount}
            tone="warn"
          />
          <QuickFilter
            label="Kein Lagerplatz"
            active={quickFilter === "nobin"}
            onClick={() => setQuickFilter("nobin")}
            count={kpis.noBinCount}
          />
          <QuickFilter
            label="30 Tage unbewegt"
            active={quickFilter === "stale"}
            onClick={() => setQuickFilter("stale")}
            count={kpis.staleCount}
          />
        </div>
        <div className="flex-1 w-full sm:w-auto sm:max-w-xs ml-auto">
          <div className="relative">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-txt-muted"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            <input
              type="text"
              placeholder="Suche nach Name, SKU, EAN..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-app-surface border border-app-border rounded-lg pl-9 pr-3 py-2 text-sm text-txt-primary placeholder:text-txt-muted focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent"
            />
          </div>
        </div>
      </div>

      {/* Results count */}
      <div className="text-xs text-txt-muted">
        {filteredProducts.length} von {products.length} Artikeln
      </div>

      {/* Data Table */}
      <div className="rounded-xl bg-app-surface border border-app-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-app-border text-left">
                <th className="px-3 py-3 w-14"></th>
                <th
                  className="px-3 py-3 font-medium text-txt-secondary cursor-pointer group"
                  onClick={() => handleSort("name")}
                >
                  <div className="flex items-center gap-1">
                    Produkt
                    <SortIcon field="name" />
                  </div>
                </th>
                <th
                  className="px-3 py-3 w-28 font-medium text-txt-secondary cursor-pointer group"
                  onClick={() => handleSort("sku")}
                >
                  <div className="flex items-center gap-1">
                    SKU
                    <SortIcon field="sku" />
                  </div>
                </th>
                <th
                  className="px-3 py-3 w-28 font-medium text-txt-secondary cursor-pointer group"
                  onClick={() => handleSort("binCode")}
                >
                  <div className="flex items-center gap-1">
                    Lagerplatz
                    <SortIcon field="binCode" />
                  </div>
                </th>
                <th
                  className="px-3 py-3 w-20 font-medium text-txt-secondary cursor-pointer group text-right"
                  onClick={() => handleSort("quantity")}
                >
                  <div className="flex items-center justify-end gap-1">
                    Menge
                    <SortIcon field="quantity" />
                  </div>
                </th>
                <th
                  className="px-3 py-3 w-24 font-medium text-txt-secondary cursor-pointer group text-right"
                  onClick={() => handleSort("available")}
                >
                  <div className="flex items-center justify-end gap-1">
                    Verfügbar
                    <SortIcon field="available" />
                  </div>
                </th>
                <th
                  className="px-3 py-3 w-20 font-medium text-txt-secondary cursor-pointer group text-right"
                  onClick={() => handleSort("buyPrice")}
                >
                  <div className="flex items-center justify-end gap-1">
                    EK
                    <SortIcon field="buyPrice" />
                  </div>
                </th>
                <th
                  className="px-3 py-3 w-28 font-medium text-txt-secondary cursor-pointer group text-right"
                  onClick={() => handleSort("value")}
                >
                  <div className="flex items-center justify-end gap-1">
                    Bestandswert
                    <SortIcon field="value" />
                  </div>
                </th>
                <th className="px-3 py-3 w-20 font-medium text-txt-secondary text-center">
                  Marktplatz
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredProducts.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-center py-12 text-txt-muted text-sm">
                    Keine Artikel gefunden
                  </td>
                </tr>
              )}
              {filteredProducts.map((product) => {
                const qty = product.inventory?.quantity ?? 0;
                const availableQty = product.inventory?.availableQuantity ?? qty;
                const reservedQty = product.inventory?.reservedQuantity ?? 0;
                const buyPrice = product.details?.pricing?.buyPrice ?? 0;
                const rowValue = qty * buyPrice;
                const binCode = getBinCode(product);
                const zone = getBinZone(product);
                const imgUrl = primaryImage(product);
                const ebayStatus = (product as any)?.ops?.listingStatus?.ebay;
                const kauflandStatus = (product as any)?.ops?.listingStatus?.kaufland;

                return (
                  <tr
                    key={product.id}
                    className="hover:bg-app-elevated/50 cursor-pointer border-b border-app-border transition-colors"
                    onClick={() => {
                      if (onSelectProduct) {
                        onSelectProduct(product);
                      }
                    }}
                  >
                    {/* Thumbnail */}
                    <td className="px-3 py-2">
                      <div className="w-10 h-10 rounded-md overflow-hidden bg-app-elevated flex items-center justify-center text-xs text-txt-muted flex-shrink-0">
                        {imgUrl ? (
                          <img
                            src={imgUrl}
                            alt={product.identification?.name || ""}
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <svg className="w-4 h-4 text-txt-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
                          </svg>
                        )}
                      </div>
                    </td>

                    {/* Product name + brand */}
                    <td className="px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-txt-primary font-medium truncate max-w-xs">
                          {product.identification?.name || "Unbenannt"}
                        </div>
                        {product.identification?.brand && (
                          <div className="text-xs text-txt-muted truncate">
                            {product.identification.brand}
                          </div>
                        )}
                      </div>
                    </td>

                    {/* SKU */}
                    <td className="px-3 py-2">
                      <span className="text-txt-secondary text-xs font-mono">
                        {product.identification?.sku || "\u2014"}
                      </span>
                    </td>

                    {/* Lagerplatz */}
                    <td className="px-3 py-2">
                      {binCode ? (
                        <span
                          className={`inline-block text-xs font-medium px-2 py-0.5 rounded ${zoneColor(zone)}`}
                        >
                          {binCode}
                        </span>
                      ) : (
                        <span className="text-xs text-txt-muted">\u2014</span>
                      )}
                    </td>

                    {/* Menge */}
                    <td className="px-3 py-2 text-right">
                      <span
                        className={`font-bold tabular-nums ${
                          qty === 0
                            ? "text-txt-muted"
                            : qty < 5
                              ? "text-danger"
                              : "text-txt-primary"
                        }`}
                      >
                        {qty}
                      </span>
                    </td>

                    {/* Verfügbar */}
                    <td className="px-3 py-2 text-right">
                      <div>
                        <span className="text-txt-primary tabular-nums">{availableQty}</span>
                        {reservedQty > 0 && (
                          <div className="text-xs text-txt-muted tabular-nums">
                            {reservedQty} reserv.
                          </div>
                        )}
                      </div>
                    </td>

                    {/* EK */}
                    <td className="px-3 py-2 text-right">
                      <span className="text-txt-secondary tabular-nums">
                        {buyPrice > 0 ? `\u20AC${formatCurrency(buyPrice)}` : "\u2014"}
                      </span>
                    </td>

                    {/* Bestandswert */}
                    <td className="px-3 py-2 text-right">
                      <span className="text-txt-primary font-medium tabular-nums">
                        {rowValue > 0 ? `\u20AC${formatCurrency(rowValue)}` : "\u2014"}
                      </span>
                    </td>

                    {/* Marktplatz */}
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-center gap-1.5">
                        {ebayStatus === "active" && (
                          <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-app-elevated" title="eBay">
                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none">
                              <text x="2" y="17" fontSize="11" fontWeight="bold" fill="currentColor" className="text-txt-secondary">eB</text>
                            </svg>
                          </span>
                        )}
                        {kauflandStatus === "active" && (
                          <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-app-elevated" title="Kaufland">
                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none">
                              <text x="5" y="17" fontSize="12" fontWeight="bold" fill="currentColor" className="text-txt-secondary">K</text>
                            </svg>
                          </span>
                        )}
                        {ebayStatus !== "active" && kauflandStatus !== "active" && (
                          <span className="text-xs text-txt-muted">\u2014</span>
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
    </div>
  );
};

export default InventoryView;
