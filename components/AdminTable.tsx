
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Product, SyncStatus } from '../types';
import { refreshPrice, syncToBaseLinker, deleteProduct, openProductLabelBatchWindow } from '../api/client';
import { RefreshIcon, SyncIcon, ExportIcon, SearchIcon, PrintIcon } from './icons/Icons';
import { normalizeSyncStatus, getStableNumericId } from '../utils/product';

interface AdminTableProps {
  products: Product[];
  onSelectProduct: (productId: string) => void;
  onUpdateProducts: (products: Product[]) => void;
  focusProductId?: string | null;
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

const AdminTable: React.FC<AdminTableProps> = ({ products, onSelectProduct, onUpdateProducts, focusProductId }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<SyncStatus | 'all'>('all');
  const [filterCategory, setFilterCategory] = useState('all');
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>({ key: 'ops.last_saved_iso', direction: 'desc' });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});

  const categories = useMemo(() => ['all', ...new Set(products.map(p => p.identification.category))], [products]);

  const filteredAndSortedProducts = useMemo(() => {
    let filtered = products.filter(p => {
      const normalizedStatus = normalizeSyncStatus(p.ops.sync_status, p.ops.last_synced_iso);
      const matchesSearch =
        p.identification.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        p.identification.brand.toLowerCase().includes(searchTerm.toLowerCase()) ||
        p.id.includes(searchTerm);
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
    if (!confirm(`Delete ${selectedIds.size} selected products? This cannot be undone.`)) return;
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

  const SortableHeader: React.FC<{ sortKey: string; children: React.ReactNode }> = ({ sortKey, children }) => (
    <th
      className="p-3 cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-300 whitespace-nowrap"
      onClick={() => requestSort(sortKey)}
    >
      {children}
      {sortConfig?.key === sortKey && (sortConfig.direction === 'asc' ? ' ▲' : ' ▼')}
    </th>
  );

  return (
    <section id="admin-table" className="p-6 bg-slate-800 rounded-lg shadow-lg">
      <header className="mb-6">
        <h2 className="text-2xl font-bold text-white">Inventar</h2>
        <p className="text-slate-400">Behalte den Überblick über alle Bestände und führe Sammelaktionen aus.</p>
      </header>
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        <div className="relative md:col-span-3">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input id="table-search" type="text" placeholder="Suchen..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="w-full pl-10 p-2 bg-slate-700 border border-slate-600 rounded-lg focus:ring-2 focus:ring-sky-500" />
        </div>
        <select id="table-filter-status" value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)} className="w-full p-2 bg-slate-700 border border-slate-600 rounded-lg">
          <option value="all">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="synced">Synced</option>
          <option value="failed">Failed</option>
        </select>
        <select id="table-filter-category" value={filterCategory} onChange={e => setFilterCategory(e.target.value)} className="w-full p-2 bg-slate-700 border border-slate-600 rounded-lg">
          {categories.map(cat => <option key={cat} value={cat}>{cat === 'all' ? 'All Categories' : cat}</option>)}
        </select>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <button id="table-sync-selected" onClick={handleBatchSync} disabled={selectedIds.size === 0} className="flex items-center justify-center px-3 py-2 text-sm bg-sky-600 text-white rounded-md disabled:bg-slate-600 disabled:cursor-not-allowed w-full sm:w-auto"><SyncIcon className="w-4 h-4 mr-1.5" /> Sync ausgewählte</button>
        <button id="table-price-refresh" onClick={handleBatchPriceRefresh} disabled={selectedIds.size === 0} className="flex items-center justify-center px-3 py-2 text-sm bg-sky-600 text-white rounded-md disabled:bg-slate-600 disabled:cursor-not-allowed w-full sm:w-auto"><RefreshIcon className="w-4 h-4 mr-1.5" /> Price Refresh</button>
        <button id="table-export-csv" onClick={handleExportCsv} className="flex items-center justify-center px-3 py-2 text-sm bg-slate-600 text-white rounded-md w-full sm:w-auto"><ExportIcon className="w-4 h-4 mr-1.5" /> Export CSV</button>
        <button
          id="table-print-labels"
          onClick={handleBatchLabelPrint}
          disabled={selectedIds.size === 0}
          className="flex items-center justify-center px-3 py-2 text-sm bg-emerald-600 text-white rounded-md disabled:bg-slate-600 disabled:cursor-not-allowed w-full sm:w-auto"
        >
          <PrintIcon className="w-4 h-4 mr-1.5" /> Print Label
        </button>
        <button id="table-delete-selected" onClick={handleBatchDelete} disabled={selectedIds.size === 0} className="flex items-center justify-center px-3 py-2 text-sm bg-red-600 text-white rounded-md disabled:bg-slate-600 disabled:cursor-not-allowed w-full sm:w-auto">Delete selected</button>
      </div>

      <div className="overflow-x-auto">
        <table id="grid" className="w-full text-left min-w-[1040px]">
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
              <th className="p-3 w-20 text-xs font-semibold uppercase tracking-wide text-slate-300 whitespace-nowrap">
                Thumbnail
              </th>
              <SortableHeader sortKey="identification.name">Name / Brand</SortableHeader>
              <SortableHeader sortKey="identification.category">Kategorie</SortableHeader>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-slate-300 whitespace-nowrap">
                EAN / GTIN / SKU
              </th>
              <SortableHeader sortKey="details.pricing.lowest_price.amount">Niedrigster Preis</SortableHeader>
              <SortableHeader sortKey="ops.sync_status">Sync-Status</SortableHeader>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-slate-300 whitespace-nowrap">
                Speicherstatus
              </th>
              <SortableHeader sortKey="ops.last_saved_iso">Zuletzt gespeichert</SortableHeader>
              <SortableHeader sortKey="ops.last_synced_iso">Zuletzt synchronisiert</SortableHeader>
              <SortableHeader sortKey="ops.revision">Revision</SortableHeader>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-slate-300 whitespace-nowrap">
                Aktionen
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
                <td className="p-3"><img src={p.details.images[0]?.url_or_base64} alt={p.identification.name} className="w-12 h-12 object-cover rounded-md" /></td>
                <td className="p-3">
                  <a href="#" onClick={(e) => { e.preventDefault(); onSelectProduct(p.id); }} className="font-medium text-sky-400 hover:underline">{p.identification.name}</a>
                  <div className="text-sm text-slate-400">{p.identification.brand}</div>
                </td>
                <td className="p-3 text-slate-300">{p.identification.category}</td>
                <td className="p-3 text-slate-400 font-mono text-sm">{p.details.identifiers.ean || p.details.identifiers.sku || p.id}</td>
                <td className="p-3 text-slate-300">{new Intl.NumberFormat('de-DE', { style: 'currency', currency: p.details.pricing.lowest_price.currency }).format(p.details.pricing.lowest_price.amount)}</td>
                <td className="p-3">
                  <SyncStatusBadge status={normalizeSyncStatus(p.ops.sync_status, p.ops.last_synced_iso)} />
                </td>
                <td className="p-3">
                  <SaveStatusBadge saved={Boolean(p.ops?.last_saved_iso)} />
                </td>
                <td className="p-3 text-slate-400 text-sm">{p.ops.last_saved_iso ? new Date(p.ops.last_saved_iso).toLocaleString('de-DE') : 'N/A'}</td>
                <td className="p-3 text-slate-400 text-sm">{p.ops.last_synced_iso ? new Date(p.ops.last_synced_iso).toLocaleString('de-DE') : 'N/A'}</td>
                <td className="p-3 text-center text-slate-400 text-sm">{p.ops.revision}</td>
                <td className="p-3">
                  <button
                    className="px-2 py-1 text-xs bg-red-600 text-white rounded-md"
                    onClick={async () => {
                      if (!confirm(`Delete product "${p.identification.name}"?`)) return;
                      const res = await deleteProduct(p.id);
                      if (res.ok) {
                        onUpdateProducts(products.filter(x => x.id !== p.id));
                      } else {
                        alert(`Delete failed: ${res.error?.message || 'Unknown error'}`);
                      }
                    }}
                  >
                    Delete
                  </button>
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
