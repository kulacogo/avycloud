import React, { useState, useCallback, useEffect, useMemo } from "react";
import {
  fetchEbayLiveListings,
  syncEbayLiveListings,
  fetchEbayStatus,
  bulkUpdateEbayListings,
  syncKauflandListings,
  fetchKauflandListings,
  publishToEbay,
  publishToKaufland,
  bulkPublishToEbay,
  bulkPublishToKaufland,
  fetchProducts,
} from "../api/client";
import type { Product } from "../types";
import type { EbayListingRow, } from "../types";
import type { EbayConnectionStatus, KauflandListingRow } from "../api/client";

// ─── Types ───────────────────────────────────────────────────

interface MarketplaceListingsViewProps {
  marketplace: "ebay" | "kaufland";
}

type ListingStatus = "active" | "inactive" | "unknown";
type TabFilter = "all" | "active" | "inactive";

interface NormalizedListing {
  id: string;
  title: string;
  sku: string | null;
  ean: string | null;
  price: number | null;
  currency: string | null;
  quantity: number | null;
  status: ListingStatus;
  category: string | null;
  viewItemUrl: string | null;
  lastSync: string | null;
  errors?: string[];
  imageUrl?: string | null;
  brand?: string | null;
  warehouseStock: number | null;
  binLocation: string | null;
  stockMismatch: boolean;
}

// ─── Constants ───────────────────────────────────────────────

const STATUS_CONFIG: Record<ListingStatus, { label: string; bg: string; text: string }> = {
  active: { label: "Aktiv", bg: "bg-success-dim", text: "text-success" },
  inactive: { label: "Inaktiv", bg: "bg-app-elevated", text: "text-txt-muted" },
  unknown: { label: "Unbekannt", bg: "bg-app-elevated", text: "text-txt-muted" },
};

const TAB_LABELS: Record<TabFilter, string> = {
  all: "Alle",
  active: "Aktiv",
  inactive: "Inaktiv",
};

const MARKETPLACE_LABELS = {
  ebay: "eBay",
  kaufland: "Kaufland",
};

const PAGE_SIZE_OPTIONS = [25, 50, 100, 250] as const;

type SortKey = "title" | "price" | "quantity" | "status" | "category" | "lastSync";
type SortDir = "asc" | "desc";
type StockFilter = "all" | "inStock" | "low" | "empty";

// ─── Helpers ─────────────────────────────────────────────────

function formatPrice(price: number | null | undefined, currency?: string | null): string {
  if (price == null) return "—";
  return price.toLocaleString("de-DE", { style: "currency", currency: currency || "EUR" });
}

function formatRelativeTime(iso?: string | null): string {
  if (!iso) return "—";
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "—";
  const diff = Date.now() - ts;
  if (diff < 0) return "gerade eben";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "gerade eben";
  if (mins < 60) return `vor ${mins} Min.`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  const days = Math.floor(hours / 24);
  return `vor ${days} ${days === 1 ? "Tag" : "Tagen"}`;
}

function normalizeEbayStatus(row: EbayListingRow): ListingStatus {
  if (row.active === false || row.listingStatus === "Completed" || row.listingStatus === "Ended") return "inactive";
  if (row.active === true || row.listingStatus === "Active") return "active";
  return "unknown";
}

function normalizeEbayRow(row: EbayListingRow): NormalizedListing {
  return {
    id: row.itemId,
    title: row.title || row.sku || row.itemId,
    sku: row.sku || null,
    ean: (row as any).ean || null,
    price: row.currentPrice ?? null,
    currency: row.currency ?? null,
    quantity: row.quantityAvailable ?? null,
    status: normalizeEbayStatus(row),
    category: row.categoryName || (row.primaryCategoryId ? `Kat. ${row.primaryCategoryId}` : null),
    viewItemUrl: row.viewItemUrl || (row.itemId ? `https://www.ebay.de/itm/${row.itemId}` : null),
    lastSync: row.updatedAt || null,
    warehouseStock: row.warehouseStock ?? null,
    binLocation: row.binLocation ?? null,
    stockMismatch: row.stockMismatch === true,
  };
}

function normalizeKauflandRow(row: KauflandListingRow): NormalizedListing {
  let status: ListingStatus = "unknown";
  if (row.active === true) {
    status = "active";
  } else if (row.status != null) {
    // Map Kaufland unit statuses to our schema
    const s = String(row.status).toUpperCase();
    if (s === "AVAILABLE") status = "active";
    else status = "inactive"; // ONHOLD, DEACTIVATED, blocked, etc.
  }

  return {
    id: row.idUnit,
    title: row.title || row.sku || row.ean || row.idUnit,
    sku: row.sku,
    ean: row.ean || null,
    price: row.price,
    currency: "EUR",
    quantity: row.quantity ?? null,
    status,
    category: row.category || null,
    viewItemUrl: row.viewItemUrl || null,
    lastSync: row.updatedAt || null,
    imageUrl: row.imageUrl || null,
    brand: row.brand || null,
    warehouseStock: row.warehouseStock ?? null,
    binLocation: row.binLocation ?? null,
    stockMismatch: row.stockMismatch === true,
  };
}

// ─── Icons ───────────────────────────────────────────────────

const IconSync = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
  </svg>
);

const IconExternalLink = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
  </svg>
);

const IconSearch = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
  </svg>
);

const IconChevronLeft = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
  </svg>
);

const IconChevronRight = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
  </svg>
);

const IconWarning = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
  </svg>
);

// ─── Component ───────────────────────────────────────────────

export function MarketplaceListingsView({ marketplace }: MarketplaceListingsViewProps) {
  const [listings, setListings] = useState<NormalizedListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [stockFilter, setStockFilter] = useState<StockFilter>("all");
  const [syncing, setSyncing] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<EbayConnectionStatus | null>(null);
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [publishProducts, setPublishProducts] = useState<Product[]>([]);
  const [publishSearch, setPublishSearch] = useState("");
  const [publishLoading, setPublishLoading] = useState(false);
  const [publishSort, setPublishSort] = useState<"name" | "stock" | "bin">("name");
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [publishSelectedIds, setPublishSelectedIds] = useState<Set<string>>(new Set());
  const [bulkPublishing, setBulkPublishing] = useState(false);
  const [bulkPublishSummary, setBulkPublishSummary] = useState<{
    total: number; success: number; failed: number; failedNames: string[]; failedDetails: string[];
  } | null>(null);

  const label = MARKETPLACE_LABELS[marketplace];

  // ─── Data Loading ────────────────────────────────────────

  const loadEbayListings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rows, status] = await Promise.all([
        fetchEbayLiveListings({ limit: 2000, includeInactive: true }),
        fetchEbayStatus().catch(() => null),
      ]);
      const normalized = rows.map((r) => normalizeEbayRow(r));
      setListings(normalized);
      if (status) setConnectionStatus(status);
      setLastSyncTime(new Date().toISOString());
    } catch (err: any) {
      setError(err.message || "Fehler beim Laden der eBay-Listings");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadKauflandListings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchKauflandListings("de");
      const normalized = rows.map((r) => normalizeKauflandRow(r));
      setListings(normalized);
      setLastSyncTime(new Date().toISOString());
    } catch (err: any) {
      setError(err.message || "Fehler beim Laden der Kaufland-Listings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (marketplace === "ebay") {
      loadEbayListings();
    } else {
      loadKauflandListings();
    }
  }, [marketplace, loadEbayListings, loadKauflandListings]);

  // ─── Actions ─────────────────────────────────────────────

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      if (marketplace === "ebay") {
        await syncEbayLiveListings();
        await loadEbayListings();
      } else {
        await syncKauflandListings("de");
        await loadKauflandListings();
      }
    } catch (err: any) {
      setError(err.message || "Synchronisierung fehlgeschlagen");
    } finally {
      setSyncing(false);
    }
  }, [marketplace, loadEbayListings, loadKauflandListings]);

  const handleBulkUpdate = useCallback(async () => {
    if (marketplace !== "ebay" || selectedIds.size === 0) return;
    setBulkUpdating(true);
    setError(null);
    try {
      await bulkUpdateEbayListings({ itemIds: [...selectedIds] });
      setSelectedIds(new Set());
      await loadEbayListings();
    } catch (err: any) {
      setError(err.message || "Bulk-Update fehlgeschlagen");
    } finally {
      setBulkUpdating(false);
    }
  }, [marketplace, selectedIds, loadEbayListings]);

  const openPublishModal = useCallback(async () => {
    setShowPublishModal(true);
    setPublishSearch("");
    setPublishSort("name");
    setPublishResult(null);
    setPublishSelectedIds(new Set());
    setBulkPublishSummary(null);
    setPublishLoading(true);
    try {
      const products = await fetchProducts();
      // Nur Produkte die physisch im Lager sind: Bin-Zuordnung UND Bestand > 0
      const inStockProducts = products.filter((p) => {
        if (!Array.isArray(p.storageBins) || p.storageBins.length === 0) return false;
        const binStock = p.storageBins.reduce((sum, b) => sum + Number(b?.quantity || 0), 0);
        return binStock > 0;
      });
      // Bereits aktiv gelistete Produkte ausfiltern (SKU + EAN + listingStatus)
      const activeListings = listings.filter((l) => l.status === "active");
      const listedSkus = new Set(
        activeListings
          .filter((l) => l.sku)
          .map((l) => String(l.sku).toLowerCase())
      );
      const listedEans = new Set(
        activeListings
          .filter((l) => l.ean)
          .map((l) => String(l.ean).toLowerCase())
      );
      const notYetListed = inStockProducts.filter((p) => {
        // Check ops.listingStatus for current marketplace
        const mpStatus = p.ops?.listingStatus?.[marketplace];
        if (mpStatus === "active") return false;
        // Check SKU match against active listings
        const sku = String(p.identification?.sku || p.details?.identifiers?.sku || "").toLowerCase();
        if (sku && listedSkus.has(sku)) return false;
        // Check EAN match against active listings
        const ean = String(p.identification?.barcodes?.[0] || p.details?.identifiers?.ean || "").toLowerCase();
        if (ean && listedEans.has(ean)) return false;
        return true;
      });
      setPublishProducts(notYetListed);
    } catch {
      setPublishProducts([]);
    } finally {
      setPublishLoading(false);
    }
  }, [listings]);

  const handlePublish = useCallback(async (productId: string) => {
    setPublishingId(productId);
    setPublishResult(null);
    try {
      if (marketplace === "ebay") {
        await publishToEbay(productId);
        setPublishResult({ ok: true, message: "Erfolgreich auf eBay gelistet!" });
        loadEbayListings();
      } else {
        await publishToKaufland(productId);
        setPublishResult({ ok: true, message: "Erfolgreich auf Kaufland gelistet!" });
        loadKauflandListings();
      }
    } catch (err: any) {
      setPublishResult({ ok: false, message: err.message || "Veröffentlichung fehlgeschlagen" });
    } finally {
      setPublishingId(null);
    }
  }, [marketplace, loadEbayListings, loadKauflandListings]);

  const togglePublishSelect = useCallback((productId: string) => {
    setPublishSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  }, []);

  const togglePublishSelectAll = useCallback((visibleProducts: Product[]) => {
    setPublishSelectedIds((prev) => {
      const visibleIds = visibleProducts.map((p) => p.id);
      const allSelected = visibleIds.length > 0 && visibleIds.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allSelected) {
        visibleIds.forEach((id) => next.delete(id));
      } else {
        visibleIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }, []);

  const handleBulkPublish = useCallback(async () => {
    const ids = [...publishSelectedIds];
    if (!ids.length) return;

    setBulkPublishing(true);
    setBulkPublishSummary(null);
    setPublishResult(null);

    try {
      let summary: { total: number; success: number; failed: number };
      let failedNames: string[] = [];

      let failedDetails: string[] = [];

      if (marketplace === "ebay") {
        const result = await bulkPublishToEbay(ids);
        summary = result.summary;
        const failedResults = result.results.filter((r: any) => !r.ok);
        failedNames = failedResults.map((r: any) => {
          const prod = publishProducts.find((p) => p.id === r.productId);
          return prod?.identification?.name || r.productId;
        });
        failedDetails = failedResults.map((r: any) => {
          const prod = publishProducts.find((p) => p.id === r.productId);
          const name = prod?.identification?.name || r.productId;
          const reasons = Array.isArray(r.blockers) && r.blockers.length > 0 ? r.blockers.join(", ") : "Unbekannter Fehler";
          return `${name}: ${reasons}`;
        });
        loadEbayListings();
      } else {
        const result = await bulkPublishToKaufland(ids);
        summary = result.summary;
        const failedResults = result.results.filter((r) => !r.ok);
        failedNames = failedResults.map((r) => {
          const prod = publishProducts.find((p) => p.id === r.productId);
          return prod?.identification?.name || r.productId;
        });
        failedDetails = failedResults.map((r) => {
          const prod = publishProducts.find((p) => p.id === r.productId);
          const name = prod?.identification?.name || r.productId;
          const reasons = Array.isArray((r as any).blockers) && (r as any).blockers.length > 0 ? (r as any).blockers.join(", ") : "Unbekannter Fehler";
          return `${name}: ${reasons}`;
        });
        loadKauflandListings();
      }

      setBulkPublishSummary({ ...summary, failedNames, failedDetails });
      setPublishSelectedIds(new Set());
    } catch (err: any) {
      setPublishResult({
        ok: false,
        message: err.message || "Bulk-Veröffentlichung fehlgeschlagen",
      });
    } finally {
      setBulkPublishing(false);
    }
  }, [marketplace, publishSelectedIds, publishProducts, loadEbayListings, loadKauflandListings]);

  const getBinStock = useCallback((p: Product) => {
    if (!Array.isArray(p.storageBins)) return 0;
    return p.storageBins.reduce((sum, b) => sum + Number(b?.quantity || 0), 0);
  }, []);

  const filteredPublishProducts = useMemo(() => {
    let items = publishProducts;
    const q = publishSearch.trim().toLowerCase();
    if (q) {
      items = items.filter((p) => {
        const title = (p.identification?.name || "").toLowerCase();
        const sku = (p.identification?.sku || "").toLowerCase();
        const ean = (p.identification?.barcodes?.[0] || "").toLowerCase();
        return title.includes(q) || sku.includes(q) || ean.includes(q);
      });
    }
    const sorted = [...items].sort((a, b) => {
      if (publishSort === "stock") return getBinStock(b) - getBinStock(a);
      if (publishSort === "bin") {
        const binA = a.storageBins?.[0]?.code || "";
        const binB = b.storageBins?.[0]?.code || "";
        return binA.localeCompare(binB);
      }
      return (a.identification?.name || "").localeCompare(b.identification?.name || "");
    });
    return sorted.slice(0, 100);
  }, [publishProducts, publishSearch, publishSort, getBinStock]);

  // ─── Computed Data ───────────────────────────────────────

  const tabCounts = useMemo(() => {
    const counts: Record<TabFilter, number> = { all: 0, active: 0, inactive: 0 };
    listings.forEach((l) => {
      counts.all++;
      if (l.status === "active") counts.active++;
      else if (l.status === "inactive" || l.status === "unknown") counts.inactive++;
    });
    return counts;
  }, [listings]);

  const filteredListings = useMemo(() => {
    let result = listings;
    if (activeTab === "active") result = result.filter((l) => l.status === "active");
    else if (activeTab === "inactive") result = result.filter((l) => l.status === "inactive" || l.status === "unknown");

    if (stockFilter === "inStock") result = result.filter((l) => l.quantity != null && l.quantity > 3);
    else if (stockFilter === "low") result = result.filter((l) => l.quantity != null && l.quantity > 0 && l.quantity <= 3);
    else if (stockFilter === "empty") result = result.filter((l) => l.quantity != null && l.quantity <= 0);

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (l) =>
          l.title.toLowerCase().includes(q) ||
          l.id.toLowerCase().includes(q) ||
          l.sku?.toLowerCase().includes(q)
      );
    }

    if (sortKey) {
      result = [...result].sort((a, b) => {
        let aVal: any = a[sortKey];
        let bVal: any = b[sortKey];
        // Nulls always last
        if (aVal == null && bVal == null) return 0;
        if (aVal == null) return 1;
        if (bVal == null) return -1;
        if (typeof aVal === "string") aVal = aVal.toLowerCase();
        if (typeof bVal === "string") bVal = bVal.toLowerCase();
        const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        return sortDir === "asc" ? cmp : -cmp;
      });
    }

    return result;
  }, [listings, activeTab, searchQuery, stockFilter, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filteredListings.length / pageSize));
  const paginatedListings = filteredListings.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );

  const handleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => d === "asc" ? "desc" : "asc");
        return key;
      }
      setSortDir("asc");
      return key;
    });
    setCurrentPage(1);
  }, []);

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return null;
    return <span className="ml-1 text-accent">{sortDir === "asc" ? "↑" : "↓"}</span>;
  };

  const allVisibleSelected =
    paginatedListings.length > 0 && paginatedListings.every((l) => selectedIds.has(l.id));

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        paginatedListings.forEach((l) => next.delete(l.id));
      } else {
        paginatedListings.forEach((l) => next.add(l.id));
      }
      return next;
    });
  }, [allVisibleSelected, paginatedListings]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    setCurrentPage(1);
    setSelectedIds(new Set());
  }, [activeTab, searchQuery, stockFilter]);

  // ─── Loading State ───────────────────────────────────────

  if (loading) {
    return (
      <div className="p-6 space-y-6 animate-pulse">
        <div className="h-8 w-64 bg-app-elevated rounded-lg" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-app-surface border border-app-border rounded-xl p-4 h-20" />
          ))}
        </div>
        <div className="bg-app-surface border border-app-border rounded-xl p-4 h-12" />
        <div className="bg-app-surface border border-app-border rounded-xl h-96" />
      </div>
    );
  }

  // ─── Error State ─────────────────────────────────────────

  if (error && listings.length === 0) {
    return (
      <div className="p-6">
        <div className="bg-danger-dim border border-app-border rounded-xl p-6 text-center">
          <p className="text-danger font-semibold mb-2">Fehler beim Laden der {label}-Listings</p>
          <p className="text-txt-secondary text-sm mb-4">{error}</p>
          <button
            onClick={() => {
              setError(null);
              if (marketplace === "ebay") loadEbayListings();
              else loadKauflandListings();
            }}
            className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Erneut versuchen
          </button>
        </div>
      </div>
    );
  }

  // ─── Render ──────────────────────────────────────────────

  return (
    <div className="p-6 space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-app-elevated border border-app-border rounded-xl flex items-center justify-center text-txt-secondary font-bold text-sm">
            {marketplace === "ebay" ? "eB" : "KL"}
          </div>
          <div>
            <h1 className="text-xl font-bold text-txt-primary">{label} Listings</h1>
            <p className="text-sm text-txt-muted">
              {listings.length} Listings · {tabCounts.active} aktiv
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Connection status for eBay — only show "Verbunden" */}
          {marketplace === "ebay" && connectionStatus?.connected && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-success-dim text-success">
              <span className="w-2 h-2 rounded-full bg-current" />
              Verbunden
            </span>
          )}
          <button
            onClick={openPublishModal}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-accent rounded-lg hover:opacity-90 transition-opacity"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Artikel listen
          </button>
        </div>
      </div>

      {/* Inline error banner */}
      {error && listings.length > 0 && (
        <div className="bg-danger-dim border border-app-border rounded-xl px-4 py-3 flex items-center gap-3">
          <span className="text-danger"><IconWarning /></span>
          <span className="text-sm text-danger flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-txt-muted hover:text-txt-primary text-sm">
            Schließen
          </button>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-app-surface border border-app-border rounded-xl p-4">
          <div className="text-sm text-txt-muted mb-1">Gesamt</div>
          <div className="text-2xl font-bold text-txt-primary">{listings.length}</div>
        </div>
        <div className="bg-app-surface border border-app-border rounded-xl p-4">
          <div className="text-sm text-txt-muted mb-1">Aktiv</div>
          <div className="text-2xl font-bold text-success">{tabCounts.active}</div>
        </div>
        <div className="bg-app-surface border border-app-border rounded-xl p-4">
          <div className="text-sm text-txt-muted mb-1">Inaktiv</div>
          <div className="text-2xl font-bold text-txt-primary">{tabCounts.inactive}</div>
        </div>
        <div className="bg-app-surface border border-app-border rounded-xl p-4">
          <div className="text-sm text-txt-muted mb-1">Bestandsabweichungen</div>
          <div className={`text-2xl font-bold ${
            listings.filter((l) => l.stockMismatch).length > 0 ? "text-warning" : "text-txt-primary"
          }`}>
            {listings.filter((l) => l.stockMismatch).length}
          </div>
          {listings.filter((l) => l.warehouseStock === 0).length > 0 && (
            <div className="text-xs text-danger mt-0.5">
              {listings.filter((l) => l.warehouseStock === 0).length} nicht auf Lager
            </div>
          )}
        </div>
      </div>

      {/* Sync Status Banner */}
      <div className="bg-app-surface border border-app-border rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4 text-sm text-txt-secondary">
          <span>
            Letzter Sync:{" "}
            <span className="text-txt-primary font-medium">
              {formatRelativeTime(lastSyncTime)}
            </span>
          </span>
        </div>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-accent bg-accent-dim rounded-lg hover:opacity-80 transition-opacity disabled:opacity-50"
        >
          <span className={syncing ? "animate-spin" : ""}>
            <IconSync />
          </span>
          {syncing ? "Synchronisiere..." : "Jetzt synchronisieren"}
        </button>
      </div>

      {/* Tab Bar */}
      <div className="flex gap-1 border-b border-app-border overflow-x-auto">
        {(Object.keys(TAB_LABELS) as TabFilter[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
              activeTab === tab
                ? "border-accent text-accent"
                : "border-transparent text-txt-muted hover:text-txt-secondary"
            }`}
          >
            {TAB_LABELS[tab]}
            <span
              className={`ml-1.5 px-1.5 py-0.5 rounded-full text-xs ${
                activeTab === tab ? "bg-accent-dim text-accent" : "bg-app-elevated text-txt-muted"
              }`}
            >
              {tabCounts[tab]}
            </span>
          </button>
        ))}
      </div>

      {/* Search Row */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-txt-muted">
            <IconSearch />
          </span>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={`${label} Listings durchsuchen (Titel, ID, SKU)...`}
            className="w-full pl-10 pr-4 py-2 bg-app-surface border border-app-border rounded-lg text-sm text-txt-primary placeholder:text-txt-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors"
          />
        </div>
        <select
          value={stockFilter}
          onChange={(e) => { setStockFilter(e.target.value as StockFilter); setCurrentPage(1); }}
          className="px-3 py-2 bg-app-surface border border-app-border rounded-lg text-sm text-txt-primary focus:outline-none focus:ring-2 focus:ring-accent/30"
        >
          <option value="all">Alle Bestände</option>
          <option value="inStock">Auf Lager (&gt;3)</option>
          <option value="low">Niedrig (1–3)</option>
          <option value="empty">Leer (0)</option>
        </select>
      </div>

      {/* Bulk Actions Bar */}
      {selectedIds.size > 0 && (
        <div className="bg-accent-dim border border-app-border rounded-xl px-4 py-3 flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-accent">{selectedIds.size} ausgewählt</span>
          <div className="flex items-center gap-2 ml-auto">
            {marketplace === "ebay" && (
              <button
                onClick={handleBulkUpdate}
                disabled={bulkUpdating}
                className="px-3 py-1.5 text-sm font-medium text-txt-primary bg-app-surface border border-app-border rounded-lg hover:bg-app-elevated transition-colors disabled:opacity-50"
              >
                {bulkUpdating ? "Aktualisiere..." : "Listings aktualisieren"}
              </button>
            )}
            <button
              onClick={() => setSelectedIds(new Set())}
              className="px-3 py-1.5 text-sm font-medium text-txt-muted bg-app-surface border border-app-border rounded-lg hover:bg-app-elevated transition-colors"
            >
              Auswahl aufheben
            </button>
          </div>
        </div>
      )}

      {/* Data Table or Empty State */}
      {filteredListings.length === 0 ? (
        <div className="bg-app-surface border border-app-border rounded-xl p-12 text-center">
          <div className="w-16 h-16 mx-auto mb-4 bg-app-elevated rounded-full flex items-center justify-center text-txt-muted">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
          </div>
          <p className="text-txt-primary font-medium mb-1">Keine {label} Listings gefunden</p>
          <p className="text-txt-muted text-sm mb-4">
            {searchQuery ? "Versuche eine andere Suchanfrage." : "Klicke auf \"Jetzt synchronisieren\" um Listings zu laden."}
          </p>
          {!searchQuery && (
            <button
              onClick={handleSync}
              disabled={syncing}
              className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {syncing ? "Synchronisiere..." : "Jetzt synchronisieren"}
            </button>
          )}
        </div>
      ) : (
        <div className="bg-app-surface border border-app-border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-app-border bg-app-bg">
                  <th className="px-4 py-3 text-left w-10">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleSelectAll}
                      className="rounded border-app-border accent-accent"
                    />
                  </th>
                  <th className="px-4 py-3 text-left text-txt-muted font-medium cursor-pointer select-none hover:text-txt-primary" onClick={() => handleSort("title")}>
                    Titel / SKU{sortIndicator("title")}
                  </th>
                  <th className="px-4 py-3 text-left text-txt-muted font-medium hidden md:table-cell">
                    Listing-ID
                  </th>
                  <th className="px-4 py-3 text-right text-txt-muted font-medium cursor-pointer select-none hover:text-txt-primary" onClick={() => handleSort("price")}>
                    Preis{sortIndicator("price")}
                  </th>
                  <th className="px-4 py-3 text-right text-txt-muted font-medium cursor-pointer select-none hover:text-txt-primary" onClick={() => handleSort("quantity")}>
                    Marktplatz{sortIndicator("quantity")}
                  </th>
                  <th className="px-4 py-3 text-right text-txt-muted font-medium hidden sm:table-cell">Lager</th>
                  <th className="px-4 py-3 text-left text-txt-muted font-medium cursor-pointer select-none hover:text-txt-primary" onClick={() => handleSort("status")}>
                    Status{sortIndicator("status")}
                  </th>
                  <th className="px-4 py-3 text-left text-txt-muted font-medium hidden md:table-cell cursor-pointer select-none hover:text-txt-primary" onClick={() => handleSort("category")}>
                    Kategorie{sortIndicator("category")}
                  </th>
                  <th className="px-4 py-3 text-left text-txt-muted font-medium hidden lg:table-cell cursor-pointer select-none hover:text-txt-primary" onClick={() => handleSort("lastSync")}>
                    Letztes Update{sortIndicator("lastSync")}
                  </th>
                  <th className="px-4 py-3 text-right text-txt-muted font-medium w-20">Link</th>
                </tr>
              </thead>
              <tbody>
                {paginatedListings.map((listing) => {
                  const statusCfg = STATUS_CONFIG[listing.status];
                  return (
                    <tr
                      key={listing.id}
                      className="border-b border-app-border last:border-b-0 hover:bg-app-bg/50 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(listing.id)}
                          onChange={() => toggleSelect(listing.id)}
                          className="rounded border-app-border accent-accent"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          {listing.imageUrl && (
                            <img
                              src={listing.imageUrl}
                              alt=""
                              className="w-8 h-8 rounded object-cover flex-shrink-0 bg-app-elevated"
                              loading="lazy"
                            />
                          )}
                          <div className="min-w-0">
                            <span
                              className="text-txt-primary font-medium truncate block max-w-[280px]"
                              title={listing.title}
                            >
                              {listing.title}
                            </span>
                            <div className="flex items-center gap-2 mt-0.5">
                              {listing.sku && (
                                <span className="text-xs text-txt-muted font-mono truncate max-w-[200px]">
                                  SKU: {listing.sku}
                                </span>
                              )}
                              {listing.brand && (
                                <span className="text-xs text-txt-muted truncate">
                                  {listing.brand}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <span className="text-txt-secondary text-xs font-mono">
                          {listing.id}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="text-txt-primary font-medium">
                          {formatPrice(listing.price, listing.currency)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className={`font-medium ${
                          listing.quantity != null && listing.quantity <= 0 ? "text-danger" :
                          listing.quantity != null && listing.quantity <= 3 ? "text-warning" :
                          "text-txt-primary"
                        }`}>
                          {listing.quantity != null ? listing.quantity : "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right hidden sm:table-cell">
                        <div className="flex items-center justify-end gap-1.5">
                          <span className={`font-medium ${
                            listing.warehouseStock === 0 ? "text-danger" :
                            listing.warehouseStock != null && listing.warehouseStock <= 3 ? "text-warning" :
                            listing.warehouseStock != null ? "text-txt-primary" : "text-txt-muted"
                          }`}>
                            {listing.warehouseStock != null ? listing.warehouseStock : "—"}
                          </span>
                          {listing.stockMismatch && (
                            <span
                              className="inline-flex px-1 py-0.5 rounded text-[10px] font-semibold bg-warning-dim text-warning"
                              title={`Marktplatz: ${listing.quantity ?? '—'}, Lager: ${listing.warehouseStock ?? '—'}`}
                            >
                              ≠
                            </span>
                          )}
                          {listing.warehouseStock === 0 && (
                            <span
                              className="inline-flex px-1 py-0.5 rounded text-[10px] font-semibold bg-danger-dim text-danger"
                              title="Nicht auf Lager"
                            >
                              !
                            </span>
                          )}
                          {listing.status === "inactive" && listing.warehouseStock != null && listing.warehouseStock > 0 && (
                            <span
                              className="inline-flex px-1 py-0.5 rounded text-[10px] font-semibold bg-warning-dim text-warning"
                              title="Lagerbestand vorhanden, aber Listing inaktiv"
                            >
                              ⚠
                            </span>
                          )}
                        </div>
                        {listing.binLocation && (
                          <div className="text-[10px] text-txt-muted mt-0.5 font-mono">
                            {listing.binLocation}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${statusCfg.bg} ${statusCfg.text}`}
                        >
                          {statusCfg.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <span className="text-txt-secondary text-xs truncate max-w-[150px] inline-block">
                          {listing.category || "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-txt-muted hidden lg:table-cell whitespace-nowrap">
                        {formatRelativeTime(listing.lastSync)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end">
                          {listing.viewItemUrl && (
                            <a
                              href={listing.viewItemUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Auf Marktplatz ansehen"
                              className="p-1.5 rounded-lg text-txt-muted hover:text-txt-primary hover:bg-app-elevated transition-colors"
                            >
                              <IconExternalLink />
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

          {/* Pagination */}
          <div className="flex items-center justify-between px-4 py-3 border-t border-app-border">
            <div className="flex items-center gap-3">
              <span className="text-sm text-txt-muted">
                Zeige {(currentPage - 1) * pageSize + 1}–
                {Math.min(currentPage * pageSize, filteredListings.length)} von{" "}
                {filteredListings.length}
              </span>
              <select
                value={pageSize}
                onChange={(e) => { setPageSize(Number(e.target.value)); setCurrentPage(1); }}
                className="px-2 py-1 bg-app-bg border border-app-border rounded text-xs text-txt-secondary focus:outline-none"
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>{n} pro Seite</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1">
              <button
                disabled={currentPage <= 1}
                onClick={() => setCurrentPage((p) => p - 1)}
                className="p-1.5 rounded-lg text-txt-muted hover:text-txt-primary hover:bg-app-elevated transition-colors disabled:opacity-30 disabled:pointer-events-none"
              >
                <IconChevronLeft />
              </button>
              <span className="px-3 py-1 text-sm text-txt-secondary">
                {currentPage} / {totalPages}
              </span>
              <button
                disabled={currentPage >= totalPages}
                onClick={() => setCurrentPage((p) => p + 1)}
                className="p-1.5 rounded-lg text-txt-muted hover:text-txt-primary hover:bg-app-elevated transition-colors disabled:opacity-30 disabled:pointer-events-none"
              >
                <IconChevronRight />
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Publish Modal */}
      {showPublishModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => !bulkPublishing && setShowPublishModal(false)} />
          <div className="relative bg-app-surface border border-app-border rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-app-border">
              <div className="flex items-center gap-3">
                {!publishLoading && filteredPublishProducts.length > 0 && (
                  <input
                    type="checkbox"
                    checked={filteredPublishProducts.length > 0 && filteredPublishProducts.every((p) => publishSelectedIds.has(p.id))}
                    onChange={() => togglePublishSelectAll(filteredPublishProducts)}
                    className="w-4 h-4 rounded border-app-border text-accent focus:ring-accent/30 cursor-pointer"
                    disabled={bulkPublishing}
                  />
                )}
                <div>
                  <h2 className="text-lg font-bold text-txt-primary">Artikel auf {label} listen</h2>
                  <p className="text-xs text-txt-muted">Nur Artikel mit Lagerbestand</p>
                </div>
              </div>
              <button
                onClick={() => setShowPublishModal(false)}
                className="text-txt-muted hover:text-txt-primary p-1"
                disabled={bulkPublishing}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Result banners */}
            {publishResult && (
              <div className={`mx-5 mt-4 px-3 py-2 rounded-lg text-sm ${publishResult.ok ? "bg-success-dim text-success" : "bg-danger-dim text-danger"}`}>
                {publishResult.message}
              </div>
            )}
            {bulkPublishSummary && (
              <div className={`mx-5 mt-4 px-3 py-2 rounded-lg text-sm ${
                bulkPublishSummary.failed === 0 ? "bg-success-dim text-success" : "bg-warning-dim text-warning"
              }`}>
                <div className="font-medium">
                  {bulkPublishSummary.success} von {bulkPublishSummary.total} erfolgreich gelistet
                  {bulkPublishSummary.failed > 0 && `, ${bulkPublishSummary.failed} fehlgeschlagen`}
                </div>
                {bulkPublishSummary.failedDetails && bulkPublishSummary.failedDetails.length > 0 ? (
                  <div className="mt-2 text-xs space-y-1 max-h-40 overflow-y-auto">
                    {bulkPublishSummary.failedDetails.slice(0, 10).map((detail, i) => (
                      <div key={i} className="opacity-90">{detail}</div>
                    ))}
                    {bulkPublishSummary.failedDetails.length > 10 && (
                      <div className="opacity-60">+{bulkPublishSummary.failedDetails.length - 10} weitere</div>
                    )}
                  </div>
                ) : bulkPublishSummary.failedNames.length > 0 && (
                  <div className="mt-1 text-xs opacity-80">
                    Fehlgeschlagen: {bulkPublishSummary.failedNames.slice(0, 5).join(", ")}
                    {bulkPublishSummary.failedNames.length > 5 && ` (+${bulkPublishSummary.failedNames.length - 5} weitere)`}
                  </div>
                )}
              </div>
            )}

            {/* Search */}
            <div className="px-5 pt-4">
              <input
                type="text"
                value={publishSearch}
                onChange={(e) => setPublishSearch(e.target.value)}
                placeholder="Produkt suchen (Titel, SKU, EAN)..."
                className="w-full px-3 py-2 bg-app-bg border border-app-border rounded-lg text-sm text-txt-primary placeholder:text-txt-muted focus:outline-none focus:ring-2 focus:ring-accent/30"
                autoFocus
                disabled={bulkPublishing}
              />
            </div>

            {/* Sort controls */}
            {!publishLoading && publishProducts.length > 0 && (
              <div className="px-5 pt-3 flex items-center gap-1.5">
                <span className="text-xs text-txt-muted mr-1">Sortieren:</span>
                {([
                  ["name", "Name"],
                  ["stock", "Bestand"],
                  ["bin", "Lagerplatz"],
                ] as const).map(([key, lbl]) => (
                  <button
                    key={key}
                    onClick={() => setPublishSort(key)}
                    className={`px-2 py-1 text-xs rounded-md transition-colors ${
                      publishSort === key
                        ? "bg-accent/15 text-accent font-medium"
                        : "text-txt-muted hover:text-txt-primary hover:bg-app-elevated"
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
                <span className="ml-auto text-xs text-txt-muted">
                  {filteredPublishProducts.length} Artikel
                </span>
              </div>
            )}

            {/* Product list */}
            <div className="flex-1 overflow-y-auto px-5 py-3 space-y-1">
              {publishLoading ? (
                <div className="text-center text-txt-muted py-8">Lade Produkte…</div>
              ) : filteredPublishProducts.length === 0 ? (
                <div className="text-center text-txt-muted py-8">Keine Produkte gefunden</div>
              ) : (
                filteredPublishProducts.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-app-elevated transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={publishSelectedIds.has(p.id)}
                      onChange={() => togglePublishSelect(p.id)}
                      className="w-4 h-4 rounded border-app-border text-accent focus:ring-accent/30 flex-shrink-0 cursor-pointer"
                      disabled={bulkPublishing}
                    />
                    {p.details?.images?.[0]?.url_or_base64 ? (
                      <img src={p.details.images[0].url_or_base64} alt="" className="w-10 h-10 rounded-md object-cover flex-shrink-0" />
                    ) : (
                      <div className="w-10 h-10 rounded-md bg-app-elevated flex items-center justify-center text-txt-muted text-xs flex-shrink-0">—</div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-txt-primary font-medium truncate">{p.identification?.name || "Ohne Titel"}</div>
                      <div className="text-xs text-txt-muted">
                        {p.identification?.sku && <span>SKU: {p.identification.sku}</span>}
                        {p.identification?.barcodes?.[0] && <span className="ml-2">EAN: {p.identification.barcodes[0]}</span>}
                      </div>
                      <div className="text-xs text-txt-muted mt-0.5">
                        <span className="text-success font-medium">
                          Bestand: {getBinStock(p)}
                        </span>
                        {p.storageBins?.filter((b) => Number(b?.quantity || 0) > 0).map((b) => (
                          <span key={b.code} className="ml-2 px-1.5 py-0.5 bg-app-elevated rounded text-[10px]">
                            {b.code} ({b.quantity})
                          </span>
                        ))}
                      </div>
                    </div>
                    <button
                      onClick={() => handlePublish(p.id)}
                      disabled={publishingId === p.id || bulkPublishing}
                      className="flex-shrink-0 px-3 py-1.5 text-xs font-medium text-white bg-accent rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
                    >
                      {publishingId === p.id ? "Wird gelistet…" : "Listen"}
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Bulk publish footer */}
            {publishSelectedIds.size > 0 && (
              <div className="px-5 py-3 border-t border-app-border flex items-center justify-between">
                <span className="text-sm text-txt-muted">
                  {publishSelectedIds.size} ausgewählt
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPublishSelectedIds(new Set())}
                    disabled={bulkPublishing}
                    className="px-3 py-1.5 text-sm font-medium text-txt-muted hover:text-txt-primary transition-colors disabled:opacity-50"
                  >
                    Auswahl aufheben
                  </button>
                  <button
                    onClick={handleBulkPublish}
                    disabled={bulkPublishing}
                    className="px-4 py-1.5 text-sm font-medium text-white bg-accent rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
                  >
                    {bulkPublishing
                      ? "Wird gelistet…"
                      : `${publishSelectedIds.size} Artikel listen`}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default MarketplaceListingsView;
