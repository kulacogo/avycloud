import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Order, Product } from '../types';
import { getProductQuantity } from '../utils/product';
import { SyncIcon } from './icons/Icons';
import { fetchOrders as fetchOrdersApi, syncOrders as syncOrdersApi } from '../api/client';
import { useI18n } from '../i18n';
import { compareBinCodesForPickRoute } from '../utils/warehouseRoute';

interface DashboardMobileProps {
  products: Product[];
  onRefreshProducts?: () => void;
  onNavigate?: (view: string) => void;
  isLoading?: boolean;
}

const StatCard: React.FC<{ label: string; value: string; sub?: string }> = ({ label, value, sub }) => (
  <div className="rounded-2xl bg-slate-800 border border-white/5 p-4 shadow-lg shadow-black/30">
    <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
    <p className="text-2xl font-semibold text-white mt-1">{value}</p>
    {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
  </div>
);

const ActionCard: React.FC<{
  label: string;
  value: string;
  sub?: string;
  onClick?: () => void;
  tone?: 'primary' | 'success' | 'warn' | 'neutral';
  disabled?: boolean;
}> = ({ label, value, sub, onClick, tone = 'neutral', disabled }) => {
  const toneClass =
    tone === 'primary'
      ? 'bg-sky-600 text-white'
      : tone === 'success'
        ? 'bg-emerald-600 text-white'
        : tone === 'warn'
          ? 'bg-amber-600 text-white'
          : 'bg-slate-800 text-white border border-white/5';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || !onClick}
      className={`w-full rounded-2xl p-4 text-left shadow-lg shadow-black/30 transition active:scale-[0.99] disabled:opacity-40 ${toneClass}`}
    >
      <p className="text-xs uppercase tracking-wide opacity-90">{label}</p>
      <p className="text-2xl font-semibold mt-1">{value}</p>
      {sub && <p className="text-xs opacity-90 mt-1">{sub}</p>}
    </button>
  );
};

const safeCurrency = (code?: string) => {
  const c = (code || '').toString().trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : 'EUR';
};

const DashboardMobile: React.FC<DashboardMobileProps> = ({ products, onRefreshProducts, onNavigate, isLoading }) => {
  const { t, locale } = useI18n();
  const [orders, setOrders] = useState<Order[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const dedupeOrders = useCallback((list: Order[]) => {
    const seen = new Set<string>();
    const result: Order[] = [];
    list.forEach((order) => {
      const key = order.baselinkerId || order.id;
      if (seen.has(key)) return;
      seen.add(key);
      result.push(order);
    });
    return result;
  }, []);

  const intlLocale = locale === 'de' ? 'de-DE' : locale === 'tr' ? 'tr-TR' : 'en-GB';

  const formatCurrency = useCallback(
    (value: number, currency: string) => {
      const cur = safeCurrency(currency);
      try {
        return new Intl.NumberFormat(intlLocale, { style: 'currency', currency: cur }).format(value);
      } catch {
        return `${value.toFixed(2)} ${cur}`;
      }
    },
    [intlLocale]
  );

  const loadOrders = useCallback(
    async ({ sync }: { sync: boolean }) => {
      try {
        if (sync) {
          try {
            await syncOrdersApi({ timeoutMs: 20000 });
          } catch (err) {
            console.warn('Order sync failed (dashboard will still fetch)', err);
          }
        }
        const data = await fetchOrdersApi(100, { timeoutMs: 20000 });
        setOrders(dedupeOrders(data || []));
      } catch {
        setOrders([]);
      }
    },
    [dedupeOrders]
  );

  useEffect(() => {
    let cancelled = false;
    const initial = async () => {
      if (cancelled) return;
      await loadOrders({ sync: true });
    };
    void initial();
    const interval = setInterval(() => {
      if (cancelled) return;
      void loadOrders({ sync: false });
    }, 60000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [loadOrders]);

  const handleRefresh = useCallback(async () => {
    if (!onRefreshProducts) return;
    setRefreshing(true);
    try {
      await Promise.all([Promise.resolve(onRefreshProducts()), loadOrders({ sync: true })]);
    } finally {
      setRefreshing(false);
    }
  }, [loadOrders, onRefreshProducts]);

  const navigateTo = useCallback(
    (view: string) => {
      if (onNavigate) {
        onNavigate(view);
        return;
      }
      // Fallback for older callers
      const map: Record<string, string> = {
        home: '#/home',
        search: '#/search',
        operations: '#/operations',
        'operations-identify': '#/operations/identify',
        'operations-stow': '#/operations/stow',
        'operations-pick': '#/operations/pick',
        'operations-pack': '#/operations/pack',
      };
      const hash = map[view] || `#/${view}`;
      window.location.hash = hash;
    },
    [onNavigate]
  );

  const openOrders = useMemo(() => orders.filter((o) => o.status === 'new'), [orders]);

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

  const stowBacklog = useMemo(
    () => products.filter((p) => getProductQuantity(p) > 0 && !p.storage?.binCode).length,
    [products]
  );

  const nextPick = useMemo(() => {
    const tasks: Array<{ binCode: string; sku: string; name: string; remaining: number }> = [];
    const normalizeScan = (val?: string | null) => (val || '').replace(/\s+/g, '').toUpperCase();
    const normalizeSkuScan = (val?: string | null) => normalizeScan(val).replace(/^SKU[-_\s]*/i, '');

    const resolveProductForItem = (item: any) => {
      if (item?.productId) {
        const byId = products.find((p) => p.id === item.productId) || null;
        if (byId) return byId;
      }
      const keys = [item?.sku, item?.ean].filter(Boolean).map((v) => normalizeSkuScan(String(v)));
      if (!keys.length) return null;
      return (
        products.find((p) => {
          const candidateValues = [
            p.identification?.sku,
            p.details?.identifiers?.sku,
            p.details?.identifiers?.ean,
            p.details?.identifiers?.gtin,
            p.details?.identifiers?.upc,
            p.id,
            ...(p.identification?.barcodes || []),
          ]
            .filter(Boolean)
            .map((val) => normalizeSkuScan(String(val)));
          return candidateValues.some((candidate) => keys.includes(candidate));
        }) || null
      );
    };

    const chooseBestBin = (product: Product | null) => {
      if (!product) return null;
      const bins = Array.isArray(product.storageBins) ? product.storageBins : [];
      const positive = bins
        .filter((b) => b && b.code && Number(b.quantity || 0) > 0)
        .map((b) => ({ code: String(b.code).toUpperCase(), quantity: Number(b.quantity || 0) || 0 }))
        .filter((b) => b.quantity > 0);
      if (positive.length) {
        positive.sort((a, b) => (b.quantity - a.quantity) || compareBinCodesForPickRoute(a.code, b.code));
        return positive[0];
      }
      if (product.storage?.binCode) {
        return { code: String(product.storage.binCode).toUpperCase(), quantity: Number(product.storage.quantity || 0) || 0 };
      }
      return null;
    };

    openOrders.forEach((order) => {
      order.items.forEach((it) => {
        if (it.pickCompleted) return;
        const remaining = Number(it.quantity || 0) || 0;
        if (!remaining) return;
        const hint = it.pickHint as any;
        const product = resolveProductForItem(it);
        const skuCandidate =
          normalizeScan(it.sku) ||
          normalizeScan(hint?.sku) ||
          normalizeScan(it.ean) ||
          normalizeScan(product?.details?.identifiers?.sku) ||
          normalizeScan(product?.identification?.sku) ||
          normalizeScan(product?.details?.identifiers?.ean) ||
          normalizeScan(product?.details?.identifiers?.gtin) ||
          normalizeScan(product?.id) ||
          it.id;
        const bestBin = chooseBestBin(product) || (hint?.binCode ? { code: String(hint.binCode).toUpperCase(), quantity: 0 } : null);
        tasks.push({
          binCode: bestBin?.code || '',
          sku: skuCandidate,
          name: hint?.productName || product?.identification?.name || it.name,
          remaining,
        });
      });
    });
    tasks.sort((a, b) => compareBinCodesForPickRoute(a.binCode, b.binCode));
    return tasks[0] || null;
  }, [openOrders, products]);

  const isEmpty = products.length === 0;

  return (
    <div className="space-y-4 max-w-xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">{t('nav.home')}</h1>
          <p className="text-slate-400 text-sm">{t('mobile.dashboard.subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={!onRefreshProducts || refreshing}
          className="inline-flex items-center gap-2 rounded-lg bg-slate-800 px-3 py-2 text-sm text-slate-100 border border-slate-700"
        >
          <SyncIcon className="w-4 h-4" />
          {refreshing ? t('mobile.dashboard.refreshing') : t('actions.refresh')}
        </button>
      </div>

      {isEmpty ? (
        <div className="rounded-2xl border border-white/10 bg-slate-800/70 p-4 text-sm text-slate-300">
          {isLoading ? t('status.loading.products') : t('mobile.dashboard.empty')}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <ActionCard
              tone="warn"
              label={t('ops.mode.pick')}
              value={`${openOrders.length}`}
              sub={
                openOrders.length === 0
                  ? t('ops.orders.none')
                  : nextPick
                    ? `${t('ops.labels.nextPick')}: ${nextPick.binCode || '—'} · ${nextPick.sku} · ${t('ops.labels.openRemaining', {
                        count: nextPick.remaining,
                      })}`
                    : t('ops.orders.open')
              }
              onClick={() => navigateTo('operations-pick')}
            />
            <ActionCard
              tone="success"
              label={t('ops.mode.stow')}
              value={`${stowBacklog}`}
              sub={t('table.binFilter.withoutBin')}
              onClick={() => navigateTo('operations-stow')}
            />
            <ActionCard
              label={t('nav.search')}
              value={t('common.open')}
              sub={t('mobile.dashboard.searchHint')}
              onClick={() => navigateTo('search')}
            />
            <ActionCard
              label={t('ops.mode.identify')}
              value={t('common.open')}
              sub={t('mobile.dashboard.identifyHint')}
              onClick={() => navigateTo('operations-identify')}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <StatCard
              label={t('mobile.dashboard.kpi.products')}
              value={`${summary.total}`}
              sub={t('mobile.dashboard.kpi.productsSub', { count: summary.inStock })}
            />
            <StatCard
              label={t('mobile.dashboard.kpi.units')}
              value={`${summary.qtySum}`}
              sub={t('mobile.dashboard.kpi.unitsSub')}
            />
            <StatCard
              label={t('mobile.dashboard.kpi.sync')}
              value={`${summary.pending}`}
              sub={t('mobile.dashboard.kpi.syncSub', { count: summary.synced })}
            />
            <StatCard
              label={t('mobile.dashboard.kpi.value')}
              value={formatCurrency(summary.value, 'EUR')}
              sub={t('mobile.dashboard.kpi.valueSub', { count: summary.synced })}
            />
          </div>
        </>
      )}
    </div>
  );
};

export default DashboardMobile;
