
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Product, SyncStatus } from '../types';
import { refreshPrice, syncToBaseLinker, deleteProduct, openProductLabelBatchWindow } from '../api/client';
import { RefreshIcon, SyncIcon, ExportIcon, SearchIcon, PrintIcon, OperationsIcon, SheetIcon, TrashIcon } from './icons/Icons';
import { normalizeSyncStatus, getStableNumericId, getProductQuantity } from '../utils/product';
import { useI18n } from '../i18n';

const COLUMN_STORAGE_KEY = 'avystock:admin-table:visible-columns';
type ColumnId =
  | 'thumbnail'
  | 'nameBrand'
  | 'category'
  | 'sku'
  | 'barcode'
  | 'price'
  | 'inventory'
  | 'pendingIntake'
  | 'storage'
  | 'lastSold'
  | 'syncStatus'
  | 'saveStatus'
  | 'lastSaved'
  | 'lastSynced'
  | 'revision';

type ColumnPreset = 'standard' | 'warehouse' | 'pricing' | 'minimal';
const COLUMN_PRESETS: Record<ColumnPreset, ColumnId[]> = {
  standard: ['thumbnail', 'nameBrand', 'sku', 'barcode', 'category', 'price', 'inventory', 'pendingIntake', 'storage', 'syncStatus', 'lastSaved'],
  warehouse: ['nameBrand', 'sku', 'barcode', 'inventory', 'pendingIntake', 'storage', 'syncStatus', 'saveStatus'],
  pricing: ['nameBrand', 'price', 'sku', 'barcode', 'pendingIntake', 'syncStatus', 'lastSynced'],
  minimal: ['nameBrand', 'sku', 'barcode', 'inventory', 'pendingIntake', 'syncStatus'],
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
  improvingProductIds?: Set<string>;
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
      className={`inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full ${
        saved ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-200'
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
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition ${
        toneClasses[tone]
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
  improvingProductIds,
}) => {
  const { t } = useI18n();
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<SyncStatus | 'all'>('all');
  const [filterCategory, setFilterCategory] = useState('all');
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>({ key: 'ops.last_saved_iso', direction: 'desc' });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isColumnPanelOpen, setIsColumnPanelOpen] = useState(false);
  // track a simple preset to make column selection easier
  const [columnPreset, setColumnPreset] = useState<ColumnPreset>('standard');
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 640px)').matches : false
  );
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 640px)');
    const handler = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    if (!isMobile) {
      setMobileFiltersOpen(false);
    }
  }, [isMobile]);


  const categories = useMemo(() => ['all', ...new Set(products.map(p => p.identification.category))], [products]);

  const primaryImage = (product: Product) =>
    (product.details.images || []).find((img) => img.url_or_base64?.startsWith('http')) || null;
  const primaryBarcode = (product: Product) => {
    const codes = product.identification?.barcodes || [];
    const ids = product.details?.identifiers || {};
    return codes[0] || ids.ean || ids.gtin || ids.upc || '—';
  };
  const primaryBin = (product: Product) =>
    (product.storageBins && product.storageBins[0]?.code) || product.storage?.binCode || null;
  const shortCategory = (product: Product) =>
    (product.identification?.category || '')
      .split('>')
      .map((c) => c.trim())
      .filter(Boolean)
      .pop() ||
    product.identification?.category ||
    '—';

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
                alt={product.identification.name}
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
              href="#"
              onClick={(e) => {
                e.preventDefault();
                handleSelect(product.id);
              }}
              className="font-medium text-sky-400 hover:underline"
            >
              {product.identification.name}
            </a>
            <div className="text-sm text-slate-400">{product.identification.brand}</div>
          </div>
        ),
      },
      {
        id: 'category',
        label: t('table.category'),
        sortKey: 'identification.category',
        defaultVisible: true,
        render: ({ product }) => <span className="text-slate-300">{product.identification.category}</span>,
      },
      {
        id: 'sku',
        label: t('table.sku'),
        defaultVisible: true,
        render: ({ product }) => (
          <div className="text-slate-300 text-sm font-mono leading-tight">
            {product.details.identifiers.sku || product.identification.sku || '—'}
          </div>
        ),
      },
      {
        id: 'barcode',
        label: t('table.barcode'),
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
          product.details.pricing?.lowest_price?.amount
            ? new Intl.NumberFormat('de-DE', {
                style: 'currency',
                currency: product.details.pricing.lowest_price.currency || 'EUR',
              }).format(product.details.pricing.lowest_price.amount)
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
            return valid;
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
    let filtered = products.filter(p => {
      const normalizedStatus = normalizeSyncStatus(p.ops.sync_status, p.ops.last_synced_iso);
      const term = searchTerm.toLowerCase().trim();
      const identifiers = [
        p.details.identifiers?.sku,
        p.identification?.sku,
        p.details.identifiers?.ean,
        p.details.identifiers?.gtin,
        p.details.identifiers?.upc,
        p.id,
      ]
        .filter(Boolean)
        .map((v) => String(v).toLowerCase());
      const matchesSearch =
        term === '' ||
        p.identification.name.toLowerCase().includes(term) ||
        p.identification.brand.toLowerCase().includes(term) ||
        identifiers.some((idVal) => idVal.includes(term));
      const matchesStatus = filterStatus === 'all' || normalizedStatus === filterStatus;
      const matchesCategory = filterCategory === 'all' || p.identification.category === filterCategory;
      return matchesSearch && matchesStatus && matchesCategory;
    });

    if (sortConfig !== null) {
      filtered.sort((a, b) => {
        const getNestedValue = (obj: any, path: string) => path.split('.').reduce((o, k) => (o || {})[k], obj);
        
        let aValue = getNestedValue(a, sortConfig.key);
        let bValue = getNestedValue(b, sortConfig.key);

        if (aValue === null || aValue === undefined) aValue = sortConfig.direction === 'asc' ? Infinity : -Infinity;
        if (bValue === null || bValue === undefined) bValue = sortConfig.direction === 'asc' ? Infinity : -Infinity;

        if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
        if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
      });
    }

    return filtered;
  }, [products, searchTerm, filterStatus, filterCategory, sortConfig]);

  const requestSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      setSelectedIds(new Set(filteredAndSortedProducts.map(p => p.id)));
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
    const updatingProducts = products.map(p => 
      selectedIds.has(p.id) 
        ? { ...p, ops: { ...p.ops, sync_status: 'pending' as const } }
        : p
    );
    onUpdateProducts(updatingProducts);
    
    try {
      // Sync all selected products
      const result = await syncToBaseLinker(selectedProducts);
      
      if (result.results && result.results.length > 0) {
        // Update products based on sync results
        const finalProducts = products.map(p => {
          const syncResult = result.results?.find(r => r.id === p.id);
          if (!syncResult) return p;
          
          return {
            ...p,
            ops: {
              ...p.ops,
              sync_status: syncResult.status,
              last_synced_iso: syncResult.status === 'synced' ? new Date().toISOString() : p.ops.last_synced_iso
            }
          };
        });
        
        onUpdateProducts(finalProducts);
        
        const successCount = result.results.filter(r => r.status === 'synced').length;
        const failedEntries = result.results.filter(r => r.status === 'failed');
        const failCount = failedEntries.length;
        const failureSummary = failedEntries.map(entry => `${entry.id}: ${entry.message || 'fehlgeschlagen'}`).join('\n');
        const baseSummary = `Sync abgeschlossen.\n✓ ${successCount} Produkte synchronisiert\n✗ ${failCount} fehlgeschlagen`;
        
        if (failCount > 0) {
          alert(`${baseSummary}\n\nDetails:\n${failureSummary}`);
        } else {
          alert(baseSummary);
        }
      } else {
        // Revert to original state on error
        onUpdateProducts(products);
        alert(`Sync failed: ${result.error?.message || 'Unknown error'}`);
      }
    } catch (error) {
      // Revert to original state on error
      onUpdateProducts(products);
      alert(`Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleBatchPriceRefresh = async () => {
    alert(`Refreshing prices for ${selectedIds.size} products... (mocked)`);
    const updatedProducts = [...products];
    for (const id of selectedIds) {
        const result = await refreshPrice(id);
        if (result.ok && result.data) {
            const productIndex = updatedProducts.findIndex(p => p.id === id);
            if (productIndex > -1) {
                updatedProducts[productIndex].details.pricing = {
                    ...updatedProducts[productIndex].details.pricing,
                    ...result.data
                };
            }
        }
    }
    onUpdateProducts(updatedProducts);
    alert('Price refresh complete.');
  };

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(t('table.actions.deleteConfirm', { count: selectedIds.size } as any))) return;
    const remaining = [...products];
    for (const id of Array.from(selectedIds)) {
      const res = await deleteProduct(id);
      if (res.ok) {
        const idx = remaining.findIndex(p => p.id === id);
        if (idx > -1) remaining.splice(idx, 1);
      } else {
        alert(`Failed to delete ${id}: ${res.error?.message || 'Unknown error'}`);
      }
    }
    setSelectedIds(new Set());
    onUpdateProducts(remaining);
  };

  const handleBatchLabelPrint = () => {
    if (selectedIds.size === 0) return;
    const selectedProducts = filteredAndSortedProducts.filter((p) => selectedIds.has(p.id));
    const missingSku = selectedProducts.filter(
      (p) => !p.identification.sku && !p.details?.identifiers?.sku
    );
    if (missingSku.length > 0) {
      alert(
        `Die folgenden Produkte haben noch keine SKU und können nicht gedruckt werden:\n${missingSku
          .map((p) => `• ${p.identification.name}`)
          .join('\n')}`
      );
      return;
    }
    const orderedIds = selectedProducts.map((p) => p.id);
    const result = openProductLabelBatchWindow(orderedIds);
    if (!result.ok) {
      alert(result.error?.message || 'Konnte Label-Ansicht nicht öffnen.');
    }
  };

  const handleExportCsv = () => {
    const headers = ['ID', 'ProductKey', 'Name', 'Brand', 'Category', 'EAN', 'Price', 'Currency', 'Sync Status'];
    const rows = filteredAndSortedProducts.map((p) => [
      getStableNumericId(p),
      p.id,
      `"${p.identification.name}"`,
      `"${p.identification.brand}"`,
      p.identification.category,
      p.details.identifiers.ean || '', p.details.pricing.lowest_price.amount, p.details.pricing.lowest_price.currency, p.ops.sync_status
    ].join(','));
    const csvContent = `data:text/csv;charset=utf-8,${headers.join(',')}\n${rows.join('\n')}`;
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', 'products.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
    setFilterCategory('all');
  };

  const renderFilterControls = () => (
    <>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <select
            id="table-filter-status"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as SyncStatus | 'all')}
            className="p-2 text-sm bg-slate-700 border border-slate-600 rounded-lg text-slate-100"
          >
            {statusFilters.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            id="table-filter-category"
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="p-2 text-sm bg-slate-700 border border-slate-600 rounded-lg text-slate-100"
          >
            {categories.map((cat) => (
              <option key={cat} value={cat}>
                {cat === 'all' ? t('table.categories.all') : cat}
              </option>
            ))}
          </select>
          <select
            value={columnPreset}
            onChange={(e) => {
              const preset = e.target.value as ColumnPreset;
              setVisibleColumns(COLUMN_PRESETS[preset]);
              setColumnPreset(preset);
            }}
            className="p-2 text-sm bg-slate-700 border border-slate-600 rounded-lg text-slate-100"
          >
            <option value="standard">{t('table.presets.standard')}</option>
            <option value="warehouse">{t('table.presets.warehouse')}</option>
            <option value="pricing">{t('table.presets.pricing')}</option>
            <option value="minimal">{t('table.presets.minimal')}</option>
          </select>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsColumnPanelOpen((prev) => !prev)}
              className="flex-1 rounded-md border border-slate-600 bg-slate-700 px-3 py-2 text-xs font-semibold text-slate-100 hover:border-slate-500"
            >
              {t('table.columns.edit')}
            </button>
            <button
              type="button"
              onClick={resetColumns}
              className="rounded-md border border-slate-600 bg-slate-700 px-3 py-2 text-xs font-semibold text-slate-100 hover:border-slate-500"
            >
              {t('table.columns.reset')}
            </button>
          </div>
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

        <div className="flex flex-wrap gap-1.5 pt-2 border-t border-slate-700/40">
          <ActionButton
            icon={<SyncIcon className="w-4 h-4" />}
            label={t('table.actions.syncSelected')}
            onClick={handleBatchSync}
            disabled={selectedIds.size === 0}
            tone="primary"
          />
          <ActionButton
            icon={<RefreshIcon className="w-4 h-4" />}
            label={t('table.actions.priceRefresh')}
            onClick={handleBatchPriceRefresh}
            disabled={selectedIds.size === 0}
            tone="primary"
          />
          {onImproveSelected && (
            <ActionButton
              icon={<OperationsIcon className="w-4 h-4" />}
              label="Improve"
              onClick={() => onImproveSelected(Array.from(selectedIds))}
              disabled={selectedIds.size === 0}
              tone="accent"
            />
          )}
          <ActionButton
            icon={<ExportIcon className="w-4 h-4" />}
            label={t('table.actions.exportCsv')}
            onClick={handleExportCsv}
          />
          <ActionButton
            icon={<PrintIcon className="w-4 h-4" />}
            label={t('table.actions.printLabel')}
            onClick={handleBatchLabelPrint}
            disabled={selectedIds.size === 0}
          />
          <ActionButton
            icon={<PrintIcon className="w-4 h-4 rotate-180" />}
            label={t('table.columns.reset')}
            onClick={resetColumns}
          />
          <ActionButton
            icon={<SyncIcon className="w-4 h-4 rotate-90" />}
            label={t('table.actions.deleteSelected')}
            onClick={handleBatchDelete}
            disabled={selectedIds.size === 0}
            tone="danger"
          />
        </div>
    </>
  );

  return (
    <section id="admin-table" className="p-6 bg-slate-800 rounded-lg shadow-lg">
      <header className="mb-6">
        <h2 className="text-2xl font-bold text-white">{t('inventory.title')}</h2>
      </header>
      
      <div className="space-y-3 mb-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              id="table-search"
              type="text"
              placeholder={t('table.search')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-slate-700 border border-slate-600 rounded-lg focus:ring-2 focus:ring-sky-500 text-sm"
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
              <span>{`${t('table.actions.label')} & Filter`}</span>
              <span>{mobileFiltersOpen ? '−' : '+'}</span>
            </button>
            {mobileFiltersOpen && <div className="p-3 space-y-3">{renderFilterControls()}</div>}
          </div>
        ) : (
          <div className="space-y-3">{renderFilterControls()}</div>
        )}
      </div>

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
                    selectedIds.size === filteredAndSortedProducts.length &&
                    filteredAndSortedProducts.length > 0
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
            {filteredAndSortedProducts.map(p => (
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
                    {onImproveProduct && (
                      <button
                        type="button"
                        className="px-2 py-1 text-xs bg-sky-600 text-white rounded-md disabled:opacity-60"
                        disabled={Boolean(improvingProductIds?.has(p.id))}
                        onClick={() => onImproveProduct(p.id)}
                      >
                        {improvingProductIds?.has(p.id) ? 'Verbessere…' : 'Improve'}
                      </button>
                    )}
                  <button
                    className="px-2 py-1 text-xs bg-red-600 text-white rounded-md"
                    onClick={async () => {
                      if (!confirm(t('table.actions.deleteOne', { name: p.identification.name } as any))) return;
                      const res = await deleteProduct(p.id);
                      if (res.ok) {
                          onUpdateProducts(products.filter((x) => x.id !== p.id));
                      } else {
                        alert(`Delete failed: ${res.error?.message || 'Unknown error'}`);
                      }
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
    </section>
  );
};

export default AdminTable;
