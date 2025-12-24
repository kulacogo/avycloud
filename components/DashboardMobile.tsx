import React, { useEffect, useMemo, useState } from 'react';
import { Order, Product } from '../types';
import { getProductQuantity } from '../utils/product';
import { SyncIcon } from './icons/Icons';
import { fetchOrders as fetchOrdersApi, syncOrders as syncOrdersApi } from '../api/client';

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

const safeCurrency = (code?: string) => {
  const c = (code || '').toString().trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : 'EUR';
};

const formatCurrency = (value: number, currency: string) => {
  const cur = safeCurrency(currency);
  try {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: cur }).format(value);
  } catch {
    return `${value.toFixed(2)} ${cur}`;
  }
};

const DashboardMobile: React.FC<DashboardMobileProps> = ({ products, onRefreshProducts, isLoading }) => {
  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);

  const dedupeOrders = (list: Order[]) => {
    const seen = new Set<string>();
    const result: Order[] = [];
    list.forEach((order) => {
      const key = order.baselinkerId || order.id;
      if (seen.has(key)) return;
      seen.add(key);
      result.push(order);
    });
    return result;
  };

  useEffect(() => {
    let cancelled = false;
    const loadOrders = async () => {
      setOrdersLoading(true);
      try {
        try {
          await syncOrdersApi({ timeoutMs: 20000 });
        } catch (err) {
          console.warn('Order sync failed (dashboard will still fetch)', err);
        }
        const data = await fetchOrdersApi(100, { timeoutMs: 20000 });
        if (!cancelled) setOrders(dedupeOrders(data || []));
      } catch {
        if (!cancelled) setOrders([]);
      } finally {
        if (!cancelled) setOrdersLoading(false);
      }
    };
    loadOrders();
    const interval = setInterval(loadOrders, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const orderStats = useMemo(() => {
    const toRaw = (order: Order) => (order.statusLabel || order.status || '').toLowerCase();
    const categorize = (order: Order) => {
      const raw = toRaw(order);
      if (raw.includes('storniert') || raw.includes('cancel')) return 'cancelled';
      if (raw.includes('zugestellt') || raw.includes('delivered')) return 'zugestellt';
      if (raw.includes('versendet') || raw.includes('shipped') || raw.includes('dispatched')) return 'versendet';
      if (raw.includes('kommission') || raw.includes('picked')) return 'kommissioniert';
      if (raw.includes('neu') || raw.includes('new')) return 'neu';
      return 'other';
    };

    const counts = {
      neu: 0,
      kommissioniert: 0,
      versendet: 0,
      zugestellt: 0,
      cancelled: 0,
      other: 0,
    };

    const valueMap = new Map<string, number>();

    orders.forEach((order) => {
      const cat = categorize(order);
      if (cat === 'cancelled') {
        counts.cancelled += 1;
        return;
      }
      if (cat === 'neu') counts.neu += 1;
      else if (cat === 'kommissioniert') counts.kommissioniert += 1;
      else if (cat === 'versendet') counts.versendet += 1;
      else if (cat === 'zugestellt') counts.zugestellt += 1;
      else counts.other += 1;

      const amount = Number(order.totalAmount) || 0;
      const currency = safeCurrency(order.currency || 'EUR');
      valueMap.set(currency, (valueMap.get(currency) || 0) + amount);
    });

    const revenueEntries = Array.from(valueMap.entries()).map(([currency, amount]) => ({ currency, amount }));
    revenueEntries.sort((a, b) => b.amount - a.amount);
    const revenuePrimary = revenueEntries[0] || { currency: 'EUR', amount: 0 };
    const revenueOthers = revenueEntries.slice(1);

    return { ...counts, revenuePrimary, revenueOthers };
  }, [orders]);

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
        <>
          <div className="grid grid-cols-2 gap-3">
            <Card label="Produkte" value={`${summary.total}`} sub={`${summary.inStock} mit Bestand`} />
            <Card label="Bestandseinheiten" value={`${summary.qtySum}`} sub="aufsummiert" />
            <Card label="Bestandswert" value={`${summary.value.toFixed(2)} €`} sub={`${summary.synced} synced`} />
            <Card label="Sync Status" value={`${summary.pending} pending`} sub={`${summary.synced} ok`} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Card label="Neue Bestellung" value={`${orderStats.neu}`} sub={ordersLoading ? 'lädt…' : 'BaseLinker'} />
            <Card label="Kommissioniert" value={`${orderStats.kommissioniert}`} sub={ordersLoading ? 'lädt…' : 'BaseLinker'} />
            <Card label="Versendet" value={`${orderStats.versendet}`} sub={ordersLoading ? 'lädt…' : 'BaseLinker'} />
            <Card label="Zugestellt" value={`${orderStats.zugestellt}`} sub={ordersLoading ? 'lädt…' : 'BaseLinker'} />
          </div>
          <div className="grid grid-cols-1 gap-3">
            <Card
              label="Gesamtumsatz (ohne Storniert)"
              value={formatCurrency(orderStats.revenuePrimary.amount, orderStats.revenuePrimary.currency)}
              sub={
                orderStats.revenueOthers.length
                  ? `Weitere: ${orderStats.revenueOthers.map((r) => formatCurrency(r.amount, r.currency)).join(', ')}`
                  : undefined
              }
            />
          </div>
        </>
      )}
    </div>
  );
};

export default DashboardMobile;
