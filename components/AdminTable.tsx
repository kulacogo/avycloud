
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Product, SyncStatus } from '../types';
import { fetchProducts, getProductBulkJob, runProductBulkAction, syncToBaseLinker, deleteProduct, deleteProductsBulk, openProductLabelBatchWindow, assignInventoryToProducts, lookupBaseLinkerBySkus, uploadKTypeCsv, bulkVerifyEbayPublish, bulkPublishToEbay, fetchEbaySkuIndex, bulkUpdateEbayListings, type ProductBulkActionName } from '../api/client';
import { RefreshIcon, SyncIcon, ExportIcon, SearchIcon, PrintIcon, OperationsIcon, SheetIcon, TrashIcon, BarcodeIcon } from './icons/Icons';
import {
  normalizeSyncStatus,
  getStableNumericId,
  getProductQuantity,
  getProductDisplayCategory,
} from '../utils/product';
import { useI18n } from '../i18n';
import { Spinner } from './Spinner';
import { addMediaQueryListener } from '../utils/mediaQuery';
import { useInventoryContext } from '../context/InventoryContext';
import { isInventoryItem, isProductBacklogItem } from '../utils/inventorySplit';
import { PageHeader } from './ui/PageHeader';
import { Notice } from './ui/Notice';
import { ConfirmDialog } from './ui/ConfirmDialog';

const safeCurrency = (code?: string) => {
  const c = (code || '').toString().trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : 'EUR';
};

const COLUMN_STORAGE_KEY = 'avystock:admin-table:visible-columns';
type ColumnId =
  | 'thumbnail'
  | 'nameBrand'
  | 'category'
  | 'sku'
  | 'barcode'
  | 'price'
  | 'completeness'
  | 'qualityGate'
  | 'inventory'
  | 'pendingIntake'
  | 'storage'
  | 'baselinker'
  | 'ebay'
  | 'lastSold'
  | 'syncStatus'
  | 'saveStatus'
  | 'lastSaved'
  | 'lastSynced'
  | 'revision';

type ColumnPreset = 'standard' | 'warehouse' | 'pricing' | 'minimal';
const COLUMN_PRESETS: Record<ColumnPreset, ColumnId[]> = {
  standard: ['thumbnail', 'nameBrand', 'sku', 'barcode', 'category', 'price', 'completeness', 'qualityGate', 'inventory', 'pendingIntake', 'storage', 'baselinker', 'ebay', 'syncStatus', 'lastSaved'],
  warehouse: ['nameBrand', 'sku', 'barcode', 'qualityGate', 'inventory', 'pendingIntake', 'storage', 'baselinker', 'syncStatus', 'saveStatus'],
  pricing: ['nameBrand', 'price', 'sku', 'barcode', 'qualityGate', 'pendingIntake', 'baselinker', 'syncStatus', 'lastSynced'],
  minimal: ['nameBrand', 'sku', 'barcode', 'qualityGate', 'inventory', 'pendingIntake', 'baselinker', 'syncStatus'],
};

interface ColumnDefinition {
  id: ColumnId;
  label: string;
  sortKey?: string;
  defaultVisible?: boolean;
  widthClass?: string;
  render: (args: { product: Product; onSelectProduct: (id: string) => void }) => React.ReactNode;
}

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
    synced: 'bg-green-500/20 text-green-300',
    pending: 'bg-yellow-500/20 text-yellow-300',
    failed: 'bg-red-500/20 text-red-300',
  };
  return <span className={`${baseClasses} ${statusMap[status]}`}>{status}</span>;
};

const SaveStatusBadge: React.FC<{ saved: boolean }> = ({ saved }) => {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full ${saved ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-200'
        }`}
    >
      {saved ? 'Gespeichert' : 'Nicht gespeichert'}
    </span>
  );
};

const ActionButton: React.FC<{
  icon: React.ReactNode;
  label: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'secondary' | 'danger' | 'accent';
}> = ({ icon, label, onClick, disabled, tone = 'secondary' }) => {
  const toneClasses = {
    primary: 'bg-sky-600 text-white hover:bg-sky-500',
    secondary: 'bg-slate-700 text-slate-100 hover:bg-slate-600',
    danger: 'bg-red-600 text-white hover:bg-red-500',
    accent: 'bg-purple-600 text-white hover:bg-purple-500',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition ${toneClasses[tone]
        } ${disabled ? 'opacity-40 cursor-not-allowed hover:none' : ''}`}
    >
      {icon}
      <span className="whitespace-nowrap">{label}</span>
    </button>
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
  const [filterStock, setFilterStock] = useState<'all' | 'inStock' | 'outOfStock'>(() => {
    if (typeof window === 'undefined') return 'all';
    return (window.sessionStorage.getItem('avystock:admin-table:filterStock') as 'all' | 'inStock' | 'outOfStock') || 'all';
  });
  const [filterBin, setFilterBin] = useState<'all' | 'withBin' | 'withoutBin'>(() => {
    if (typeof window === 'undefined') return 'all';
    return (window.sessionStorage.getItem('avystock:admin-table:filterBin') as 'all' | 'withBin' | 'withoutBin') || 'all';
  });
  const [filterBinSplit, setFilterBinSplit] = useState<'all' | 'singleBin' | 'multiBin'>(() => {
    if (typeof window === 'undefined') return 'all';
    return (window.sessionStorage.getItem('avystock:admin-table:filterBinSplit') as any) || 'all';
  });
  const [filterImage, setFilterImage] = useState<'all' | 'withImages' | 'noImages'>(() => {
    if (typeof window === 'undefined') return 'all';
    return (window.sessionStorage.getItem('avystock:admin-table:filterImage') as 'all' | 'withImages' | 'noImages') || 'all';
  });
  const [filterCompleteness, setFilterCompleteness] = useState<'all' | 'complete' | 'incomplete' | 'lt80' | 'lt50'>(() => {
    if (typeof window === 'undefined') return 'all';
    return (window.sessionStorage.getItem('avystock:admin-table:filterCompleteness') as any) || 'all';
  });
  const [filterBaselinkerLink, setFilterBaselinkerLink] = useState<'all' | 'linked' | 'unlinked'>(() => {
    if (typeof window === 'undefined') return 'all';
    return (window.sessionStorage.getItem('avystock:admin-table:filterBaselinkerLink') as any) || 'all';
  });
  const [filterWeight, setFilterWeight] = useState<'all' | 'withWeight' | 'noWeight'>(() => {
    if (typeof window === 'undefined') return 'all';
    return (window.sessionStorage.getItem('avystock:admin-table:filterWeight') as any) || 'all';
  });
  const [filterReserved, setFilterReserved] = useState<'all' | 'reserved' | 'notReserved'>(() => {
    if (typeof window === 'undefined') return 'all';
    return (window.sessionStorage.getItem('avystock:admin-table:filterReserved') as any) || 'all';
  });
  const [filterAvailable, setFilterAvailable] = useState<'all' | 'available' | 'notAvailable'>(() => {
    if (typeof window === 'undefined') return 'all';
    return (window.sessionStorage.getItem('avystock:admin-table:filterAvailable') as any) || 'all';
  });
  const [filterQuality, setFilterQuality] = useState<
    'all' | 'notChecked' | 'ok' | 'warn' | 'error' | 'issues'
  >(() => {
    if (typeof window === 'undefined') return 'all';
    return (window.sessionStorage.getItem('avystock:admin-table:filterQuality') as any) || 'all';
  });
  const [filterEbay, setFilterEbay] = useState<'all' | 'listed' | 'notListed'>(() => {
    if (typeof window === 'undefined') return 'all';
    return (window.sessionStorage.getItem('avystock:admin-table:filterEbay') as any) || 'all';
  });
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(() => {
    if (typeof window === 'undefined') return { key: 'ops.last_saved_iso', direction: 'desc' };
    try {
      const raw = window.sessionStorage.getItem('avystock:admin-table:sort');
      if (!raw) return { key: 'ops.last_saved_iso', direction: 'desc' };
      const parsed = JSON.parse(raw);
      if (parsed?.key && parsed?.direction) {
        const migratedKey =
          parsed.key === 'ops.data_quality.last_quality_gate_iso' ? 'qualityGate.sort_score' : parsed.key;
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
  const [isColumnPanelOpen, setIsColumnPanelOpen] = useState(false);
  // track a simple preset to make column selection easier
  const [columnPreset, setColumnPreset] = useState<ColumnPreset>('standard');
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 640px)').matches : false
  );
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
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
  // Fixed BaseLinker inventory
  const [syncInventoryId] = useState('78659');
  const [syncInProgress, setSyncInProgress] = useState(false);
  const [ebayPublishInProgress, setEbayPublishInProgress] = useState(false);
  // productId → itemId map from ebayListingLinks (matched listings)
  const [ebayLinkedMap, setEbayLinkedMap] = useState<Map<string, string>>(new Map());
  const [ebayItemIdMap, setEbayItemIdMap] = useState<Map<string, string>>(new Map()); // SKU → itemId
  const [ebayUpdateInProgress, setEbayUpdateInProgress] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
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
  const [baselinkerLookupInProgress, setBaselinkerLookupInProgress] = useState(false);
  const [bulkJobId, setBulkJobId] = useState<string | null>(null);
  const [bulkJobAction, setBulkJobAction] = useState<string | null>(null);
  const [bulkJobLoading, setBulkJobLoading] = useState(false);
  const baselinkerChecked = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 640px)');
    const handler = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    const detach = addMediaQueryListener(mq, handler);
    return () => detach();
  }, []);

  useEffect(() => {}, []);

  // Load eBay SKU-index (alle aktiven Listings, SKU → viewItemUrl + itemId) once on mount
  useEffect(() => {
    fetchEbaySkuIndex()
      .then((entries) => {
        const urlMap = new Map<string, string>();
        const itemIdMap = new Map<string, string>();
        entries.forEach((entry) => {
          if (!entry.sku) return;
          const key = String(entry.sku).trim().toUpperCase();
          const url = entry.viewItemUrl || `https://www.ebay.de/itm/${encodeURIComponent(entry.itemId)}`;
          urlMap.set(key, url);
          itemIdMap.set(key, entry.itemId);
        });
        setEbayLinkedMap(urlMap);
        setEbayItemIdMap(itemIdMap);
      })
      .catch(() => {/* ignore – column zeigt dann keine Daten */});
  }, []);

  useEffect(() => {
    if (!isMobile) {
      setMobileFiltersOpen(false);
    }
  }, [isMobile]);

  // Helper: normalize SKU/EAN
  const normalizeSku = (value?: string | null) => {
    if (!value) return '';
    return value.toString().trim().replace(/\s+/g, '').toUpperCase();
  };

  // On load: check BaseLinker existence by SKU/EAN and update products with found product_id
  useEffect(() => {
    const candidates = products
      .filter((p) => !p?.ops?.baselinker?.product_id)
      .map((p) => {
        const identifiers = p.details?.identifiers || {};
        const sku = normalizeSku(p.identification?.sku || identifiers.sku);
        const ean = normalizeSku(identifiers.ean || identifiers.gtin || identifiers.upc || (p.identification?.barcodes || [])[0]);
        return sku || ean || '';
      })
      .filter(Boolean)
      .filter((sku) => !baselinkerChecked.current.has(sku));

    const uniqueSkus = Array.from(new Set(candidates));
    if (!uniqueSkus.length || baselinkerLookupInProgress) return;

    let cancelled = false;
    const run = async () => {
      try {
        setBaselinkerLookupInProgress(true);
        const res = await lookupBaseLinkerBySkus(uniqueSkus);
        if (!res.ok || !res.results || cancelled) return;

        const updated = products.map((p) => {
          const identifiers = p.details?.identifiers || {};
          const sku = normalizeSku(p.identification?.sku || identifiers.sku);
          const ean = normalizeSku(identifiers.ean || identifiers.gtin || identifiers.upc || (p.identification?.barcodes || [])[0]);
          const key = sku || ean || '';
          const match = key ? res.results?.[key] : undefined;
          if (match?.product_id) {
            const currentOps = { ...(p.ops || {}) };
            const currentBL = currentOps.baselinker || {};
            return {
              ...p,
              ops: {
                ...currentOps,
                baselinker: {
                  ...currentBL,
                  product_id: match.product_id,
                  synced_inventory: match.inventoryId || syncInventoryId,
                  matched_sku: match.sku || sku || null,
                  matched_ean: match.ean || ean || null,
                },
              },
            };
          }
          return p;
        });

        // mark checked
        uniqueSkus.forEach((s) => baselinkerChecked.current.add(s));
        onUpdateProducts(updated);
      } finally {
        if (!cancelled) setBaselinkerLookupInProgress(false);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [products, baselinkerLookupInProgress, onUpdateProducts, syncInventoryId]);


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
          <div className="w-12 h-12 rounded-md overflow-hidden bg-slate-700 flex items-center justify-center text-xs text-slate-400">
            {primaryImage(product) ? (
              <img
                src={primaryImage(product)!.url_or_base64}
                alt={product.identification?.name || ''}
                className="w-full h-full object-cover"
              />
            ) : (
              '—'
            )}
          </div>
        ),
      },
      {
        id: 'completeness',
        label: 'Vollständig',
        sortKey: 'completeness.percent',
        defaultVisible: true,
        widthClass: 'w-32',
        render: ({ product }) => {
          const percent = product.completeness?.percent ?? 0;
          const missing = product.completeness?.missing || [];
          const barWidth = Math.min(Math.max(percent, 0), 100);
          return (
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs text-slate-200">
                <span>{percent}%</span>
                {missing.length > 0 && (
                  <span className="text-[11px] text-amber-300">
                    fehlend: {missing.length}
                  </span>
                )}
              </div>
              <div className="h-2 w-full rounded-full bg-slate-700 overflow-hidden">
                <div
                  className="h-full bg-emerald-500"
                  style={{ width: `${barWidth}%` }}
                  title={missing.length ? `Fehlt: ${missing.join(', ')}` : 'Vollständig'}
                />
              </div>
            </div>
          );
        },
      },
      {
        id: 'qualityGate',
        label: 'Quality',
        sortKey: 'qualityGate.sort_score',
        defaultVisible: true,
        widthClass: 'w-28',
        render: ({ product }) => {
          const gate: any = (product as any)?.ops?.data_quality?.quality_gate_v1;
          if (!gate) {
            return <span className="text-[11px] text-slate-500">—</span>;
          }
          const issues = Array.isArray(gate.issues) ? gate.issues : [];
          const errors = issues.filter((i: any) => i?.severity === 'error').length;
          const warns = issues.filter((i: any) => i?.severity === 'warn').length;
          const ok = errors === 0 && warns === 0 && issues.length === 0;
          const title = gate.summary || (issues.length ? `Issues: ${issues.map((i: any) => i?.code).filter(Boolean).slice(0, 6).join(', ')}` : 'OK');
          if (ok) {
            return (
              <span title={title} className="inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                OK
              </span>
            );
          }
          if (errors === 0 && warns > 0) {
            return (
              <span
                title={title}
                className="inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full bg-amber-500/15 text-amber-200 border border-amber-500/30"
              >
                W{warns}
              </span>
            );
          }
          return (
            <span
              title={title}
              className="inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full bg-red-500/15 text-red-200 border border-red-500/30"
            >
              {errors ? `E${errors}` : ''}{warns ? ` W${warns}` : issues.length ? ` ${issues.length}` : ''}
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
                // Nur bei normalem Klick SPA-Navigation nutzen; bei Ctrl/Meta/Middle/Shift Tabs öffnen erlauben
                if (e.metaKey || e.ctrlKey || e.button === 1 || e.shiftKey) {
                  return;
                }
                e.preventDefault();
                handleSelect(product.id);
                // URL aktualisieren, damit Reload/Copy funktioniert
                window.location.hash = `#/sheet/${product.id}`;
              }}
              className="font-medium text-sky-400 hover:underline"
            >
              {product.identification?.name || '—'}
            </a>
            <div className="text-sm text-slate-400">{product.identification?.brand || '—'}</div>
          </div>
        ),
      },
      {
        id: 'category',
        label: t('table.category'),
        sortKey: 'category.display',
        defaultVisible: true,
        render: ({ product }) => <span className="text-slate-300">{getProductDisplayCategory(product)}</span>,
      },
      {
        id: 'sku',
        label: t('table.sku'),
        sortKey: 'details.identifiers.sku',
        defaultVisible: true,
        render: ({ product }) => (
          <div className="text-slate-300 text-sm font-mono leading-tight whitespace-nowrap">
            {product.details?.identifiers?.sku || product.identification?.sku || '—'}
          </div>
        ),
      },
      {
        id: 'barcode',
        label: t('table.barcode'),
        sortKey: 'details.identifiers.ean',
        defaultVisible: true,
        render: ({ product }) => (
          <div className="text-slate-300 text-sm font-mono leading-tight">{primaryBarcode(product)}</div>
        ),
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
            <span className="font-semibold text-slate-100 text-center block">{getProductQuantity(product)}</span>
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
            return <span className="text-slate-500 text-sm">0</span>;
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
            <div className="flex flex-col text-sm text-slate-300">
              <span className="font-mono text-base text-white">{primaryBin(product)}</span>
            </div>
          ) : (
            <span className="text-slate-500">{t('table.noBin')}</span>
          ),
      },
      {
        id: 'baselinker',
        label: 'BaseLinker',
        sortKey: 'ops.baselinker.product_id',
        defaultVisible: true,
        render: ({ product }) => {
          const bl = (product as any)?.ops?.baselinker;
          const linked = Boolean(bl?.product_id);
          return (
            <span
              className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-semibold ${linked
                  ? 'bg-emerald-500/20 text-emerald-200'
                  : 'bg-slate-700 text-slate-200'
                }`}
            >
              {linked ? 'verknüpft' : 'nicht in BL'}
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
          // SKU-Match aus Trading-API-Sync (ebayListingsLive), Fallback auf marketplace.ebay.itemId
          const productSku = String(
            (product as any)?.identification?.sku || product.details?.identifiers?.sku || ''
          ).trim().toUpperCase();
          const viewItemUrl =
            (productSku ? ebayLinkedMap.get(productSku) : null) ||
            ((product as any)?.marketplace?.ebay?.itemId
              ? `https://www.ebay.de/itm/${encodeURIComponent(String((product as any).marketplace.ebay.itemId).trim())}`
              : null);
          return (
            viewItemUrl ? (
              <a
                href={viewItemUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                title="eBay-Listing öffnen"
                className="inline-flex items-center justify-center rounded-full bg-sky-500/20 px-2 py-0.5 text-xs font-semibold text-sky-200 hover:bg-sky-500/30 hover:text-sky-100"
              >
                gelistet
              </a>
            ) : (
              <span
                title="Nicht auf eBay gelistet"
                className="inline-flex items-center justify-center rounded-full bg-slate-700 px-2 py-0.5 text-xs font-semibold text-slate-500"
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
          if (!raw) return <span className="text-slate-500">Keine Daten</span>;
          const date = new Date(raw);
          if (Number.isNaN(date.getTime())) return <span className="text-slate-500">Unbekannt</span>;
          return <span className="text-slate-300 text-sm">{date.toLocaleString('de-DE')}</span>;
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
          <span className="text-slate-400 text-sm">
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
          <span className="text-slate-400 text-sm">
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
        render: ({ product }) => <span className="text-slate-200 text-sm">{product.ops.revision}</span>,
      },
    ];
    return baseRenderers;
  }, [onSelectProduct, t]);

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
            return newDefaults.length > 0 ? [...valid, ...newDefaults] : valid;
          }
        }
      } catch (error) {
        console.warn('Konnte gespeicherte Spalten nicht laden:', error);
      }
    }
    const mobileDefault = typeof window !== 'undefined' ? window.matchMedia('(max-width: 900px)').matches : false;
    return mobileDefault ? COLUMN_PRESETS.minimal : COLUMN_PRESETS.standard;
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
      return [...prev, id];
    });
  };

  const resetColumns = () => {
    setVisibleColumns(COLUMN_PRESETS.standard);
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
      const quantity = getProductQuantity(p) || 0;
      const matchesStock =
        filterStock === 'all' ||
        (filterStock === 'inStock' && quantity > 0) ||
        (filterStock === 'outOfStock' && quantity <= 0);
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

      const hasImages = Array.isArray(p.details?.images) && p.details.images.length > 0;
      const matchesImages =
        filterImage === 'all' ||
        (filterImage === 'withImages' && hasImages) ||
        (filterImage === 'noImages' && !hasImages);

      const baselinkerProductId = (p as any)?.ops?.baselinker?.product_id;
      const hasBaselinkerLink = Boolean(baselinkerProductId);
      const matchesBaselinkerLink =
        filterBaselinkerLink === 'all' ||
        (filterBaselinkerLink === 'linked' && hasBaselinkerLink) ||
        (filterBaselinkerLink === 'unlinked' && !hasBaselinkerLink);

      const weight = Number((p.details?.attributes as any)?.weight || 0);
      const hasWeight = Number.isFinite(weight) && weight > 0;
      const matchesWeight =
        filterWeight === 'all' ||
        (filterWeight === 'withWeight' && hasWeight) ||
        (filterWeight === 'noWeight' && !hasWeight);

      const reservedQuantity = Number(p.inventory?.reservedQuantity || 0) || 0;
      const availableQuantity =
        typeof p.inventory?.availableQuantity === 'number'
          ? Math.max(0, p.inventory.availableQuantity)
          : Math.max(0, quantity - reservedQuantity);
      const matchesReserved =
        filterReserved === 'all' ||
        (filterReserved === 'reserved' && reservedQuantity > 0) ||
        (filterReserved === 'notReserved' && reservedQuantity <= 0);
      const matchesAvailable =
        filterAvailable === 'all' ||
        (filterAvailable === 'available' && availableQuantity > 0) ||
        (filterAvailable === 'notAvailable' && availableQuantity <= 0);

      const percent = p.completeness?.percent ?? 0;
      const isComplete = p.completeness?.complete === true;
      const matchesCompleteness =
        filterCompleteness === 'all' ||
        (filterCompleteness === 'complete' && isComplete) ||
        (filterCompleteness === 'incomplete' && !isComplete) ||
        (filterCompleteness === 'lt80' && percent < 80) ||
        (filterCompleteness === 'lt50' && percent < 50);

      const gate: any = (p as any)?.ops?.data_quality?.quality_gate_v1;
      const gateIssues = Array.isArray(gate?.issues) ? gate.issues : [];
      const gateErrors = gateIssues.filter((i: any) => i?.severity === 'error').length;
      const gateWarns = gateIssues.filter((i: any) => i?.severity === 'warn').length;
      const gateHas = Boolean(gate);
      const gateOk = gateHas && gateErrors === 0 && gateWarns === 0 && gateIssues.length === 0;
      const gateHasIssues = gateHas && gateIssues.length > 0;
      const matchesQuality =
        filterQuality === 'all' ||
        (filterQuality === 'notChecked' && !gateHas) ||
        (filterQuality === 'ok' && gateOk) ||
        (filterQuality === 'warn' && gateHas && gateErrors === 0 && gateWarns > 0) ||
        (filterQuality === 'error' && gateHas && gateErrors > 0) ||
        (filterQuality === 'issues' && gateHasIssues);

      const pSku = String(
        (p as any)?.identification?.sku || p.details?.identifiers?.sku || ''
      ).trim().toUpperCase();
      const isEbayListed = Boolean(
        (pSku ? ebayLinkedMap.get(pSku) : null) ||
        (p as any)?.marketplace?.ebay?.itemId
      );
      const matchesEbay =
        filterEbay === 'all' ||
        (filterEbay === 'listed' && isEbayListed) ||
        (filterEbay === 'notListed' && !isEbayListed);

      return (
        matchesSearch &&
        matchesStatus &&
        matchesCategory &&
        matchesStock &&
        matchesBin &&
        matchesBinSplit &&
        matchesImages &&
        matchesBaselinkerLink &&
        matchesWeight &&
        matchesReserved &&
        matchesAvailable &&
        matchesCompleteness &&
        matchesQuality &&
        matchesEbay
      );
    });

    if (sortConfig !== null) {
        const getNestedValue = (obj: any, path: string) => path.split('.').reduce((o, k) => (o || {})[k], obj);
      const getSortValue = (product: Product, key: string) => {
        switch (key) {
          case 'category.display':
            return getProductDisplayCategory(product).toLowerCase();
          case 'qualityGate.sort_score': {
            const gate: any = (product as any)?.ops?.data_quality?.quality_gate_v1;
            if (!gate) return 100000; // "nicht geprüft" → last in asc, first in desc
            const issues = Array.isArray(gate.issues) ? gate.issues : [];
            const errors = issues.filter((i: any) => i?.severity === 'error').length;
            const warns = issues.filter((i: any) => i?.severity === 'warn').length;
            // Higher = worse. errors dominate, then warns.
            return errors * 1000 + warns * 10 + (issues.length ? 1 : 0);
          }
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
            const sortSku = String(
              (product as any)?.identification?.sku || product.details?.identifiers?.sku || ''
            ).trim().toUpperCase();
            return Boolean(
              (sortSku ? ebayLinkedMap.get(sortSku) : null) ||
              (product as any)?.marketplace?.ebay?.itemId
            ) ? 1 : 0;
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
    filterStock,
    filterBin,
    filterBinSplit,
    filterImage,
    filterBaselinkerLink,
    filterWeight,
    filterReserved,
    filterAvailable,
    filterCompleteness,
    filterQuality,
    filterEbay,
    ebayLinkedMap,
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

  const handleBatchSync = async () => {
    if (selectedIds.size === 0) return;

    // Get selected products
    const selectedProducts = products.filter(p => selectedIds.has(p.id));
    if (selectedProducts.length === 0) return;

    // Update UI to show syncing state
    setSyncInProgress(true);
    setSyncMessage(`Synchronisiere ${selectedProducts.length} Produkte …`);
    setNotice({
      tone: 'info',
      title: 'Sync gestartet',
      message: `Synchronisiere ${selectedProducts.length} Produkte (BaseLinker Inventory ${syncInventoryId}).`,
    });
    const updatingProducts = products.map(p =>
      selectedIds.has(p.id)
        ? { ...p, ops: { ...p.ops, sync_status: 'pending' as const } }
        : p
    );
    onUpdateProducts(updatingProducts);

    try {
      const missingCats = selectedProducts
        .filter((p) => {
          const v = String(p?.details?.baselinkerCategoryPath || '').trim();
          if (v) return false;
          const legacyMap = (p?.details?.baselinkerCategories || {}) as any;
          return !String(legacyMap?.['91387'] || '').trim();
        })
        .map((p) => p.id);

      if (missingCats.length) {
        throw new Error(
          `Sync abgebrochen: BaseLinker-Kategorie fehlt für ${missingCats.length} Produkte (z.B. ${missingCats
            .slice(0, 8)
            .join(', ')}).`
        );
      }

      const res = await syncToBaseLinker(selectedProducts, syncInventoryId);
      const results = Array.isArray(res?.results) ? res.results : [];
      const byId = new Map(results.map((r) => [r.id, r]));

      const finalProducts = products.map((p) => {
        if (!selectedIds.has(p.id)) return p;
        const entry = byId.get(p.id);
        const ok = entry?.status === 'synced';
        return {
          ...p,
          ops: {
            ...p.ops,
            sync_status: ok ? ('synced' as const) : ('failed' as const),
            last_synced_iso: ok ? new Date().toISOString() : p.ops.last_synced_iso,
          },
        };
      });
      onUpdateProducts(finalProducts);

      const successCount = finalProducts.filter((p) => selectedIds.has(p.id) && p.ops.sync_status === 'synced').length;
      const failCount = selectedProducts.length - successCount;
      const failureSummary = results
        .filter((r) => r.status !== 'synced')
        .slice(0, 200)
        .map((r) => `${r.id}: ${r.message || 'fehlgeschlagen'}`)
        .join('\n');

      setNotice({
        tone: failCount > 0 ? 'warning' : 'success',
        title: 'Sync abgeschlossen',
        message: `✓ ${successCount} synchronisiert · ✗ ${failCount} fehlgeschlagen`,
        details: failCount > 0 ? failureSummary : undefined,
      });
    } catch (error) {
      // Revert to original state on error
      onUpdateProducts(products);
      setNotice({
        tone: 'error',
        title: 'Sync fehlgeschlagen',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setSyncInProgress(false);
      setSyncMessage(null);
      setSelectedIds(new Set());
    }
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
          entries.forEach((entry) => {
            if (!entry.sku) return;
            const key = String(entry.sku).trim().toUpperCase();
            const url = entry.viewItemUrl || `https://www.ebay.de/itm/${encodeURIComponent(entry.itemId)}`;
            urlMap.set(key, url);
            itemIdMap.set(key, entry.itemId);
          });
          setEbayLinkedMap(urlMap);
          setEbayItemIdMap(itemIdMap);
        }).catch(() => {});
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
        return sku ? ebayItemIdMap.get(sku) : null;
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

  const handleUpdateAllEbay = async () => {
    const total = ebayLinkedMap.size;
    if (!window.confirm(
      `Alle ${total} aktiven eBay-Listings aktualisieren?\nNur geänderte Felder werden übertragen.\nDies kann mehrere Minuten dauern.\n\nFortfahren?`
    )) return;

    setEbayUpdateInProgress(true);
    setNotice({ tone: 'info', title: 'eBay Update', message: `Aktualisiere alle ${total} aktiven Listings...` });

    try {
      const result = await bulkUpdateEbayListings({ applyAll: true });
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
        inventoryId: syncInventoryId,
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
          }
          setNotice({
            tone: 'success',
            title: 'Bulk Job abgeschlossen',
            message: 'Aktion abgeschlossen. Bitte Produkte neu laden, um Änderungen zu sehen.',
            details: JSON.stringify(job?.result?.summary || job?.result || {}, null, 2),
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
    row.classList.add('ring-2', 'ring-sky-400', 'ring-offset-2', 'ring-offset-slate-800');
    const timeout = window.setTimeout(() => {
      row.classList.remove('ring-2', 'ring-sky-400', 'ring-offset-2', 'ring-offset-slate-800');
    }, 2000);
    return () => {
      window.clearTimeout(timeout);
      row.classList.remove('ring-2', 'ring-sky-400', 'ring-offset-2', 'ring-offset-slate-800');
    };
  }, [focusProductId, filteredAndSortedProducts]);

  const SortableHeader: React.FC<{ sortKey?: string; children: React.ReactNode; widthClass?: string }> = ({
    sortKey,
    children,
    widthClass,
  }) => {
    if (!sortKey) {
      return (
        <th className={`p-3 text-xs font-semibold uppercase tracking-wide text-slate-300 whitespace-nowrap ${widthClass || ''}`}>
          {children}
        </th>
      );
    }
    return (
      <th
        className={`p-3 cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-300 whitespace-nowrap ${widthClass || ''}`}
        onClick={() => requestSort(sortKey)}
      >
        {children}
        {sortConfig?.key === sortKey && (sortConfig.direction === 'asc' ? ' ▲' : ' ▼')}
      </th>
    );
  };

  const resetFilters = () => {
    setSearchTerm('');
    setFilterStatus('all');
    setFilterCategorySelection([]);
    setFilterStock('all');
    setFilterBin('all');
    setFilterBinSplit('all');
    setFilterImage('all');
    setFilterCompleteness('all');
    setFilterBaselinkerLink('all');
    setFilterWeight('all');
    setFilterReserved('all');
    setFilterAvailable('all');
    setFilterQuality('all');
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
    window.sessionStorage.setItem('avystock:admin-table:filterQuality', filterQuality);
  }, [filterQuality]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem('avystock:admin-table:filterStock', filterStock);
  }, [filterStock]);
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
    window.sessionStorage.setItem('avystock:admin-table:filterImage', filterImage);
  }, [filterImage]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem('avystock:admin-table:filterCompleteness', filterCompleteness);
  }, [filterCompleteness]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem('avystock:admin-table:filterBaselinkerLink', filterBaselinkerLink);
  }, [filterBaselinkerLink]);
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
    window.sessionStorage.setItem('avystock:admin-table:filterAvailable', filterAvailable);
  }, [filterAvailable]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem('avystock:admin-table:filterEbay', filterEbay);
  }, [filterEbay]);
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

  const filterControlClass = 'p-2 text-sm bg-slate-800/70 border border-slate-700 rounded-lg text-slate-100';
  const filterButtonClass =
    'w-full p-2 text-sm bg-slate-800/70 border border-slate-700 rounded-lg text-slate-100 text-left';
  const menuItemClass =
    'w-full text-left px-3 py-2 text-sm text-slate-100 hover:bg-slate-800 rounded-lg transition';

  const renderFilterControls = () => (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        <select
          id="table-filter-status"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value as SyncStatus | 'all')}
          className={filterControlClass}
        >
          {statusFilters.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <select
          id="table-filter-stock"
          value={filterStock}
          onChange={(e) => setFilterStock(e.target.value as 'all' | 'inStock' | 'outOfStock')}
          className={filterControlClass}
        >
          <option value="all">{t('table.stockFilter.all')}</option>
          <option value="inStock">{t('table.stockFilter.inStock')}</option>
          <option value="outOfStock">{t('table.stockFilter.outOfStock')}</option>
        </select>

        <div className="relative">
          <button
            type="button"
            onClick={() => setCategoryFilterOpen((v) => !v)}
            className={filterButtonClass}
          >
            {filterCategorySelection.length === 0
              ? 'Kategorie: Alle'
              : `Kategorie: ${filterCategorySelection.length} ausgewählt`}
          </button>
          {categoryFilterOpen && (
            <div className="absolute z-30 mt-2 w-[360px] max-w-[90vw] rounded-xl border border-slate-700 bg-slate-950 p-3 shadow-xl">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-200">Kategorien</p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setFilterCategorySelection([])}
                    className="text-xs text-sky-400 hover:underline"
                  >
                    Alle
                  </button>
                  <button
                    type="button"
                    onClick={() => setCategoryFilterOpen(false)}
                    className="text-xs text-slate-300 hover:underline"
                  >
                    Schließen
                  </button>
                </div>
              </div>
              <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
                {categoryTree.map((node) => {
                  const topKey = node.top;
                  const childKeys = node.children.map((c) => `${node.top} > ${c.sub}`);
                  const allKeys = [topKey, ...childKeys];
                  const selectedCount = allKeys.filter((k) => categorySelectionSet.has(k)).length;
                  const isAllSelected = selectedCount === allKeys.length && allKeys.length > 0;
                  const isIndeterminate = selectedCount > 0 && selectedCount < allKeys.length;
                  return (
                    <div key={node.top} className="rounded-md border border-slate-800 bg-slate-900/40">
                      <label className="flex items-center gap-2 px-2 py-2 text-sm text-slate-100">
                        <input
                          type="checkbox"
                          checked={isAllSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = isIndeterminate;
                          }}
                          onChange={() => toggleTopCategory(node.top)}
                        />
                        <span className="flex-1">{node.top}</span>
                        <span className="text-xs text-slate-400">({node.count})</span>
                      </label>
                      {node.children.length > 0 && (
                        <div className="border-t border-slate-800 px-2 py-2 space-y-1">
                          {node.children.map((c) => {
                            const key = `${node.top} > ${c.sub}`;
                            return (
                              <label
                                key={key}
                                className="flex items-center gap-2 pl-5 pr-2 py-1 text-sm text-slate-200"
                              >
                                <input
                                  type="checkbox"
                                  checked={isCategorySelected(key)}
                                  onChange={() => toggleCategoryKey(key)}
                                />
                                <span className="flex-1">{c.sub}</span>
                                <span className="text-xs text-slate-500">({c.count})</span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <select
          id="table-filter-bin"
          value={filterBin}
          onChange={(e) => setFilterBin(e.target.value as 'all' | 'withBin' | 'withoutBin')}
          className={filterControlClass}
        >
          <option value="all">{t('table.binFilter.all')}</option>
          <option value="withBin">{t('table.binFilter.withBin')}</option>
          <option value="withoutBin">{t('table.binFilter.withoutBin')}</option>
        </select>
      </div>

      <details className="rounded-lg border border-slate-700 bg-slate-900/40">
        <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-200">
          Mehr Filter
        </summary>
        <div className="p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <select
            id="table-filter-images"
            value={filterImage}
            onChange={(e) => setFilterImage(e.target.value as 'all' | 'withImages' | 'noImages')}
            className={filterControlClass}
          >
            <option value="all">Bilder: Alle</option>
            <option value="withImages">Mit Bildern</option>
            <option value="noImages">Keine Bilder</option>
          </select>
          <select
            id="table-filter-completeness"
            value={filterCompleteness}
            onChange={(e) =>
              setFilterCompleteness(e.target.value as 'all' | 'complete' | 'incomplete' | 'lt80' | 'lt50')
            }
            className={filterControlClass}
          >
            <option value="all">Vollständig: Alle</option>
            <option value="complete">Nur vollständig</option>
            <option value="incomplete">Unvollständig</option>
            <option value="lt80">&lt; 80%</option>
            <option value="lt50">&lt; 50%</option>
          </select>
          <select
            id="table-filter-quality"
            value={filterQuality}
            onChange={(e) => setFilterQuality(e.target.value as any)}
            className={filterControlClass}
          >
            <option value="all">Quality: Alle</option>
            <option value="notChecked">Quality: nicht geprüft</option>
            <option value="ok">Quality: OK</option>
            <option value="warn">Quality: WARN</option>
            <option value="error">Quality: ERROR</option>
            <option value="issues">Quality: Issues</option>
          </select>
          <select
            id="table-filter-baselinker-link"
            value={filterBaselinkerLink}
            onChange={(e) => setFilterBaselinkerLink(e.target.value as any)}
            className={filterControlClass}
          >
            <option value="all">BaseLinker: Alle</option>
            <option value="linked">BaseLinker: verknüpft</option>
            <option value="unlinked">BaseLinker: nicht verknüpft</option>
          </select>
          <select
            id="table-filter-ebay"
            value={filterEbay}
            onChange={(e) => setFilterEbay(e.target.value as any)}
            className={filterControlClass}
          >
            <option value="all">eBay: Alle</option>
            <option value="listed">eBay: gelistet</option>
            <option value="notListed">eBay: nicht gelistet</option>
          </select>
          <select
            id="table-filter-weight"
            value={filterWeight}
            onChange={(e) => setFilterWeight(e.target.value as any)}
            className={filterControlClass}
          >
            <option value="all">Gewicht: Alle</option>
            <option value="withWeight">Gewicht: vorhanden</option>
            <option value="noWeight">Gewicht: fehlt</option>
          </select>
          <select
            id="table-filter-reserved"
            value={filterReserved}
            onChange={(e) => setFilterReserved(e.target.value as any)}
            className={filterControlClass}
          >
            <option value="all">Reserviert: Alle</option>
            <option value="reserved">Reserviert: &gt; 0</option>
            <option value="notReserved">Reserviert: 0</option>
          </select>
          <select
            id="table-filter-available"
            value={filterAvailable}
            onChange={(e) => setFilterAvailable(e.target.value as any)}
            className={filterControlClass}
          >
            <option value="all">Verfügbar: Alle</option>
            <option value="available">Verfügbar: &gt; 0</option>
            <option value="notAvailable">Verfügbar: 0</option>
          </select>
          <select
            id="table-filter-bin-split"
            value={filterBinSplit}
            onChange={(e) => setFilterBinSplit(e.target.value as any)}
            className={filterControlClass}
          >
            <option value="all">Bins: Alle</option>
            <option value="singleBin">Bins: 1 BIN</option>
            <option value="multiBin">Bins: mehrere BINs</option>
          </select>
        </div>
      </details>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={columnPreset}
            onChange={(e) => {
              const preset = e.target.value as ColumnPreset;
              setVisibleColumns(COLUMN_PRESETS[preset]);
              setColumnPreset(preset);
            }}
            className={filterControlClass}
          >
            <option value="standard">{t('table.presets.standard')}</option>
            <option value="warehouse">{t('table.presets.warehouse')}</option>
            <option value="pricing">{t('table.presets.pricing')}</option>
            <option value="minimal">{t('table.presets.minimal')}</option>
          </select>
          <button
            type="button"
            onClick={() => setIsColumnPanelOpen((prev) => !prev)}
            className="rounded-md border border-slate-700 bg-slate-800/70 px-3 py-2 text-xs font-semibold text-slate-100 hover:border-slate-600"
          >
            {t('table.columns.edit')}
          </button>
          <button
            type="button"
            onClick={resetColumns}
            className="rounded-md border border-slate-700 bg-slate-800/70 px-3 py-2 text-xs font-semibold text-slate-100 hover:border-slate-600"
          >
            {t('table.columns.reset')}
          </button>
        </div>

        <details className="relative">
          <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden rounded-md border border-slate-700 bg-slate-800/70 px-3 py-2 text-xs font-semibold text-slate-100 hover:border-slate-600">
            Tools
          </summary>
          <div className="absolute right-0 mt-2 w-[340px] max-w-[90vw] rounded-xl border border-slate-700 bg-slate-950 p-1 shadow-xl z-30">
            <button type="button" onClick={handleExportCsv} className={menuItemClass}>
              Export CSV
            </button>
            <button
              type="button"
              onClick={() => {
                setKtypeModalOpen(true);
                setKtypeFile(null);
                setKtypeReport(null);
                setKtypeMessage(null);
              }}
              className={menuItemClass}
            >
              K‑Typ importieren
            </button>

            {onBulkImprove ? (
              <button
                type="button"
                onClick={() => {
                  setConfirmDialog({
                    title: 'Alle Produkte verbessern?',
                    tone: 'default',
                    description:
                      'Startet KI/Improve-Jobs für alle Produkte. Das kann viele Jobs erzeugen und je nach Menge dauern.',
                    confirmLabel: 'Verbessern (alle) starten',
                    onConfirm: () => {
                      setConfirmDialog(null);
                      onBulkImprove();
                    },
                  });
                }}
                className={menuItemClass}
              >
                Verbessern (alle)
              </button>
            ) : null}

            {mode === 'inventory' ? (
              <>
                <div className="my-1 border-t border-slate-800" />
                <div className="px-3 py-1 text-[11px] uppercase tracking-wide text-slate-400">
                  Inventory Fix + Sync
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmDialog({
                      title: 'Titel-Fix für alle Inventory-Produkte?',
                      tone: 'default',
                      description:
                        "Entfernt einen Bindestrich am Ende (inkl. Leerzeichen) und stößt anschließend einen BaseLinker Text-Sync an.",
                      confirmLabel: 'Starten',
                      onConfirm: async () => {
                        setConfirmDialog(null);
                        await enqueueBulkForAllInCurrentMode('title_cleanup');
                      },
                    });
                  }}
                  className={menuItemClass}
                >
                  Titel Cleanup + Sync
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmDialog({
                      title: 'Highlights als HTML formatieren?',
                      tone: 'default',
                      description:
                        'Speichert Highlights als <ul><li>…</li></ul> (kein „•“) und synchronisiert sie per Text-Only Sync nach BaseLinker.',
                      confirmLabel: 'Starten',
                      onConfirm: async () => {
                        setConfirmDialog(null);
                        await enqueueBulkForAllInCurrentMode('highlights_html');
                      },
                    });
                  }}
                  className={menuItemClass}
                >
                  Highlights → HTML + Sync
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmDialog({
                      title: 'Beschreibung als HTML formatieren?',
                      tone: 'default',
                      description:
                        'Formatiert Absätze zu <p>…</p> und Label wie „Zustand:“ zu <strong>…</strong>. Danach Text-Only Sync nach BaseLinker.',
                      confirmLabel: 'Starten',
                      onConfirm: async () => {
                        setConfirmDialog(null);
                        await enqueueBulkForAllInCurrentMode('description_html');
                      },
                    });
                  }}
                  className={menuItemClass}
                >
                  Beschreibung → HTML + Sync
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmDialog({
                      title: 'Listing-Readiness Audit ausführen?',
                      tone: 'default',
                      description:
                        'Korrigiert/vereinheitlicht Titel/Highlights/Beschreibung/Attribute und stößt anschließend Text-Only Sync nach BaseLinker an.',
                      confirmLabel: 'Starten',
                      onConfirm: async () => {
                        setConfirmDialog(null);
                        await enqueueBulkForAllInCurrentMode('listing_readiness');
                      },
                    });
                  }}
                  className={menuItemClass}
                >
                  Listing-Readiness Audit + Fix + Sync
                </button>
              </>
            ) : null}
          </div>
        </details>
      </div>

      {isColumnPanelOpen && (
        <div className="rounded-lg border border-slate-600 bg-slate-900 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-white">{t('table.columns.visible')}</p>
            <button type="button" className="text-xs text-sky-400 hover:underline" onClick={resetColumns}>
              {t('table.columns.reset')}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto">
            {columnDefinitions.map((column) => (
              <label key={column.id} className="flex items-center gap-2 text-sm text-slate-200">
                <input
                  type="checkbox"
                  checked={visibleColumns.includes(column.id)}
                  onChange={() => toggleColumnVisibility(column.id)}
                  disabled={visibleColumns.length === 1 && visibleColumns.includes(column.id)}
                  className="bg-slate-600 border-slate-500"
                />
                {column.label}
              </label>
            ))}
          </div>
        </div>
      )}
    </>
  );

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

    if (filterStock !== 'all') {
      const label = filterStock === 'inStock' ? t('table.stockFilter.inStock') : t('table.stockFilter.outOfStock');
      chips.push({ key: 'stock', label, onClear: () => setFilterStock('all') });
    }

    if (filterBin !== 'all') {
      const label = filterBin === 'withBin' ? t('table.binFilter.withBin') : t('table.binFilter.withoutBin');
      chips.push({ key: 'bin', label, onClear: () => setFilterBin('all') });
    }

    if (filterImage !== 'all') {
      const label = filterImage === 'withImages' ? 'Mit Bildern' : 'Keine Bilder';
      chips.push({ key: 'images', label, onClear: () => setFilterImage('all') });
    }

    if (filterCompleteness !== 'all') {
      const label =
        filterCompleteness === 'complete'
          ? 'Vollständig'
          : filterCompleteness === 'incomplete'
            ? 'Unvollständig'
            : filterCompleteness === 'lt80'
              ? 'Vollständigkeit < 80%'
              : 'Vollständigkeit < 50%';
      chips.push({ key: 'completeness', label, onClear: () => setFilterCompleteness('all') });
    }

    if (filterQuality !== 'all') {
      const label =
        filterQuality === 'notChecked'
          ? 'Quality: nicht geprüft'
          : filterQuality === 'ok'
            ? 'Quality: OK'
            : filterQuality === 'warn'
              ? 'Quality: WARN'
              : filterQuality === 'error'
                ? 'Quality: ERROR'
                : 'Quality: Issues';
      chips.push({ key: 'quality', label, onClear: () => setFilterQuality('all') });
    }

    if (filterBaselinkerLink !== 'all') {
      chips.push({
        key: 'baselinker',
        label: filterBaselinkerLink === 'linked' ? 'BaseLinker: verknüpft' : 'BaseLinker: nicht verknüpft',
        onClear: () => setFilterBaselinkerLink('all'),
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

    if (filterAvailable !== 'all') {
      chips.push({
        key: 'available',
        label: filterAvailable === 'available' ? 'Verfügbar > 0' : 'Verfügbar = 0',
        onClear: () => setFilterAvailable('all'),
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
    filterAvailable,
    filterBaselinkerLink,
    filterBin,
    filterBinSplit,
    filterCategorySelection,
    filterCompleteness,
    filterImage,
    filterQuality,
    filterReserved,
    filterStatus,
    filterStock,
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
      return Boolean(sku && ebayItemIdMap.has(sku));
    });
  }, [selectedIds, products, ebayItemIdMap]);

  const renderSelectionBar = () => {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-950/30 p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="text-xs text-slate-200">
          <b>{selectedIds.size}</b> ausgewählt
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton
            icon={<SyncIcon className="w-4 h-4" />}
            label={t('table.actions.syncSelected')}
            onClick={handleBatchSync}
            disabled={selectedIds.size === 0 || syncInProgress}
            tone="primary"
          />
          <ActionButton
            icon={
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="10" cy="10" r="7" />
                <path d="M3 10h14M10 3a10.5 10.5 0 013 7 10.5 10.5 0 01-3 7 10.5 10.5 0 01-3-7 10.5 10.5 0 013-7z" />
              </svg>
            }
            label={ebayPublishInProgress ? 'Wird gelistet...' : 'Auf eBay listen'}
            onClick={handleBatchPublishEbay}
            disabled={selectedIds.size === 0 || ebayPublishInProgress}
            tone="primary"
          />
          {hasSelectedEbayListings && (
            <ActionButton
              icon={
                <svg className="w-4 h-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 4v5h5M16 16v-5h-5" />
                  <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m18 0 4.36 4.36A9 9 0 0 1 3.51 15" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              }
              label={ebayUpdateInProgress ? 'Wird aktualisiert...' : 'eBay aktualisieren'}
              onClick={handleBatchUpdateEbay}
              disabled={ebayUpdateInProgress || ebayPublishInProgress}
              tone="primary"
            />
          )}
          {onImproveSelected ? (
            <ActionButton
              icon={<OperationsIcon className="w-4 h-4" />}
              label="Verbessern"
              onClick={() => {
                const ids = Array.from(selectedIds);
                if (!ids.length) return;
                setImproveInProgress(true);
                setImproveMessage(`Verbessern gestartet (${ids.length}) …`);
                try {
                  onImproveSelected(ids);
                } catch (err: any) {
                  console.error('Improve Selected failed', err?.message || err);
                  setImproveMessage('Fehler beim Verbessern');
                } finally {
                  setTimeout(() => setImproveInProgress(false), 3000);
                }
              }}
              disabled={selectedIds.size === 0 || improveInProgress}
              tone="accent"
            />
          ) : null}

          <details className="relative">
            <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden rounded-md bg-slate-800/70 border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-100 hover:border-slate-600">
              Mehr
            </summary>
            <div className="absolute right-0 mt-2 w-[320px] max-w-[90vw] rounded-xl border border-slate-700 bg-slate-950 p-1 shadow-xl z-30">
              <button
                type="button"
                onClick={() => enqueueBulkForSelection('price')}
                disabled={bulkJobLoading}
                className={menuItemClass}
              >
                Price Refresh
              </button>
              <button
                type="button"
                onClick={() => enqueueBulkForSelection('title')}
                disabled={bulkJobLoading}
                className={menuItemClass}
              >
                Titel fix
              </button>
              <button
                type="button"
                onClick={() => enqueueBulkForSelection('category')}
                disabled={bulkJobLoading}
                className={menuItemClass}
              >
                Kategorie fix
              </button>
              <button
                type="button"
                onClick={() => enqueueBulkForSelection('ktype')}
                disabled={bulkJobLoading}
                className={menuItemClass}
              >
                K‑Typ enrich
              </button>

              <div className="my-1 border-t border-slate-800" />

              <button
                type="button"
                onClick={handleBatchPublishEbay}
                disabled={selectedIds.size === 0 || ebayPublishInProgress}
                className={menuItemClass}
              >
                {ebayPublishInProgress ? 'eBay Publish läuft...' : 'Auf eBay listen'}
              </button>
              <button
                type="button"
                onClick={handleUpdateAllEbay}
                disabled={ebayUpdateInProgress || ebayLinkedMap.size === 0}
                className={menuItemClass}
              >
                {ebayUpdateInProgress ? 'eBay Update läuft...' : `Alle eBay-Listings aktualisieren (${ebayLinkedMap.size})`}
              </button>

              <div className="my-1 border-t border-slate-800" />

              <button
                type="button"
                onClick={handleBatchLabelPrint}
                disabled={selectedIds.size === 0}
                className={menuItemClass}
              >
                Label drucken
              </button>
              <button
                type="button"
                onClick={handleBatchDelete}
                disabled={selectedIds.size === 0}
                className={`${menuItemClass} text-rose-200 hover:bg-rose-900/30`}
              >
                Auswahl löschen
              </button>
            </div>
          </details>
        </div>
      </div>
    );
  };

  return (
    <>
      <section id="admin-table" className="space-y-4">
        <PageHeader
          title={mode === 'inventory' ? t('nav.inventory') : mode === 'products' ? t('nav.products') : t('inventory.title')}
        />

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

        <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[220px]">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                id="table-search"
                type="text"
                placeholder={t('table.search')}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-3 py-2 bg-slate-800/70 border border-slate-700 rounded-lg focus:ring-2 focus:ring-sky-500 text-sm"
              />
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span>
                {filteredAndSortedProducts.length} / {products.length} Produkte
              </span>
              <button type="button" onClick={resetFilters} className="text-sky-400 hover:underline">
                Filter zurücksetzen
              </button>
            </div>
          </div>
          {isMobile ? (
            <div className="rounded-2xl border border-slate-700 bg-slate-900/40">
              <button
                type="button"
                onClick={() => setMobileFiltersOpen((prev) => !prev)}
                className="w-full px-4 py-2 text-sm font-semibold text-slate-100 flex items-center justify-between"
              >
                <span>{mobileFiltersOpen ? 'Filter schließen' : 'Filter öffnen'}</span>
                <span>{mobileFiltersOpen ? '−' : '+'}</span>
              </button>
              {mobileFiltersOpen && <div className="p-3 space-y-3">{renderFilterControls()}</div>}
            </div>
          ) : (
            <div className="space-y-3">{renderFilterControls()}</div>
          )}

          {activeFilterChips.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              {activeFilterChips.map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  onClick={chip.onClear}
                  className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-950/30 px-3 py-1 text-xs text-slate-200 hover:border-slate-600"
                  title="Filter entfernen"
                >
                  <span className="whitespace-nowrap">{chip.label}</span>
                  <span className="text-slate-400">×</span>
                </button>
              ))}
              <button
                type="button"
                onClick={resetFilters}
                className="text-xs text-sky-400 hover:underline"
              >
                Alles löschen
              </button>
            </div>
          ) : null}

          {renderSelectionBar()}
        </div>

        {filteredAndSortedProducts.length === 0 ? (
          <div className="rounded-xl bg-slate-900/40 p-4 text-sm text-slate-300 ring-1 ring-slate-700/50">
            {mode === 'inventory' ? (
              <>
                <b>Keine Inventory-Artikel gefunden.</b>
                <div className="mt-1 text-slate-400">
                  Typische Ursachen: kein Bestand oder kein BIN. (Sync/Listing/Bilder/Vollständigkeit kannst du über Filter zusätzlich einschränken.)
                </div>
              </>
            ) : mode === 'products' ? (
              <>
                <b>Keine Products (Backlog) gefunden.</b>
                <div className="mt-1 text-slate-400">Prüfe Suche/Filter oder ob alle Produkte bereits Inventory-Kriterien erfüllen.</div>
              </>
            ) : (
              <b>Keine Produkte gefunden.</b>
            )}
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <table id="grid" className="w-full text-left min-w-[1000px]">
            <thead className="bg-slate-700/50">
              <tr>
                <th className="p-3 w-12 text-xs font-semibold uppercase tracking-wide text-slate-300">
                  <input
                    type="checkbox"
                    name="select-all-products"
                    onChange={handleSelectAll}
                    checked={
                      selectedIds.size > 0 &&
                      selectedIds.size === pageProducts.length &&
                      pageProducts.length > 0
                    }
                    className="bg-slate-600 border-slate-500"
                  />
                </th>
                {visibleColumnDefinitions.map((column) => {
                  const isThumbnail = column.id === 'thumbnail';
                  return (
                    <SortableHeader key={column.id} sortKey={column.sortKey} widthClass={column.widthClass}>
                      {column.label}
                    </SortableHeader>
                  );
                })}
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-slate-300 whitespace-nowrap">
                  {t('table.actions.label')}
                </th>
              </tr>
            </thead>
            <tbody>
              {pageProducts.map(p => (
                <tr
                  key={p.id}
                  ref={(el) => {
                    rowRefs.current[p.id] = el;
                  }}
                  data-product-row={p.id}
                  className="border-b border-slate-700 hover:bg-slate-700/50 transition-colors"
                >
                  <td className="p-3">
                    <input
                      type="checkbox"
                      name={`select-product-${p.id}`}
                      checked={selectedIds.has(p.id)}
                      onChange={() => handleSelectOne(p.id)}
                      className="bg-slate-600 border-slate-500"
                    />
                  </td>
                  {visibleColumnDefinitions.map((column) => (
                    <td
                      key={`${p.id}-${column.id}`}
                      className="p-3 align-top"
                      style={column.id === 'thumbnail' ? { width: '80px' } : undefined}
                    >
                      {column.render({ product: p, onSelectProduct })}
                    </td>
                  ))}
                  <td className="p-3">
                    <div className="flex flex-col gap-2">

                      <button
                        className="px-2 py-1 text-xs bg-red-600 text-white rounded-md"
                        onClick={async () => {
                          setConfirmDialog({
                            title: 'Produkt löschen?',
                            tone: 'danger',
                            description: (
                              <span>
                                <b>{p.identification?.name || p.id}</b> wird dauerhaft gelöscht.
                              </span>
                            ),
                            confirmLabel: 'Löschen',
                            onConfirm: async () => {
                              setConfirmDialog((prev) => (prev ? { ...prev, confirmBusy: true } : prev));
                              try {
                                const res = await deleteProduct(p.id);
                                if (res.ok) {
                                  onUpdateProducts(products.filter((x) => x.id !== p.id));
                                  setNotice({ tone: 'success', title: 'Produkt gelöscht', message: p.identification?.name || p.id });
                                } else {
                                  setNotice({
                                    tone: 'error',
                                    title: 'Löschen fehlgeschlagen',
                                    details: res.error?.message || 'Unknown error',
                                  });
                                }
                              } finally {
                                setConfirmDialog(null);
                              }
                            },
                          });
                        }}
                      >
                        {t('table.actions.delete')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-slate-400">
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
              className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-slate-200 focus:ring-2 focus:ring-sky-500 outline-none"
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
                className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-slate-200"
              >
                Zurück
              </button>
              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-slate-200"
              >
                Weiter
              </button>
            </div>
          </div>
        </div>
      </section >
      {inventoryModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-700 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">{t('table.inventory.assignTitle')}</h3>
              <button
                type="button"
                className="text-slate-400 hover:text-white"
                onClick={() => {
                  setInventoryModalOpen(false);
                  setInventoryAssignMessage(null);
                }}
              >
                ✕
              </button>
            </div>
            <div className="space-y-2">
              <label className="block text-xs uppercase tracking-wide text-slate-400">
                {t('table.inventory.selectLabel')}
              </label>
              <select
                value={inventorySelection}
                onChange={(event) => setInventorySelection(event.target.value)}
                className="w-full rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-100"
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
              <p className="text-xs text-slate-300">{inventoryAssignMessage}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setInventoryModalOpen(false);
                  setInventoryAssignMessage(null);
                }}
                className="px-3 py-1.5 rounded-lg border border-slate-600 text-sm text-slate-200"
              >
                {t('table.inventory.cancel')}
              </button>
              <button
                type="button"
                onClick={handleAssignInventory}
                disabled={inventoryAssigning}
                className="px-4 py-1.5 rounded-lg bg-sky-600 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-60"
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
          <div className="w-full max-w-2xl rounded-2xl bg-slate-900 border border-slate-700 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">K‑Typ Import (CSV)</h3>
              <button
                type="button"
                className="text-slate-400 hover:text-white"
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

            <div className="text-xs text-slate-400">
              Format: eBay Export (Revise + Compatibility Zeilen, z. B. <span className="font-mono">Ktype=12345|Notes=...</span>).
            </div>

            <div className="space-y-2">
              <label className="block text-xs uppercase tracking-wide text-slate-400">
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
                className="w-full rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-100"
              />
              {ktypeFile && (
                <div className="text-xs text-slate-300">
                  Datei: <span className="font-mono">{ktypeFile.name}</span> ({Math.round(ktypeFile.size / 1024)} KB)
                </div>
              )}
            </div>

            {ktypeMessage && (
              <p className="text-xs text-slate-200">{ktypeMessage}</p>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => runKTypeUpload(true)}
                disabled={ktypeBusy || !ktypeFile}
                className="px-3 py-1.5 rounded-lg border border-slate-600 text-sm text-slate-200 disabled:opacity-60"
              >
                Dry-Run
              </button>
              <button
                type="button"
                onClick={() => runKTypeUpload(false)}
                disabled={ktypeBusy || !ktypeFile}
                className="px-4 py-1.5 rounded-lg bg-sky-600 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-60"
              >
                {ktypeBusy ? 'Läuft …' : 'Übernehmen'}
              </button>
            </div>

            {ktypeReport && (
              <div className="rounded-xl border border-slate-700 bg-slate-950/40 p-3 space-y-2">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                  <div className="text-slate-300">
                    <div className="text-slate-500">SKUs</div>
                    <div className="font-semibold text-white">{ktypeReport.parsed?.skus ?? '—'}</div>
                  </div>
                  <div className="text-slate-300">
                    <div className="text-slate-500">Einträge</div>
                    <div className="font-semibold text-white">{ktypeReport.parsed?.entries ?? '—'}</div>
                  </div>
                  <div className="text-slate-300">
                    <div className="text-slate-500">Updated</div>
                    <div className="font-semibold text-white">{ktypeReport.updated ?? 0}</div>
                  </div>
                  <div className="text-slate-300">
                    <div className="text-slate-500">Not found</div>
                    <div className="font-semibold text-white">{(ktypeReport.notFound || []).length}</div>
                  </div>
                </div>

                <details className="text-xs">
                  <summary className="cursor-pointer select-none text-slate-200">
                    Report JSON anzeigen
                  </summary>
                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-[11px] text-slate-200">
                    {JSON.stringify(ktypeReport, null, 2)}
                  </pre>
                </details>
              </div>
            )}
          </div>
        </div>
      )}
      {syncInProgress && (
        <div className="fixed bottom-6 right-6 z-40 flex items-center gap-3 rounded-2xl bg-slate-900/90 border border-slate-700 px-4 py-3 shadow-xl shadow-black/40 max-w-sm">
          <Spinner className="w-6 h-6 text-sky-300" />
          <div className="text-sm text-slate-100">
            <p className="font-semibold">Sync läuft …</p>
            <p className="text-slate-400 text-xs">{syncMessage || 'Produkte werden übertragen'}</p>
          </div>
        </div>
      )}
      {improveInProgress && (
        <div className="fixed bottom-20 right-6 z-40 flex items-center gap-3 rounded-2xl bg-slate-900/90 border border-slate-700 px-4 py-3 shadow-xl shadow-black/40 max-w-sm">
          <Spinner className="w-6 h-6 text-purple-300" />
          <div className="text-sm text-slate-100">
            <p className="font-semibold">Improve läuft …</p>
            <p className="text-slate-400 text-xs">{improveMessage || 'Produkte werden verbessert'}</p>
          </div>
        </div>
      )}
    </>
  );
};

export default AdminTable;
