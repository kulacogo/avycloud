import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DashboardMetrics, Order, Product } from '../../types';
import { getProductAvailableQuantity, getProductPhysicalQuantity } from '../../utils/product';
import { fetchDashboardMetrics, fetchOrders as fetchOrdersApi, syncOrders as syncOrdersApi } from '../../api/client';
import { useI18n } from '../../i18n';
import { compareBinCodesForPickRoute } from '../../utils/warehouseRoute';

interface DashboardMobileProps {
  products: Product[];
  onRefreshProducts?: () => void;
  onNavigate?: (view: string) => void;
  isLoading?: boolean;
  rangePreset?: string;
  onRangePresetChange?: (preset: string) => void;
}

/* -------------------------------------------------------
   StatCard - v2.1 design system (surface bg, border, rounded-xl)
   ------------------------------------------------------- */
const StatCard: React.FC<{ label: string; value: string; sub?: string }> = ({ label, value, sub }) => (
  <div className="rounded-xl bg-[var(--surface)] border border-[var(--border)] p-4 hover:border-[var(--border-hover)] transition-colors duration-200 shadow-[var(--shadow-sm)]">
    <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{label}</p>
    <p className="text-2xl font-bold text-[var(--text-primary)] mt-1">{value}</p>
    {sub && <p className="text-xs text-[var(--text-tertiary)] mt-1">{sub}</p>}
  </div>
);

/* -------------------------------------------------------
   ActionCard - v2.1 toned action buttons
   ------------------------------------------------------- */
const ActionCard: React.FC<{
  label: string;
  value: string;
  sub?: string;
  onClick?: () => void;
  tone?: 'primary' | 'success' | 'warn' | 'neutral';
  disabled?: boolean;
}> = ({ label, value, sub, onClick, tone = 'neutral', disabled }) => {
  const toneClasses: Record<string, string> = {
    primary: 'bg-[var(--avy-purple)] text-white border border-[var(--avy-purple)]',
    success: 'bg-[var(--success)] text-white border border-[var(--success)]',
    warn: 'bg-[var(--warning)] text-white border border-[var(--warning)]',
    neutral: 'bg-[var(--surface)] text-[var(--text-primary)] border border-[var(--border)]',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || !onClick}
      className={`w-full rounded-xl p-4 text-left shadow-[var(--shadow-sm)] transition-all duration-150 active:scale-[0.99] disabled:opacity-40 ${toneClasses[tone] || toneClasses.neutral}`}
    >
      <p className="text-xs font-semibold uppercase tracking-wide opacity-90">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
      {sub && <p className="text-xs opacity-80 mt-1">{sub}</p>}
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

  const [selectedBarIdx, setSelectedBarIdx] = useState<number | null>(null);
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
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-[var(--text-primary)]">{t('mobile.dashboard.title')}</h1>
          <p className="text-xs text-[var(--text-tertiary)]">
            {lastUpdatedAt ? t('mobile.dashboard.lastUpdated', { value: lastUpdatedAt.toLocaleString(intlLocale) }) : '\u2014'}
          </p>
        </div>
      </div>

      {/* Empty state */}
      {isEmpty && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm text-[var(--text-secondary)]">
          {isLoading ? t('status.loading.products') : t('mobile.dashboard.empty')}
        </div>
      )}

      {/* Quick Action Cards - Pick & Stow */}
      <div className="grid grid-cols-2 gap-3">
        <ActionCard
          tone="warn"
          label={t('ops.mode.pick')}
          value={`${openOrders.length}`}
          sub={
            openOrders.length === 0
              ? t('ops.orders.none')
              : nextPick
                ? `${t('ops.labels.nextPick')}: ${nextPick.binCode || '\u2014'} \u00B7 ${nextPick.sku} \u00B7 ${t('ops.labels.openRemaining', {
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

      {/* Quick Action Cards - Search & Identify */}
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => navigateTo('search')}
          className="w-full rounded-xl bg-[var(--surface)] border border-[var(--border)] p-4 text-left shadow-[var(--shadow-sm)] transition-all duration-150 active:scale-[0.99] hover:border-[var(--border-hover)]"
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('nav.search')}</p>
          <p className="text-2xl font-bold text-[var(--text-primary)] mt-1">{t('mobile.dashboard.action.search')}</p>
          <p className="text-xs text-[var(--text-tertiary)] mt-1">{t('mobile.dashboard.action.searchSub')}</p>
        </button>
        <button
          type="button"
          onClick={() => navigateTo('operations-identify')}
          className="w-full rounded-xl bg-[var(--avy-purple)] text-white p-4 text-left shadow-[var(--shadow-sm)] transition-all duration-150 active:scale-[0.99]"
        >
          <p className="text-xs font-semibold uppercase tracking-wide opacity-90">{t('ops.mode.identify')}</p>
          <p className="text-2xl font-bold mt-1">{t('mobile.dashboard.action.identify')}</p>
        </button>
      </div>

      {/* KPI Stat Cards (2-column grid) */}
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

      {/* Orders & Revenue collapsible section */}
      <details className="rounded-xl bg-[var(--surface)] border border-[var(--border)] p-4 group">
        <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
          {t('mobile.dashboard.section.ordersRevenue')}
        </summary>
        <div className="mt-3 space-y-3">
          {/* Timestamp + Range selector */}
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-[var(--text-tertiary)]">
              {metrics?.generated_at_iso
                ? new Date(metrics.generated_at_iso).toLocaleString(intlLocale)
                : metricsLoading
                  ? t('common.loading')
                  : '\u2014'}
            </p>
            <select
              value={activePreset}
              onChange={(e) => setPreset(e.target.value)}
              className="text-[11px] rounded-lg bg-[var(--surface-secondary)] border border-[var(--border)] px-2 py-1 text-[var(--text-secondary)] focus:outline-none focus:border-[var(--avy-purple)]"
              aria-label="Dashboard Zeitraum"
            >
              {DASHBOARD_RANGE_PRESETS.map((p) => (
                <option key={p.id} value={p.id} className="bg-[var(--surface)]">
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {/* Metrics stat cards */}
          <div className="grid grid-cols-2 gap-3">
            <StatCard
              label={t('mobile.dashboard.metrics.revenueTotal')}
              value={
                metrics ? formatCurrency(metrics.revenue.all_non_cancelled_total || 0, metrics.currency || 'EUR') : '\u2014'
              }
              sub={
                metrics
                  ? (() => {
                      const windowLabel = `${activeRangeLabel}: ${formatCurrency(metrics.revenue.window_non_cancelled_total || 0, metrics.currency || 'EUR')}`;
                      const ebayNet = typeof metrics.revenue.ebay_net_window === 'number'
                        ? ` · eBay Netto: ${formatCurrency(metrics.revenue.ebay_net_window, metrics.currency || 'EUR')}`
                        : '';
                      return windowLabel + ebayNet;
                    })()
                  : undefined
              }
            />
            <StatCard
              label={t('mobile.dashboard.metrics.ordersCompleted')}
              value={metrics ? `${metrics.orders.completed_total}` : '\u2014'}
              sub={metrics ? `${t('mobile.dashboard.metrics.month')}: ${metrics.orders.completed_month}` : undefined}
            />
            <StatCard
              label={t('mobile.dashboard.metrics.returns')}
              value={metrics ? `${metrics.orders.returns_total}` : '\u2014'}
              sub={metrics ? `${t('mobile.dashboard.metrics.month')}: ${metrics.orders.returns_month}` : undefined}
            />
            <StatCard
              label={t('mobile.dashboard.metrics.openCurrent')}
              value={metrics ? `${metrics.orders.open_current}` : '\u2014'}
              sub={t('mobile.dashboard.metrics.openCurrentSub')}
            />
          </div>

          {/* Volume chart — touch-interactive */}
          <div className="rounded-lg bg-[var(--surface-secondary)] border border-[var(--border)] p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('mobile.dashboard.chart.title')}</p>
              <p className="text-[11px] text-[var(--text-tertiary)]">
                {volume7d.length
                  ? t('mobile.dashboard.chart.ordersCount', {
                      count: volume7d.reduce((s, d) => s + (Number(d.orders || 0) || 0), 0),
                    })
                  : '\u2014'}
              </p>
            </div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] text-[var(--text-tertiary)]">{activeRangeLabel}</p>
            </div>

            {/* Selected bar tooltip */}
            {selectedBarIdx !== null && volume7d[selectedBarIdx] && (() => {
              const d = volume7d[selectedBarIdx];
              const count = Number(d.orders || 0) || 0;
              const revenue = Number(d.revenue || 0) || 0;
              return (
                <div className="mb-2 flex items-center justify-between rounded-md bg-[var(--avy-deep)] text-white px-3 py-2 text-[11px] font-semibold">
                  <span>{d.date}</span>
                  <span>{count} {t('mobile.dashboard.chart.title')} · {formatCurrency(revenue, metrics?.currency || 'EUR')}</span>
                </div>
              );
            })()}

            <div>
              <div
                className="grid items-end"
                style={{
                  gridTemplateColumns: `repeat(${Math.max(1, volume7d.length)}, minmax(0, 1fr))`,
                  gap: volume7d.length > 14 ? '2px' : '6px',
                  height: `${Math.min(140, Math.max(80, volume7d.length <= 7 ? 120 : 100))}px`,
                }}
              >
                {volume7d.length ? (
                  volume7d.map((d, idx) => {
                    const count = Number(d.orders || 0) || 0;
                    const maxH = volume7d.length <= 7 ? 96 : 76;
                    const barPx = Math.max(4, Math.round((count / maxVolume) * maxH));
                    const isSelected = selectedBarIdx === idx;
                    return (
                      <div
                        key={d.date}
                        className="h-full flex flex-col items-center justify-end gap-0.5 cursor-pointer"
                        onClick={() => setSelectedBarIdx(isSelected ? null : idx)}
                        onTouchEnd={(e) => { e.preventDefault(); setSelectedBarIdx(isSelected ? null : idx); }}
                      >
                        <div
                          className="w-full rounded-sm transition-all duration-200"
                          style={{
                            height: `${barPx}px`,
                            background: isSelected ? 'var(--avy-purple)' : 'var(--avy-gradient)',
                            opacity: selectedBarIdx !== null && !isSelected ? 0.4 : 1,
                          }}
                        />
                        <div className={`text-[10px] font-semibold tabular-nums truncate w-full text-center ${isSelected ? 'text-[var(--avy-purple)]' : 'text-[var(--text-secondary)]'}`}>
                          {count}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="text-sm text-[var(--text-tertiary)]">{t('mobile.dashboard.chart.noData')}</div>
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
