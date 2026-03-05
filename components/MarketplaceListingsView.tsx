import React, { useState, useCallback, useEffect, useMemo } from "react";
import { Product } from "../types";

// Types
interface MarketplaceListingsViewProps {
  marketplace: "ebay" | "kaufland";
  products?: Product[];
  onNavigateToProduct?: (product: Product) => void;
}

type ListingStatus = "active" | "inactive" | "draft" | "error";
type TabFilter = "all" | "active" | "inactive" | "draft" | "error";

interface MarketplaceListing {
  id: string;
  productId: string;
  title: string;
  imageUrl?: string;
  itemId?: string;
  price: number;
  quantity: number;
  status: ListingStatus;
  category?: string;
  watchers?: number;
  sales30d?: number;
  lastSync?: string;
  listingUrl?: string;
  errors?: string[];
}

// Mock Data
const MOCK_LISTINGS: MarketplaceListing[] = [
  {
    id: "ml-1",
    productId: "p-001",
    title: "Samsung Galaxy S24 Ultra 256GB Titanium Black - Neu & OVP",
    imageUrl: "",
    itemId: "1849572630",
    price: 1149.99,
    quantity: 3,
    status: "active",
    category: "Handys & Smartphones",
    watchers: 24,
    sales30d: 7,
    lastSync: "2026-03-05T14:30:00Z",
    listingUrl: "https://www.ebay.de/itm/1849572630",
  },
  {
    id: "ml-2",
    productId: "p-002",
    title: "Apple AirPods Pro 2. Generation mit MagSafe Ladecase USB-C",
    imageUrl: "",
    itemId: "1849572631",
    price: 229.0,
    quantity: 12,
    status: "active",
    category: "Kopfhörer",
    watchers: 18,
    sales30d: 15,
    lastSync: "2026-03-05T14:30:00Z",
    listingUrl: "https://www.ebay.de/itm/1849572631",
  },
  {
    id: "ml-3",
    productId: "p-003",
    title: "Dyson V15 Detect Absolute Akku-Staubsauger - Generalüberholt",
    imageUrl: "",
    itemId: "1849572632",
    price: 449.95,
    quantity: 1,
    status: "active",
    category: "Staubsauger",
    watchers: 9,
    sales30d: 2,
    lastSync: "2026-03-05T14:28:00Z",
    listingUrl: "https://www.ebay.de/itm/1849572632",
  },
  {
    id: "ml-4",
    productId: "p-004",
    title: "LEGO Technic 42151 Bugatti Bolide - Neu versiegelt",
    imageUrl: "",
    itemId: "1849572633",
    price: 39.99,
    quantity: 5,
    status: "inactive",
    category: "LEGO Baukästen & Sets",
    watchers: 3,
    sales30d: 0,
    lastSync: "2026-03-05T12:00:00Z",
    listingUrl: "https://www.ebay.de/itm/1849572633",
  },
  {
    id: "ml-5",
    productId: "p-005",
    title: "Sony WH-1000XM5 Bluetooth Kopfhörer Noise Cancelling Silber",
    imageUrl: "",
    itemId: undefined,
    price: 289.0,
    quantity: 4,
    status: "draft",
    category: "Kopfhörer",
    watchers: 0,
    sales30d: 0,
    lastSync: undefined,
  },
  {
    id: "ml-6",
    productId: "p-006",
    title: "Bosch Professional GSR 18V-90 Akku-Bohrschrauber Set",
    imageUrl: "",
    itemId: "1849572635",
    price: 319.0,
    quantity: 0,
    status: "error",
    category: "Akkuschrauber",
    watchers: 6,
    sales30d: 1,
    lastSync: "2026-03-05T10:15:00Z",
    listingUrl: "https://www.ebay.de/itm/1849572635",
    errors: ["Bestand ist 0 - Listing automatisch deaktiviert", "Preisabweichung erkannt"],
  },
  {
    id: "ml-7",
    productId: "p-007",
    title: "Nintendo Switch OLED Modell Weiss inkl. Mario Kart 8 Deluxe",
    imageUrl: "",
    itemId: "1849572636",
    price: 349.99,
    quantity: 2,
    status: "active",
    category: "Spielekonsolen",
    watchers: 31,
    sales30d: 4,
    lastSync: "2026-03-05T14:30:00Z",
    listingUrl: "https://www.ebay.de/itm/1849572636",
  },
];

const STATUS_CONFIG: Record<ListingStatus, { label: string; bg: string; text: string }> = {
  active: { label: "Aktiv", bg: "bg-success-dim", text: "text-success" },
  inactive: { label: "Inaktiv", bg: "bg-warning-dim", text: "text-warning" },
  draft: { label: "Entwurf", bg: "bg-info-dim", text: "text-info" },
  error: { label: "Fehler", bg: "bg-danger-dim", text: "text-danger" },
};

const TAB_LABELS: Record<TabFilter, string> = {
  all: "Alle",
  active: "Aktiv",
  inactive: "Inaktiv",
  draft: "Entwürfe",
  error: "Fehler",
};

const MARKETPLACE_LABELS = {
  ebay: "eBay",
  kaufland: "Kaufland",
};

function formatPrice(price: number): string {
  return price.toLocaleString("de-DE", { style: "currency", currency: "EUR" });
}

function formatRelativeTime(iso?: string): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "gerade eben";
  if (mins < 60) return `vor ${mins} Min.`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  return `vor ${Math.floor(hours / 24)} Tagen`;
}

// Icons as inline SVGs
const IconEdit = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
  </svg>
);

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

const PAGE_SIZE = 25;

export function MarketplaceListingsView({
  marketplace,
  products,
  onNavigateToProduct,
}: MarketplaceListingsViewProps) {
  const [listings, setListings] = useState<MarketplaceListing[]>(MOCK_LISTINGS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const [syncing, setSyncing] = useState(false);

  const label = MARKETPLACE_LABELS[marketplace];

  // TODO: API call — fetch listings from backend
  // useEffect(() => {
  //   setLoading(true);
  //   fetch(`/api/v1/marketplace/${marketplace}/listings`)
  //     .then(r => r.json())
  //     .then(data => { setListings(data.listings); setLoading(false); })
  //     .catch(err => { setError(err.message); setLoading(false); });
  // }, [marketplace]);

  const tabCounts = useMemo(() => {
    const counts: Record<TabFilter, number> = { all: 0, active: 0, inactive: 0, draft: 0, error: 0 };
    listings.forEach((l) => {
      counts.all++;
      counts[l.status]++;
    });
    return counts;
  }, [listings]);

  const filteredListings = useMemo(() => {
    let result = listings;
    if (activeTab !== "all") {
      result = result.filter((l) => l.status === activeTab);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (l) =>
          l.title.toLowerCase().includes(q) ||
          l.itemId?.toLowerCase().includes(q) ||
          l.category?.toLowerCase().includes(q)
      );
    }
    return result;
  }, [listings, activeTab, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filteredListings.length / PAGE_SIZE));
  const paginatedListings = filteredListings.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE
  );

  const kpis = useMemo(() => {
    const active = listings.filter((l) => l.status === "active").length;
    const drafts = listings.filter((l) => l.status === "draft").length;
    const errors = listings.filter((l) => l.status === "error").length;
    const revenue = listings.reduce((sum, l) => sum + (l.sales30d ?? 0) * l.price, 0);
    return { active, drafts, errors, revenue };
  }, [listings]);

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

  const handleSync = useCallback(async () => {
    setSyncing(true);
    // TODO: API call — POST /api/v1/marketplace/${marketplace}/sync
    await new Promise((r) => setTimeout(r, 1500));
    setSyncing(false);
  }, [marketplace]);

  const handleBulkPriceUpdate = useCallback(() => {
    // TODO: API call — POST /api/v1/marketplace/${marketplace}/bulk/price
    console.log("Bulk price update for:", [...selectedIds]);
  }, [marketplace, selectedIds]);

  const handleBulkDeactivate = useCallback(() => {
    // TODO: API call — POST /api/v1/marketplace/${marketplace}/bulk/deactivate
    console.log("Bulk deactivate for:", [...selectedIds]);
  }, [marketplace, selectedIds]);

  const handleBulkSync = useCallback(() => {
    // TODO: API call — POST /api/v1/marketplace/${marketplace}/bulk/sync
    console.log("Bulk sync for:", [...selectedIds]);
  }, [marketplace, selectedIds]);

  useEffect(() => {
    setCurrentPage(1);
    setSelectedIds(new Set());
  }, [activeTab, searchQuery]);

  // Loading skeleton
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

  // Error state
  if (error) {
    return (
      <div className="p-6">
        <div className="bg-danger-dim border border-app-border rounded-xl p-6 text-center">
          <p className="text-danger font-semibold mb-2">Fehler beim Laden der Listings</p>
          <p className="text-txt-secondary text-sm mb-4">{error}</p>
          <button
            onClick={() => setError(null)}
            className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Erneut versuchen
          </button>
        </div>
      </div>
    );
  }

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
            <p className="text-sm text-txt-muted">Verwalte deine {label}-Angebote</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-success-dim text-success">
            <span className="w-2 h-2 rounded-full bg-current" />
            Verbunden
          </span>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-app-surface border border-app-border rounded-xl p-4">
          <div className="text-sm text-txt-muted mb-1">Aktive Listings</div>
          <div className="text-2xl font-bold text-txt-primary">{kpis.active}</div>
        </div>
        <div className="bg-app-surface border border-app-border rounded-xl p-4">
          <div className="text-sm text-txt-muted mb-1">Entwürfe</div>
          <div className="text-2xl font-bold text-txt-primary">{kpis.drafts}</div>
        </div>
        <div className="bg-app-surface border border-app-border rounded-xl p-4">
          <div className="text-sm text-txt-muted mb-1">Fehler</div>
          <div className="text-2xl font-bold text-danger">{kpis.errors}</div>
        </div>
        <div className="bg-app-surface border border-app-border rounded-xl p-4">
          <div className="text-sm text-txt-muted mb-1">Umsatz 30 Tage</div>
          <div className="text-2xl font-bold text-txt-primary">{formatPrice(kpis.revenue)}</div>
        </div>
      </div>

      {/* Sync Status Banner */}
      <div className="bg-app-surface border border-app-border rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4 text-sm text-txt-secondary">
          <span>
            Letzter Sync: <span className="text-txt-primary font-medium">vor 5 Min.</span>
          </span>
          <span className="hidden sm:inline text-app-border">|</span>
          <span className="hidden sm:inline">
            Nächster: <span className="text-txt-primary font-medium">in 10 Min.</span>
          </span>
          {kpis.errors > 0 && (
            <>
              <span className="hidden sm:inline text-app-border">|</span>
              <span className="text-danger font-medium">{kpis.errors} Fehler</span>
            </>
          )}
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

      {/* Search + Filter Row */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-txt-muted">
            <IconSearch />
          </span>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={`${label} Listings durchsuchen...`}
            className="w-full pl-10 pr-4 py-2 bg-app-surface border border-app-border rounded-lg text-sm text-txt-primary placeholder:text-txt-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors"
          />
        </div>
        <button className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity whitespace-nowrap">
          + Neues Listing
        </button>
      </div>

      {/* Bulk Actions Bar */}
      {selectedIds.size > 0 && (
        <div className="bg-accent-dim border border-app-border rounded-xl px-4 py-3 flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-accent">{selectedIds.size} ausgewählt</span>
          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={handleBulkPriceUpdate}
              className="px-3 py-1.5 text-sm font-medium text-txt-primary bg-app-surface border border-app-border rounded-lg hover:bg-app-elevated transition-colors"
            >
              Preis aktualisieren
            </button>
            <button
              onClick={handleBulkDeactivate}
              className="px-3 py-1.5 text-sm font-medium text-warning bg-warning-dim border border-app-border rounded-lg hover:opacity-80 transition-opacity"
            >
              Deaktivieren
            </button>
            <button
              onClick={handleBulkSync}
              className="px-3 py-1.5 text-sm font-medium text-accent bg-app-surface border border-app-border rounded-lg hover:bg-app-elevated transition-colors"
            >
              Sync alle
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
          <p className="text-txt-muted text-sm">
            Erstelle ein neues Listing aus deinem Produktkatalog.
          </p>
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
                  <th className="px-4 py-3 text-left w-12" />
                  <th className="px-4 py-3 text-left text-txt-muted font-medium">Titel</th>
                  <th className="px-4 py-3 text-left text-txt-muted font-medium hidden md:table-cell">
                    Item-ID
                  </th>
                  <th className="px-4 py-3 text-right text-txt-muted font-medium">Preis</th>
                  <th className="px-4 py-3 text-right text-txt-muted font-medium hidden sm:table-cell">
                    Menge
                  </th>
                  <th className="px-4 py-3 text-left text-txt-muted font-medium">Status</th>
                  <th className="px-4 py-3 text-left text-txt-muted font-medium hidden lg:table-cell">
                    Kategorie
                  </th>
                  <th className="px-4 py-3 text-right text-txt-muted font-medium hidden xl:table-cell">
                    Watchers
                  </th>
                  <th className="px-4 py-3 text-right text-txt-muted font-medium hidden xl:table-cell">
                    Verkäufe 30d
                  </th>
                  <th className="px-4 py-3 text-left text-txt-muted font-medium hidden lg:table-cell">
                    Letzter Sync
                  </th>
                  <th className="px-4 py-3 text-right text-txt-muted font-medium w-28">
                    Aktionen
                  </th>
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
                        <div className="w-10 h-10 rounded-lg bg-app-elevated border border-app-border flex items-center justify-center text-txt-muted text-xs overflow-hidden">
                          {listing.imageUrl ? (
                            <img
                              src={listing.imageUrl}
                              alt=""
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.41a2.25 2.25 0 013.182 0l2.909 2.91m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                            </svg>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div
                          className="text-txt-primary font-medium truncate max-w-[280px] cursor-pointer hover:text-accent transition-colors"
                          title={listing.title}
                        >
                          {listing.title}
                        </div>
                        {listing.errors && listing.errors.length > 0 && (
                          <div className="text-xs text-danger mt-0.5 truncate max-w-[280px]">
                            {listing.errors[0]}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        {listing.itemId ? (
                          listing.listingUrl ? (
                            <a
                              href={listing.listingUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-accent hover:underline text-xs font-mono"
                            >
                              {listing.itemId}
                            </a>
                          ) : (
                            <span className="text-txt-secondary text-xs font-mono">
                              {listing.itemId}
                            </span>
                          )
                        ) : (
                          <span className="text-txt-muted text-xs">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-txt-primary font-medium whitespace-nowrap">
                        {formatPrice(listing.price)}
                      </td>
                      <td className="px-4 py-3 text-right text-txt-secondary hidden sm:table-cell">
                        {listing.quantity}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${statusCfg.bg} ${statusCfg.text}`}
                        >
                          {statusCfg.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-txt-secondary text-xs hidden lg:table-cell truncate max-w-[160px]">
                        {listing.category ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-right text-txt-secondary hidden xl:table-cell">
                        {listing.watchers ?? 0}
                      </td>
                      <td className="px-4 py-3 text-right text-txt-secondary hidden xl:table-cell">
                        {listing.sales30d ?? 0}
                      </td>
                      <td className="px-4 py-3 text-xs text-txt-muted hidden lg:table-cell whitespace-nowrap">
                        {formatRelativeTime(listing.lastSync)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            title="Bearbeiten"
                            className="p-1.5 rounded-lg text-txt-muted hover:text-txt-primary hover:bg-app-elevated transition-colors"
                          >
                            <IconEdit />
                          </button>
                          <button
                            title="Synchronisieren"
                            className="p-1.5 rounded-lg text-txt-muted hover:text-accent hover:bg-accent-dim transition-colors"
                          >
                            <IconSync />
                          </button>
                          {listing.listingUrl && (
                            <a
                              href={listing.listingUrl}
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
            <span className="text-sm text-txt-muted">
              Zeige {(currentPage - 1) * PAGE_SIZE + 1}-
              {Math.min(currentPage * PAGE_SIZE, filteredListings.length)} von{" "}
              {filteredListings.length}
            </span>
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
    </div>
  );
}

export default MarketplaceListingsView;
