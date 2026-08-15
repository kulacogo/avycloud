import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Product } from "../types";
import { fetchProducts, fetchEbaySkuIndex, fetchKauflandSkuIndex } from "../api/client";
import { READINESS_LABELS, normalizeReadiness } from "../utils/readiness";
import { getProductBinCode, getProductBinZone } from "../utils/product";
import { exportToCsv } from "../utils/csv-export";
import {
  buildInventoryExport,
  buildInventoryExportFilename,
  loadInventoryExportPreferences,
  saveInventoryExportPreferences,
  type InventoryExportPreferences,
} from "../utils/inventory-export";
import InventoryExportDialog, { type InventoryExportScope } from "./inventory/InventoryExportDialog";
import { Spinner } from "./Spinner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InventoryViewProps {
  onNavigate?: (view: string) => void;
  onSelectProduct?: (product: Product) => void;
}

type QuickFilterKey = "all" | "low" | "nobin" | "stale" | "listed" | "unlisted" | "listingErrors" | "ready" | "in_progress" | "pending" | "sold" | "unsold" | "listingReady";
type SortField = "name" | "sku" | "quantity" | "available" | "buyPrice" | "value" | "binCode" | "marketplace";
type SortDir = "asc" | "desc";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const primaryImage = (product: Product): string | null => {
  for (const img of product.details?.images || []) {
    const raw = (img as any).url_or_base64;
    const src = typeof raw === "string" ? raw
      : raw && typeof raw === "object" && typeof raw.url === "string" ? raw.url
      : typeof (img as any).url === "string" ? (img as any).url
      : null;
    if (src && src.startsWith("http")) return src;
  }
  return null;
};

// Lagerplatz-Aufloesung liegt in utils/product.ts, damit die CSV-Ausgabe
// garantiert dieselben Werte zeigt wie diese Tabelle.
const getBinCode = getProductBinCode;
const getBinZone = getProductBinZone;

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
  // Marketplace listing index: productId → isListed
  const [ebayListedProductIds, setEbayListedProductIds] = useState<Set<string>>(new Set());
  const [kauflandListedSkus, setKauflandListedSkus] = useState<Set<string>>(new Set());
  const [kauflandListedEans, setKauflandListedEans] = useState<Set<string>>(new Set());

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

  // ---- Marketplace index loading ----
  useEffect(() => {
    fetchEbaySkuIndex()
      .then((entries) => {
        const pids = new Set<string>();
        entries.forEach((e) => { if (e.productId) pids.add(String(e.productId)); });
        setEbayListedProductIds(pids);
      })
      .catch(() => {/* non-blocking */});
  }, []);

  useEffect(() => {
    fetchKauflandSkuIndex('de')
      .then((entries) => {
        const skus = new Set<string>();
        const eans = new Set<string>();
        entries.forEach((e) => {
          const sku = String(e.skuNormalized || e.sku || '').trim().toUpperCase();
          if (sku) skus.add(sku);
          const ean = String(e.ean || '').replace(/\D+/g, '').trim();
          if (ean) eans.add(ean);
          (Array.isArray(e.eans) ? e.eans : []).forEach((v: string) => {
            const n = String(v || '').replace(/\D+/g, '').trim();
            if (n) eans.add(n);
          });
        });
        setKauflandListedSkus(skus);
        setKauflandListedEans(eans);
      })
      .catch(() => {/* non-blocking */});
  }, []);

  // ---- Marketplace status helper ----
  const getMarketplaceInfo = useCallback((p: Product) => {
    const ebayStatus = p.ops?.listingStatus?.ebay;
    const kauflandStatus = p.ops?.listingStatus?.kaufland;
    const productSku = String(p.identification?.sku || '').trim().toUpperCase();
    const productEans = (() => {
      const raw = (p as any).identification?.ean || (p as any).identification?.barcode || '';
      return [raw, ...((p as any).identification?.eans || [])].map((v: string) => String(v || '').replace(/\D+/g, '').trim()).filter(Boolean);
    })();
    const isEbayActive = ebayStatus === 'active' || ebayListedProductIds.has(p.id);
    const isKauflandActive = kauflandStatus === 'active' || (productSku && kauflandListedSkus.has(productSku)) || productEans.some((e) => kauflandListedEans.has(e));
    const ebayValidation = p.marketplace_listings?.ebay?.validation;
    const kauflandValidation = p.marketplace_listings?.kaufland?.validation;
    // Boolean(): ohne Validierungsdaten war das Ergebnis vorher `undefined` und
    // damit nicht als Flag weiterreichbar (nur zufällig truthy-verträglich).
    const hasErrors = Boolean(
      (ebayValidation && !ebayValidation.ready) || (kauflandValidation && !kauflandValidation.ready)
    );
    const errorCount = (ebayValidation?.issues?.length ?? 0) + (kauflandValidation?.issues?.length ?? 0);
    const isListed = isEbayActive || isKauflandActive;
    return { isEbayActive, isKauflandActive, isListed, hasErrors, errorCount, ebayValidation, kauflandValidation };
  }, [ebayListedProductIds, kauflandListedSkus, kauflandListedEans]);

  // ---- KPI calculations ----
  const kpis = useMemo(() => {
    const withStock = products.filter((p) => (p.inventory?.quantity ?? 0) > 0);
    const totalProducts = withStock.length;
    const totalUnits = products.reduce((sum, p) => sum + (p.inventory?.quantity ?? 0), 0);
    const totalValue = products.reduce((sum, p) => {
      const qty = p.inventory?.quantity ?? 0;
      // BUG-074: Use buyPrice, fall back to lowest_price.amount (same as Dashboard)
      const buyPrice = p.details?.pricing?.buyPrice
        || (p.details?.pricing as any)?.lowest_price?.amount
        || 0;
      return sum + qty * buyPrice;
    }, 0);
    const lowStockCount = products.filter(isLowStock).length;
    const noBinCount = products.filter((p) => (p.inventory?.quantity ?? 0) > 0 && isNoBin(p)).length;
    const staleCount = products.filter((p) => (p.inventory?.quantity ?? 0) > 0 && isStale(p)).length;
    let listedCount = 0;
    let unlistedCount = 0;
    let listingErrorCount = 0;
    withStock.forEach((p) => {
      const info = getMarketplaceInfo(p);
      if (info.isListed) listedCount++;
      else unlistedCount++;
      if (info.hasErrors) listingErrorCount++;
    });

    let readyCount = 0;
    let pendingCount = 0;
    let inProgressCount = 0;
    let soldCount = 0;
    let unsoldCount = 0;
    let listingReadyCount = 0;
    withStock.forEach((p) => {
      const readiness = normalizeReadiness(p.ops?.readiness);
      if (readiness === "ready") readyCount++;
      else if (readiness === "in_progress") inProgressCount++;
      else pendingCount++;
      const isSold = (p.inventory?.soldQuantity ?? 0) > 0 || (p.inventory?.openOrderQuantity ?? 0) > 0;
      if (isSold) soldCount++;
      else unsoldCount++;
      const hasBin = !isNoBin(p);
      const info = getMarketplaceInfo(p);
      if (hasBin && !info.isListed && !isSold) listingReadyCount++;
    });

    return { totalProducts, totalUnits, totalValue, lowStockCount, noBinCount, staleCount, listedCount, unlistedCount, listingErrorCount, readyCount, pendingCount, inProgressCount, soldCount, unsoldCount, listingReadyCount };
  }, [products, getMarketplaceInfo]);

  // Inventar = was tatsächlich auf Lager ist. Basis für Tabelle UND Export.
  const stockProducts = useMemo(
    () => products.filter((p) => (p.inventory?.quantity ?? 0) > 0),
    [products]
  );

  // ---- Sorting ----
  const compareProducts = useCallback((a: Product, b: Product) => {
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
      case "buyPrice": {
        const aBuy = a.details?.pricing?.buyPrice || (a.details?.pricing as any)?.lowest_price?.amount || 0;
        const bBuy = b.details?.pricing?.buyPrice || (b.details?.pricing as any)?.lowest_price?.amount || 0;
        cmp = aBuy - bBuy;
        break;
      }
      case "value": {
        const aVal = (a.inventory?.quantity ?? 0) * (a.details?.pricing?.buyPrice || (a.details?.pricing as any)?.lowest_price?.amount || 0);
        const bVal = (b.inventory?.quantity ?? 0) * (b.details?.pricing?.buyPrice || (b.details?.pricing as any)?.lowest_price?.amount || 0);
        cmp = aVal - bVal;
        break;
      }
      case "binCode":
        cmp = (getBinCode(a) || "zzz").localeCompare(getBinCode(b) || "zzz", "de");
        break;
      case "marketplace": {
        const aInfo = getMarketplaceInfo(a);
        const bInfo = getMarketplaceInfo(b);
        // Listed first, then by channel count
        const aScore = (aInfo.isEbayActive ? 1 : 0) + (aInfo.isKauflandActive ? 1 : 0);
        const bScore = (bInfo.isEbayActive ? 1 : 0) + (bInfo.isKauflandActive ? 1 : 0);
        cmp = aScore - bScore;
        break;
      }
    }
    return sortDir === "asc" ? cmp : -cmp;
  }, [sortField, sortDir, getMarketplaceInfo]);

  // ---- Filtering ----
  const filteredProducts = useMemo(() => {
    let list = stockProducts;

    // Quick filter
    switch (quickFilter) {
      case "low":
        list = list.filter(isLowStock);
        break;
      case "nobin":
        list = list.filter((p) => isNoBin(p));
        break;
      case "stale":
        list = list.filter((p) => isStale(p));
        break;
      case "listed":
        list = list.filter((p) => getMarketplaceInfo(p).isListed);
        break;
      case "unlisted":
        list = list.filter((p) => !getMarketplaceInfo(p).isListed);
        break;
      case "listingErrors":
        list = list.filter((p) => getMarketplaceInfo(p).hasErrors);
        break;
      case "ready":
        list = list.filter((p) => normalizeReadiness(p.ops?.readiness) === "ready");
        break;
      case "in_progress":
        list = list.filter((p) => normalizeReadiness(p.ops?.readiness) === "in_progress");
        break;
      case "pending":
        list = list.filter((p) => normalizeReadiness(p.ops?.readiness) === "pending");
        break;
      case "sold":
        list = list.filter((p) => (p.inventory?.soldQuantity ?? 0) > 0 || (p.inventory?.openOrderQuantity ?? 0) > 0);
        break;
      case "unsold":
        list = list.filter((p) => (p.inventory?.soldQuantity ?? 0) === 0 && (p.inventory?.openOrderQuantity ?? 0) === 0);
        break;
      case "listingReady":
        list = list.filter((p) => !isNoBin(p) && !getMarketplaceInfo(p).isListed && (p.inventory?.soldQuantity ?? 0) === 0 && (p.inventory?.openOrderQuantity ?? 0) === 0);
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

    return [...list].sort(compareProducts);
  }, [stockProducts, quickFilter, searchQuery, compareProducts, getMarketplaceInfo]);

  // Gesamter Bestand in derselben Sortierung — Umfangsoption "Gesamter Bestand"
  // im Export-Dialog.
  const sortedStockProducts = useMemo(
    () => [...stockProducts].sort(compareProducts),
    [stockProducts, compareProducts]
  );

  // ---- CSV-Export ----
  const [exportOpen, setExportOpen] = useState(false);
  const [exportPrefs, setExportPrefs] = useState<InventoryExportPreferences>(() =>
    loadInventoryExportPreferences()
  );

  const filterActive = quickFilter !== "all" || searchQuery.trim().length > 0;

  const handleExport = useCallback(
    ({ scope, fields, numberFormat }: { scope: InventoryExportScope; fields: string[]; numberFormat: InventoryExportPreferences["numberFormat"] }) => {
      const list = scope === "all" ? sortedStockProducts : filteredProducts;
      const { headers, rows } = buildInventoryExport(
        list,
        fields,
        { marketplace: getMarketplaceInfo },
        numberFormat
      );
      exportToCsv(buildInventoryExportFilename(scope), headers, rows);
      const next: InventoryExportPreferences = { fields, numberFormat };
      saveInventoryExportPreferences(next);
      setExportPrefs(next);
      setExportOpen(false);
    },
    [sortedStockProducts, filteredProducts, getMarketplaceInfo]
  );

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
          <span className="w-px h-5 bg-app-border mx-1 self-center" />
          <QuickFilter
            label="Gelistet"
            active={quickFilter === "listed"}
            onClick={() => setQuickFilter("listed")}
            count={kpis.listedCount}
          />
          <QuickFilter
            label="Nicht gelistet"
            active={quickFilter === "unlisted"}
            onClick={() => setQuickFilter("unlisted")}
            count={kpis.unlistedCount}
          />
          {kpis.listingErrorCount > 0 && (
            <QuickFilter
              label="Listing-Fehler"
              active={quickFilter === "listingErrors"}
              onClick={() => setQuickFilter("listingErrors")}
              count={kpis.listingErrorCount}
              tone="warn"
            />
          )}
          <span className="w-px h-5 bg-app-border mx-1 self-center" />
          <QuickFilter
            label={READINESS_LABELS.ready}
            active={quickFilter === "ready"}
            onClick={() => setQuickFilter("ready")}
            count={kpis.readyCount}
          />
          <QuickFilter
            label={READINESS_LABELS.in_progress}
            active={quickFilter === "in_progress"}
            onClick={() => setQuickFilter("in_progress")}
            count={kpis.inProgressCount}
          />
          <QuickFilter
            label={READINESS_LABELS.pending}
            active={quickFilter === "pending"}
            onClick={() => setQuickFilter("pending")}
            count={kpis.pendingCount}
          />
          <span className="w-px h-5 bg-app-border mx-1 self-center" />
          <QuickFilter
            label="Verkauft"
            active={quickFilter === "sold"}
            onClick={() => setQuickFilter("sold")}
            count={kpis.soldCount}
          />
          <QuickFilter
            label="Unverkauft"
            active={quickFilter === "unsold"}
            onClick={() => setQuickFilter("unsold")}
            count={kpis.unsoldCount}
          />
          {kpis.listingReadyCount > 0 && (
            <>
              <span className="w-px h-5 bg-app-border mx-1 self-center" />
              <QuickFilter
                label="Listing-bereit"
                active={quickFilter === "listingReady"}
                onClick={() => setQuickFilter("listingReady")}
                count={kpis.listingReadyCount}
              />
            </>
          )}
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

      {/* Results count + Export */}
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-txt-muted">
          {filteredProducts.length} von {products.length} Artikeln
        </div>
        <button
          type="button"
          onClick={() => setExportOpen(true)}
          disabled={stockProducts.length === 0}
          className="inline-flex items-center gap-2 rounded-lg border border-app-border bg-app-surface text-txt-primary px-3 py-1.5 text-sm font-medium hover:bg-app-elevated transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
          </svg>
          Export
        </button>
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
                <th
                  className="px-3 py-3 w-28 font-medium text-txt-secondary cursor-pointer group text-center"
                  onClick={() => handleSort("marketplace")}
                >
                  <div className="flex items-center justify-center gap-1">
                    Marktplatz
                    <SortIcon field="marketplace" />
                  </div>
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
                const buyPrice = product.details?.pricing?.buyPrice
                  || (product.details?.pricing as any)?.lowest_price?.amount
                  || 0;
                const rowValue = qty * buyPrice;
                const binCode = getBinCode(product);
                const zone = getBinZone(product);
                const imgUrl = primaryImage(product);
                const mpInfo = getMarketplaceInfo(product);
                const { isEbayActive, isKauflandActive, hasErrors, ebayValidation, kauflandValidation } = mpInfo;

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
                            onError={(e) => {
                              const el = e.currentTarget;
                              el.style.display = "none";
                              if (el.parentElement) el.parentElement.textContent = "—";
                            }}
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
                        <span className="text-xs text-txt-muted">{"—"}</span>
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
                      <div className="flex flex-col items-center gap-1">
                        <div className="flex items-center gap-1.5">
                          {isEbayActive ? (
                            <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-success-dim text-success" title="eBay: Aktiv">
                              eB
                            </span>
                          ) : ebayValidation && !ebayValidation.ready ? (
                            <span
                              className="inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-danger-dim text-danger cursor-help"
                              title={`eBay: ${ebayValidation.issues.map((i) => i.message).join(', ')}`}
                            >
                              eB
                            </span>
                          ) : null}
                          {isKauflandActive ? (
                            <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-success-dim text-success" title="Kaufland: Aktiv">
                              K
                            </span>
                          ) : kauflandValidation && !kauflandValidation.ready ? (
                            <span
                              className="inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-danger-dim text-danger cursor-help"
                              title={`Kaufland: ${kauflandValidation.issues.map((i) => i.message).join(', ')}`}
                            >
                              K
                            </span>
                          ) : null}
                          {!isEbayActive && !isKauflandActive && !hasErrors && (
                            <span className="text-xs text-txt-muted">—</span>
                          )}
                        </div>
                        {hasErrors && (
                          <span className="text-[10px] text-danger flex items-center gap-0.5" title="Listing-Probleme vorhanden">
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                            </svg>
                            Fehler
                          </span>
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

      {/* Beim Öffnen frisch montiert, damit die gespeicherte Feldauswahl gelesen wird. */}
      {exportOpen && (
        <InventoryExportDialog
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          filteredCount={filteredProducts.length}
          totalCount={stockProducts.length}
          filterActive={filterActive}
          initialFields={exportPrefs.fields}
          initialNumberFormat={exportPrefs.numberFormat}
          onExport={handleExport}
        />
      )}
    </div>
  );
};

export default InventoryView;
