import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DashboardMetrics, Order, Product } from '../types';
import { getProductAvailableQuantity, getProductPhysicalQuantity } from '../utils/product';
import { fetchDashboardMetrics, fetchOrders as fetchOrdersApi, syncOrders as syncOrdersApi } from '../api/client';
import { useI18n } from '../i18n';
import { compareBinCodesForPickRoute } from '../utils/warehouseRoute';

interface DashboardMobileProps {
  products: Product[];
  onRefreshProducts?: () => void;
  onNavigate?: (view: string) => void;
  isLoading?: boolean;
  rangePreset?: string;
  onRangePresetChange?: (preset: string) => void;
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

const DASHBOARD_RANGE_PRESETS: Array<{ id: string; label: string }> = [
  { id: 'last7', label: 'Letzte 7 Tage' },
  { id: 'month_to_date', label: 'Aktueller Monat' },
  { id: 'last_month', label: 'Letzter Monat' },
  { id: 'year_to_date', label: 'Dieses Jahr' },
  { id: 'last_year', label: 'Letztes Jahr' },
  { id: 'today', label: 'Heute' },
];

const DashboardMobile: React.FC<DashboardMobileProps> = ({
  products,
  onRefreshProducts,
  onNavigate,
  isLoading,
  rangePreset,
  onRangePresetChange,
}) => {
  const { t, locale } = useI18n();
  const [orders, setOrders] = useState<Order[]>([]);
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const refreshInFlightRef = useRef(false);
  const unmountedRef = useRef(false);
  const activePresetRef = useRef('last7');

  const dedupeOrders = useCallback((list: Order[]) => {
    const seen = new Set<string>();
    const result: Order[] = [];
    const getOrderCouplingKey = (order: Order) => {
      const src = (order.orderSource || '-').toString().trim() || '-';
      const srcId = (order.orderSourceId || '-').toString().trim() || '-';
      const orderId = (order.baselinkerId || order.id || '').toString().trim();
      return order.baselinkerOrderKey || `${orderId}::${src}::${srcId}`;
    };
    list.forEach((order) => {
      const key = getOrderCouplingKey(order);
      if (seen.has(key)) return;
      seen.add(key);
      result.push(order);
    });
    return result;
  }, []);

  const intlLocale = locale === 'de' ? 'de-DE' : locale === 'tr' ? 'tr-TR' : 'en-GB';

  const [internalPreset, setInternalPreset] = useState('last7');
  const activePreset = useMemo(() => {
    const raw = typeof rangePreset === 'string' ? rangePreset.trim() : '';
    if (raw && DASHBOARD_RANGE_PRESETS.some((p) => p.id === raw)) return raw;
    return internalPreset;
  }, [rangePreset, internalPreset]);
  const lastMetricsPresetRef = useRef(activePreset);

  useEffect(() => {
    activePresetRef.current = activePreset;
  }, [activePreset]);

  const loadMetrics = useCallback(async (presetOverride?: string) => {
    setMetricsLoading(true);
    try {
      const preset =
        presetOverride != null && String(presetOverride).trim()
          ? String(presetOverride).trim()
          : activePresetRef.current;
      lastMetricsPresetRef.current = preset;
      const longRange = preset === 'year_to_date' || preset === 'last_year';
      const data = await fetchDashboardMetrics({ days: 7, preset }, { timeoutMs: longRange ? 60000 : 20000 });
      setMetrics(data);
    } catch (error) {
      console.warn('Failed to load dashboard metrics', error);
      setMetrics(null);
    } finally {
      setMetricsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!activePreset) return;
    if (lastMetricsPresetRef.current === activePreset) return;
    void loadMetrics(activePreset);
  }, [activePreset, loadMetrics]);

  const setPreset = useCallback(
    (next: string) => {
      const v = String(next || '').trim();
      if (!v) return;
      activePresetRef.current = v;
      if (onRangePresetChange) {
        onRangePresetChange(v);
      } else {
        setInternalPreset(v);
      }
      void loadMetrics(v);
    },
    [onRangePresetChange, loadMetrics]
  );

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

  const refreshAll = useCallback(
    async ({ syncOrders, refreshProducts }: { syncOrders: boolean; refreshProducts: boolean }) => {
      if (refreshInFlightRef.current) return;
      refreshInFlightRef.current = true;
      try {
        await Promise.all([
          refreshProducts && onRefreshProducts ? Promise.resolve(onRefreshProducts()) : Promise.resolve(),
          loadOrders({ sync: syncOrders }),
          loadMetrics(),
        ]);
        if (!unmountedRef.current) setLastUpdatedAt(new Date());
      } finally {
        refreshInFlightRef.current = false;
      }
    },
    [loadMetrics, loadOrders, onRefreshProducts]
  );

  useEffect(() => {
    unmountedRef.current = false;
    let cancelled = false;
    void refreshAll({ syncOrders: true, refreshProducts: false });
    const interval = setInterval(() => {
      if (cancelled) return;
      void refreshAll({ syncOrders: false, refreshProducts: false });
    }, activePreset === 'year_to_date' || activePreset === 'last_year' ? 5 * 60 * 1000 : 60000);
    return () => {
      cancelled = true;
      unmountedRef.current = true;
      clearInterval(interval);
    };
  }, [refreshAll, activePreset]);

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

  const openOrders = useMemo(() => orders.filter((o) => o && o.status === 'new'), [orders]);

  const volume7d = metrics?.volume_7d?.days || [];
  const activeRangeLabel =
    metrics?.range?.label ||
    DASHBOARD_RANGE_PRESETS.find((p) => p.id === activePreset)?.label ||
    `Letzte ${metrics?.revenue?.window_days || 7} Tage`;
  const maxVolume = useMemo(() => {
    const max = volume7d.reduce((m, d) => Math.max(m, Number(d?.orders || 0) || 0), 0);
    return Math.max(1, max);
  }, [volume7d]);

  const summary = useMemo(() => {
    const total = products.length;
    const inStock = products.filter((p) => getProductAvailableQuantity(p) > 0).length;
    const qtySum = products.reduce((s, p) => s + getProductAvailableQuantity(p), 0);
    const priced = products.filter((p) => (p.details?.pricing?.lowest_price?.amount || 0) > 0);
    const value = priced.reduce(
      (s, p) => s + getProductAvailableQuantity(p) * (p.details?.pricing?.lowest_price?.amount || 0),
      0
    );
    const pending = products.filter((p) => (p.ops?.sync_status || 'pending') !== 'synced').length;
    const synced = products.length - pending;
    const physical = products.reduce((s, p) => s + getProductPhysicalQuantity(p), 0);
    return { total, inStock, qtySum, value, synced, pending, physical };
  }, [products]);

  const stowBacklog = useMemo(
    () => products.filter((p) => getProductPhysicalQuantity(p) > 0 && !p.storage?.binCode).length,
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
      const items = Array.isArray((order as any)?.items) ? (order as any).items : [];
      items.forEach((it: any) => {
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
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-white">{t('mobile.dashboard.title')}</h1>
          <p className="text-xs text-slate-500">
            {lastUpdatedAt ? t('mobile.dashboard.lastUpdated', { value: lastUpdatedAt.toLocaleString(intlLocale) }) : '—'}
          </p>
        </div>
      </div>

      {isEmpty && (
        <div className="rounded-2xl border border-white/10 bg-slate-800/70 p-4 text-sm text-slate-300">
          {isLoading ? t('status.loading.products') : t('mobile.dashboard.empty')}
        </div>
      )}

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
      </div>

      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => navigateTo('search')}
          className="w-full rounded-2xl bg-slate-800 border border-white/5 p-4 text-left shadow-lg shadow-black/30 transition active:scale-[0.99]"
        >
          <p className="text-xs uppercase tracking-wide text-slate-400">{t('nav.search')}</p>
          <p className="text-2xl font-semibold text-white mt-1">{t('mobile.dashboard.action.search')}</p>
          <p className="text-xs text-slate-400 mt-1">{t('mobile.dashboard.action.searchSub')}</p>
        </button>
        <button
          type="button"
          onClick={() => navigateTo('operations-identify')}
          className="w-full rounded-2xl bg-sky-600 text-white p-4 text-left shadow-lg shadow-black/30 transition active:scale-[0.99]"
        >
          <p className="text-xs uppercase tracking-wide opacity-90">{t('ops.mode.identify')}</p>
          <p className="text-2xl font-semibold mt-1">{t('mobile.dashboard.action.identify')}</p>
        </button>
      </div>

      {!isEmpty && (
        <div className="grid grid-cols-2 gap-3">
          <StatCard
            label="Inventar (mit Bestand)"
            value={`${summary.inStock}`}
            sub={`${summary.total} Produkte gesamt`}
          />
          <StatCard
            label={t('mobile.dashboard.kpi.units')}
            value={`${summary.qtySum}`}
            sub={t('mobile.dashboard.kpi.unitsSub')}
          />
          <StatCard
            label={t('mobile.dashboard.kpi.value')}
            value={formatCurrency(summary.value, 'EUR')}
            sub={t('mobile.dashboard.kpi.valueSub', { count: summary.synced })}
          />
        </div>
      )}

      <details className="rounded-2xl bg-slate-900/40 border border-white/5 p-4">
        <summary className="cursor-pointer select-none text-xs uppercase tracking-wide text-slate-400">
          {t('mobile.dashboard.section.ordersRevenue')}
        </summary>
        <div className="mt-3 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-slate-500">
              {metrics?.generated_at_iso
                ? new Date(metrics.generated_at_iso).toLocaleString(intlLocale)
                : metricsLoading
                  ? t('common.loading')
                  : '—'}
            </p>
            <select
              value={activePreset}
              onChange={(e) => setPreset(e.target.value)}
              className="text-[11px] rounded-lg bg-slate-800/90 border border-white/10 px-2 py-1 text-slate-200"
              aria-label="Dashboard Zeitraum"
            >
              {DASHBOARD_RANGE_PRESETS.map((p) => (
                <option key={p.id} value={p.id} className="bg-slate-900">
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <StatCard
              label={t('mobile.dashboard.metrics.revenueTotal')}
              value={
                metrics ? formatCurrency(metrics.revenue.all_non_cancelled_total || 0, metrics.currency || 'EUR') : '—'
              }
              sub={
                metrics
                  ? `${activeRangeLabel}: ${formatCurrency(metrics.revenue.window_non_cancelled_total || 0, metrics.currency || 'EUR')}`
                  : undefined
              }
            />
            <StatCard
              label={t('mobile.dashboard.metrics.ordersCompleted')}
              value={metrics ? `${metrics.orders.completed_total}` : '—'}
              sub={metrics ? `${t('mobile.dashboard.metrics.month')}: ${metrics.orders.completed_month}` : undefined}
            />
            <StatCard
              label={t('mobile.dashboard.metrics.returns')}
              value={metrics ? `${metrics.orders.returns_total}` : '—'}
              sub={metrics ? `${t('mobile.dashboard.metrics.month')}: ${metrics.orders.returns_month}` : undefined}
            />
            <StatCard
              label={t('mobile.dashboard.metrics.openCurrent')}
              value={metrics ? `${metrics.orders.open_current}` : '—'}
              sub={t('mobile.dashboard.metrics.openCurrentSub')}
            />
          </div>

          <div className="rounded bg-slate-800/70 border border-white/5 p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs uppercase tracking-wide text-slate-400">{t('mobile.dashboard.chart.title')}</p>
              <p className="text-[11px] text-slate-500">
                {volume7d.length
                  ? t('mobile.dashboard.chart.ordersCount', {
                      count: volume7d.reduce((s, d) => s + (Number(d.orders || 0) || 0), 0),
                    })
                  : '—'}
              </p>
            </div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] text-slate-500">{activeRangeLabel}</p>
            </div>
            <div>
              <div
                className="grid gap-2 items-end h-20"
                style={{
                  gridTemplateColumns: `repeat(${Math.max(1, volume7d.length)}, minmax(0, 1fr))`,
                }}
              >
                {volume7d.length ? (
                  volume7d.map((d) => {
                    const count = Number(d.orders || 0) || 0;
                    const revenue = Number(d.revenue || 0) || 0;
                    const barPx = Math.max(6, Math.round((count / maxVolume) * 56));
                    return (
                      <div key={d.date} className="h-full flex flex-col items-center justify-end gap-1">
                        <div
                          title={t('mobile.dashboard.chart.barTitle', {
                            date: d.date,
                            orders: count,
                            revenue: formatCurrency(revenue, metrics?.currency || 'EUR'),
                          })}
                          className="w-full rounded-[2px] bg-sky-500/70"
                          style={{ height: `${barPx}px`, borderRadius: '2px' }}
                        />
                        <div className="text-[11px] text-slate-300 font-semibold tabular-nums">{count}</div>
                      </div>
                    );
                  })
                ) : (
                  <div className="text-sm text-slate-400">{t('mobile.dashboard.chart.noData')}</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </details>
    </div>
  );
};

export default DashboardMobile;
