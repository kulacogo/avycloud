
import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Product, SyncStatus } from '../types';
import { fetchProducts, getProductBulkJob, runProductBulkAction, deleteProductsBulk, openProductLabelBatchWindow, assignInventoryToProducts, uploadKTypeCsv, bulkVerifyEbayPublish, bulkPublishToEbay, fetchEbaySkuIndex, lightSyncEbayLiveListings, bulkUpdateEbayListings, fetchKauflandSkuIndex, syncKauflandListings, type ProductBulkActionName } from '../api/client';
import { SearchIcon } from './icons/Icons';
import {
  normalizeSyncStatus,
  getStableNumericId,
  getProductQuantity,
  getProductDisplayCategory,
} from '../utils/product';
import { isValidGtin, normalizeBarcode } from '../utils/gtin';
import { useI18n } from '../i18n';
import { Spinner } from './Spinner';
import { addMediaQueryListener } from '../utils/mediaQuery';
import { useInventoryContext } from '../context/InventoryContext';
import { isInventoryItem, isProductBacklogItem } from '../utils/inventorySplit';
import { Notice } from './ui/Notice';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { AdminTableHeader, AdminTableRow, AdminTableFilters, BulkActions } from './admin-table';
import type { ColumnId, ColumnPreset, ColumnDefinition, SortConfig } from './admin-table';
import { useGridEdit } from '../hooks/useGridEdit';
import { useBulkUpdate } from '../hooks/useBulkUpdate';

const safeCurrency = (code?: string) => {
  const c = (code || '').toString().trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : 'EUR';
};

const COLUMN_STORAGE_KEY = 'avystock:admin-table:visible-columns';
const COLUMN_PRESETS: Record<ColumnPreset, ColumnId[]> = {
  standard: ['thumbnail', 'nameBrand', 'sku', 'barcode', 'category', 'price', 'inventory', 'pendingIntake', 'storage', 'ebay', 'kaufland', 'syncStatus', 'lastSaved'],
  warehouse: ['nameBrand', 'sku', 'barcode', 'inventory', 'pendingIntake', 'storage', 'ebay', 'kaufland', 'syncStatus', 'saveStatus'],
  pricing: ['nameBrand', 'price', 'sku', 'barcode', 'pendingIntake', 'ebay', 'kaufland', 'syncStatus', 'lastSynced'],
  minimal: ['nameBrand', 'sku', 'barcode', 'inventory', 'pendingIntake', 'ebay', 'kaufland', 'syncStatus'],
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

const SyncStatusBadge: React.FC<{ status: SyncStatus }> = ({ status }) => {
  const baseClasses = 'px-2 py-1 text-xs font-bold rounded-full';
  const statusMap = {
    synced: 'bg-success-dim text-success',
    pending: 'bg-warning-dim text-warning',
    failed: 'bg-danger-dim text-danger',
  };
  const labelMap: Record<SyncStatus, string> = { synced: 'Synced', pending: 'Pending', failed: 'Failed' };
  return <span className={`${baseClasses} ${statusMap[status]}`}>{labelMap[status]}</span>;
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
  const [searchTerm, setSearchTerm] = useState(() => {
    if (typeof window === 'undefined') return '';
    return window.sessionStorage.getItem('avystock:admin-table:search') || '';
  });
  const [filterStatus, setFilterStatus] = useState<SyncStatus | 'all'>(() => {
    if (typeof window === 'undefined') return 'all';
    return (window.sessionStorage.getItem('avystock:admin-table:filterStatus') as SyncStatus | 'all') || 'all';
  });
  const [filterCategorySelection, setFilterCategorySelection] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    const raw = window.sessionStorage.getItem('avystock:admin-table:filterCategorySelection');
    if (!raw) {
      const legacy = window.sessionStorage.getItem('avystock:admin-table:filterCategory');
      return legacy && legacy !== 'all' ? [legacy] : [];
    }
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(Boolean).map((v) => String(v)) : [];
    } catch {
      return [];
    }
  });
  const [filterBin, setFilterBin] = useState<'all' | 'withBin' | 'withoutBin'>(() => {
    if (typeof window === 'undefined') return 'all';
    return (window.sessionStorage.getItem('avystock:admin-table:filterBin') as 'all' | 'withBin' | 'withoutBin') || 'all';
  });
  const [filterBinSplit, setFilterBinSplit] = useState<'all' | 'singleBin' | 'multiBin'>(() => {
    if (typeof window === 'undefined') return 'all';
    return (window.sessionStorage.getItem('avystock:admin-table:filterBinSplit') as any) || 'all';
  });
  const [filterEanValid, setFilterEanValid] = useState<'all' | 'valid' | 'invalid' | 'missing'>(() => {
    if (typeof window === 'undefined') return 'all';
    return (window.sessionStorage.getItem('avystock:admin-table:filterEanValid') as any) || 'all';
  });
  const [filterGpsr, setFilterGpsr] = useState<'all' | 'complete' | 'incomplete'>(() => {
    if (typeof window === 'undefined') return 'all';
    return (window.sessionStorage.getItem('avystock:admin-table:filterGpsr') as any) || 'all';
  });
  const [filterWeight, setFilterWeight] = useState<'all' | 'withWeight' | 'noWeight'>(() => {
    if (typeof window === 'undefined') return 'all';
    return (window.sessionStorage.getItem('avystock:admin-table:filterWeight') as any) || 'all';
  });
  const [filterReserved, setFilterReserved] = useState<'all' | 'reserved' | 'notReserved'>(() => {
    if (typeof window === 'undefined') return 'all';
    return (window.sessionStorage.getItem('avystock:admin-table:filterReserved') as any) || 'all';
  });
  const [filterEbay, setFilterEbay] = useState<'all' | 'listed' | 'notListed'>(() => {
    if (typeof window === 'undefined') return 'all';
    return (window.sessionStorage.getItem('avystock:admin-table:filterEbay') as any) || 'all';
  });
  const [filterKaufland, setFilterKaufland] = useState<'all' | 'listed' | 'notListed'>(() => {
    if (typeof window === 'undefined') return 'all';
    return (window.sessionStorage.getItem('avystock:admin-table:filterKaufland') as any) || 'all';
  });
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(() => {
    if (typeof window === 'undefined') return { key: 'ops.last_saved_iso', direction: 'desc' };
    try {
      const raw = window.sessionStorage.getItem('avystock:admin-table:sort');
      if (!raw) return { key: 'ops.last_saved_iso', direction: 'desc' };
      const parsed = JSON.parse(raw);
      if (parsed?.key && parsed?.direction) {
        const migratedKey =
          parsed.key === 'ops.data_quality.last_quality_gate_iso' ? 'ops.last_saved_iso' : parsed.key;
        return { key: migratedKey, direction: parsed.direction };
      }
      return { key: 'ops.last_saved_iso', direction: 'desc' };
    } catch {
      return { key: 'ops.last_saved_iso', direction: 'desc' };
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

  const [categoryFilterOpen, setCategoryFilterOpen] = useState(false);

  const categorySelectionSet = useMemo(
    () => new Set(filterCategorySelection.map((s) => String(s).trim()).filter(Boolean)),
    [filterCategorySelection]
  );

  const isCategorySelected = (key: string) => categorySelectionSet.has(key);

  const toggleCategoryKey = (key: string) => {
    const next = new Set(categorySelectionSet);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setFilterCategorySelection(Array.from(next));
  };

  const toggleTopCategory = (top: string) => {
    const next = new Set(categorySelectionSet);
    const node = categoryTree.find((t) => t.top === top);
    const childKeys = node ? node.children.map((c) => `${top} > ${c.sub}`) : [];
    const allKeys = [top, ...childKeys];
    const allOn = allKeys.length ? allKeys.every((k) => next.has(k)) : next.has(top);
    if (allOn) {
      allKeys.forEach((k) => next.delete(k));
    } else {
      allKeys.forEach((k) => next.add(k));
    }
    setFilterCategorySelection(Array.from(next));
  };

  const primaryImage = (product: Product) =>
    (product.details?.images || []).find((img) => img.url_or_base64?.startsWith('http')) || null;
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

  const columnDefinitions: ColumnDefinition[] = useMemo(() => {
    const baseRenderers: ColumnDefinition[] = [
      {
        id: 'thumbnail',
        label: t('table.thumbnail'),
        defaultVisible: true,
        widthClass: 'w-20',
        render: ({ product }) => (
          <div className="w-12 h-12 rounded-md overflow-hidden bg-app-elevated flex items-center justify-center text-xs text-txt-muted">
            {primaryImage(product) ? (
              <img
                src={primaryImage(product)!.url_or_base64}
                alt={product.identification?.name || 'Produktbild'}
                className="w-full h-full object-cover"
              />
            ) : (
              '—'
            )}
          </div>
        ),
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
        id: 'price',
        label: t('table.price'),
        sortKey: 'details.pricing.lowest_price.amount',
        defaultVisible: true,
        render: ({ product }) =>
          product.details?.pricing?.lowest_price?.amount
            ? new Intl.NumberFormat('de-DE', {
              style: 'currency',
              currency: safeCurrency(product.details?.pricing?.lowest_price?.currency),
            }).format(product.details?.pricing?.lowest_price?.amount as number)
            : '—',
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
            <span className="inline-flex items-center justify-center rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-200">
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
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                title="eBay-Listing öffnen"
                className="inline-flex items-center justify-center rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/30 hover:text-amber-100"
              >
                Gelistet
              </a>
            ) : isActive ? (
              <span
                title="Auf eBay gelistet"
                className="inline-flex items-center justify-center rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-200"
              >
                Gelistet
              </span>
            ) : isInactive ? (
              <span
                title="eBay-Listing inaktiv"
                className="inline-flex items-center justify-center rounded-full bg-amber-800/30 px-2 py-0.5 text-xs font-semibold text-amber-400"
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
                rel="noreferrer"
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
                className="inline-flex items-center justify-center rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-200"
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
        id: 'syncStatus',
        label: t('table.syncStatus'),
        sortKey: 'ops.sync_status',
        defaultVisible: true,
        render: ({ product }) => (
          <SyncStatusBadge status={normalizeSyncStatus(product.ops.sync_status, product.ops.last_synced_iso)} />
        ),
      },
      {
        id: 'saveStatus',
        label: t('table.saveStatus'),
        defaultVisible: true,
        render: ({ product }) => <SaveStatusBadge saved={Boolean(product.ops?.last_saved_iso)} />,
      },
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
  ]);

  const statusFilters: Array<{ value: SyncStatus | 'all'; label: string }> = [
    { value: 'all', label: t('table.status.all') },
    { value: 'pending', label: t('table.status.pending') },
    { value: 'synced', label: t('table.status.synced') },
    { value: 'failed', label: t('table.status.failed') },
  ];

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

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(visibleColumns));
    } catch (error) {
      console.warn('Konnte Spaltenkonfiguration nicht speichern:', error);
    }
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

    let filtered = modeFiltered.filter(p => {
      const normalizedStatus = normalizeSyncStatus(p.ops?.sync_status, p.ops?.last_synced_iso);
      const term = (searchTerm || '').toLowerCase().trim();
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
      const matchesSearch =
        term === '' ||
        name.includes(term) ||
        brand.includes(term) ||
        identifiers.some((idVal) => idVal.includes(term));
      const matchesStatus = filterStatus === 'all' || normalizedStatus === filterStatus;
      const resolvedCategory = getProductDisplayCategory(p);
      const productCategory = resolvedCategory && resolvedCategory !== '—' ? resolvedCategory : 'Unbekannt';
      const matchesCategory = (() => {
        if (filterCategorySelection.length === 0) return true;
        const raw = (productCategory || '').toString();
        const parts = raw.split('>').map((s) => s.trim()).filter(Boolean);
        const top = parts[0] || 'Unbekannt';
        const sub = parts.length >= 2 ? parts[1] : '';
        const topKey = top;
        const subKey = sub ? `${top} > ${sub}` : '';
        return categorySelectionSet.has(topKey) || (subKey && categorySelectionSet.has(subKey));
      })();
      const hasBin = Boolean(p.storage?.binCode) || (Array.isArray(p.storageBins) && p.storageBins.length > 0);
      const matchesBin =
        filterBin === 'all' || (filterBin === 'withBin' && hasBin) || (filterBin === 'withoutBin' && !hasBin);

      const binCodesWithStock = new Set<string>();
      const storageBins = Array.isArray(p.storageBins) ? p.storageBins : [];
      storageBins
        .filter((bin) => Boolean(bin?.code))
        .forEach((bin) => {
          const qty = Number(bin?.quantity || 0) || 0;
          if (qty > 0) {
            binCodesWithStock.add(String(bin.code).toUpperCase());
          }
        });
      // Fallback: if we have no storageBins (or all 0), use primary storage bin if present
      if (binCodesWithStock.size === 0 && p.storage?.binCode) {
        binCodesWithStock.add(String(p.storage.binCode).toUpperCase());
      }
      const binCount = binCodesWithStock.size;
      const matchesBinSplit =
        filterBinSplit === 'all' ||
        (filterBinSplit === 'singleBin' && binCount <= 1) ||
        (filterBinSplit === 'multiBin' && binCount >= 2);

      const weight = Number((p.details?.attributes as any)?.weight || 0);
      const hasWeight = Number.isFinite(weight) && weight > 0;
      const matchesWeight =
        filterWeight === 'all' ||
        (filterWeight === 'withWeight' && hasWeight) ||
        (filterWeight === 'noWeight' && !hasWeight);

      const reservedQuantity = Number(p.inventory?.reservedQuantity || 0) || 0;
      const matchesReserved =
        filterReserved === 'all' ||
        (filterReserved === 'reserved' && reservedQuantity > 0) ||
        (filterReserved === 'notReserved' && reservedQuantity <= 0);
      // EAN/GTIN validity filter
      const pBarcode = primaryBarcode(p);
      const pBarcodePresent = pBarcode !== '—';
      const pBarcodeValid = pBarcodePresent && isValidMarketplaceEan(pBarcode);
      const matchesEanValid =
        filterEanValid === 'all' ||
        (filterEanValid === 'valid' && pBarcodeValid) ||
        (filterEanValid === 'invalid' && pBarcodePresent && !pBarcodeValid) ||
        (filterEanValid === 'missing' && !pBarcodePresent);

      // GPSR completeness filter
      const gpsr = p.details?.gpsr;
      const gpsrHasName = Boolean(gpsr?.manufacturer_name?.trim());
      const gpsrHasAddress = Boolean(gpsr?.manufacturer_address?.trim());
      const gpsrHasCity = Boolean(gpsr?.manufacturer_city?.trim());
      const gpsrHasPostal = Boolean(gpsr?.manufacturer_postalcode?.trim());
      const gpsrHasCountry = Boolean(gpsr?.entity_country?.trim() || gpsr?.country_code?.trim());
      const gpsrHasContact = Boolean(gpsr?.email?.trim() || gpsr?.manufacturer_phone?.trim());
      const gpsrComplete = gpsrHasName && gpsrHasAddress && gpsrHasCity && gpsrHasPostal && gpsrHasCountry && gpsrHasContact;
      const matchesGpsr =
        filterGpsr === 'all' ||
        (filterGpsr === 'complete' && gpsrComplete) ||
        (filterGpsr === 'incomplete' && !gpsrComplete);

      // eBay listing filter: ops.listingStatus.ebay is authoritative, fallback to cross-reference
      const pEbayStatus = (p as any)?.ops?.listingStatus?.ebay;
      const pSkuCandidates = Array.from(
        new Set(
          [
            normalizeSku(p.details?.identifiers?.sku),
            normalizeSku((p as any)?.identification?.sku),
          ].filter(Boolean)
        )
      );
      const marketplaceItemId = String((p as any)?.marketplace?.ebay?.itemId || '').trim();
      // Resolve viewItemUrl same way as badge render (line ~664-669)
      const pSkuUrl = pSkuCandidates.map((sku) => ebayLinkedMap.get(sku)).find(Boolean) || null;
      const pPidItemId = ebayProductIdMap.get(p.id);
      const pViewItemUrl =
        pSkuUrl ||
        (pPidItemId ? true : null) ||
        (marketplaceItemId && ebayActiveItemIds.has(marketplaceItemId) ? true : null);
      const isEbayListed = !!pViewItemUrl || pEbayStatus === 'active';
      const matchesEbay =
        filterEbay === 'all' ||
        (filterEbay === 'listed' && isEbayListed) ||
        (filterEbay === 'notListed' && !isEbayListed);
      // Kaufland listing filter: ops.listingStatus.kaufland is authoritative, fallback to cross-reference
      const pKauflandStatus = (p as any)?.ops?.listingStatus?.kaufland;
      const pSku = normalizeSku(
        (p as any)?.identification?.sku ||
        p?.details?.identifiers?.sku ||
        (p as any)?.id ||
        ''
      );
      const pEanCandidates = Array.from(
        new Set(
          [
            p?.details?.identifiers?.ean,
            p?.details?.identifiers?.gtin,
            p?.details?.identifiers?.upc,
            ...((p as any)?.identification?.barcodes || []),
          ]
            .map((v) => normalizeEan(String(v || '')))
            .filter(Boolean)
        )
      );
      // Match badge logic: SKU/EAN index presence = listed, regardless of stale ops status
      const pKauflandByIndex = (pSku && kauflandSkuSet.has(pSku)) || pEanCandidates.some((ean) => kauflandEanSet.has(ean));
      const isKauflandListed = pKauflandStatus === 'active' || pKauflandByIndex;
      const matchesKaufland =
        filterKaufland === 'all' ||
        (filterKaufland === 'listed' && isKauflandListed) ||
        (filterKaufland === 'notListed' && !isKauflandListed);

      return (
        matchesSearch &&
        matchesStatus &&
        matchesCategory &&
        matchesBin &&
        matchesBinSplit &&
        matchesWeight &&
        matchesReserved &&
        matchesEanValid &&
        matchesGpsr &&
        matchesEbay &&
        matchesKaufland
      );
    });

    if (sortConfig !== null) {
        const getNestedValue = (obj: any, path: string) => path.split('.').reduce((o, k) => (o || {})[k], obj);
      const getSortValue = (product: Product, key: string) => {
        switch (key) {
          case 'category.display':
            return getProductDisplayCategory(product).toLowerCase();
          case 'details.pricing.lowest_price.amount':
            return Number(product.details?.pricing?.lowest_price?.amount || 0);
          case 'inventory.quantity':
            // Sort by effektiver Bestand (summe aus inventory + storageBins)
            return getProductQuantity(product);
          case 'storage.binCode':
            return (primaryBin(product) || '').toString().toLowerCase();
          case 'identification.name':
            return (product.identification?.name || '').toString().toLowerCase();
          case 'ebay.listed': {
            const sortEbayStatus = (product as any)?.ops?.listingStatus?.ebay;
            if (sortEbayStatus) return sortEbayStatus === 'active' ? 1 : 0;
            // Fallback to cross-reference
            const sortSkuCandidates = Array.from(
              new Set(
                [
                  normalizeSku(product.details?.identifiers?.sku),
                  normalizeSku((product as any)?.identification?.sku),
                ].filter(Boolean)
              )
            );
            const hasSkuMatch = sortSkuCandidates.some((sku) => Boolean(ebayLinkedMap.get(sku)));
            const marketplaceItemId = String((product as any)?.marketplace?.ebay?.itemId || '').trim();
            return Boolean(
              hasSkuMatch ||
              ebayProductIdMap.get(product.id) ||
              (marketplaceItemId && ebayActiveItemIds.has(marketplaceItemId))
            ) ? 1 : 0;
          }
          case 'kaufland.listed': {
            const sortKauflandStatus = (product as any)?.ops?.listingStatus?.kaufland;
            if (sortKauflandStatus) return sortKauflandStatus === 'active' ? 1 : 0;
            // Fallback to cross-reference
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
            const listedByIndex = (sku && kauflandSkuSet.has(sku)) || eanCandidates.some((ean) => kauflandEanSet.has(ean));
            return listedByIndex ? 1 : 0;
          }
          default:
            return getNestedValue(product, key);
        }
      };

      filtered.sort((a, b) => {
        let aValue = getSortValue(a, sortConfig.key);
        let bValue = getSortValue(b, sortConfig.key);

        const isNumber = typeof aValue === 'number' || typeof bValue === 'number';
        if (isNumber) {
          aValue = Number(aValue) || 0;
          bValue = Number(bValue) || 0;
        } else {
          aValue = (aValue ?? '').toString().toLowerCase();
          bValue = (bValue ?? '').toString().toLowerCase();
        }

        if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
        if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
      });
    }

    return filtered;
  }, [
    products,
    scopeProductIds,
    mode,
    searchTerm,
    filterStatus,
    filterCategorySelection,
    filterBin,
    filterBinSplit,
    filterWeight,
    filterReserved,
    filterEanValid,
    filterGpsr,
    filterEbay,
    filterKaufland,
    ebayLinkedMap,
    ebayProductIdMap,
    ebayActiveItemIds,
    kauflandSkuSet,
    kauflandEanSet,
    sortConfig,
  ]);

  const totalPages = Math.max(1, Math.ceil(filteredAndSortedProducts.length / pageSize));
  useEffect(() => {
    setCurrentPage((prev) => {
      if (prev > totalPages) return totalPages;
      if (prev < 1) return 1;
      return prev;
    });
  }, [totalPages]);

  const pageProducts = useMemo(() => {
    const safePage = Math.min(Math.max(currentPage, 1), totalPages);
    const start = (safePage - 1) * pageSize;
    return filteredAndSortedProducts.slice(start, start + pageSize);
  }, [filteredAndSortedProducts, currentPage, pageSize, totalPages]);

  const requestSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      // Select only currently visible page
      setSelectedIds(new Set(pageProducts.map((p) => p.id)));
    } else {
      setSelectedIds(new Set());
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

  useEffect(() => {
    if (!focusProductId) return;
    const row = rowRefs.current[focusProductId];
    if (!row) return;
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
    setFilterStatus('all');
    setFilterCategorySelection([]);
    setFilterBin('all');
    setFilterBinSplit('all');
    setFilterWeight('all');
    setFilterReserved('all');
    setFilterEanValid('all');
    setFilterGpsr('all');
    setFilterEbay('all');
    setFilterKaufland('all');
    setPageSize(50);
    setCurrentPage(1);
  };
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem('avystock:admin-table:search', searchTerm);
  }, [searchTerm]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem('avystock:admin-table:filterStatus', filterStatus);
  }, [filterStatus]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.sessionStorage.setItem('avystock:admin-table:filterCategorySelection', JSON.stringify(filterCategorySelection));
      // Keep legacy key for backwards compatibility (best-effort).
      window.sessionStorage.setItem(
        'avystock:admin-table:filterCategory',
        filterCategorySelection.length === 1 ? filterCategorySelection[0] : 'all'
      );
    } catch {
      // ignore session storage errors
    }
  }, [filterCategorySelection]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem('avystock:admin-table:filterBin', filterBin);
  }, [filterBin]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem('avystock:admin-table:filterBinSplit', filterBinSplit);
  }, [filterBinSplit]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem('avystock:admin-table:filterEanValid', filterEanValid);
  }, [filterEanValid]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem('avystock:admin-table:filterGpsr', filterGpsr);
  }, [filterGpsr]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem('avystock:admin-table:filterWeight', filterWeight);
  }, [filterWeight]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem('avystock:admin-table:filterReserved', filterReserved);
  }, [filterReserved]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem('avystock:admin-table:filterEbay', filterEbay);
  }, [filterEbay]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem('avystock:admin-table:filterKaufland', filterKaufland);
  }, [filterKaufland]);
  // Note: legacy filters (inventoryId, eBay category) removed to reduce UI clutter.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem('avystock:admin-table:pageSize', String(pageSize));
  }, [pageSize]);
  useEffect(() => {
    if (typeof window === 'undefined' || !sortConfig) return;
    try {
      window.sessionStorage.setItem('avystock:admin-table:sort', JSON.stringify(sortConfig));
    } catch {
      // ignore session storage errors
    }
  }, [sortConfig]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filterStatus !== 'all') count++;
    if (filterCategorySelection.length > 0) count++;
    if (filterBin !== 'all') count++;
    if (filterEbay !== 'all') count++;
    if (filterKaufland !== 'all') count++;
    if (filterWeight !== 'all') count++;
    if (filterReserved !== 'all') count++;
    if (filterBinSplit !== 'all') count++;
    if (filterEanValid !== 'all') count++;
    if (filterGpsr !== 'all') count++;
    return count;
  }, [filterStatus, filterCategorySelection, filterBin, filterEbay, filterKaufland, filterWeight, filterReserved, filterBinSplit, filterEanValid, filterGpsr]);

  const activeFilterChips = useMemo(() => {
    const chips: Array<{ key: string; label: string; onClear: () => void }> = [];
    const s = String(searchTerm || '').trim();
    if (s) chips.push({ key: 'search', label: `Suche: ${s}`, onClear: () => setSearchTerm('') });

    if (filterStatus !== 'all') {
      const label = statusFilters.find((o) => o.value === filterStatus)?.label || `Status: ${filterStatus}`;
      chips.push({ key: 'status', label, onClear: () => setFilterStatus('all') });
    }

    if (filterCategorySelection.length > 0) {
      chips.push({
        key: 'category',
        label: `Kategorie: ${filterCategorySelection.length}`,
        onClear: () => setFilterCategorySelection([]),
      });
    }

    if (filterBin !== 'all') {
      const label = filterBin === 'withBin' ? t('table.binFilter.withBin') : t('table.binFilter.withoutBin');
      chips.push({ key: 'bin', label, onClear: () => setFilterBin('all') });
    }

    if (filterEanValid !== 'all') {
      const label = filterEanValid === 'valid' ? 'EAN/GTIN: Gültig' : filterEanValid === 'invalid' ? 'EAN/GTIN: Ungültig' : 'EAN/GTIN: Fehlt';
      chips.push({ key: 'eanValid', label, onClear: () => setFilterEanValid('all') });
    }

    if (filterGpsr !== 'all') {
      const label = filterGpsr === 'complete' ? 'GPSR: Vollständig' : 'GPSR: Unvollständig';
      chips.push({ key: 'gpsr', label, onClear: () => setFilterGpsr('all') });
    }

    if (filterEbay !== 'all') {
      chips.push({
        key: 'ebay',
        label: filterEbay === 'listed' ? 'eBay: Gelistet' : 'eBay: Nicht gelistet',
        onClear: () => setFilterEbay('all'),
      });
    }

    if (filterKaufland !== 'all') {
      chips.push({
        key: 'kaufland',
        label: filterKaufland === 'listed' ? 'Kaufland: Gelistet' : 'Kaufland: Nicht gelistet',
        onClear: () => setFilterKaufland('all'),
      });
    }

    if (filterWeight !== 'all') {
      chips.push({
        key: 'weight',
        label: filterWeight === 'withWeight' ? 'Gewicht: vorhanden' : 'Gewicht: fehlt',
        onClear: () => setFilterWeight('all'),
      });
    }

    if (filterReserved !== 'all') {
      chips.push({
        key: 'reserved',
        label: filterReserved === 'reserved' ? 'Reserviert > 0' : 'Reserviert = 0',
        onClear: () => setFilterReserved('all'),
      });
    }

    if (filterBinSplit !== 'all') {
      chips.push({
        key: 'binSplit',
        label: filterBinSplit === 'singleBin' ? 'Bins: 1 BIN' : 'Bins: mehrere BINs',
        onClear: () => setFilterBinSplit('all'),
      });
    }

    return chips;
  }, [
    filterBin,
    filterBinSplit,
    filterCategorySelection,
    filterEanValid,
    filterEbay,
    filterGpsr,
    filterKaufland,
    filterReserved,
    filterStatus,
    filterWeight,
    searchTerm,
    statusFilters,
    t,
  ]);

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
                className="w-full pl-9 pr-3 py-2 bg-app-surface border border-app-border rounded-lg focus:ring-2 focus:ring-accent text-sm"
              />
            </div>
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
            <span className="text-xs text-txt-muted whitespace-nowrap">
              {filteredAndSortedProducts.length} / {products.length}
            </span>
            {activeFilterCount > 0 && (
              <button type="button" onClick={resetFilters} className="text-xs text-accent hover:underline whitespace-nowrap">
                Zurücksetzen
              </button>
            )}
          </div>
          {filterPanelOpen && (
            <div className="rounded-xl border border-app-border bg-app-bg/40 p-4 space-y-3 animate-in fade-in slide-in-from-top-2 duration-200">
              <AdminTableFilters
                filterStatus={filterStatus}
                setFilterStatus={setFilterStatus}
                statusFilters={statusFilters}
                filterCategorySelection={filterCategorySelection}
                setFilterCategorySelection={setFilterCategorySelection}
                categoryTree={categoryTree}
                categorySelectionSet={categorySelectionSet}
                categoryFilterOpen={categoryFilterOpen}
                setCategoryFilterOpen={setCategoryFilterOpen}
                isCategorySelected={isCategorySelected}
                toggleCategoryKey={toggleCategoryKey}
                toggleTopCategory={toggleTopCategory}
                filterBin={filterBin}
                setFilterBin={setFilterBin}
                filterEanValid={filterEanValid}
                setFilterEanValid={setFilterEanValid}
                filterGpsr={filterGpsr}
                setFilterGpsr={setFilterGpsr}
                filterEbay={filterEbay}
                setFilterEbay={setFilterEbay}
                filterKaufland={filterKaufland}
                setFilterKaufland={setFilterKaufland}
                filterWeight={filterWeight}
                setFilterWeight={setFilterWeight}
                filterReserved={filterReserved}
                setFilterReserved={setFilterReserved}
                columnPreset={columnPreset}
                setColumnPreset={setColumnPreset}
                visibleColumns={visibleColumns}
                setVisibleColumns={setVisibleColumns}
                columnDefinitions={columnDefinitions}
                isColumnPanelOpen={isColumnPanelOpen}
                setIsColumnPanelOpen={setIsColumnPanelOpen}
                toggleColumnVisibility={toggleColumnVisibility}
                moveColumn={moveColumn}
                resetColumns={resetColumns}
                normalizeMarketplaceColumnOrder={normalizeMarketplaceColumnOrder}
                mode={mode}
                handleExportCsv={handleExportCsv}
                onBulkImprove={onBulkImprove}
                enqueueBulkForAllInCurrentMode={enqueueBulkForAllInCurrentMode}
                setKtypeModalOpen={setKtypeModalOpen}
                setKtypeFile={setKtypeFile}
                setKtypeReport={setKtypeReport}
                setKtypeMessage={setKtypeMessage}
                setConfirmDialog={setConfirmDialog}
                t={t}
              />
            </div>
          )}

          {activeFilterChips.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {activeFilterChips.map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  onClick={chip.onClear}
                  className="group inline-flex items-center gap-1.5 rounded-lg border border-accent/20 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent/20 hover:border-accent/30 transition"
                  title="Filter entfernen"
                >
                  <span className="whitespace-nowrap">{chip.label}</span>
                  <span className="text-accent/70 group-hover:text-accent text-sm leading-none">×</span>
                </button>
              ))}
              <button
                type="button"
                onClick={resetFilters}
                className="text-xs text-txt-muted hover:text-txt-secondary ml-1 transition"
              >
                Alle entfernen
              </button>
            </div>
          ) : null}

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
                for (const payload of payloads) {
                  await gridBulkUpdate.executeCommit([payload.productId], payload.updates);
                }
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
              <b>Keine Produkte gefunden.</b>
            )}
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <table id="grid" className="w-full text-left min-w-[1000px]" aria-label="Produkttabelle">
            <AdminTableHeader
              visibleColumnDefinitions={visibleColumnDefinitions}
              sortConfig={sortConfig}
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
