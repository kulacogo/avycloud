
import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Product } from '../types';
import { readinessLabel, readinessBadgeClasses } from '../utils/readiness';
import {
  applyProductFilters,
  effectiveSellPrice,
  FILTERS_STORAGE_KEY,
  getFilterDefs,
  hasUnreadNotes,
  isEbayListed,
  isKauflandListed,
  loadFilterState,
  productWeightKg,
  serializeFilters,
  type ActiveFilter,
  type FilterContext,
  type FilterOption,
  type FilterValue,
} from '../utils/productFilters';
import {
  buildProductComparator,
  DEFAULT_SORT,
  migrateSortState,
  SORT_STORAGE_KEY,
  toggleSortLevel,
  type SortLevel,
} from '../utils/productSort';
import {
  buildInventoryExport,
  buildProductExportFilename,
  loadProductExportPreferences,
  saveProductExportPreferences,
  PRODUCT_EXPORT_DEFAULT_FIELDS,
  type InventoryExportPreferences,
} from '../utils/inventory-export';
import { exportToCsv } from '../utils/csv-export';
import InventoryExportDialog, { type InventoryExportScope } from './inventory/InventoryExportDialog';
import {
  deleteSavedView,
  loadSavedViews,
  serializeSavedViews,
  upsertSavedView,
  VIEWS_STORAGE_KEY,
  type SavedView,
} from '../utils/savedViews';
import { fetchProducts, getProductBulkJob, runProductBulkAction, deleteProductsBulk, openProductLabelBatchWindow, assignInventoryToProducts, uploadKTypeCsv, bulkVerifyEbayPublish, bulkPublishToEbay, fetchEbaySkuIndex, lightSyncEbayLiveListings, bulkUpdateEbayListings, fetchKauflandSkuIndex, syncKauflandListings, getProductNotesOverview, getProductNotesCounts, type ProductBulkActionName, type ProductNotesOverviewEntry } from '../api/client';
import { SearchIcon } from './icons/Icons';
import {
  getStableNumericId,
  getProductQuantity,
  getProductDisplayCategory,
} from '../utils/product';
import { isValidGtin, normalizeBarcode } from '../utils/gtin';
import { readInitialGlobalSearch, subscribeGlobalSearch } from '../utils/globalSearch';
import { useI18n } from '../i18n';
import { Spinner } from './Spinner';
import { addMediaQueryListener } from '../utils/mediaQuery';
import { useInventoryContext } from '../context/InventoryContext';
import { isInventoryItem, isProductBacklogItem } from '../utils/inventorySplit';
import { Notice } from './ui/Notice';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { AdminTableHeader, AdminTableRow, AdminTableFilters, BulkActions } from './admin-table';
import { COLUMN_PRESETS } from './admin-table/types';
import type { ColumnId, ColumnPreset, ColumnDefinition } from './admin-table';
import { useGridEdit } from '../hooks/useGridEdit';
import { useBulkUpdate } from '../hooks/useBulkUpdate';
import { useAuth } from '../context/AuthContext';
import { deriveInitials } from '../utils/product';
import { useListPaging } from "../hooks/useListPaging";

const safeCurrency = (code?: string) => {
  const c = (code || '').toString().trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : 'EUR';
};

const COLUMN_STORAGE_KEY = 'avystock:admin-table:visible-columns';

// Schon der PROPERTY-Zugriff window.sessionStorage/localStorage wirft, wenn
// der Browser Website-Daten blockiert — dann darf nicht die ganze Ansicht
// crashen, sondern es gilt: kein gespeicherter Zustand.
const safeSessionStorage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
};
const safeLocalStorage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
};

const normalizeMarketplaceColumnOrder = (columns: ColumnId[]): ColumnId[] => {
  const unique = Array.from(new Set(columns));
  const hasEbay = unique.includes('ebay');
  const hasKaufland = unique.includes('kaufland');
  if (!hasEbay || !hasKaufland) return unique;
  const firstMarketplaceIndex = unique.findIndex((id) => id === 'ebay' || id === 'kaufland');
  const base: ColumnId[] = unique.filter((id) => id !== 'ebay' && id !== 'kaufland');
  const insertAt = firstMarketplaceIndex >= 0 ? Math.min(firstMarketplaceIndex, base.length) : base.length;
  base.splice(insertAt, 0, 'ebay', 'kaufland');
  return base;
};

interface AdminTableProps {
  products: Product[];
  onSelectProduct: (productId: string) => void;
  onUpdateProducts: (products: Product[]) => void;
  focusProductId?: string | null;
  onImproveProduct?: (productId: string) => void;
  onImproveSelected?: (productIds: string[]) => void;
  onBulkImprove?: () => void;
  improvingProductIds?: Set<string>;
  mode?: 'inventory' | 'products' | 'all';
  scopeProductIds?: Set<string> | null;
}

const ReadinessBadge: React.FC<{ readiness?: string | null; editor?: string | null }> = ({ readiness, editor }) => {
  const base = "px-2 py-1 text-xs font-bold rounded-full inline-flex items-center gap-1";
  return (
    <span className={`${base} ${readinessBadgeClasses(readiness)}`}>
      {readinessLabel(readiness)}
      {editor && <span className="opacity-60 text-[10px]">({editor})</span>}
    </span>
  );
};

const SaveStatusBadge: React.FC<{ saved: boolean }> = ({ saved }) => {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full ${saved ? 'bg-success-dim text-success' : 'bg-warning-dim text-warning'
        }`}
    >
      {saved ? 'Gespeichert' : 'Nicht gespeichert'}
    </span>
  );
};

// Thumbnail mit Fallback: probiert die Bildkandidaten der Reihe nach; bei
// Ladefehler (z.B. GCS-404, Incident 2026-07-09) das naechste, sonst Platzhalter.
const ProductThumbnail: React.FC<{ srcs: string[]; alt: string }> = ({ srcs, alt }) => {
  const [idx, setIdx] = useState(0);
  useEffect(() => { setIdx(0); }, [srcs.join('|')]);
  const src = srcs[idx];
  return (
    <div className="w-12 h-12 rounded-md overflow-hidden bg-app-elevated flex items-center justify-center text-xs text-txt-muted">
      {src ? (
        <img
          src={src}
          alt={alt}
          className="w-full h-full object-cover"
          loading="lazy"
          onError={() => setIdx((i) => i + 1)}
        />
      ) : (
        '—'
      )}
    </div>
  );
};

const AdminTable: React.FC<AdminTableProps> = ({
  products,
  onSelectProduct,
  onUpdateProducts,
  focusProductId,
  onImproveProduct,
  onImproveSelected,
  onBulkImprove,
  improvingProductIds,
  mode = 'all',
  scopeProductIds = null,
}) => {
  const { t } = useI18n();
  const [searchTerm, setSearchTerm] = useState(() => readInitialGlobalSearch());
  // EIN Filterzustand fuer alle Dimensionen (utils/productFilters.ts).
  // Reihenfolge = Aktivierungs-Reihenfolge (fuer Chips + "letzten entfernen").
  // Alt-Schluessel (avystock:admin-table:filter*) werden beim ersten Laden
  // einmalig migriert.
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>(() =>
    loadFilterState(safeSessionStorage())
  );
  const setFilterValue = useCallback((id: string, value: FilterValue) => {
    setActiveFilters((prev) => {
      const idx = prev.findIndex((f) => f.id === id);
      if (idx < 0) return [...prev, { id, value }];
      const next = [...prev];
      next[idx] = { id, value };
      return next;
    });
  }, []);
  const removeFilter = useCallback((id: string) => {
    setActiveFilters((prev) => prev.filter((f) => f.id !== id));
  }, []);
  const clearAllFilters = useCallback(() => setActiveFilters([]), []);
  // Multi-Sort: Klick ersetzt, Shift-Klick ergaenzt (utils/productSort.ts).
  const [sortLevels, setSortLevels] = useState<SortLevel[]>(() => {
    if (typeof window === 'undefined') return DEFAULT_SORT;
    try {
      return migrateSortState(window.sessionStorage.getItem(SORT_STORAGE_KEY));
    } catch {
      return DEFAULT_SORT;
    }
  });
  const [pageSize, setPageSize] = useState<number>(() => {
    if (typeof window === 'undefined') return 50;
    try {
      const stored = window.sessionStorage.getItem('avystock:admin-table:pageSize');
      const parsed = stored ? parseInt(stored, 10) : NaN;
      return Number.isFinite(parsed) ? parsed : 50;
    } catch {
      return 50;
    }
  });
  const [currentPage, setCurrentPage] = useState(1);
  // Nach dem Blaettern oben in der Liste stehen — sonst landet man
  // mitten in der neuen Seite (gemeinsame Regel: utils/listPaging.ts).
  useListPaging(currentPage);

  // Suche aus der oberen Leiste: erreicht die Tabelle auch dann, wenn sie schon
  // aufgebaut ist. Der Startwert von `searchTerm` greift nur beim ERSTEN Aufbau
  // — stand der Bediener bereits auf "Produkte", passierte vorher gar nichts.
  useEffect(
    () =>
      subscribeGlobalSearch((term) => {
        setSearchTerm(term);
        setCurrentPage(1);
      }),
    []
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const gridEdit = useGridEdit();
  const gridBulkUpdate = useBulkUpdate();
  const [isColumnPanelOpen, setIsColumnPanelOpen] = useState(false);
  // track a simple preset to make column selection easier
  const [columnPreset, setColumnPreset] = useState<ColumnPreset>('standard');
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 640px)').matches : false
  );
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  // Sichtbarer Fehler beim Inline-Speichern. Vorher verschwand der
  // Speichern-Knopf auch im Fehlerfall und die Eingaben waren stumm weg.
  const [bulkError, setBulkError] = useState<string | null>(null);
  const { inventories } = useInventoryContext();
  const [inventoryModalOpen, setInventoryModalOpen] = useState(false);
  const [inventorySelection, setInventorySelection] = useState('');
  const [inventoryAssigning, setInventoryAssigning] = useState(false);
  const [inventoryAssignMessage, setInventoryAssignMessage] = useState<string | null>(null);
  const [ktypeModalOpen, setKtypeModalOpen] = useState(false);
  const [ktypeFile, setKtypeFile] = useState<File | null>(null);
  const [ktypeBusy, setKtypeBusy] = useState(false);
  const [ktypeMessage, setKtypeMessage] = useState<string | null>(null);
  const [ktypeReport, setKtypeReport] = useState<any | null>(null);
  const [ebayPublishInProgress, setEbayPublishInProgress] = useState(false);
  // productId → itemId map from ebayListingLinks (matched listings)
  const [ebayLinkedMap, setEbayLinkedMap] = useState<Map<string, string>>(new Map());
  const [ebayItemIdMap, setEbayItemIdMap] = useState<Map<string, string>>(new Map()); // SKU → itemId
  const [ebayProductIdMap, setEbayProductIdMap] = useState<Map<string, string>>(new Map()); // productId → itemId
  const [ebayActiveItemIds, setEbayActiveItemIds] = useState<Set<string>>(new Set());
  const [ebayUpdateInProgress, setEbayUpdateInProgress] = useState(false);
  const [ebaySyncInProgress, setEbaySyncInProgress] = useState(false);
  const [kauflandSkuSet, setKauflandSkuSet] = useState<Set<string>>(new Set());
  const [kauflandEanSet, setKauflandEanSet] = useState<Set<string>>(new Set());
  const [kauflandSkuUrlMap, setKauflandSkuUrlMap] = useState<Map<string, string>>(new Map());
  const [kauflandEanUrlMap, setKauflandEanUrlMap] = useState<Map<string, string>>(new Map());
  const [kauflandSkuProductIdMap, setKauflandSkuProductIdMap] = useState<Map<string, number>>(new Map());
  const [kauflandEanProductIdMap, setKauflandEanProductIdMap] = useState<Map<string, number>>(new Map());
  const [kauflandSyncInProgress, setKauflandSyncInProgress] = useState(false);
  const [improveInProgress, setImproveInProgress] = useState(false);
  const [improveMessage, setImproveMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: 'info' | 'success' | 'warning' | 'error';
    title: string;
    message?: string;
    details?: string;
  } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    description?: React.ReactNode;
    details?: React.ReactNode;
    confirmLabel: string;
    tone?: 'default' | 'danger';
    confirmBusy?: boolean;
    onConfirm: () => void | Promise<void>;
  } | null>(null);
  const [bulkJobId, setBulkJobId] = useState<string | null>(null);
  const [bulkJobAction, setBulkJobAction] = useState<string | null>(null);
  const [bulkJobLoading, setBulkJobLoading] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 640px)');
    const handler = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    const detach = addMediaQueryListener(mq, handler);
    return () => detach();
  }, []);

  useEffect(() => {}, []);

  // Load eBay SKU-index (alle aktiven Listings, SKU → viewItemUrl + itemId, productId → itemId) once on mount
  useEffect(() => {
    fetchEbaySkuIndex()
      .then((entries) => {
        const urlMap = new Map<string, string>();
        const itemIdMap = new Map<string, string>();
        const pidMap = new Map<string, string>();
        const activeItemIds = new Set<string>();
        entries.forEach((entry) => {
          const url = entry.viewItemUrl || `https://www.ebay.de/itm/${encodeURIComponent(entry.itemId)}`;
          if (entry.itemId) activeItemIds.add(String(entry.itemId).trim());
          const key = normalizeSku(entry.sku);
          if (key) {
            urlMap.set(key, url);
            itemIdMap.set(key, entry.itemId);
          }
          if (entry.productId) {
            pidMap.set(entry.productId, entry.itemId);
          }
        });
        setEbayLinkedMap(urlMap);
        setEbayItemIdMap(itemIdMap);
        setEbayProductIdMap(pidMap);
        setEbayActiveItemIds(activeItemIds);
      })
      .catch(() => {/* ignore – column zeigt dann keine Daten */});
  }, []);

  useEffect(() => {
    loadKauflandIndex().catch(() => {/* ignore – bis zum ersten Sync bleibt Spalte neutral */});
  }, []);

  useEffect(() => {
    if (!isMobile) {
      setFilterPanelOpen(false);
    }
  }, [isMobile]);

  // Helper: normalize SKU/EAN
  const normalizeSku = (value?: string | null) => {
    if (!value) return '';
    return value.toString().trim().replace(/\s+/g, '').toUpperCase();
  };

  const normalizeEan = (value?: string | null) => {
    if (!value) return '';
    return value.toString().replace(/\D+/g, '').trim();
  };

  const buildKauflandProductUrl = (idProduct?: number | null) => {
    const n = Number(idProduct || 0);
    if (!Number.isFinite(n) || n <= 0) return '';
    return `https://www.kaufland.de/product/${Math.trunc(n)}/`;
  };

  const loadKauflandIndex = async () => {
    const entries = await fetchKauflandSkuIndex('de');
    const skuSet = new Set<string>();
    const eanSet = new Set<string>();
    const skuUrlMap = new Map<string, string>(); 
    const eanUrlMap = new Map<string, string>();
    const skuProductIdMap = new Map<string, number>();
    const eanProductIdMap = new Map<string, number>();
    entries.forEach((entry) => {
      const sku = normalizeSku(entry.skuNormalized || entry.sku || '');
      const idProduct = Number(entry.idProduct || 0);
      const hasIdProduct = Number.isFinite(idProduct) && idProduct > 0;
      const fallbackUrl = hasIdProduct ? buildKauflandProductUrl(idProduct) : '';
      const viewItemUrl = String(entry.viewItemUrl || '').trim() || fallbackUrl;
      if (sku) skuSet.add(sku);
      if (sku && viewItemUrl && !skuUrlMap.has(sku)) skuUrlMap.set(sku, viewItemUrl);
      if (sku && hasIdProduct && !skuProductIdMap.has(sku)) skuProductIdMap.set(sku, idProduct);
      const ean = normalizeEan(entry.ean || '');
      if (ean) eanSet.add(ean);
      if (ean && viewItemUrl && !eanUrlMap.has(ean)) eanUrlMap.set(ean, viewItemUrl);
      if (ean && hasIdProduct && !eanProductIdMap.has(ean)) eanProductIdMap.set(ean, idProduct);
      (Array.isArray(entry.eans) ? entry.eans : []).forEach((v) => {
        const n = normalizeEan(v);
        if (n) eanSet.add(n);
        if (n && viewItemUrl && !eanUrlMap.has(n)) eanUrlMap.set(n, viewItemUrl);
        if (n && hasIdProduct && !eanProductIdMap.has(n)) eanProductIdMap.set(n, idProduct);
      });
    });
    setKauflandSkuSet(skuSet);
    setKauflandEanSet(eanSet);
    setKauflandSkuUrlMap(skuUrlMap);
    setKauflandEanUrlMap(eanUrlMap);
    setKauflandSkuProductIdMap(skuProductIdMap);
    setKauflandEanProductIdMap(eanProductIdMap);
  };

  const categoryTree = useMemo(() => {
    const tree = new Map<string, { count: number; children: Map<string, number> }>();
    for (const p of products) {
      const resolved = getProductDisplayCategory(p);
      const raw = (resolved && resolved !== '—' ? resolved : 'Unbekannt').toString();
      const parts = raw.split('>').map((s) => s.trim()).filter(Boolean);
      const top = parts[0] || 'Unbekannt';
      const sub = parts.length >= 2 ? parts[1] : '';
      const entry = tree.get(top) || { count: 0, children: new Map() };
      entry.count += 1;
      if (sub) {
        entry.children.set(sub, (entry.children.get(sub) || 0) + 1);
      }
      tree.set(top, entry);
    }
    const tops = Array.from(tree.entries()).sort((a, b) => a[0].localeCompare(b[0], 'de'));
    return tops.map(([top, entry]) => ({
      top,
      count: entry.count,
      children: Array.from(entry.children.entries())
        .sort((a, b) => a[0].localeCompare(b[0], 'de'))
        .map(([sub, count]) => ({ sub, count })),
    }));
  }, [products]);

  const { user, isAdmin } = useAuth();
  const myInitials = useMemo(() => deriveInitials(user?.email || ''), [user?.email]);

  // Alle http-Bildkandidaten in Reihenfolge (fuer onError-Fallback aufs naechste).
  // Incident 2026-07-09: einzelne GCS-Bilder liefern 404 — nicht das erste blind
  // nehmen, sondern durchprobieren und sonst Platzhalter zeigen.
  const imageCandidates = (product: Product): string[] => {
    const out: string[] = [];
    for (const img of product.details?.images || []) {
      const raw = (img as any).url_or_base64;
      const src = typeof raw === 'string' ? raw
        : raw && typeof raw === 'object' && typeof raw.url === 'string' ? raw.url
        : typeof (img as any).url === 'string' ? (img as any).url
        : null;
      if (src && src.startsWith('http')) out.push(src);
    }
    return out;
  };
  const primaryBarcode = (product: Product) => {
    const codes = product.identification?.barcodes || [];
    const ids = product.details?.identifiers || {};
    return codes[0] || ids.ean || ids.gtin || ids.upc || '—';
  };
  const isValidMarketplaceEan = (value?: string | null) => {
    const digits = normalizeBarcode(value || '');
    if (!digits) return false;
    if (digits.length !== 13 && digits.length !== 14) return false;
    return isValidGtin(digits);
  };
  const primaryBin = (product: Product) => {
    if (product.storage?.binCode) return product.storage.binCode;
    if (Array.isArray(product.storageBins) && product.storageBins.length) {
      // Zeige auch dann den ersten Bin, wenn die Menge 0 ist, damit „No BIN assigned“ vermieden wird.
      const withStock = product.storageBins.find((bin) => (bin.quantity || 0) > 0);
      return withStock?.code || product.storageBins[0]?.code || null;
    }
    return null;
  };

  // Notiz-Stand je Produkt (Anzahl, letzte Notiz, eigener Gelesen-Stand) —
  // Basis fuer Spalte + Filter "Notizen"/"Letzte Notiz".
  const [notesOverview, setNotesOverview] = useState<Map<string, ProductNotesOverviewEntry>>(new Map());
  useEffect(() => {
    let cancelled = false;
    getProductNotesOverview()
      .then(async (o) => {
        const entries = Object.entries(o || {});
        if (entries.length > 0) {
          if (!cancelled) setNotesOverview(new Map(entries));
          return;
        }
        // Fallback (aelterer Backend-Stand / Deploy-Fenster): der alte
        // Zaehler-Endpoint liefert nur Anzahlen. seenAt wird auf "jetzt"
        // gesetzt, damit ohne bekannten Gelesen-Stand NICHTS faelschlich
        // als ungelesen markiert wird.
        const counts = await getProductNotesCounts();
        if (cancelled) return;
        const fallbackSeen = new Date().toISOString();
        setNotesOverview(
          new Map(
            Object.entries(counts || {}).map(([pid, count]) => [
              pid,
              { count, lastNoteAt: null, seenAt: fallbackSeen },
            ])
          )
        );
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  // Oeffnet jemand die Notizen im Datenblatt, meldet ProductNotes das hierher —
  // der Ungelesen-Filter stellt sofort um, ohne Neuladen der Tabelle.
  useEffect(() => {
    const onSeen = (e: Event) => {
      const detail = (e as CustomEvent).detail as { productId?: string; seenAt?: string } | undefined;
      if (!detail?.productId) return;
      setNotesOverview((prev) => {
        const current = prev.get(detail.productId!);
        if (!current) return prev;
        const next = new Map(prev);
        next.set(detail.productId!, { ...current, seenAt: detail.seenAt || new Date().toISOString() });
        return next;
      });
    };
    window.addEventListener('avy:notes-seen', onSeen);
    return () => window.removeEventListener('avy:notes-seen', onSeen);
  }, []);

  // ---- Produktdaten-Export (Dialog mit Feldauswahl + Umfang) ----
  // Der Kopf-Knopf "Export" der Produkte-Seite feuert dieses Event: die
  // Tabelle kennt Filter, Suche und Sortierung — der alte Backend-CSV-Weg
  // exportierte IMMER alle Produkte mit fester Spaltenliste.
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportPrefs, setExportPrefs] = useState<InventoryExportPreferences>(() =>
    loadProductExportPreferences(safeLocalStorage())
  );
  useEffect(() => {
    const onOpen = () => setExportDialogOpen(true);
    window.addEventListener('avy:produktdaten-export', onOpen);
    return () => window.removeEventListener('avy:produktdaten-export', onOpen);
  }, []);

  // Admin-only: "Erfasst von" — Zuordnung aus dem Erfassungs-Protokoll (deckt
  // auch Produkte ab, die vor dem ops.identified_by-Feld erfasst wurden).
  const [identifiedByMap, setIdentifiedByMap] = useState<Record<string, { uid: string; name: string }>>({});
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    import('../api/client').then(({ getProductsIdentifiedByMap }) =>
      getProductsIdentifiedByMap()
        .then((m) => { if (!cancelled) setIdentifiedByMap(m || {}); })
        .catch(() => {})
    );
    return () => { cancelled = true; };
  }, [isAdmin]);

  // Anzeigename des Erfassers (Feld am Produkt gewinnt, sonst Protokoll-Map).
  const resolveErfasstVon = useCallback((p: any): string => {
    const field = p?.ops?.identified_by;
    return field?.name || field?.email || identifiedByMap[p?.id]?.name || '';
  }, [identifiedByMap]);

  // Sichtbare Filter-Definitionen (Erfasser nur fuer Admins) + Live-Kontext
  // fuer Predicates und Options-Counts. `now` wird beim FILTERN frisch gesetzt
  // — hier dient es nur als Platzhalter fuer Chip-Texte.
  const filterDefs = useMemo(() => getFilterDefs(isAdmin), [isAdmin]);
  const filterCtx = useMemo<FilterContext>(
    () => ({
      now: new Date(),
      myInitials,
      ebaySkuUrlMap: ebayLinkedMap,
      ebayProductIdMap,
      ebayActiveItemIds,
      kauflandSkuSet,
      kauflandEanSet,
      resolveErfasstVon,
      getDisplayCategory: getProductDisplayCategory,
      notesById: notesOverview,
    }),
    [myInitials, ebayLinkedMap, ebayProductIdMap, ebayActiveItemIds, kauflandSkuSet, kauflandEanSet, resolveErfasstVon, notesOverview]
  );
  const filterOptionsById = useMemo(() => {
    const map = new Map<string, FilterOption[]>();
    for (const def of filterDefs) {
      if (def.buildOptions) map.set(def.id, def.buildOptions(products, filterCtx));
    }
    return map;
  }, [filterDefs, products, filterCtx]);

  // Gespeicherte Ansichten (Filter + Sortierung) — lokal je Geraet.
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => loadSavedViews(safeLocalStorage()));
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(VIEWS_STORAGE_KEY, serializeSavedViews(savedViews));
    } catch {
      // ignore storage errors
    }
  }, [savedViews]);
  // Aktive Ansicht + Dirty-State (Polaris/Attio-Muster: veraenderte Ansicht
  // zeigt einen Punkt und bietet "aktualisieren"/"verwerfen" an).
  const [appliedViewId, setAppliedViewId] = useState<string | null>(() => {
    try {
      return safeSessionStorage()?.getItem('avystock:admin-table:appliedView') || null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      const storage = safeSessionStorage();
      if (!storage) return;
      if (appliedViewId) storage.setItem('avystock:admin-table:appliedView', appliedViewId);
      else storage.removeItem('avystock:admin-table:appliedView');
    } catch {
      // ignore storage errors
    }
  }, [appliedViewId]);
  const appliedView = useMemo(
    () => (appliedViewId ? savedViews.find((v) => v.id === appliedViewId) ?? null : null),
    [appliedViewId, savedViews]
  );
  const appliedViewDirty = useMemo(() => {
    if (!appliedView) return false;
    return (
      JSON.stringify(appliedView.filters) !== JSON.stringify(activeFilters) ||
      JSON.stringify(appliedView.sort) !== JSON.stringify(sortLevels)
    );
  }, [appliedView, activeFilters, sortLevels]);
  const applySavedView = useCallback((view: SavedView) => {
    setActiveFilters(structuredClone(view.filters));
    setSortLevels(structuredClone(view.sort));
    setAppliedViewId(view.id);
  }, []);
  const saveCurrentView = useCallback(
    (name: string) => {
      const next = upsertSavedView(savedViews, name, activeFilters, sortLevels);
      setSavedViews(next);
      const saved = next.find((v) => v.name === name.trim());
      if (saved) setAppliedViewId(saved.id);
    },
    [savedViews, activeFilters, sortLevels]
  );
  const updateAppliedView = useCallback(() => {
    if (appliedView) saveCurrentView(appliedView.name);
  }, [appliedView, saveCurrentView]);
  const discardViewChanges = useCallback(() => {
    if (appliedView) applySavedView(appliedView);
  }, [appliedView, applySavedView]);
  const deleteSavedViewById = useCallback((id: string) => {
    setSavedViews((prev) => deleteSavedView(prev, id));
    setAppliedViewId((prev) => (prev === id ? null : prev));
  }, []);

  const columnDefinitions: ColumnDefinition[] = useMemo(() => {
    const baseRenderers: ColumnDefinition[] = [
      {
        id: 'thumbnail',
        label: t('table.thumbnail'),
        defaultVisible: true,
        widthClass: 'w-20',
        render: ({ product }) => (
          <ProductThumbnail
            srcs={imageCandidates(product)}
            alt={product.identification?.name || 'Produktbild'}
          />
        ),
      },
      {
        id: 'images',
        label: t('table.images'),
        sortKey: 'images.count',
        defaultVisible: true,
        widthClass: 'w-16',
        render: ({ product }) => {
          const count = Array.isArray(product.details?.images) ? product.details.images.length : 0;
          if (count <= 0) return <span className="text-txt-muted text-sm">—</span>;
          return (
            <span
              className="inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-semibold bg-accent/15 text-accent"
              title={`${count} ${count === 1 ? 'Bild' : 'Bilder'}`}
            >
              {count}
            </span>
          );
        },
      },
      {
        id: 'nameBrand',
        label: t('table.nameBrand'),
        sortKey: 'identification.name',
        defaultVisible: true,
        render: ({ product, onSelectProduct: handleSelect }) => (
          <div>
            <a
              href={`#/sheet/${product.id}`}
              onClick={(e) => {
                // Ctrl/Meta/Middle/Shift → open in new tab via href
                if (e.metaKey || e.ctrlKey || e.button === 1 || e.shiftKey) {
                  return;
                }
                e.preventDefault();
                handleSelect(product.id);
              }}
              className="font-medium text-accent hover:underline"
            >
              {product.identification?.name || '—'}
            </a>
            <div className="text-sm text-txt-muted">{product.identification?.brand || '—'}</div>
          </div>
        ),
      },
      {
        id: 'category',
        label: t('table.category'),
        sortKey: 'category.display',
        defaultVisible: true,
        render: ({ product }) => <span className="text-txt-secondary">{getProductDisplayCategory(product)}</span>,
      },
      {
        id: 'sku',
        label: 'SKU',
        sortKey: 'details.identifiers.sku',
        defaultVisible: true,
        render: ({ product }) => (
          <div className="text-txt-secondary text-sm font-mono leading-tight whitespace-nowrap">
            {product.details?.identifiers?.sku || product.identification?.sku || '—'}
          </div>
        ),
      },
      {
        id: 'barcode',
        label: 'EAN/GTIN',
        sortKey: 'details.identifiers.ean',
        defaultVisible: true,
        render: ({ product }) => {
          const barcode = primaryBarcode(product);
          const isMissing = barcode === '—';
          const isValid = !isMissing && isValidMarketplaceEan(barcode);
          return (
            <div
              className={`text-sm font-mono leading-tight ${
                isMissing ? 'text-txt-secondary' : isValid ? 'text-success' : 'text-danger'
              }`}
            >
              {barcode}
            </div>
          );
        },
      },
      {
        id: 'mpn',
        label: t('table.mpn'),
        sortKey: 'details.identifiers.mpn',
        render: ({ product }) => (
          <div className="text-txt-secondary text-sm font-mono leading-tight whitespace-nowrap">
            {product.details?.identifiers?.mpn || (product as any)?.identification?.mpn || '—'}
          </div>
        ),
      },
      {
        id: 'weight',
        label: t('table.weight'),
        sortKey: 'details.weight',
        render: ({ product }) => {
          const d: any = product.details || {};
          const raw =
            d.weight ??
            d.attributes?.weight ??
            d.attributes?.['Gewicht (kg)'] ??
            d.attributes?.['Gewicht'];
          const num = Number(raw);
          if (raw === undefined || raw === null || raw === '' || !Number.isFinite(num) || num <= 0) {
            return <span className="text-txt-secondary text-sm">—</span>;
          }
          return (
            <div className="text-txt-secondary text-sm font-mono leading-tight whitespace-nowrap">
              {`${num} kg`}
            </div>
          );
        },
      },
      {
        id: 'price',
        label: t('table.price'),
        sortKey: 'details.pricing.sellPrice',
        defaultVisible: true,
        // Effective Verkaufspreis = the price the marketplace actually uses:
        // sellPrice (your durable, enrichment-safe override) if set, else the researched
        // lowest_price as a fallback (mirrors lib/kaufland-api.js price resolution).
        // Editing writes sellPrice (see EDITABLE_COLUMN_MAP). Fallback shown muted so you
        // can see at a glance which products still need a confirmed sell price.
        render: ({ product }) => {
          const pricing = product.details?.pricing;
          const sell = Number(pricing?.sellPrice);
          const hasSell = Number.isFinite(sell) && sell > 0;
          const market = Number(pricing?.lowest_price?.amount);
          const hasMarket = Number.isFinite(market) && market > 0;
          const value = hasSell ? sell : hasMarket ? market : null;
          if (value === null) {
            return <span className="text-txt-muted text-sm">—</span>;
          }
          const formatted = new Intl.NumberFormat('de-DE', {
            style: 'currency',
            currency: safeCurrency(pricing?.lowest_price?.currency),
          }).format(value);
          return hasSell ? (
            <span className="text-txt-primary">{formatted}</span>
          ) : (
            <span className="text-txt-muted" title="Marktpreis-Schätzung — noch kein Verkaufspreis gesetzt">
              {formatted}
            </span>
          );
        },
      },
      {
        id: 'inventory',
        label: t('table.inventory'),
        sortKey: 'inventory.quantity',
        defaultVisible: true,
        render: ({ product }) => (
          <div className="flex flex-col leading-tight">
            <span className="font-semibold text-txt-primary text-center block">{getProductQuantity(product)}</span>
          </div>
        ),
      },
      {
        id: 'sold',
        label: t('table.sold'),
        sortKey: 'inventory.soldQuantity',
        defaultVisible: true,
        render: ({ product }) => {
          const inv = (product as any)?.inventory || {};
          const sold = Number(inv.soldQuantity) || 0;
          const open = Number(inv.openOrderQuantity) || 0;
          const total = sold + open;
          if (total <= 0) {
            return <span className="text-txt-muted text-sm">—</span>;
          }
          return (
            <div className="flex flex-col items-center leading-tight gap-0.5">
              <span className="inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-semibold bg-success/15 text-success">
                {sold}
              </span>
              {open > 0 && (
                <span className="inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-semibold bg-warning-dim text-warning">
                  +{open} offen
                </span>
              )}
            </div>
          );
        },
      },
      {
        id: 'notizen',
        label: 'Notizen',
        defaultVisible: true,
        render: ({ product }) => {
          const info = notesOverview.get(product.id);
          const n = info?.count || 0;
          if (n <= 0) return <span className="text-txt-muted text-sm">—</span>;
          const unread = hasUnreadNotes(info);
          return (
            <span
              className={`inline-flex items-center justify-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
                unread ? 'bg-warning-dim text-warning' : 'bg-accent/15 text-accent'
              }`}
              title={`${n} Notiz${n === 1 ? '' : 'en'}${unread ? ' · ungelesen' : ''}`}
            >
              {unread && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-warning" />}
              {n}
            </span>
          );
        },
      },
      {
        id: 'pendingIntake',
        label: t('table.pendingIntake'),
        sortKey: 'ops.pending_intake_quantity',
        defaultVisible: true,
        render: ({ product }) => {
          const pending = Number(product.ops?.pending_intake_quantity) || 0;
          if (pending <= 0) {
            return <span className="text-txt-muted text-sm">0</span>;
          }
          return (
            <span className="inline-flex items-center justify-center rounded-full bg-warning-dim px-2 py-0.5 text-xs font-semibold text-warning">
              +{pending}
            </span>
          );
        },
      },
      {
        id: 'storage',
        label: t('table.storage'),
        sortKey: 'storage.binCode',
        defaultVisible: false,
        render: ({ product }) =>
          primaryBin(product) ? (
            <div className="flex flex-col text-sm text-txt-secondary">
              <span className="font-mono text-base text-txt-primary">{primaryBin(product)}</span>
            </div>
          ) : (
            <span className="text-txt-muted">{t('table.noBin')}</span>
          ),
      },
      {
        id: 'los',
        label: 'Los',
        sortKey: 'ops.sourceLot',
        defaultVisible: true,
        render: ({ product }) => {
          const lot = product.ops?.sourceLot;
          if (!lot) return <span className="text-txt-muted text-sm">—</span>;
          const assignedAt = product.ops?.sourceLotAt;
          return (
            <span
              className="font-mono text-sm text-txt-secondary whitespace-nowrap"
              title={assignedAt ? `Los zugeordnet am ${new Date(assignedAt).toLocaleDateString('de-DE')}` : undefined}
            >
              {lot}
            </span>
          );
        },
      },
      {
        id: 'ebay',
        label: 'eBay',
        sortKey: 'ebay.listed',
        defaultVisible: true,
        render: ({ product }) => {
          // Primary: ops.listingStatus.ebay from listing-sync-runner
          const ebayStatus = (product as any)?.ops?.listingStatus?.ebay;
          // Fallback link resolution: SKU match, productId match, marketplace.ebay.itemId
          const skuCandidates = Array.from(
            new Set(
              [
                normalizeSku(product.details?.identifiers?.sku),
                normalizeSku((product as any)?.identification?.sku),
              ].filter(Boolean)
            )
          );
          const pidItemId = ebayProductIdMap.get(product.id);
          const marketplaceItemId = String((product as any)?.marketplace?.ebay?.itemId || '').trim();
          const skuUrl = skuCandidates.map((sku) => ebayLinkedMap.get(sku)).find(Boolean) || null;
          const viewItemUrl =
            skuUrl ||
            (pidItemId ? `https://www.ebay.de/itm/${encodeURIComponent(pidItemId)}` : null) ||
            (marketplaceItemId && ebayActiveItemIds.has(marketplaceItemId)
              ? `https://www.ebay.de/itm/${encodeURIComponent(marketplaceItemId)}`
              : null);
          // Determine listed state: SKU-index (viewItemUrl) has priority over stale ops.listingStatus
          const isActive = !!viewItemUrl || ebayStatus === 'active';
          const isInactive = !isActive && ebayStatus === 'inactive';
          return (
            isActive && viewItemUrl ? (
              <a
                href={viewItemUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                title="eBay-Listing öffnen"
                className="inline-flex items-center justify-center rounded-full bg-warning-dim px-2 py-0.5 text-xs font-semibold text-warning hover:bg-warning/20 hover:text-warning"
              >
                Gelistet
              </a>
            ) : isActive ? (
              <span
                title="Auf eBay gelistet"
                className="inline-flex items-center justify-center rounded-full bg-warning-dim px-2 py-0.5 text-xs font-semibold text-warning"
              >
                Gelistet
              </span>
            ) : isInactive ? (
              <span
                title="eBay-Listing inaktiv"
                className="inline-flex items-center justify-center rounded-full bg-warning-dim px-2 py-0.5 text-xs font-semibold text-warning"
              >
                Inaktiv
              </span>
            ) : (
              <span
                title="Nicht auf eBay gelistet"
                className="inline-flex items-center justify-center rounded-full bg-app-elevated px-2 py-0.5 text-xs font-semibold text-txt-muted"
              >
                —
              </span>
            )
          );
        },
      },
      {
        id: 'kaufland',
        label: 'Kaufland',
        sortKey: 'kaufland.listed',
        defaultVisible: true,
        render: ({ product }) => {
          // Primary: ops.listingStatus.kaufland from listing-sync-runner
          const kauflandStatus = (product as any)?.ops?.listingStatus?.kaufland;
          const kp = (product as any)?.ops?.kaufland || {};
          const lastStatus = String(kp?.last_sync_status || '').toLowerCase();
          const sku = normalizeSku(
            (product as any)?.identification?.sku ||
            product?.details?.identifiers?.sku ||
            (product as any)?.id ||
            ''
          );
          const eanCandidates = Array.from(
            new Set(
              [
                product?.details?.identifiers?.ean,
                product?.details?.identifiers?.gtin,
                product?.details?.identifiers?.upc,
                ...((product as any)?.identification?.barcodes || []),
              ]
                .map((v) => normalizeEan(String(v || '')))
                .filter(Boolean)
            )
          );
          // Fallback: cross-reference kauflandUnitsLive index
          const listedByIndex = (sku && kauflandSkuSet.has(sku)) || eanCandidates.some((ean) => kauflandEanSet.has(ean));
          const failed = lastStatus === 'failed';
          const skuUrl = sku ? kauflandSkuUrlMap.get(sku) : null;
          const eanUrl = eanCandidates.map((ean) => kauflandEanUrlMap.get(ean)).find(Boolean) || null;
          const skuProductId = sku ? kauflandSkuProductIdMap.get(sku) : null;
          const eanProductId = eanCandidates.map((ean) => kauflandEanProductIdMap.get(ean)).find((v) => Number(v) > 0) || null;
          const viewItemUrl = skuUrl || eanUrl || buildKauflandProductUrl(skuProductId || eanProductId || null) || null;
          // Determine listed state: SKU/EAN index (listedByIndex) has priority over stale ops.listingStatus
          const isActive = listedByIndex || kauflandStatus === 'active';
          const isInactive = !isActive && kauflandStatus === 'inactive';
          return (
            failed ? (
              <span
                title="Kaufland-Sync fehlgeschlagen"
                className="inline-flex items-center justify-center rounded-full bg-danger-dim px-2 py-0.5 text-xs font-semibold text-danger"
              >
                Fehler
              </span>
            ) : isActive && viewItemUrl ? (
              <a
                href={viewItemUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                title="Kaufland-Listing öffnen"
                className="inline-flex items-center justify-center rounded-full bg-danger-dim px-2 py-0.5 text-xs font-semibold text-danger hover:bg-danger/20 hover:text-danger"
              >
                Gelistet
              </a>
            ) : isActive ? (
              <span
                title="Auf Kaufland gelistet (kein Link verfügbar)"
                className="inline-flex items-center justify-center rounded-full bg-danger-dim px-2 py-0.5 text-xs font-semibold text-danger"
              >
                Gelistet
              </span>
            ) : isInactive ? (
              <span
                title="Kaufland-Listing inaktiv"
                className="inline-flex items-center justify-center rounded-full bg-danger-dim px-2 py-0.5 text-xs font-semibold text-danger"
              >
                Inaktiv
              </span>
            ) : lastStatus === 'ok' ? (
              <span
                title="Kaufland-Sync OK, aber nicht im Index"
                className="inline-flex items-center justify-center rounded-full bg-warning-dim px-2 py-0.5 text-xs font-semibold text-warning"
              >
                Sync OK
              </span>
            ) : (
              <span
                title="Nicht auf Kaufland gelistet"
                className="inline-flex items-center justify-center rounded-full bg-app-elevated px-2 py-0.5 text-xs font-semibold text-txt-muted"
              >
                —
              </span>
            )
          );
        },
      },
      {
        id: 'lastSold',
        label: t('table.lastSold'),
        sortKey: 'details.attributes.lastSoldAt',
        defaultVisible: false,
        render: ({ product }) => {
          const attrs = product.details?.attributes || {};
          const raw =
            (attrs.lastSoldAt as string) ||
            (attrs.last_sold_at as string) ||
            (attrs.lastSold as string) ||
            null;
          if (!raw) return <span className="text-txt-muted">Keine Daten</span>;
          const date = new Date(raw);
          if (Number.isNaN(date.getTime())) return <span className="text-txt-muted">Unbekannt</span>;
          return <span className="text-txt-secondary text-sm">{date.toLocaleString('de-DE')}</span>;
        },
      },
      {
        id: 'readiness',
        label: t('table.readiness'),
        sortKey: 'ops.readiness',
        defaultVisible: true,
        render: ({ product }) => (
          <ReadinessBadge readiness={product.ops?.readiness} editor={product.ops?.readiness_editor} />
        ),
      },
      {
        id: 'saveStatus',
        label: t('table.saveStatus'),
        defaultVisible: true,
        render: ({ product }) => <SaveStatusBadge saved={Boolean(product.ops?.last_saved_iso)} />,
      },
      {
        id: 'createdAt',
        label: t('table.createdAt'),
        sortKey: 'ops.created_at_iso',
        defaultVisible: true,
        render: ({ product }) => (
          <span className="text-txt-muted text-sm">
            {(product.ops as any)?.created_at_iso ? new Date((product.ops as any).created_at_iso).toLocaleString('de-DE') : 'N/A'}
          </span>
        ),
      },
      // Admin-only: wer hat das Produkt erfasst (Feld am Produkt, sonst Protokoll-Map).
      ...(isAdmin ? [{
        id: 'erfasstVon' as ColumnId,
        label: t('table.identifiedBy'),
        sortKey: 'erfasstVon',
        defaultVisible: true,
        render: ({ product }: { product: any }) => {
          const label = resolveErfasstVon(product);
          return label
            ? <span className="text-txt-secondary text-sm whitespace-nowrap">{label}</span>
            : <span className="text-txt-muted text-sm">—</span>;
        },
      }] : []),
      {
        id: 'lastSaved',
        label: t('table.lastSaved'),
        sortKey: 'ops.last_saved_iso',
        defaultVisible: true,
        render: ({ product }) => (
          <span className="text-txt-muted text-sm">
            {product.ops.last_saved_iso ? new Date(product.ops.last_saved_iso).toLocaleString('de-DE') : 'N/A'}
          </span>
        ),
      },
      {
        id: 'lastSynced',
        label: t('table.lastSynced'),
        sortKey: 'ops.last_synced_iso',
        defaultVisible: true,
        render: ({ product }) => (
          <span className="text-txt-muted text-sm">
            {product.ops.last_synced_iso ? new Date(product.ops.last_synced_iso).toLocaleString('de-DE') : 'N/A'}
          </span>
        ),
      },
      {
        id: 'revision',
        label: t('table.revision'),
        sortKey: 'ops.revision',
        defaultVisible: false,
        widthClass: 'text-center',
        render: ({ product }) => <span className="text-txt-secondary text-sm">{product.ops.revision}</span>,
      },
    ];
    return baseRenderers;
  }, [
    onSelectProduct,
    t,
    ebayLinkedMap,
    ebayProductIdMap,
    ebayActiveItemIds,
    kauflandSkuSet,
    kauflandEanSet,
    kauflandSkuUrlMap,
    kauflandEanUrlMap,
    kauflandSkuProductIdMap,
    kauflandEanProductIdMap,
    notesOverview,
    isAdmin,
    resolveErfasstVon,
  ]);

  const resolveInitialColumns = (): ColumnId[] => {
    if (typeof window !== 'undefined') {
      try {
        const stored = window.localStorage.getItem(COLUMN_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as ColumnId[];
          const valid = parsed.filter((id) => columnDefinitions.some((col) => col.id === id));
          if (valid.length > 0) {
            // Neu hinzugefügte Spalten (defaultVisible: true im Standard-Preset) automatisch ergänzen
            const newDefaults = COLUMN_PRESETS.standard.filter(
              (id) => !valid.includes(id) && columnDefinitions.some((col) => col.id === id && col.defaultVisible)
            );
            return normalizeMarketplaceColumnOrder(newDefaults.length > 0 ? [...valid, ...newDefaults] : valid);
          }
        }
      } catch (error) {
        console.warn('Konnte gespeicherte Spalten nicht laden:', error);
      }
    }
    const mobileDefault = typeof window !== 'undefined' ? window.matchMedia('(max-width: 900px)').matches : false;
    return normalizeMarketplaceColumnOrder(mobileDefault ? COLUMN_PRESETS.minimal : COLUMN_PRESETS.standard);
  };

  const [visibleColumns, setVisibleColumns] = useState<ColumnId[]>(() => resolveInitialColumns());

  // Per-User-Persistenz (serverseitig, geräteübergreifend): beim Mount die im
  // Profil gespeicherte Spaltenkonfiguration laden — sie gewinnt gegenüber dem
  // rein lokalen localStorage-Cache. profileLoadedRef verhindert, dass der
  // initiale State das Profil sofort wieder überschreibt.
  const profileLoadedRef = useRef(false);
  const profileSaveTimer = useRef<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    import('../api/client').then(({ fetchProfile }) =>
      fetchProfile()
        .then((profile) => {
          if (cancelled) return;
          const stored = (profile as any)?.tablePrefs?.adminTableColumns;
          if (Array.isArray(stored) && stored.length > 0) {
            const valid = stored.filter((id: ColumnId) => columnDefinitions.some((c) => c.id === id));
            if (valid.length > 0) {
              // Neu hinzugefügte Standard-Spalten (defaultVisible) auch bei einer
              // gespeicherten Profil-Konfiguration ergänzen — sonst sieht ein Nutzer
              // mit eigener Spaltenauswahl neue Spalten nie (symmetrisch zum localStorage-Pfad).
              const newDefaults = COLUMN_PRESETS.standard.filter(
                (id) => !valid.includes(id) && columnDefinitions.some((c) => c.id === id && c.defaultVisible)
              );
              setVisibleColumns(normalizeMarketplaceColumnOrder(newDefaults.length > 0 ? [...valid, ...newDefaults] : valid));
            }
          }
        })
        .catch(() => {})
        .finally(() => { if (!cancelled) profileLoadedRef.current = true; })
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(visibleColumns));
    } catch (error) {
      console.warn('Konnte Spaltenkonfiguration nicht speichern:', error);
    }
    // Debounced ins Nutzer-Profil spiegeln (erst nach dem initialen Profil-Load,
    // damit der Default-State das gespeicherte Profil nicht überschreibt).
    if (!profileLoadedRef.current) return;
    if (profileSaveTimer.current) window.clearTimeout(profileSaveTimer.current);
    profileSaveTimer.current = window.setTimeout(() => {
      import('../api/client').then(({ saveProfile }) =>
        saveProfile({ tablePrefs: { adminTableColumns: visibleColumns } }).catch(() => {})
      );
    }, 1200);
  }, [visibleColumns]);

  useEffect(() => {
    const match = (preset: ColumnPreset) =>
      COLUMN_PRESETS[preset].length === visibleColumns.length &&
      COLUMN_PRESETS[preset].every((id) => visibleColumns.includes(id));
    if (match('standard')) setColumnPreset('standard');
    else if (match('warehouse')) setColumnPreset('warehouse');
    else if (match('pricing')) setColumnPreset('pricing');
    else if (match('minimal')) setColumnPreset('minimal');
    else setColumnPreset('standard');
  }, [visibleColumns]);

  const toggleColumnVisibility = (id: ColumnId) => {
    setVisibleColumns((prev) => {
      if (prev.includes(id)) {
        if (prev.length === 1) return prev; // mindestens eine Spalte
        return prev.filter((columnId) => columnId !== id);
      }
      // Insert at canonical position from columnDefinitions
      const canonicalOrder = columnDefinitions.map((c) => c.id);
      const next = [...prev, id];
      next.sort((a, b) => canonicalOrder.indexOf(a) - canonicalOrder.indexOf(b));
      return next;
    });
  };

  const moveColumn = (id: ColumnId, direction: 'up' | 'down') => {
    setVisibleColumns((prev) => {
      const idx = prev.indexOf(id);
      if (idx < 0) return prev;
      const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
      return next;
    });
  };

  // Drag & Drop: Spalte an eine Ziel-Position verschieben.
  const moveColumnTo = (id: ColumnId, targetIndex: number) => {
    setVisibleColumns((prev) => {
      const from = prev.indexOf(id);
      if (from < 0) return prev;
      const next = [...prev];
      next.splice(from, 1);
      next.splice(Math.max(0, Math.min(targetIndex, next.length)), 0, id);
      return next;
    });
  };

  const resetColumns = () => {
    setVisibleColumns(normalizeMarketplaceColumnOrder(COLUMN_PRESETS.standard));
    setColumnPreset('standard');
  };

  const visibleColumnDefinitions = useMemo(() => {
    return columnDefinitions
      .filter((col) => visibleColumns.includes(col.id))
      .sort((a, b) => visibleColumns.indexOf(a.id) - visibleColumns.indexOf(b.id));
  }, [columnDefinitions, visibleColumns]);

  const filteredAndSortedProducts = useMemo(() => {
    const scoped =
      scopeProductIds && scopeProductIds.size ? products.filter((p) => scopeProductIds.has(p.id)) : products;
    const modeFiltered =
      mode === 'inventory'
        ? scoped.filter(isInventoryItem)
        : mode === 'products'
          ? scoped.filter(isProductBacklogItem)
          : scoped;

    // Volltextsuche (Name, Marke, SKU/EAN/GTIN/UPC, Id) — bleibt bewusst
    // ausserhalb der Registry: sie hat ein eigenes Eingabefeld und einen
    // eigenen Kanal (Topbar-Suche via utils/globalSearch.ts).
    const term = (searchTerm || '').toLowerCase().trim();
    const searchFiltered =
      term === ''
        ? modeFiltered
        : modeFiltered.filter((p) => {
            const name = (p.identification?.name || '').toLowerCase();
            const brand = (p.identification?.brand || '').toLowerCase();
            const identifiers = [
              p.details?.identifiers?.sku,
              p.identification?.sku,
              p.details?.identifiers?.ean,
              p.details?.identifiers?.gtin,
              p.details?.identifiers?.upc,
              p.id,
            ]
              .filter(Boolean)
              .map((v) => String(v).toLowerCase());
            return name.includes(term) || brand.includes(term) || identifiers.some((idVal) => idVal.includes(term));
          });

    // Alle Dimensionen laufen durch die Registry — `now` frisch, damit
    // rollierende Datums-Presets ("Letzte 7 Tage") korrekt bleiben.
    const liveCtx = { ...filterCtx, now: new Date() };
    const filtered = applyProductFilters(searchFiltered, activeFilters, liveCtx, { isAdmin });

    if (sortLevels.length === 0) return filtered;

    const getNestedValue = (obj: any, path: string) => path.split('.').reduce((o, k) => (o || {})[k], obj);
    const getSortValue = (product: Product, key: string): unknown => {
      switch (key) {
        case 'category.display':
          return getProductDisplayCategory(product).toLowerCase();
        case 'details.pricing.sellPrice':
          // Effektiver Preis (sellPrice, sonst Marktpreis); ohne Preis → ans Ende.
          return effectiveSellPrice(product);
        case 'images.count':
          return Array.isArray(product.details?.images) ? product.details.images.length : 0;
        case 'inventory.quantity':
          // Sort by effektiver Bestand (summe aus inventory + storageBins)
          return getProductQuantity(product);
        case 'storage.binCode':
          return (primaryBin(product) || '').toString().toLowerCase();
        case 'erfasstVon':
          // Anzeigename (Feld am Produkt oder Protokoll-Map); leer sortiert ans Ende.
          return resolveErfasstVon(product).toLowerCase();
        case 'details.weight':
          // Gleiche Kette wie Spalte + Filter (utils/productFilters.ts).
          return productWeightKg(product);
        case 'identification.name':
          return (product.identification?.name || '').toString().toLowerCase();
        // Gelistet-Sortierung nutzt dieselbe Wahrheit wie Badge + Filter:
        // den Live-Index. ops.listingStatus kann stale sein (Incident 2026-08-20)
        // — vorher widersprach die Sortierung dem eigenen Badge.
        case 'ebay.listed':
          return isEbayListed(product, liveCtx) ? 1 : 0;
        case 'kaufland.listed':
          return isKauflandListed(product, liveCtx) ? 1 : 0;
        default:
          return getNestedValue(product, key);
      }
    };

    // Kopie vor sort(): applyProductFilters liefert bei leerem Filterzustand
    // das Original-Array (die products-Prop) zurueck.
    return [...filtered].sort(buildProductComparator(sortLevels, getSortValue));
  }, [
    products,
    scopeProductIds,
    mode,
    searchTerm,
    activeFilters,
    filterCtx,
    isAdmin,
    resolveErfasstVon,
    ebayLinkedMap,
    ebayProductIdMap,
    ebayActiveItemIds,
    kauflandSkuSet,
    kauflandEanSet,
    sortLevels,
  ]);

  // Marktplatz-Zustand fuer den Export — dieselbe Live-Index-Wahrheit wie
  // Badge, Filter und Sortierung; Validierungsfehler wie im Warenbestand.
  const exportMarketplaceInfo = useCallback(
    (p: Product) => {
      const isEbayActive = isEbayListed(p, filterCtx);
      const isKauflandActive = isKauflandListed(p, filterCtx);
      const ebayValidation = p.marketplace_listings?.ebay?.validation;
      const kauflandValidation = p.marketplace_listings?.kaufland?.validation;
      const hasErrors = Boolean(
        (ebayValidation && !ebayValidation.ready) || (kauflandValidation && !kauflandValidation.ready)
      );
      const errorCount = (ebayValidation?.issues?.length ?? 0) + (kauflandValidation?.issues?.length ?? 0);
      return { isEbayActive, isKauflandActive, isListed: isEbayActive || isKauflandActive, hasErrors, errorCount };
    },
    [filterCtx]
  );

  const handleProduktExport = useCallback(
    ({ scope, fields, numberFormat }: { scope: InventoryExportScope; fields: string[]; numberFormat: InventoryExportPreferences['numberFormat'] }) => {
      // "Gefilterte Auswahl" = exakt die aktuelle Ansicht in ihrer Sortierung;
      // "Alle Produkte" = kompletter Datensatz in Ladereihenfolge.
      const list = scope === 'all' ? products : filteredAndSortedProducts;
      const { headers, rows } = buildInventoryExport(
        list,
        fields,
        { marketplace: exportMarketplaceInfo, identifiedBy: resolveErfasstVon },
        numberFormat
      );
      exportToCsv(buildProductExportFilename(scope), headers, rows);
      const next: InventoryExportPreferences = { fields, numberFormat };
      saveProductExportPreferences(next, safeLocalStorage());
      setExportPrefs(next);
      setExportDialogOpen(false);
    },
    [products, filteredAndSortedProducts, exportMarketplaceInfo, resolveErfasstVon]
  );

  const totalPages = Math.max(1, Math.ceil(filteredAndSortedProducts.length / pageSize));
  useEffect(() => {
    setCurrentPage((prev) => {
      if (prev > totalPages) return totalPages;
      if (prev < 1) return 1;
      return prev;
    });
  }, [totalPages]);

  // Nach jeder Aenderung an Suche, Filtern oder Seitengroesse zurueck auf
  // Seite 1. Vorher blieb die Ansicht stehen: wer auf Seite 6 filterte, sah die
  // Treffer 251-300 statt der ersten — oder landete durch die Kappung unten auf
  // einer fast leeren Seite. Aufträge und Marktplatz-Angebote machen das seit
  // jeher richtig; ausgerechnet die groesste Tabelle nicht.
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, activeFilters, pageSize, mode]);

  const pageProducts = useMemo(() => {
    const safePage = Math.min(Math.max(currentPage, 1), totalPages);
    const start = (safePage - 1) * pageSize;
    return filteredAndSortedProducts.slice(start, start + pageSize);
  }, [filteredAndSortedProducts, currentPage, pageSize, totalPages]);

  const requestSort = (key: string, additive: boolean) => {
    setSortLevels((prev) => toggleSortLevel(prev, key, additive));
  };

  /**
   * Kopf-Haekchen ERGAENZT die Auswahl um die sichtbare Seite.
   *
   * Vorher ersetzte es sie komplett: wer auf Seite 1 Artikel anhakte und auf
   * Seite 2 das Kopf-Haekchen setzte, verlor die erste Auswahl lautlos — die
   * Sammelaktion uebersprang sie dann stillschweigend. Abhaken leerte sogar die
   * Auswahl ALLER Seiten. Aufträge und Marktplatz-Angebote wurden bereits
   * umgestellt; die Produkttabelle blieb auf dem alten Stand.
   */
  const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    const seitenIds = pageProducts.map((p) => p.id);
    if (e.target.checked) {
      setSelectedIds((prev) => new Set([...prev, ...seitenIds]));
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        seitenIds.forEach((id) => next.delete(id));
        return next;
      });
    }
  };

  const handleSelectAllFiltered = () => {
    setSelectedIds(new Set(filteredAndSortedProducts.map((p) => p.id)));
  };

  const handleSelectOne = (id: string) => {
    setSelectedIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  const handleBatchPublishEbay = async () => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    setEbayPublishInProgress(true);
    setNotice({
      tone: 'info',
      title: 'eBay Publish',
      message: `Prüfe ${ids.length} Produkte für eBay...`,
    });
    try {
      const verifyResult = await bulkVerifyEbayPublish(ids);
      const { ready, blocked } = verifyResult.summary;
      if (ready === 0) {
        const blockerMessages = verifyResult.items
          .filter((item) => !item.canPublish)
          .slice(0, 5)
          .map((item) => `${item.productId}: ${item.blockers.join(', ')}`)
          .join('\n');
        setNotice({
          tone: 'error',
          title: 'eBay Publish blockiert',
          message: `Alle ${blocked} Produkte haben Blocker.`,
          details: blockerMessages,
        });
        return;
      }
      if (!window.confirm(`${ready} von ${ids.length} Produkten können auf eBay gelistet werden.${blocked > 0 ? ` ${blocked} Produkte übersprungen (Blocker).` : ''}\n\nFortfahren?`)) {
        return;
      }
      setNotice({
        tone: 'info',
        title: 'eBay Publish',
        message: `Liste ${ready} Produkte auf eBay.de...`,
      });
      const readyIds = verifyResult.items.filter((item) => item.canPublish).map((item) => item.productId);
      const publishResult = await bulkPublishToEbay(readyIds);
      const { success, failed } = publishResult.summary;
      const blockedItems = verifyResult.items.filter((item) => !item.canPublish);
      const detailLines: string[] = [];
      publishResult.results
        .filter((r) => !r.ok)
        .slice(0, 5)
        .forEach((r) => detailLines.push(`✗ ${r.productId}: ${r.blockers?.join(', ') || r.warnings?.join(', ') || 'Fehler'}`));
      blockedItems
        .slice(0, 5)
        .forEach((item) => detailLines.push(`⊘ ${item.productId}: ${item.blockers?.join(', ') || 'Geblockt'}`));
      setNotice({
        tone: failed === 0 && blocked === 0 ? 'success' : 'warning',
        title: 'eBay Publish abgeschlossen',
        message: `Gelistet: ${success}${failed > 0 ? `, Fehlgeschlagen: ${failed}` : ''}${blocked > 0 ? `, Übersprungen: ${blocked}` : ''}`,
        details: detailLines.length > 0 ? detailLines.join('\n') : undefined,
      });
      if (success > 0) {
        try {
          const list = await fetchProducts();
          if (Array.isArray(list)) onUpdateProducts(list);
        } catch {
          // ignore
        }
        // eBay Maps neu laden damit neu gelistete Artikel sofort den Indikator bekommen
        fetchEbaySkuIndex().then((entries) => {
          const urlMap = new Map<string, string>();
          const itemIdMap = new Map<string, string>();
          const pidMap = new Map<string, string>();
          entries.forEach((entry) => {
            const url = entry.viewItemUrl || `https://www.ebay.de/itm/${encodeURIComponent(entry.itemId)}`;
            if (entry.sku) {
              const key = String(entry.sku).trim().toUpperCase();
              urlMap.set(key, url);
              itemIdMap.set(key, entry.itemId);
            }
            if (entry.productId) {
              pidMap.set(entry.productId, entry.itemId);
            }
          });
          setEbayLinkedMap(urlMap);
          setEbayItemIdMap(itemIdMap);
          setEbayProductIdMap(pidMap);
        }).catch(() => {});
        loadKauflandIndex().catch(() => {});
      }
      setSelectedIds(new Set());
    } catch (err: any) {
      setNotice({
        tone: 'error',
        title: 'eBay Publish fehlgeschlagen',
        details: err?.message || String(err),
      });
    } finally {
      setEbayPublishInProgress(false);
    }
  };

  const handleBatchUpdateEbay = async () => {
    const ids = Array.from(selectedIds);
    // Selektierte Produkte → itemIds über SKU-Lookup
    const listedItemIds = ids
      .map((pid) => {
        const product = products.find((p) => p.id === pid);
        if (!product) return null;
        const sku = String(
          (product as any)?.identification?.sku || product.details?.identifiers?.sku || ''
        ).trim().toUpperCase();
        return (sku ? ebayItemIdMap.get(sku) : null) || ebayProductIdMap.get(pid) || null;
      })
      .filter((id): id is string => Boolean(id));

    if (!listedItemIds.length) {
      setNotice({
        tone: 'error',
        title: 'eBay Update',
        message: 'Keine der ausgewählten Produkte ist auf eBay gelistet.',
      });
      return;
    }

    if (!window.confirm(
      `${listedItemIds.length} eBay-Listing${listedItemIds.length !== 1 ? 's' : ''} aktualisieren?\nNur geänderte Felder werden übertragen.\n\nFortfahren?`
    )) return;

    setEbayUpdateInProgress(true);
    setNotice({ tone: 'info', title: 'eBay Update', message: `Aktualisiere ${listedItemIds.length} Listing${listedItemIds.length !== 1 ? 's' : ''}...` });

    try {
      const result = await bulkUpdateEbayListings({ itemIds: listedItemIds });
      const { success, failed, skipped } = result.summary;
      setNotice({
        tone: failed === 0 ? 'success' : 'warning',
        title: 'eBay Update abgeschlossen',
        message: `Aktualisiert: ${success}${failed > 0 ? `, Fehlgeschlagen: ${failed}` : ''}${skipped > 0 ? `, Übersprungen: ${skipped}` : ''}`,
      });
    } catch (err: any) {
      setNotice({ tone: 'error', title: 'eBay Update fehlgeschlagen', details: err?.message || String(err) });
    } finally {
      setEbayUpdateInProgress(false);
    }
  };

  const handleSyncEbayListings = async () => {
    if (!window.confirm('eBay-Listings jetzt synchronisieren?\nDadurch wird nur der Listing-Status im Inventory aktualisiert.')) return;
    setEbaySyncInProgress(true);
    setNotice({ tone: 'info', title: 'eBay Sync', message: 'Synchronisiere eBay-Listings...' });
    try {
      await lightSyncEbayLiveListings({});
      const entries = await fetchEbaySkuIndex();
      const urlMap = new Map<string, string>();
      const itemIdMap = new Map<string, string>();
      const pidMap = new Map<string, string>();
      const activeItemIds = new Set<string>();
      entries.forEach((entry) => {
        const url = entry.viewItemUrl || `https://www.ebay.de/itm/${encodeURIComponent(entry.itemId)}`;
        if (entry.itemId) activeItemIds.add(String(entry.itemId).trim());
        const key = normalizeSku(entry.sku);
        if (key) {
          urlMap.set(key, url);
          itemIdMap.set(key, entry.itemId);
        }
        if (entry.productId) {
          pidMap.set(entry.productId, entry.itemId);
        }
      });
      setEbayLinkedMap(urlMap);
      setEbayItemIdMap(itemIdMap);
      setEbayProductIdMap(pidMap);
      setEbayActiveItemIds(activeItemIds);
      setNotice({
        tone: 'success',
        title: 'eBay Sync abgeschlossen',
        message: `Aktive Listings: ${activeItemIds.size}.`,
      });
    } catch (err: any) {
      setNotice({ tone: 'error', title: 'eBay Sync fehlgeschlagen', details: err?.message || String(err) });
    } finally {
      setEbaySyncInProgress(false);
    }
  };

  const enqueueBulkForIds = async (action: ProductBulkActionName, ids: string[], opts?: { apply?: boolean }) => {
    if (!ids.length) return;
    setBulkJobLoading(true);
    setNotice({
      tone: 'info',
      title: 'Bulk Action gestartet',
      message: `${action.toUpperCase()} für ${ids.length} Produkte wird im Backend ausgeführt …`,
    });
    try {
      const res = await runProductBulkAction({
        action,
        productIds: ids,
        apply:
          typeof opts?.apply === 'boolean'
            ? opts.apply
            : action === 'export_marketplace'
              ? false
              : true,
        debug: false,
        // price: default to "missing only"; set >0 in Admin → Bulk if you want "stale refresh"
        maxAgeDays: action === 'price' ? 0 : undefined,
        force: action === 'price',
        inventoryId: '78659',
      });
      setBulkJobId(res.jobId);
      setBulkJobAction(action);
      setNotice({
        tone: 'info',
        title: 'Bulk Job enqueued',
        message: `Job: ${res.jobId} (läuft asynchron).`,
      });
    } catch (err: any) {
      setNotice({
        tone: 'error',
        title: 'Bulk Action fehlgeschlagen',
        details: err?.message || String(err),
      });
    } finally {
      setBulkJobLoading(false);
    }
  };

  const enqueueBulkForSelection = async (action: ProductBulkActionName, opts?: { apply?: boolean }) => {
    const ids = Array.from(selectedIds);
    return enqueueBulkForIds(action, ids, opts);
  };

  const handleSyncKauflandListings = async () => {
    if (!window.confirm('Kaufland-Listings jetzt synchronisieren?\nDadurch wird der Status-Indikator in der Inventory-Tabelle aktualisiert.')) return;
    setKauflandSyncInProgress(true);
    setNotice({
      tone: 'info',
      title: 'Kaufland Sync',
      message: 'Lade aktuelle Kaufland-Listings...',
    });
    try {
      const result = await syncKauflandListings('de');
      await loadKauflandIndex();
      setNotice({
        tone: 'success',
        title: 'Kaufland Sync abgeschlossen',
        message: `Aktive Listings: ${result.active} (geladen: ${result.fetched}).`,
      });
    } catch (err: any) {
      setNotice({
        tone: 'error',
        title: 'Kaufland Sync fehlgeschlagen',
        details: err?.message || String(err),
      });
    } finally {
      setKauflandSyncInProgress(false);
    }
  };

  const enqueueBulkForAllInCurrentMode = async (action: ProductBulkActionName, opts?: { apply?: boolean }) => {
    const scoped =
      scopeProductIds && scopeProductIds.size ? products.filter((p) => scopeProductIds.has(p.id)) : products;
    const modeFiltered =
      mode === 'inventory'
        ? scoped.filter(isInventoryItem)
        : mode === 'products'
          ? scoped.filter(isProductBacklogItem)
          : scoped;
    const ids = modeFiltered.map((p) => p.id);
    return enqueueBulkForIds(action, ids, opts);
  };

  useEffect(() => {
    if (!bulkJobId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const job = await getProductBulkJob(bulkJobId);
        if (cancelled) return;
        const status = String(job?.status || '');
        if (status === 'done') {
          const files = Array.isArray(job?.result?.files) ? job.result.files : [];
          const summary = job?.result?.summary && typeof job.result.summary === 'object' ? job.result.summary : {};
          const samples = Array.isArray(job?.result?.samples) ? job.result.samples : [];
          const failedSamples = samples
            .filter((sample: any) => String(sample?.status || '').toLowerCase() === 'error')
            .slice(0, 8)
            .map((sample: any) => ({
              id: sample?.id || null,
              sku: sample?.sku || null,
              message: sample?.message || null,
              errors: Array.isArray(sample?.errors) ? sample.errors : undefined,
            }));
          const failedCount = Math.max(
            Number.isFinite(Number((summary as any)?.failed)) ? Number((summary as any).failed) : 0,
            failedSamples.length
          );
          const csvUrl = files.find((f: any) => String(f?.mimeType || '').includes('text/csv'))?.url || files[0]?.url;
          if (bulkJobAction === 'export_marketplace' && csvUrl) {
            try {
              window.open(String(csvUrl), '_blank', 'noopener,noreferrer');
            } catch {
              // ignore
            }
          }
          if (bulkJobAction && bulkJobAction !== 'export_marketplace') {
            try {
              const list = await fetchProducts();
              if (Array.isArray(list)) {
                onUpdateProducts(list);
              }
            } catch {
              // ignore
            }
            if (bulkJobAction === 'kaufland_create' || bulkJobAction === 'kaufland_update') {
              loadKauflandIndex().catch(() => {});
            }
          }
          const detailsPayload = failedSamples.length
            ? { summary, failedSamples }
            : summary || job?.result || {};
          setNotice({
            tone: failedCount > 0 ? 'error' : 'success',
            title: failedCount > 0 ? 'Bulk Job mit Fehlern abgeschlossen' : 'Bulk Job abgeschlossen',
            message:
              failedCount > 0
                ? `Aktion abgeschlossen, aber ${failedCount} Eintrag${failedCount === 1 ? '' : 'e'} fehlgeschlagen.`
                : 'Aktion abgeschlossen. Bitte Produkte neu laden, um Änderungen zu sehen.',
            details: JSON.stringify(detailsPayload, null, 2),
          });
          setSelectedIds(new Set());
          setBulkJobId(null);
          setBulkJobAction(null);
        } else if (status === 'failed') {
          setNotice({
            tone: 'error',
            title: 'Bulk Job fehlgeschlagen',
            details: job?.error?.message || JSON.stringify(job?.error || {}, null, 2),
          });
          setBulkJobId(null);
          setBulkJobAction(null);
        }
      } catch {
        // ignore polling errors
      }
    };
    tick();
    const t = window.setInterval(tick, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [bulkJobId]);

  const executeBatchDelete = async (ids: string[]) => {
    if (!ids.length) return;
    const res = await deleteProductsBulk(ids, { purgeDuplicates: false });
    const remaining = [...products];
    const failures: string[] = [];
    if (!res.ok) {
      failures.push(res.error?.message || 'Bulk delete failed');
    } else {
      const deleted = new Set((res.deleted || []).map((x) => String(x)));
      // Remove deleted from local list
      for (let i = remaining.length - 1; i >= 0; i -= 1) {
        if (deleted.has(remaining[i].id)) {
          remaining.splice(i, 1);
        }
      }
      (res.failed || []).forEach((f) => failures.push(`${f.id}: ${f.error || 'failed'}`));
      (res.notFound || []).forEach((id) => failures.push(`${id}: not found`));
    }
    setSelectedIds(new Set());
    onUpdateProducts(remaining);
    if (failures.length > 0) {
      setNotice({
        tone: 'error',
        title: 'Löschen teilweise fehlgeschlagen',
        message: `${failures.length} / ${ids.length} konnten nicht gelöscht werden.`,
        details: failures.join('\n'),
      });
    } else {
      setNotice({
        tone: 'success',
        title: 'Produkte gelöscht',
        message: `${ids.length} Produkte wurden gelöscht.`,
      });
    }
  };

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    setConfirmDialog({
      title: 'Auswahl löschen?',
      tone: 'danger',
      description: `Diese Aktion ist dauerhaft. ${ids.length} ${
        ids.length === 1 ? 'Produkt wird' : 'Produkte werden'
      } gelöscht.`,
      details: ids.slice(0, 30).join('\n') + (ids.length > 30 ? `\n… +${ids.length - 30} mehr` : ''),
      confirmLabel: `Löschen (${ids.length})`,
      onConfirm: async () => {
        setConfirmDialog((prev) => (prev ? { ...prev, confirmBusy: true } : prev));
        try {
          await executeBatchDelete(ids);
        } finally {
          setConfirmDialog(null);
        }
      },
    });
  };

  const handleBatchLabelPrint = () => {
    if (selectedIds.size === 0) return;
    const selectedProducts = filteredAndSortedProducts.filter((p) => selectedIds.has(p.id));
    const missingSku = selectedProducts.filter(
      (p) => !(p.identification?.sku || p.details?.identifiers?.sku)
    );
    if (missingSku.length > 0) {
      setNotice({
        tone: 'warning',
        title: 'Labeldruck nicht möglich',
        message: 'Einige Produkte haben keine SKU.',
        details: missingSku.map((p) => `• ${p.identification?.name || p.id}`).join('\n'),
      });
      return;
    }
    const orderedIds = selectedProducts.map((p) => p.id);
    const result = openProductLabelBatchWindow(orderedIds);
    if (!result.ok) {
      setNotice({
        tone: 'error',
        title: 'Label-Ansicht konnte nicht geöffnet werden',
        details: result.error?.message || 'Unbekannter Fehler',
      });
    }
  };

  const handleAssignInventory = async () => {
    if (!inventorySelection) {
      setInventoryAssignMessage(t('table.inventory.selectOne'));
      return;
    }
    setInventoryAssigning(true);
    setInventoryAssignMessage(null);
    try {
      await assignInventoryToProducts(Array.from(selectedIds), inventorySelection);
      const inventoryRecord = inventories.find((inv) => inv.inventoryId === inventorySelection) || null;
      const updated = products.map((product) =>
        selectedIds.has(product.id)
          ? {
            ...product,
            inventory: {
              ...(product.inventory || {}),
              inventoryId: inventorySelection,
              inventoryName: inventoryRecord?.name || product.inventory?.inventoryName || null,
            },
          }
          : product
      );
      onUpdateProducts(updated);
      setInventoryAssignMessage(t('table.inventory.assignSuccess'));
      setInventoryModalOpen(false);
      setInventorySelection('');
    } catch (error: any) {
      console.error('Inventory assignment failed:', error);
      setInventoryAssignMessage(error?.message || t('table.inventory.assignError'));
    } finally {
      setInventoryAssigning(false);
    }
  };



  const runKTypeUpload = async (dryRun: boolean) => {
    if (!ktypeFile) {
      setKtypeMessage('Bitte eine CSV-Datei auswählen.');
      return;
    }
    setKtypeBusy(true);
    setKtypeReport(null);
    setKtypeMessage(dryRun ? 'Dry-Run läuft …' : 'Upload läuft …');
    try {
      const res = await uploadKTypeCsv(ktypeFile, { dryRun });
      if (!res.ok) {
        setKtypeMessage(res.error?.message || 'K‑Typ Import fehlgeschlagen.');
        return;
      }
      setKtypeReport(res.report || null);
      setKtypeMessage(
        dryRun
          ? 'Dry-Run abgeschlossen.'
          : 'Upload abgeschlossen. Bitte Produkte neu laden, damit die neuen K-Typ Werte sichtbar sind.'
      );
    } finally {
      setKtypeBusy(false);
    }
  };

  const handleExportCsv = async () => {
    if (selectedIds.size === 0) {
      setNotice({
        tone: 'warning',
        title: 'Keine Auswahl',
        message: 'Bitte zuerst Produkte auswählen – Export läuft nur auf die Auswahl.',
      });
      return;
    }
    await enqueueBulkForSelection('export_marketplace');
  };

  // `focusProductId` is a one-shot command ("scroll to this product once"), not
  // persistent state — it is set whenever a product is opened/acted upon and is
  // never cleared by the parent. `filteredAndSortedProducts` stays in the deps so a
  // not-yet-rendered row (e.g. a freshly identified product) still gets scrolled to
  // once its row appears. Without the ref guard the effect re-fires on every 60s
  // product poll (the memo returns a new array reference each time), which silently
  // scrolls the table back to the last-focused product even though nothing was
  // opened. The guard makes us act exactly once per focus value.
  const scrolledFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusProductId) {
      scrolledFocusRef.current = null;
      return;
    }
    if (scrolledFocusRef.current === focusProductId) return;
    const row = rowRefs.current[focusProductId];
    if (!row) return;
    scrolledFocusRef.current = focusProductId;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('ring-2', 'ring-accent', 'ring-offset-2', 'ring-offset-app-surface');
    const timeout = window.setTimeout(() => {
      row.classList.remove('ring-2', 'ring-accent', 'ring-offset-2', 'ring-offset-app-surface');
    }, 2000);
    return () => {
      window.clearTimeout(timeout);
      row.classList.remove('ring-2', 'ring-accent', 'ring-offset-2', 'ring-offset-app-surface');
    };
  }, [focusProductId, filteredAndSortedProducts]);

  const resetFilters = () => {
    setSearchTerm('');
    clearAllFilters();
    setAppliedViewId(null);
    setPageSize(50);
    setCurrentPage(1);
  };
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem('avystock:admin-table:search', searchTerm);
  }, [searchTerm]);
  // EIN Persistenz-Effekt fuer alle Filter (ersetzt die frueheren ~12
  // Einzel-Effekte je Alt-Schluessel).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.sessionStorage.setItem(FILTERS_STORAGE_KEY, serializeFilters(activeFilters));
    } catch {
      // ignore session storage errors
    }
  }, [activeFilters]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem('avystock:admin-table:pageSize', String(pageSize));
  }, [pageSize]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.sessionStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sortLevels));
    } catch {
      // ignore session storage errors
    }
  }, [sortLevels]);

  // Zaehler + "letzter aktiver Filter" kommen aus der Registry — nicht mehr
  // aus einer handgepflegten Aufzaehlung.
  const activeFilterEntries = useMemo(
    () =>
      activeFilters.filter((f) => {
        const def = filterDefs.find((d) => d.id === f.id);
        return def ? def.isActive(f.value) : false;
      }),
    [activeFilters, filterDefs]
  );
  const activeFilterCount = activeFilterEntries.length;

  const hasSelectedEbayListings = useMemo(() => {
    return Array.from(selectedIds).some((pid) => {
      const product = products.find((p) => p.id === pid);
      if (!product) return false;
      const sku = String(
        (product as any)?.identification?.sku || product.details?.identifiers?.sku || ''
      ).trim().toUpperCase();
      const marketplaceItemId = String((product as any)?.marketplace?.ebay?.itemId || '').trim();
      return Boolean(
        (sku && ebayItemIdMap.has(sku)) ||
        ebayProductIdMap.has(pid) ||
        (marketplaceItemId && ebayActiveItemIds.has(marketplaceItemId))
      );
    });
  }, [selectedIds, products, ebayItemIdMap, ebayProductIdMap, ebayActiveItemIds]);

  const hasSelectedKauflandListings = useMemo(() => {
    return Array.from(selectedIds).some((pid) => {
      const product = products.find((p) => p.id === pid);
      if (!product) return false;
      const sku = normalizeSku(
        (product as any)?.identification?.sku ||
        product?.details?.identifiers?.sku ||
        (product as any)?.id ||
        ''
      );
      const eanCandidates = Array.from(
        new Set(
          [
            product?.details?.identifiers?.ean,
            product?.details?.identifiers?.gtin,
            product?.details?.identifiers?.upc,
            ...((product as any)?.identification?.barcodes || []),
          ]
            .map((v) => normalizeEan(String(v || '')))
            .filter(Boolean)
        )
      );
      return (sku && kauflandSkuSet.has(sku)) || eanCandidates.some((ean) => kauflandEanSet.has(ean));
    });
  }, [selectedIds, products, kauflandSkuSet, kauflandEanSet]);

  return (
    <>
      <section id="admin-table" className="space-y-4">

        {notice ? (
          <Notice
            tone={notice.tone}
            title={notice.title}
            details={notice.details}
            onDismiss={() => setNotice(null)}
          >
            {notice.message}
          </Notice>
        ) : null}

        <InventoryExportDialog
          open={exportDialogOpen}
          onClose={() => setExportDialogOpen(false)}
          filteredCount={filteredAndSortedProducts.length}
          totalCount={products.length}
          filterActive={activeFilterCount > 0 || searchTerm.trim() !== ''}
          initialFields={exportPrefs.fields}
          initialNumberFormat={exportPrefs.numberFormat}
          title="Produktdaten exportieren"
          allScopeLabel="Alle Produkte"
          onExport={handleProduktExport}
        />

        {confirmDialog ? (
          <ConfirmDialog
            open
            title={confirmDialog.title}
            description={confirmDialog.description}
            details={confirmDialog.details}
            confirmLabel={confirmDialog.confirmLabel}
            tone={confirmDialog.tone || 'default'}
            confirmBusy={Boolean(confirmDialog.confirmBusy)}
            onCancel={() => setConfirmDialog(null)}
            onConfirm={confirmDialog.onConfirm}
          />
        ) : null}

        <div className="rounded-2xl border border-app-border bg-app-surface p-5 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-txt-muted" />
              <input
                id="table-search"
                type="text"
                placeholder={t('table.search')}
                aria-label="Produkte durchsuchen"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-8 py-2 bg-app-surface border border-app-border rounded-lg focus:ring-2 focus:ring-accent text-sm"
              />
              {searchTerm && (
                <button
                  type="button"
                  onClick={() => setSearchTerm('')}
                  aria-label="Suche leeren"
                  title="Suche leeren"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-txt-muted hover:text-txt-primary text-sm leading-none"
                >
                  ×
                </button>
              )}
            </div>
            {isMobile && (
              <button
                type="button"
                onClick={() => setFilterPanelOpen((v) => !v)}
                aria-expanded={filterPanelOpen}
                aria-label="Filter ein-/ausblenden"
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition ${
                  filterPanelOpen
                    ? 'border-accent/40 bg-accent-dim text-accent'
                    : activeFilterCount > 0
                      ? 'border-accent/30 bg-app-surface text-accent hover:border-accent/50'
                      : 'border-app-border bg-app-surface text-txt-secondary hover:border-app-border/80'
                }`}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                </svg>
                Filter
                {activeFilterCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[20px] h-5 rounded-full bg-accent text-txt-primary text-[11px] font-bold px-1">
                    {activeFilterCount}
                  </span>
                )}
              </button>
            )}
            <span className="text-xs text-txt-muted whitespace-nowrap">
              {filteredAndSortedProducts.length} / {products.length}
            </span>
            {(activeFilterCount > 0 || searchTerm.trim() !== '') && (
              <button type="button" onClick={resetFilters} className="text-xs text-accent hover:underline whitespace-nowrap">
                Zurücksetzen
              </button>
            )}
          </div>
          {/* Filter-Leiste: auf dem Desktop DAUERHAFT sichtbar (versteckte
              Filter werden messbar uebersehen — Baymard), mobil hinter dem
              Filter-Knopf. Chips + Editoren leben in AdminTableFilters. */}
          {(!isMobile || filterPanelOpen) && (
            <AdminTableFilters
              filterDefs={filterDefs}
              activeFilters={activeFilters}
              optionsById={filterOptionsById}
              filterCtx={filterCtx}
              setFilterValue={setFilterValue}
              removeFilter={removeFilter}
              clearAllFilters={clearAllFilters}
              myInitials={myInitials}
              categoryTree={categoryTree}
              savedViews={savedViews}
              onApplyView={applySavedView}
              onSaveView={saveCurrentView}
              onDeleteView={deleteSavedViewById}
              appliedViewId={appliedViewId}
              appliedViewDirty={appliedViewDirty}
              onUpdateAppliedView={updateAppliedView}
              onDiscardViewChanges={discardViewChanges}
              sortLevels={sortLevels}
              setSortLevels={setSortLevels}
              columnPreset={columnPreset}
              setColumnPreset={setColumnPreset}
              visibleColumns={visibleColumns}
              setVisibleColumns={setVisibleColumns}
              columnDefinitions={columnDefinitions}
              isColumnPanelOpen={isColumnPanelOpen}
              setIsColumnPanelOpen={setIsColumnPanelOpen}
              toggleColumnVisibility={toggleColumnVisibility}
              moveColumn={moveColumn}
              moveColumnTo={moveColumnTo}
              resetColumns={resetColumns}
              normalizeMarketplaceColumnOrder={normalizeMarketplaceColumnOrder}
              mode={mode}
              handleExportCsv={handleExportCsv}
              onOpenProduktExport={() => setExportDialogOpen(true)}
              onBulkImprove={onBulkImprove}
              enqueueBulkForAllInCurrentMode={enqueueBulkForAllInCurrentMode}
              setKtypeModalOpen={setKtypeModalOpen}
              setKtypeFile={setKtypeFile}
              setKtypeReport={setKtypeReport}
              setKtypeMessage={setKtypeMessage}
              setConfirmDialog={setConfirmDialog}
              t={t}
            />
          )}

          {selectedIds.size > 0 && (
            <BulkActions
              selectedIds={selectedIds}
              setSelectedIds={setSelectedIds}
              totalFilteredCount={filteredAndSortedProducts.length}
              ebayPublishInProgress={ebayPublishInProgress}
              handleBatchPublishEbay={handleBatchPublishEbay}
              ebayUpdateInProgress={ebayUpdateInProgress}
              handleBatchUpdateEbay={handleBatchUpdateEbay}
              hasSelectedEbayListings={hasSelectedEbayListings}
              ebaySyncInProgress={ebaySyncInProgress}
              handleSyncEbayListings={handleSyncEbayListings}
              bulkJobLoading={bulkJobLoading}
              enqueueBulkForSelection={enqueueBulkForSelection}
              hasSelectedKauflandListings={hasSelectedKauflandListings}
              kauflandSyncInProgress={kauflandSyncInProgress}
              handleSyncKauflandListings={handleSyncKauflandListings}
              onImproveSelected={onImproveSelected}
              improveInProgress={improveInProgress}
              setImproveInProgress={setImproveInProgress}
              setImproveMessage={setImproveMessage}
              handleBatchDelete={handleBatchDelete}
              handleBatchLabelPrint={handleBatchLabelPrint}
              isEditMode={gridEdit.isEditMode}
              onToggleEditMode={gridEdit.toggleEditMode}
              dirtyCount={gridEdit.dirtyCount}
              onCommitEdits={async () => {
                const payloads = gridEdit.toBulkUpdatePayloads();
                if (payloads.length === 0) return;
                // Group all dirty products into one bulk call
                // Grid edit: each product can have different values, so we do per-product calls
                // Eingaben NUR verwerfen, wenn wirklich alles geschrieben
                // wurde. Vorher lief `discardAll()` bedingungslos: schlug der
                // Schreibvorgang fehl, verschwand der Speichern-Knopf wie bei
                // Erfolg, die Tabelle zeigte wieder die alten Werte und es gab
                // keinerlei Meldung.
                const fehlgeschlagen: string[] = [];
                for (const payload of payloads) {
                  const ok = await gridBulkUpdate.executeCommit([payload.productId], payload.updates);
                  if (!ok) fehlgeschlagen.push(payload.productId);
                }
                if (fehlgeschlagen.length) {
                  setBulkError(
                    `${fehlgeschlagen.length} von ${payloads.length} Produkt(en) konnten nicht gespeichert werden — deine Eingaben bleiben stehen. ` +
                      `Betroffen: ${fehlgeschlagen.slice(0, 5).join(', ')}${fehlgeschlagen.length > 5 ? ' …' : ''}`
                  );
                  return;
                }
                setBulkError(null);
                gridEdit.discardAll();
                try {
                  const list = await fetchProducts();
                  if (Array.isArray(list)) onUpdateProducts(list);
                } catch { /* ignore */ }
              }}
              onDiscardEdits={gridEdit.discardAll}
              onRefreshProducts={async () => {
                try {
                  const list = await fetchProducts();
                  if (Array.isArray(list)) onUpdateProducts(list);
                } catch { /* ignore */ }
              }}
            />
          )}
        </div>

        {bulkError && (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-danger/20 bg-danger-dim px-4 py-3 text-sm text-danger">
            <span className="flex-1">{bulkError}</span>
            <button
              type="button"
              onClick={() => setBulkError(null)}
              className="text-xs font-semibold underline opacity-80 hover:opacity-100"
            >
              Schließen
            </button>
          </div>
        )}

        {filteredAndSortedProducts.length === 0 ? (
          <div className="rounded-2xl bg-app-surface p-5 text-sm text-txt-secondary border border-app-border">
            {mode === 'inventory' ? (
              <>
                <b>Keine Inventory-Artikel gefunden.</b>
                <div className="mt-1 text-txt-muted">
                  Typische Ursachen: kein Bestand oder kein BIN. (Sync/Listing/Bilder/Vollständigkeit kannst du über Filter zusätzlich einschränken.)
                </div>
              </>
            ) : mode === 'products' ? (
              <>
                <b>Keine Products (Backlog) gefunden.</b>
                <div className="mt-1 text-txt-muted">Prüfe Suche/Filter oder ob alle Produkte bereits Inventory-Kriterien erfüllen.</div>
              </>
            ) : (
              <b>Keine Produkte für diese Filter gefunden.</b>
            )}
            {/* Sackgassen vermeiden: konkrete Auswege statt nur "keine Treffer". */}
            {(activeFilterCount > 0 || searchTerm.trim() !== '') && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {activeFilterEntries.length > 0 && (
                  <button
                    type="button"
                    onClick={() => removeFilter(activeFilterEntries[activeFilterEntries.length - 1].id)}
                    className="rounded-xl border border-app-border bg-app-surface px-3 py-1.5 text-xs font-semibold text-txt-primary transition hover:border-app-border/80"
                  >
                    Letzten Filter entfernen
                  </button>
                )}
                {searchTerm.trim() !== '' && (
                  <button
                    type="button"
                    onClick={() => setSearchTerm('')}
                    className="rounded-xl border border-app-border bg-app-surface px-3 py-1.5 text-xs font-semibold text-txt-primary transition hover:border-app-border/80"
                  >
                    Suche leeren
                  </button>
                )}
                <button
                  type="button"
                  onClick={resetFilters}
                  className="rounded-xl bg-accent-dim px-3 py-1.5 text-xs font-semibold text-accent transition hover:bg-accent/20"
                >
                  Alle Filter zurücksetzen
                </button>
              </div>
            )}
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <table id="grid" className="w-full text-left min-w-[1000px]" aria-label="Produkttabelle">
            <AdminTableHeader
              visibleColumnDefinitions={visibleColumnDefinitions}
              sortLevels={sortLevels}
              onSort={requestSort}
              selectedIds={selectedIds}
              pageProducts={pageProducts}
              onSelectAll={handleSelectAll}
              totalFilteredCount={filteredAndSortedProducts.length}
              onSelectAllFiltered={handleSelectAllFiltered}
            />
            <tbody>
              {pageProducts.map(p => (
                <AdminTableRow
                  key={p.id}
                  product={p}
                  visibleColumnDefinitions={visibleColumnDefinitions}
                  isSelected={selectedIds.has(p.id)}
                  onSelect={handleSelectOne}
                  onSelectProduct={onSelectProduct}
                  rowRef={(el) => {
                    rowRefs.current[p.id] = el;
                  }}
                  isEditMode={gridEdit.isEditMode}
                  dirtyFields={gridEdit.dirtyFields.get(p.id)}
                  onCellChange={gridEdit.setCellValue}
                />
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-txt-muted">
          <div className="flex items-center gap-2">
            <span>Zeige</span>
            <select
              title="Items per page"
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                if (typeof window !== 'undefined') {
                  window.sessionStorage.setItem('avystock:admin-table:pageSize', e.target.value);
                }
              }}
              className="bg-app-elevated border border-app-border rounded px-2 py-1 text-txt-secondary focus:ring-2 focus:ring-accent outline-none"
            >
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={200}>200</option>
            </select>
            <span>Einträge</span>
          </div>

          <div className="flex items-center gap-4">
            <span>
              Seite {currentPage} von {totalPages}
            </span>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                aria-label="Vorherige Seite"
                className="px-3 py-1 rounded bg-app-elevated hover:bg-app-border disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-txt-secondary"
              >
                Zurück
              </button>
              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                aria-label="Nächste Seite"
                className="px-3 py-1 rounded bg-app-elevated hover:bg-app-border disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-txt-secondary"
              >
                Weiter
              </button>
            </div>
          </div>
        </div>
      </section >
      {inventoryModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-md rounded-2xl bg-app-bg border border-app-border p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-txt-primary">{t('table.inventory.assignTitle')}</h3>
              <button
                type="button"
                className="text-txt-muted hover:text-txt-primary"
                onClick={() => {
                  setInventoryModalOpen(false);
                  setInventoryAssignMessage(null);
                }}
              >
                ✕
              </button>
            </div>
            <div className="space-y-2">
              <label className="block text-xs font-medium text-txt-muted">
                {t('table.inventory.selectLabel')}
              </label>
              <select
                value={inventorySelection}
                onChange={(event) => setInventorySelection(event.target.value)}
                className="w-full rounded-xl border border-app-border bg-app-elevated px-3 py-2 text-sm text-txt-primary"
              >
                <option value="">{t('table.inventory.selectPlaceholder')}</option>
                {inventories.map((inv) => (
                  <option key={inv.inventoryId} value={inv.inventoryId}>
                    {inv.name} ({inv.inventoryId})
                  </option>
                ))}
              </select>
            </div>
            {inventoryAssignMessage && (
              <p className="text-xs text-txt-secondary">{inventoryAssignMessage}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setInventoryModalOpen(false);
                  setInventoryAssignMessage(null);
                }}
                className="px-3 py-1.5 rounded-xl border border-app-border text-sm text-txt-secondary"
              >
                {t('table.inventory.cancel')}
              </button>
              <button
                type="button"
                onClick={handleAssignInventory}
                disabled={inventoryAssigning}
                className="px-4 py-1.5 rounded-xl bg-accent-dim text-sm font-semibold text-accent hover:bg-accent/20 disabled:opacity-60"
              >
                {inventoryAssigning ? t('table.inventory.assigning') : t('table.inventory.assign')}
              </button>
            </div>
          </div>
        </div>
      )
      }
      {ktypeModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-2xl rounded-2xl bg-app-bg border border-app-border p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-txt-primary">K‑Typ Import (CSV)</h3>
              <button
                type="button"
                className="text-txt-muted hover:text-txt-primary"
                onClick={() => {
                  setKtypeModalOpen(false);
                  setKtypeFile(null);
                  setKtypeReport(null);
                  setKtypeMessage(null);
                }}
              >
                ✕
              </button>
            </div>

            <div className="text-xs text-txt-muted">
              Format: eBay Export (Revise + Compatibility Zeilen, z. B. <span className="font-mono">Ktype=12345|Notes=...</span>).
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-medium text-txt-muted">
                CSV Datei auswählen
              </label>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  const file = e.target.files?.[0] || null;
                  setKtypeFile(file);
                  setKtypeReport(null);
                  setKtypeMessage(null);
                }}
                className="w-full rounded-xl border border-app-border bg-app-elevated px-3 py-2 text-sm text-txt-primary"
              />
              {ktypeFile && (
                <div className="text-xs text-txt-secondary">
                  Datei: <span className="font-mono">{ktypeFile.name}</span> ({Math.round(ktypeFile.size / 1024)} KB)
                </div>
              )}
            </div>

            {ktypeMessage && (
              <p className="text-xs text-txt-secondary">{ktypeMessage}</p>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => runKTypeUpload(true)}
                disabled={ktypeBusy || !ktypeFile}
                className="px-3 py-1.5 rounded-xl border border-app-border text-sm text-txt-secondary disabled:opacity-60"
              >
                Dry-Run
              </button>
              <button
                type="button"
                onClick={() => runKTypeUpload(false)}
                disabled={ktypeBusy || !ktypeFile}
                className="px-4 py-1.5 rounded-xl bg-accent-dim text-sm font-semibold text-accent hover:bg-accent/20 disabled:opacity-60"
              >
                {ktypeBusy ? 'Läuft …' : 'Übernehmen'}
              </button>
            </div>

            {ktypeReport && (
              <div className="rounded-xl border border-app-border bg-app-bg/40 p-3 space-y-2">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                  <div className="text-txt-secondary">
                    <div className="text-txt-muted">SKUs</div>
                    <div className="font-semibold text-txt-primary">{ktypeReport.parsed?.skus ?? '—'}</div>
                  </div>
                  <div className="text-txt-secondary">
                    <div className="text-txt-muted">Einträge</div>
                    <div className="font-semibold text-txt-primary">{ktypeReport.parsed?.entries ?? '—'}</div>
                  </div>
                  <div className="text-txt-secondary">
                    <div className="text-txt-muted">Updated</div>
                    <div className="font-semibold text-txt-primary">{ktypeReport.updated ?? 0}</div>
                  </div>
                  <div className="text-txt-secondary">
                    <div className="text-txt-muted">Not found</div>
                    <div className="font-semibold text-txt-primary">{(ktypeReport.notFound || []).length}</div>
                  </div>
                </div>

                <details className="text-xs">
                  <summary className="cursor-pointer select-none text-txt-secondary">
                    Report JSON anzeigen
                  </summary>
                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-[11px] text-txt-secondary">
                    {JSON.stringify(ktypeReport, null, 2)}
                  </pre>
                </details>
              </div>
            )}
          </div>
        </div>
      )}
      {improveInProgress && (
        <div role="status" aria-live="polite" aria-busy="true" className="fixed bottom-20 right-6 z-40 flex items-center gap-3 rounded-2xl bg-app-bg/90 border border-app-border px-4 py-3 shadow-lg shadow-black/40 max-w-sm">
          <Spinner className="w-6 h-6 text-accent" />
          <div className="text-sm text-txt-primary">
            <p className="font-semibold">Improve läuft …</p>
            <p className="text-txt-muted text-xs">{improveMessage || 'Produkte werden verbessert'}</p>
          </div>
        </div>
      )}
    </>
  );
};

export default AdminTable;
