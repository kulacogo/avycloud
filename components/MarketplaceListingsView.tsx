import React, { useState, useCallback, useEffect, useMemo } from "react";
import {
  syncEbayLiveListings,
  fetchEbayStatus,
  bulkUpdateEbayListings,
  endEbayListing,
  syncKauflandListings,
  publishToEbay,
  publishToKaufland,
  bulkPublishToEbay,
  bulkPublishToKaufland,
  bulkUpdateKauflandUnits,
  bulkSetKauflandUnitStatus,
  fetchProducts,
  fetchIntegrationConfig,
  repairEbayListings,
  forceResyncStockBatch,
} from "../api/client";
import { useEbayListings, useKauflandListings } from "../hooks/useListings";
import { useQueryClient } from "@tanstack/react-query";
import type { Product } from "../types";
import type { EbayListingRow, } from "../types";
import type { EbayConnectionStatus, KauflandListingRow, IntegrationConfig } from "../api/client";
import { getProductAvailableQuantity, getProductReservedQuantity } from "../utils/product";

// ─── Types ───────────────────────────────────────────────────

interface MarketplaceListingsViewProps {
  marketplace: "ebay" | "kaufland";
}

type ListingStatus =
  | "live"
  | "indexing"
  | "active"
  | "paused"
  | "deactivated"
  | "blocked"
  | "in_review"
  | "inactive"
  | "unknown";
// "live" + "indexing" are granular Kaufland sub-states of "active":
//   live      → product.is_valid === true  (matches Kaufland Portal "Aktiv")
//   indexing  → product.is_valid === false (Kaufland still indexing, <24h)
//   active    → product.is_valid unknown   (legacy data fallback)
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
  live: { label: "Live", bg: "bg-success-dim", text: "text-success" },
  indexing: { label: "Indexierung läuft", bg: "bg-warning-dim", text: "text-warning" },
  // `active` remains as legacy/fallback (productValid unknown) — same colour
  // as `live` so old data renders identically until validity is cached.
  active: { label: "Aktiv", bg: "bg-success-dim", text: "text-success" },
  paused: { label: "Pausiert", bg: "bg-warning-dim", text: "text-warning" },
  deactivated: { label: "Deaktiviert", bg: "bg-app-elevated", text: "text-txt-muted" },
  blocked: { label: "Blockiert", bg: "bg-danger-dim", text: "text-danger" },
  in_review: { label: "In Prüfung", bg: "bg-warning-dim", text: "text-warning" },
  inactive: { label: "Inaktiv", bg: "bg-app-elevated", text: "text-txt-muted" },
  unknown: { label: "Unbekannt", bg: "bg-app-elevated", text: "text-txt-muted" },
};

// Granulare Kaufland-Status (alles außer "active") für KPI-Untertitel
const NON_ACTIVE_STATUSES: ListingStatus[] = [
  "paused",
  "deactivated",
  "blocked",
  "in_review",
  "inactive",
  "unknown",
];

const TAB_LABELS: Record<TabFilter, string> = {
  all: "Alle",
  active: "Aktiv",
  inactive: "Inaktiv",
};

const MARKETPLACE_LABELS = {
  ebay: "eBay",
  kaufland: "Kaufland",
};

/* ─── Policy Select (for publish modal) ─── */
const PolicySelect: React.FC<{
  label: string;
  items: Array<{ id: string | number; name: string }>;
  value: string;
  defaultId?: string | number | null;
  onChange: (value: string) => void;
}> = ({ label, items, value, defaultId, onChange }) => {
  const defaultLabel = defaultId
    ? items.find((i) => String(i.id) === String(defaultId))?.name || ""
    : "";
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-txt-muted w-24 shrink-0">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 px-2.5 py-1.5 text-xs bg-app-elevated border border-app-border rounded-lg text-txt-primary focus:outline-none focus:ring-1 focus:ring-accent"
      >
        <option value="">
          {defaultLabel ? `Standard: ${defaultLabel}` : "— Kein Standard —"}
        </option>
        {items.map((item) => (
          <option key={String(item.id)} value={String(item.id)}>
            {item.name} (ID: {item.id})
          </option>
        ))}
      </select>
    </div>
  );
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
  // active flag is the primary signal — set by the sync only when Kaufland's
  // /units API actually returned this unit with AVAILABLE in the latest run.
  // productValid (Kaufland product.is_valid) further splits active into Live
  // (Portal-Aktiv) vs Indexierung läuft (Kaufland-side quality indexing).
  // Status field is used only to disambiguate WHY a non-active listing is
  // inactive (paused vs deactivated vs blocked vs in-review vs stale ghost).
  const rawStatus = row.status != null ? String(row.status).trim().toUpperCase() : "";
  let status: ListingStatus = "unknown";

  if (row.active === true) {
    if (row.productValid === true) status = "live";
    else if (row.productValid === false) status = "indexing";
    else status = "active"; // legacy data with no validity check yet
  } else if (row.active === false) {
    if (rawStatus === "ONHOLD") status = "paused";
    else if (rawStatus === "DEACTIVATED") status = "deactivated";
    else if (rawStatus === "BLOCKED") status = "blocked";
    else if (rawStatus === "IN_REVIEW") status = "in_review";
    else status = "inactive"; // STALE, AVAILABLE-ghost, or unknown → catch-all
  } else if (rawStatus) {
    // Legacy data: active flag missing, fall back to status field.
    if (rawStatus === "AVAILABLE") status = "active";
    else if (rawStatus === "ONHOLD") status = "paused";
    else status = "inactive";
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
  const queryClient = useQueryClient();
  const ebayQuery = useEbayListings();
  const kauflandQuery = useKauflandListings("de");

  // Derive listings from React Query data
  const listings = useMemo<NormalizedListing[]>(() => {
    if (marketplace === "ebay") {
      return (ebayQuery.data ?? []).map((r) => normalizeEbayRow(r));
    }
    return (kauflandQuery.data ?? []).map((r: any) => normalizeKauflandRow(r));
  }, [marketplace, ebayQuery.data, kauflandQuery.data]);

  const activeQuery = marketplace === "ebay" ? ebayQuery : kauflandQuery;
  const loading = activeQuery.isLoading;
  const error = activeQuery.error ? (activeQuery.error as Error).message : null;
  const [repairing, setRepairing] = useState(false);
  const [repairResult, setRepairResult] = useState<string | null>(null);
  const [resyncingDrifts, setResyncingDrifts] = useState(false);
  const [resyncDriftsResult, setResyncDriftsResult] = useState<string | null>(null);
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
  const [endingItemId, setEndingItemId] = useState<string | null>(null);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [publishProducts, setPublishProducts] = useState<Product[]>([]);
  const [publishSearch, setPublishSearch] = useState("");
  const [publishLoading, setPublishLoading] = useState(false);
  const [publishSort, setPublishSort] = useState<"name" | "stock" | "bin" | "status">("name");
  const [publishStatusFilter, setPublishStatusFilter] = useState<"all" | "ready" | "pending" | "empty">("all");
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [publishSelectedIds, setPublishSelectedIds] = useState<Set<string>>(new Set());
  const [bulkPublishing, setBulkPublishing] = useState(false);
  const [bulkPublishSummary, setBulkPublishSummary] = useState<{
    total: number; success: number; failed: number;
    published?: number; fixed?: number; pending?: number; skipped?: number;
    failedNames: string[]; failedDetails: string[]; fixedDetails?: string[]; pendingDetails?: string[];
  } | null>(null);

  // Policy overrides for publish dialog
  const [policyConfig, setPolicyConfig] = useState<IntegrationConfig | null>(null);
  const [policyOverrides, setPolicyOverrides] = useState<Record<string, string>>({});
  const [showPolicyOverrides, setShowPolicyOverrides] = useState(false);

  const label = MARKETPLACE_LABELS[marketplace];

  // ─── Data Loading (via React Query — see useEbayListings/useKauflandListings) ──

  // Fetch eBay connection status on mount
  useEffect(() => {
    if (marketplace === "ebay") {
      fetchEbayStatus().then((s) => { if (s) setConnectionStatus(s); }).catch(() => {});
    }
  }, [marketplace]);

  // ─── Actions ─────────────────────────────────────────────

  const invalidateListings = useCallback(() => {
    return queryClient.invalidateQueries({ queryKey: ["listings"] });
  }, [queryClient]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      if (marketplace === "ebay") {
        await syncEbayLiveListings();
      } else {
        await syncKauflandListings("de");
      }
      await invalidateListings();
    } catch {
      // Error handled by React Query
    } finally {
      setSyncing(false);
    }
  }, [marketplace, invalidateListings]);

  const handleBulkUpdate = useCallback(async () => {
    if (marketplace !== "ebay" || selectedIds.size === 0) return;
    setBulkUpdating(true);
    try {
      await bulkUpdateEbayListings({ itemIds: [...selectedIds] });
      setSelectedIds(new Set());
      await invalidateListings();
    } catch {
      // Error handled by React Query
    } finally {
      setBulkUpdating(false);
    }
  }, [marketplace, selectedIds, invalidateListings]);

  const handleEndListing = useCallback(async (itemId: string) => {
    if (marketplace !== "ebay") return;
    if (!window.confirm(`Listing ${itemId} wirklich beenden? Dies kann nicht rueckgaengig gemacht werden.`)) return;
    setEndingItemId(itemId);
    try {
      await endEbayListing({ itemId });
      await invalidateListings();
    } catch {
      // Error handled by React Query
    } finally {
      setEndingItemId(null);
    }
  }, [marketplace, invalidateListings]);

  const openPublishModal = useCallback(async () => {
    setShowPublishModal(true);
    setPublishSearch("");
    setPublishSort("name");
    setPublishStatusFilter("all");
    setPublishResult(null);
    setPublishSelectedIds(new Set());
    setBulkPublishSummary(null);
    setPolicyOverrides({});
    setShowPolicyOverrides(false);
    setPublishLoading(true);
    // Load policy config in background
    fetchIntegrationConfig(marketplace === "ebay" ? "ebay" : "kaufland")
      .then((cfg) => setPolicyConfig(cfg))
      .catch(() => setPolicyConfig(null));
    try {
      const products = await fetchProducts();
      // Nur Produkte mit verfügbarem Bestand (physisch minus reserviert durch Bestellungen)
      const inStockProducts = products.filter((p) => {
        return getProductAvailableQuantity(p) > 0;
      });
      // Bereits aktiv gelistete Produkte ausfiltern (SKU + EAN + listingStatus)
      // "live" und "indexing" sind Kaufland-Sub-Status von "active" — auch
      // diese müssen rausgefiltert werden damit Produkte nicht doppelt gelistet
      // werden während Kaufland noch indexiert.
      const activeListings = listings.filter(
        (l) => l.status === "active" || l.status === "live" || l.status === "indexing"
      );
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
        const r = await publishToEbay(productId);
        const fixes = Array.isArray(r?.appliedFixes) && r.appliedFixes.length > 0 ? r.appliedFixes : null;
        setPublishResult({
          ok: true,
          message: fixes
            ? `Erfolgreich auf eBay gelistet. Automatisch korrigiert: ${fixes.join(", ")}`
            : "Erfolgreich auf eBay gelistet!",
        });
      } else {
        await publishToKaufland(productId);
        setPublishResult({ ok: true, message: "Erfolgreich auf Kaufland gelistet!" });
      }
      invalidateListings();
    } catch (err: any) {
      setPublishResult({ ok: false, message: err.message || "Veröffentlichung fehlgeschlagen" });
    } finally {
      setPublishingId(null);
    }
  }, [marketplace, invalidateListings]);

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
        // Build overrides from policy selection (only include non-empty values)
        const ebayOverrides: Record<string, string> = {};
        if (policyOverrides.shippingPolicyId) ebayOverrides.shippingProfileId = policyOverrides.shippingPolicyId;
        if (policyOverrides.returnPolicyId) ebayOverrides.returnProfileId = policyOverrides.returnPolicyId;
        if (policyOverrides.paymentPolicyId) ebayOverrides.paymentProfileId = policyOverrides.paymentPolicyId;
        const result = await bulkPublishToEbay(ids, Object.keys(ebayOverrides).length > 0 ? ebayOverrides : undefined);
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
        const ebayFixedResults = result.results.filter(
          (r: any) => r.ok && Array.isArray(r.appliedFixes) && r.appliedFixes.length > 0
        );
        const ebayFixedDetails = ebayFixedResults.map((r: any) => {
          const prod = publishProducts.find((p) => p.id === r.productId);
          const name = prod?.identification?.name || r.productId;
          const fixes = (r.appliedFixes as string[]).join(", ");
          return `${name}: ${fixes}`;
        });
        invalidateListings();
        setBulkPublishSummary({
          ...summary,
          failedNames,
          failedDetails,
          fixedDetails: ebayFixedDetails.length ? ebayFixedDetails : undefined,
        });
        setPublishSelectedIds(new Set());
        return;
      } else {
        // Build Kaufland overrides from policy selection
        const klOverrides: Record<string, string> = {};
        if (policyOverrides.shippingGroupId) klOverrides.shippingGroupId = policyOverrides.shippingGroupId;
        if (policyOverrides.warehouseId) klOverrides.warehouseId = policyOverrides.warehouseId;
        const result = await bulkPublishToKaufland(ids, "de", Object.keys(klOverrides).length > 0 ? klOverrides : undefined);
        summary = result.summary;
        const notOkResults = result.results.filter((r) => !r.ok);
        failedNames = notOkResults.map((r) => {
          const prod = publishProducts.find((p) => p.id === r.productId);
          return prod?.identification?.name || r.productId;
        });
        failedDetails = notOkResults.map((r) => {
          const prod = publishProducts.find((p) => p.id === r.productId);
          const name = prod?.identification?.name || r.productId;
          const reason = (r as any).reason || (r as any).error || "Unbekannter Fehler";
          const status = (r as any).status === "skipped" ? "Uebersprungen" : "Fehler";
          return `${name}: ${reason} (${status})`;
        });
        const fixedResults = result.results.filter((r: any) => r.ok && r.status === "fixed");
        const fixedDetails = fixedResults.map((r: any) => {
          const prod = publishProducts.find((p) => p.id === r.productId);
          const name = prod?.identification?.name || r.productId;
          const fixes = Array.isArray(r.fixes) ? r.fixes.join(", ") : "";
          return `${name}: ${fixes}`;
        });
        const pendingResults = result.results.filter((r: any) => r.status === "pending");
        const pendingDetails = pendingResults.map((r: any) => {
          const prod = publishProducts.find((p) => p.id === r.productId);
          const name = prod?.identification?.name || r.productId;
          return `${name}: Produktdaten eingereicht, spaeter erneut versuchen`;
        });
        invalidateListings();
        setBulkPublishSummary({
          ...summary,
          published: (summary as any).published,
          fixed: (summary as any).fixed,
          pending: (summary as any).pending,
          skipped: (summary as any).skipped,
          failedNames,
          failedDetails,
          fixedDetails,
          pendingDetails,
        });
        setPublishSelectedIds(new Set());
        return;
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
  }, [marketplace, publishSelectedIds, publishProducts, invalidateListings]);

  const getBinStock = useCallback((p: Product) => {
    return getProductAvailableQuantity(p);
  }, []);

  const getReadiness = (p: Product): "ready" | "pending" | "empty" => {
    // Products with no available stock (all reserved by orders) are not ready
    if (getProductAvailableQuantity(p) <= 0) return "empty";
    const r = p.ops?.readiness;
    if (r === "ready") return "ready";
    if (r === "pending") return "pending";
    return "empty";
  };

  const filteredPublishProducts = useMemo(() => {
    let items = publishProducts;
    // Text search
    const q = publishSearch.trim().toLowerCase();
    if (q) {
      items = items.filter((p) => {
        const title = (p.identification?.name || "").toLowerCase();
        const sku = (p.identification?.sku || "").toLowerCase();
        const ean = (p.identification?.barcodes?.[0] || "").toLowerCase();
        return title.includes(q) || sku.includes(q) || ean.includes(q);
      });
    }
    // Status filter
    if (publishStatusFilter !== "all") {
      items = items.filter((p) => getReadiness(p) === publishStatusFilter);
    }
    const sorted = [...items].sort((a, b) => {
      if (publishSort === "stock") return getBinStock(b) - getBinStock(a);
      if (publishSort === "bin") {
        const binA = a.storageBins?.[0]?.code || "";
        const binB = b.storageBins?.[0]?.code || "";
        return binA.localeCompare(binB);
      }
      if (publishSort === "status") {
        const order = { ready: 0, pending: 1, empty: 2 };
        return order[getReadiness(a)] - order[getReadiness(b)];
      }
      return (a.identification?.name || "").localeCompare(b.identification?.name || "");
    });
    return sorted.slice(0, 100);
  }, [publishProducts, publishSearch, publishSort, publishStatusFilter, getBinStock]);

  // ─── Computed Data ───────────────────────────────────────

  const tabCounts = useMemo(() => {
    const counts: Record<TabFilter, number> = { all: 0, active: 0, inactive: 0 };
    const byStatus: Record<ListingStatus, number> = {
      live: 0,
      indexing: 0,
      active: 0,
      paused: 0,
      deactivated: 0,
      blocked: 0,
      in_review: 0,
      inactive: 0,
      unknown: 0,
    };
    // Granulare Sub-Counts: `live` matches Kaufland Portal "Aktiv"; `indexing`
    // is Kaufland-side quality indexing (<24h, not yet shown as Aktiv in
    // Portal); `active` (no productValid signal) folds into the `active` tab
    // for backwards-compat.
    let live = 0;
    let indexing = 0;
    listings.forEach((l) => {
      counts.all++;
      byStatus[l.status]++;
      if (l.status === "live") { live++; counts.active++; }
      else if (l.status === "indexing") { indexing++; counts.active++; }
      else if (l.status === "active") counts.active++;
      else counts.inactive++;
    });
    return { ...counts, live, indexing, byStatus };
  }, [listings]);

  const filteredListings = useMemo(() => {
    let result = listings;
    // "active" tab is the union of granular live + indexing + legacy active,
    // otherwise indexing-only rows would vanish from the default view.
    const isActiveLike = (s: ListingStatus) => s === "live" || s === "indexing" || s === "active";
    if (activeTab === "active") result = result.filter((l) => isActiveLike(l.status));
    else if (activeTab === "inactive") result = result.filter((l) => !isActiveLike(l.status));

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
            onClick={() => activeQuery.refetch()}
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
          <button onClick={() => activeQuery.refetch()} className="text-txt-muted hover:text-txt-primary text-sm">
            Neu laden
          </button>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-app-surface border border-app-border rounded-xl p-4">
          <div className="text-sm text-txt-muted mb-1">Gesamt</div>
          <div className="text-2xl font-bold text-txt-primary">{listings.length}</div>
        </div>
        <div
          className="bg-app-surface border border-app-border rounded-xl p-4"
          title={
            marketplace === "kaufland"
              ? "Live = von Kaufland validiert (Portal-Aktiv). Indexierung läuft = bei Kaufland in Bearbeitung (bis 24h)."
              : undefined
          }
        >
          <div className="text-sm text-txt-muted mb-1">Aktiv</div>
          <div className="text-2xl font-bold text-success">
            {marketplace === "kaufland" && (tabCounts.live > 0 || tabCounts.indexing > 0)
              ? tabCounts.live
              : tabCounts.active}
          </div>
          {marketplace === "kaufland" && tabCounts.indexing > 0 && (
            <div className="text-xs text-warning mt-0.5">
              + {tabCounts.indexing} in Indexierung
            </div>
          )}
        </div>
        <div className="bg-app-surface border border-app-border rounded-xl p-4">
          <div className="text-sm text-txt-muted mb-1">Inaktiv</div>
          <div className="text-2xl font-bold text-txt-primary">{tabCounts.inactive}</div>
          {(() => {
            const parts = NON_ACTIVE_STATUSES
              .filter((s) => tabCounts.byStatus[s] > 0)
              .map((s) => `${tabCounts.byStatus[s]} ${STATUS_CONFIG[s].label}`);
            if (parts.length === 0) return null;
            return (
              <div className="text-xs text-txt-muted mt-0.5 truncate" title={parts.join(" · ")}>
                {parts.join(" · ")}
              </div>
            );
          })()}
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
        <div className="flex items-center gap-2">
          {repairResult && (
            <span className="text-xs text-success font-medium">{repairResult}</span>
          )}
          {resyncDriftsResult && (
            <span className="text-xs text-success font-medium">{resyncDriftsResult}</span>
          )}
          {(() => {
            const driftListings = listings.filter(
              (l) => (l.stockMismatch || l.warehouseStock === 0) && l.sku,
            );
            const driftCount = driftListings.length;
            if (driftCount === 0) return null;
            return (
              <button
                onClick={async () => {
                  if (
                    !window.confirm(
                      `${driftCount} Listings haben Bestandsabweichung oder 0 Lagerbestand. ` +
                        `Jetzt Firestore-Bestand an Marktplatz pushen? (eBay: qty=0 → Listing wird beendet)`,
                    )
                  ) {
                    return;
                  }
                  setResyncingDrifts(true);
                  setResyncDriftsResult(null);
                  try {
                    const skus = driftListings
                      .map((l) => l.sku)
                      .filter((s): s is string => Boolean(s));
                    const chunks: string[][] = [];
                    for (let i = 0; i < skus.length; i += 200) chunks.push(skus.slice(i, i + 200));
                    let totalResolved = 0;
                    let totalFailed = 0;
                    for (const chunk of chunks) {
                      const r = await forceResyncStockBatch({
                        skus: chunk,
                        reason: "ui-drift-batch-repair",
                      });
                      totalResolved += r.resolved;
                      totalFailed += r.failed + r.notFound;
                    }
                    setResyncDriftsResult(
                      `${totalResolved} repariert${totalFailed > 0 ? `, ${totalFailed} Fehler` : ""}`,
                    );
                    invalidateListings();
                  } catch (err: any) {
                    setResyncDriftsResult(`Fehler: ${err.message}`);
                  } finally {
                    setResyncingDrifts(false);
                  }
                }}
                disabled={resyncingDrifts}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-danger bg-danger-dim rounded-lg hover:opacity-80 transition-opacity disabled:opacity-50"
                title="Pusht den aktuellen Firestore-Bestand an eBay/Kaufland fuer alle Listings mit Drift oder 0 Lagerbestand"
              >
                {resyncingDrifts ? "Synchronisiere..." : `Bestand synchronisieren (${driftCount})`}
              </button>
            );
          })()}
          {marketplace === "ebay" && tabCounts.inactive > 10 && (
            <button
              onClick={async () => {
                setRepairing(true);
                setRepairResult(null);
                try {
                  const result = await repairEbayListings();
                  setRepairResult(`${result.repaired} Listings repariert`);
                  invalidateListings();
                } catch (err: any) {
                  setRepairResult(`Fehler: ${err.message}`);
                } finally {
                  setRepairing(false);
                }
              }}
              disabled={repairing}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-warning bg-warning-dim rounded-lg hover:opacity-80 transition-opacity disabled:opacity-50"
            >
              {repairing ? "Repariere..." : "Listings reparieren"}
            </button>
          )}
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
            {marketplace === "kaufland" && (
              <>
                <button
                  onClick={async () => {
                    setBulkUpdating(true);
                    try {
                      const ids = [...selectedIds];
                      const result = await bulkUpdateKauflandUnits(ids);
                      alert(`Aktualisiert: ${result.success}/${result.total}${result.failed > 0 ? ` (${result.failed} fehlgeschlagen)` : ""}`);
                      invalidateListings();
                    } catch (err: any) {
                      alert(`Fehler: ${err.message}`);
                    } finally {
                      setBulkUpdating(false);
                    }
                  }}
                  disabled={bulkUpdating}
                  className="px-3 py-1.5 text-sm font-medium text-txt-primary bg-app-surface border border-app-border rounded-lg hover:bg-app-elevated transition-colors disabled:opacity-50"
                >
                  {bulkUpdating ? "Aktualisiere..." : "Preis & Bestand aktualisieren"}
                </button>
                <button
                  onClick={async () => {
                    setBulkUpdating(true);
                    try {
                      const ids = [...selectedIds];
                      const result = await bulkSetKauflandUnitStatus(ids, "AVAILABLE");
                      alert(`Aktiviert: ${result.success}/${result.total}${result.failed > 0 ? ` (${result.failed} fehlgeschlagen)` : ""}`);
                      invalidateListings();
                    } catch (err: any) {
                      alert(`Fehler: ${err.message}`);
                    } finally {
                      setBulkUpdating(false);
                    }
                  }}
                  disabled={bulkUpdating}
                  className="px-3 py-1.5 text-sm font-medium text-success bg-success-dim border border-success/20 rounded-lg hover:brightness-110 transition-colors disabled:opacity-50"
                >
                  Aktivieren
                </button>
                <button
                  onClick={async () => {
                    setBulkUpdating(true);
                    try {
                      const ids = [...selectedIds];
                      const result = await bulkSetKauflandUnitStatus(ids, "ONHOLD");
                      alert(`Deaktiviert: ${result.success}/${result.total}${result.failed > 0 ? ` (${result.failed} fehlgeschlagen)` : ""}`);
                      invalidateListings();
                    } catch (err: any) {
                      alert(`Fehler: ${err.message}`);
                    } finally {
                      setBulkUpdating(false);
                    }
                  }}
                  disabled={bulkUpdating}
                  className="px-3 py-1.5 text-sm font-medium text-warning bg-warning-dim border border-warning/20 rounded-lg hover:brightness-110 transition-colors disabled:opacity-50"
                >
                  Deaktivieren
                </button>
              </>
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
                          {listing.status !== "active" && listing.status !== "live" && listing.status !== "indexing" && listing.warehouseStock != null && listing.warehouseStock > 0 && (
                            <span
                              className="inline-flex px-1 py-0.5 rounded text-[10px] font-semibold bg-warning-dim text-warning"
                              title={`Lagerbestand vorhanden, aber Listing ${STATUS_CONFIG[listing.status].label.toLowerCase()}`}
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
                        <div className="flex items-center justify-end gap-1">
                          {marketplace === "ebay" && listing.status === "active" && (
                            <button
                              onClick={() => handleEndListing(listing.id)}
                              disabled={endingItemId === listing.id}
                              title="Listing beenden"
                              className="p-1.5 rounded-lg text-txt-muted hover:text-danger hover:bg-danger-dim transition-colors disabled:opacity-40"
                            >
                              {endingItemId === listing.id ? (
                                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="31.4 31.4" strokeLinecap="round" /></svg>
                              ) : (
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                              )}
                            </button>
                          )}
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
          <div className="relative bg-app-surface border border-app-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
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
              <div className="mx-5 mt-4 space-y-2">
                {/* Summary line */}
                <div className={`px-3 py-2 rounded-lg text-sm ${
                  bulkPublishSummary.failed === 0 && (bulkPublishSummary.skipped ?? 0) === 0
                    ? "bg-success-dim text-success"
                    : "bg-warning-dim text-warning"
                }`}>
                  <div className="font-medium">
                    {bulkPublishSummary.success} von {bulkPublishSummary.total} erfolgreich gelistet
                    {(bulkPublishSummary.fixed ?? 0) > 0 && ` (${bulkPublishSummary.fixed} auto-gefixt)`}
                    {(bulkPublishSummary.pending ?? 0) > 0 && `, ${bulkPublishSummary.pending} eingereicht`}
                    {(bulkPublishSummary.skipped ?? 0) > 0 && `, ${bulkPublishSummary.skipped} uebersprungen`}
                    {(bulkPublishSummary.failed ?? 0) > 0 && `, ${bulkPublishSummary.failed} fehlgeschlagen`}
                  </div>
                </div>

                {/* Auto-fixed details */}
                {bulkPublishSummary.fixedDetails && bulkPublishSummary.fixedDetails.length > 0 && (
                  <div className="px-3 py-2 rounded-lg text-sm bg-info-dim text-info">
                    <div className="font-medium mb-1">Auto-gefixt:</div>
                    <div className="text-xs space-y-1 max-h-32 overflow-y-auto">
                      {bulkPublishSummary.fixedDetails.slice(0, 10).map((detail, i) => (
                        <div key={i} className="opacity-90">{detail}</div>
                      ))}
                      {bulkPublishSummary.fixedDetails.length > 10 && (
                        <div className="opacity-60">+{bulkPublishSummary.fixedDetails.length - 10} weitere</div>
                      )}
                    </div>
                  </div>
                )}

                {/* Pending details (product data submitted, async processing) */}
                {bulkPublishSummary.pendingDetails && bulkPublishSummary.pendingDetails.length > 0 && (
                  <div className="px-3 py-2 rounded-lg text-sm bg-warning-dim text-warning">
                    <div className="font-medium mb-1">Produktdaten eingereicht (spaeter erneut versuchen):</div>
                    <div className="text-xs space-y-1 max-h-32 overflow-y-auto">
                      {bulkPublishSummary.pendingDetails.slice(0, 10).map((detail, i) => (
                        <div key={i} className="opacity-90">{detail}</div>
                      ))}
                      {bulkPublishSummary.pendingDetails.length > 10 && (
                        <div className="opacity-60">+{bulkPublishSummary.pendingDetails.length - 10} weitere</div>
                      )}
                    </div>
                  </div>
                )}

                {/* Failed/skipped details */}
                {bulkPublishSummary.failedDetails && bulkPublishSummary.failedDetails.length > 0 && (
                  <div className="px-3 py-2 rounded-lg text-sm bg-danger-dim text-danger">
                    <div className="font-medium mb-1">Nicht gelistet:</div>
                    <div className="text-xs space-y-1 max-h-40 overflow-y-auto">
                      {bulkPublishSummary.failedDetails.slice(0, 10).map((detail, i) => (
                        <div key={i} className="opacity-90">{detail}</div>
                      ))}
                      {bulkPublishSummary.failedDetails.length > 10 && (
                        <div className="opacity-60">+{bulkPublishSummary.failedDetails.length - 10} weitere</div>
                      )}
                    </div>
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

            {/* Filter & Sort controls */}
            {!publishLoading && publishProducts.length > 0 && (
              <div className="px-5 pt-3 space-y-2">
                {/* Status filter */}
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-txt-muted mr-1">Status:</span>
                  {([
                    ["all", "Alle"],
                    ["ready", "Bereit"],
                    ["pending", "Ausstehend"],
                    ["empty", "Leer"],
                  ] as const).map(([key, lbl]) => {
                    const count = key === "all"
                      ? publishProducts.length
                      : publishProducts.filter((p) => getReadiness(p) === key).length;
                    return (
                      <button
                        key={key}
                        onClick={() => setPublishStatusFilter(key)}
                        className={`px-2 py-1 text-xs rounded-md transition-colors ${
                          publishStatusFilter === key
                            ? key === "ready" ? "bg-success-dim text-success font-medium"
                              : key === "pending" ? "bg-warning-dim text-warning font-medium"
                              : key === "empty" ? "bg-app-elevated text-txt-muted font-medium"
                              : "bg-accent/15 text-accent font-medium"
                            : "text-txt-muted hover:text-txt-primary hover:bg-app-elevated"
                        }`}
                      >
                        {lbl} ({count})
                      </button>
                    );
                  })}
                </div>
                {/* Sort */}
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-txt-muted mr-1">Sortieren:</span>
                  {([
                    ["name", "Name"],
                    ["stock", "Bestand"],
                    ["bin", "Lagerplatz"],
                    ["status", "Status"],
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
                      <div className="flex items-center gap-2">
                        <a
                          href={`#/sheet/${p.id}`}
                          onClick={() => setShowPublishModal(false)}
                          className="text-sm text-txt-primary font-medium truncate hover:text-accent transition-colors"
                          title="Produktdetails öffnen"
                        >
                          {p.identification?.name || "Ohne Titel"}
                        </a>
                        {(() => {
                          const r = getReadiness(p);
                          const cfg = r === "ready"
                            ? { label: "Bereit", cls: "bg-success-dim text-success" }
                            : r === "pending"
                            ? { label: "Ausstehend", cls: "bg-warning-dim text-warning" }
                            : { label: "Leer", cls: "bg-app-elevated text-txt-muted" };
                          return (
                            <span className={`flex-shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded ${cfg.cls}`}>
                              {cfg.label}
                            </span>
                          );
                        })()}
                      </div>
                      <div className="text-xs text-txt-muted">
                        {p.identification?.sku && <span>SKU: {p.identification.sku}</span>}
                        {p.identification?.barcodes?.[0] && <span className="ml-2">EAN: {p.identification.barcodes[0]}</span>}
                      </div>
                      <div className="text-xs text-txt-muted mt-0.5">
                        <span className={`font-medium ${getBinStock(p) > 0 ? "text-success" : "text-danger"}`}>
                          Bestand: {getBinStock(p)}
                        </span>
                        {getProductReservedQuantity(p) > 0 && (
                          <span className="ml-1 text-warning text-[10px]">
                            ({getProductReservedQuantity(p)} reserviert)
                          </span>
                        )}
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

            {/* Policy overrides section */}
            {publishSelectedIds.size > 0 && (
              <div className="px-5 py-3 border-t border-app-border">
                <button
                  onClick={() => setShowPolicyOverrides(!showPolicyOverrides)}
                  className="flex items-center gap-2 text-xs font-medium text-txt-muted hover:text-txt-primary transition-colors"
                >
                  <svg className={`w-3.5 h-3.5 transition-transform ${showPolicyOverrides ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  Rahmenbedingungen anpassen
                  {Object.values(policyOverrides).some(Boolean) && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-accent/10 text-accent">
                      Angepasst
                    </span>
                  )}
                </button>
                {showPolicyOverrides && (
                  <div className="mt-3 space-y-2.5">
                    {!policyConfig?.cachedData ? (
                      <p className="text-xs text-txt-muted">
                        Rahmenbedingungen nicht geladen. Bitte unter Integrationen &gt; {marketplace === "ebay" ? "eBay" : "Kaufland"} zuerst synchronisieren.
                      </p>
                    ) : (
                      <>
                        {marketplace === "ebay" && (
                          <>
                            <PolicySelect
                              label="Versand"
                              items={policyConfig.cachedData.shipping || []}
                              value={policyOverrides.shippingPolicyId || ""}
                              defaultId={policyConfig.defaults?.shippingPolicyId}
                              onChange={(v) => setPolicyOverrides((prev) => ({ ...prev, shippingPolicyId: v }))}
                            />
                            <PolicySelect
                              label="Ruecknahme"
                              items={policyConfig.cachedData.return || []}
                              value={policyOverrides.returnPolicyId || ""}
                              defaultId={policyConfig.defaults?.returnPolicyId}
                              onChange={(v) => setPolicyOverrides((prev) => ({ ...prev, returnPolicyId: v }))}
                            />
                            <PolicySelect
                              label="Zahlung"
                              items={policyConfig.cachedData.payment || []}
                              value={policyOverrides.paymentPolicyId || ""}
                              defaultId={policyConfig.defaults?.paymentPolicyId}
                              onChange={(v) => setPolicyOverrides((prev) => ({ ...prev, paymentPolicyId: v }))}
                            />
                          </>
                        )}
                        {marketplace === "kaufland" && (
                          <>
                            <PolicySelect
                              label="Versandgruppe"
                              items={policyConfig.cachedData.shippingGroups || []}
                              value={policyOverrides.shippingGroupId || ""}
                              defaultId={policyConfig.defaults?.shippingGroupId}
                              onChange={(v) => setPolicyOverrides((prev) => ({ ...prev, shippingGroupId: v }))}
                            />
                            <PolicySelect
                              label="Lager"
                              items={policyConfig.cachedData.warehouses || []}
                              value={policyOverrides.warehouseId || ""}
                              defaultId={policyConfig.defaults?.warehouseId}
                              onChange={(v) => setPolicyOverrides((prev) => ({ ...prev, warehouseId: v }))}
                            />
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

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
