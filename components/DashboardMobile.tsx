import React, { useMemo } from 'react';
import { Product } from '../types';
import { getProductQuantity } from '../utils/product';
import { SyncIcon } from './icons/Icons';

interface DashboardMobileProps {
  products: Product[];
  onRefreshProducts?: () => void;
  isLoading?: boolean;
}

const Card: React.FC<{ label: string; value: string; sub?: string }> = ({ label, value, sub }) => (
  <div className="rounded-2xl bg-slate-800 border border-white/5 p-4 shadow-lg shadow-black/30">
    <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
    <p className="text-2xl font-semibold text-white mt-1">{value}</p>
    {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
  </div>
);

const DashboardMobile: React.FC<DashboardMobileProps> = ({ products, onRefreshProducts, isLoading }) => {
  const summary = useMemo(() => {
    const total = products.length;
    const inStock = products.filter((p) => getProductQuantity(p) > 0).length;
    const qtySum = products.reduce((s, p) => s + getProductQuantity(p), 0);
    const priced = products.filter((p) => (p.details?.pricing?.lowest_price?.amount || 0) > 0);
    const value = priced.reduce(
      (s, p) => s + getProductQuantity(p) * (p.details?.pricing?.lowest_price?.amount || 0),
      0
    );
    const pending = products.filter((p) => (p.ops?.sync_status || 'pending') !== 'synced').length;
    const synced = products.length - pending;
    return { total, inStock, qtySum, value, synced, pending };
  }, [products]);

  const isEmpty = products.length === 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Home</h1>
          <p className="text-slate-400 text-sm">Mobile Dashboard</p>
        </div>
        <button
          type="button"
          onClick={onRefreshProducts}
          disabled={!onRefreshProducts}
          className="inline-flex items-center gap-2 rounded-lg bg-slate-800 px-3 py-2 text-sm text-slate-100 border border-slate-700"
        >
          <SyncIcon className="w-4 h-4" />
          Refresh
        </button>
      </div>

      {isEmpty ? (
        <div className="rounded-2xl border border-white/10 bg-slate-800/70 p-4 text-sm text-slate-300">
          {isLoading ? 'Lädt Produkte …' : 'Keine Produkte geladen. Ziehe zum Aktualisieren oder tippe auf Refresh.'}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Card label="Produkte" value={`${summary.total}`} sub={`${summary.inStock} mit Bestand`} />
          <Card label="Bestandseinheiten" value={`${summary.qtySum}`} sub="aufsummiert" />
          <Card label="Wert" value={`${summary.value.toFixed(2)} €`} sub={`${summary.synced} synced`} />
          <Card label="Sync Status" value={`${summary.pending} pending`} sub={`${summary.synced} ok`} />
        </div>
      )}
    </div>
  );
};

export default DashboardMobile;
