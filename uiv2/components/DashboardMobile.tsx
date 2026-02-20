import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DashboardMetrics, Order, Product } from '../types';
import { getProductAvailableQuantity, getProductPhysicalQuantity } from '../utils/product';
import { fetchDashboardMetrics, fetchOrders as fetchOrdersApi, syncOrders as syncOrdersApi } from '../api/client';
import { useI18n } from '../i18n';
import { compareBinCodesForPickRoute } from '../utils/warehouseRoute';
import {
  Package,
  ShoppingBag,
  Truck,
  RefreshCw,
  Camera,
  CheckSquare,
  Search,
  Bell,
  Sun,
  Moon,
  Home,
  MoreVertical,
  AlertCircle,
  DollarSign,
  ChevronRight,
} from 'lucide-react';

interface DashboardMobileProps {
  products: Product[];
  onRefreshProducts?: () => void;
  onNavigate?: (view: string) => void;
  isLoading?: boolean;
  rangePreset?: string;
  onRangePresetChange?: (preset: string) => void;
}

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
      const data = await fetchDashboardMetrics({ days: 7, preset }, { timeoutMs: 20000 });
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
    }, 60000);
    return () => {
      cancelled = true;
      unmountedRef.current = true;
      clearInterval(interval);
    };
  }, [refreshAll]);

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

  const currentDate = new Date().toLocaleDateString(intlLocale, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <div className="mdash-phone">
      {/* Mobile Header */}
      <header className="mdash-header">
        <div className="mdash-header-left">
          <div className="mdash-header-logo">A</div>
          <span className="mdash-header-brand">AvyCloud</span>
        </div>
        <div className="mdash-header-right">
          <button className="mdash-header-btn" type="button" title="Benachrichtigungen">
            <Bell />
            <span className="mdash-notif-dot" />
          </button>
        </div>
      </header>

      {/* Content */}
      <div className="mdash-content">
        {/* Greeting */}
        <div className="mdash-greeting mdash-fade-up">
          <h1>{t('mobile.dashboard.title')}</h1>
          <div className="mdash-date">
            {lastUpdatedAt
              ? t('mobile.dashboard.lastUpdated', { value: lastUpdatedAt.toLocaleString(intlLocale) })
              : currentDate}
          </div>
        </div>

        {/* Empty state */}
        {isEmpty && (
          <div className="mdash-empty-state mdash-fade-up">
            {isLoading ? t('status.loading.products') : t('mobile.dashboard.empty')}
          </div>
        )}

        {/* Quick Stats 2x2 Grid */}
        <div className="mdash-stats-grid mdash-fade-up">
          <div className="mdash-stat-card" onClick={() => navigateTo('products')}>
            <div className="mdash-stat-icon purple">
              <Package size={16} />
            </div>
            <div className="mdash-stat-value">{summary.total.toLocaleString(intlLocale)}</div>
            <div className="mdash-stat-label">{t('mobile.dashboard.kpi.products')}</div>
          </div>
          <div className="mdash-stat-card" onClick={() => navigateTo('operations-pick')}>
            <div className="mdash-stat-icon blue">
              <ShoppingBag size={16} />
            </div>
            <div className="mdash-stat-value">{openOrders.length}</div>
            <div className="mdash-stat-label">{t('ops.mode.pick')}</div>
          </div>
          <div className="mdash-stat-card" onClick={() => navigateTo('operations-stow')}>
            <div className="mdash-stat-icon green">
              <Truck size={16} />
            </div>
            <div className="mdash-stat-value">{summary.qtySum.toLocaleString(intlLocale)}</div>
            <div className="mdash-stat-label">{t('mobile.dashboard.kpi.units')}</div>
          </div>
          <div className="mdash-stat-card">
            <div className="mdash-stat-icon orange">
              <RefreshCw size={16} />
            </div>
            <div className="mdash-stat-value">
              {summary.total > 0 ? `${Math.round((summary.synced / summary.total) * 100)}%` : '—'}
            </div>
            <div className="mdash-stat-label">{t('mobile.dashboard.kpi.sync')}</div>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="mdash-section-title mdash-fade-up">{t('mobile.dashboard.action.search')}</div>
        <div className="mdash-quick-actions-scroll mdash-fade-up">
          <div className="mdash-action-card" onClick={() => navigateTo('operations-identify')}>
            <div className="mdash-action-icon">
              <Camera size={20} />
            </div>
            <span className="mdash-action-label">{t('ops.mode.identify')}</span>
          </div>
          <div className="mdash-action-card" onClick={() => navigateTo('operations-stow')}>
            <div className="mdash-action-icon">
              <Package size={20} />
            </div>
            <span className="mdash-action-label">{t('ops.mode.stow')}</span>
          </div>
          <div className="mdash-action-card" onClick={() => navigateTo('operations-pick')}>
            <div className="mdash-action-icon">
              <CheckSquare size={20} />
            </div>
            <span className="mdash-action-label">{t('ops.mode.pick')}</span>
          </div>
          <div className="mdash-action-card" onClick={() => navigateTo('search')}>
            <div className="mdash-action-icon">
              <Search size={20} />
            </div>
            <span className="mdash-action-label">{t('mobile.dashboard.action.search')}</span>
          </div>
        </div>

        {/* Inventory KPI Activity Card */}
        {!isEmpty && (
          <div className="mdash-card mdash-fade-up">
            <div className="mdash-card-header">
              <h3>{t('mobile.dashboard.kpi.value')}</h3>
              <button type="button" className="mdash-card-action" onClick={() => navigateTo('products')}>
                {t('mobile.dashboard.action.search')}
              </button>
            </div>
            <div className="mdash-activity-list">
              <div className="mdash-activity-item">
                <span className="mdash-activity-dot green" />
                <div className="mdash-activity-content">
                  <div className="mdash-activity-text">
                    {t('mobile.dashboard.kpi.productsSub', { count: summary.inStock })}
                  </div>
                  <div className="mdash-activity-time">{`${summary.total} ${t('mobile.dashboard.kpi.products')}`}</div>
                </div>
              </div>
              <div className="mdash-activity-item">
                <span className="mdash-activity-dot blue" />
                <div className="mdash-activity-content">
                  <div className="mdash-activity-text">
                    {t('mobile.dashboard.kpi.units')}: {summary.qtySum.toLocaleString(intlLocale)}
                  </div>
                  <div className="mdash-activity-time">{t('mobile.dashboard.kpi.unitsSub')}</div>
                </div>
              </div>
              <div className="mdash-activity-item">
                <span className="mdash-activity-dot purple" />
                <div className="mdash-activity-content">
                  <div className="mdash-activity-text">{formatCurrency(summary.value, 'EUR')}</div>
                  <div className="mdash-activity-time">
                    {t('mobile.dashboard.kpi.valueSub', { count: summary.synced })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Pending Tasks */}
        {(openOrders.length > 0 || stowBacklog > 0) && (
          <>
            <div className="mdash-section-title mdash-fade-up">{t('ops.mode.pick')}</div>

            {openOrders.length > 0 && (
              <div
                className="mdash-task-card warning mdash-fade-up"
                onClick={() => navigateTo('operations-pick')}
              >
                <div className="mdash-task-icon">
                  <AlertCircle size={18} />
                </div>
                <div className="mdash-task-body">
                  <div className="mdash-task-title">
                    {openOrders.length} {t('ops.mode.pick')}
                  </div>
                  <div className="mdash-task-sub">
                    {nextPick
                      ? `${t('ops.labels.nextPick')}: ${nextPick.binCode || '\u2014'} \u00B7 ${nextPick.sku}`
                      : t('ops.orders.open')}
                  </div>
                </div>
                <div className="mdash-task-arrow">
                  <ChevronRight size={16} />
                </div>
              </div>
            )}

            {stowBacklog > 0 && (
              <div
                className="mdash-task-card info mdash-fade-up"
                onClick={() => navigateTo('operations-stow')}
              >
                <div className="mdash-task-icon">
                  <DollarSign size={18} />
                </div>
                <div className="mdash-task-body">
                  <div className="mdash-task-title">
                    {stowBacklog} {t('ops.mode.stow')}
                  </div>
                  <div className="mdash-task-sub">{t('table.binFilter.withoutBin')}</div>
                </div>
                <div className="mdash-task-arrow">
                  <ChevronRight size={16} />
                </div>
              </div>
            )}
          </>
        )}

        {/* Orders & Revenue (collapsible) */}
        <details className="mdash-details-section mdash-fade-up">
          <summary className="mdash-details-summary">
            {t('mobile.dashboard.section.ordersRevenue')}
          </summary>
          <div className="mdash-details-body">
            <div className="mdash-details-meta">
              <span className="mdash-details-meta-text">
                {metrics?.generated_at_iso
                  ? new Date(metrics.generated_at_iso).toLocaleString(intlLocale)
                  : metricsLoading
                    ? t('common.loading')
                    : '\u2014'}
              </span>
              <select
                value={activePreset}
                onChange={(e) => setPreset(e.target.value)}
                className="mdash-details-select"
                aria-label="Dashboard Zeitraum"
              >
                {DASHBOARD_RANGE_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="mdash-stats-grid">
              <div className="mdash-stat-card">
                <div className="mdash-stat-label">{t('mobile.dashboard.metrics.revenueTotal')}</div>
                <div className="mdash-stat-value" style={{ fontSize: 16 }}>
                  {metrics
                    ? formatCurrency(metrics.revenue.all_non_cancelled_total || 0, metrics.currency || 'EUR')
                    : '\u2014'}
                </div>
                {metrics && (
                  <div className="mdash-stat-label">
                    {activeRangeLabel}:{' '}
                    {formatCurrency(metrics.revenue.window_non_cancelled_total || 0, metrics.currency || 'EUR')}
                  </div>
                )}
              </div>
              <div className="mdash-stat-card">
                <div className="mdash-stat-label">{t('mobile.dashboard.metrics.ordersCompleted')}</div>
                <div className="mdash-stat-value" style={{ fontSize: 16 }}>
                  {metrics ? `${metrics.orders.completed_total}` : '\u2014'}
                </div>
                {metrics && (
                  <div className="mdash-stat-label">
                    {t('mobile.dashboard.metrics.month')}: {metrics.orders.completed_month}
                  </div>
                )}
              </div>
              <div className="mdash-stat-card">
                <div className="mdash-stat-label">{t('mobile.dashboard.metrics.returns')}</div>
                <div className="mdash-stat-value" style={{ fontSize: 16 }}>
                  {metrics ? `${metrics.orders.returns_total}` : '\u2014'}
                </div>
                {metrics && (
                  <div className="mdash-stat-label">
                    {t('mobile.dashboard.metrics.month')}: {metrics.orders.returns_month}
                  </div>
                )}
              </div>
              <div className="mdash-stat-card">
                <div className="mdash-stat-label">{t('mobile.dashboard.metrics.openCurrent')}</div>
                <div className="mdash-stat-value" style={{ fontSize: 16 }}>
                  {metrics ? `${metrics.orders.open_current}` : '\u2014'}
                </div>
                <div className="mdash-stat-label">{t('mobile.dashboard.metrics.openCurrentSub')}</div>
              </div>
            </div>

            {/* Mini chart */}
            <div className="mdash-chart-wrap">
              <div className="mdash-chart-header">
                <span className="mdash-chart-label">{t('mobile.dashboard.chart.title')}</span>
                <span className="mdash-chart-count">
                  {volume7d.length
                    ? t('mobile.dashboard.chart.ordersCount', {
                        count: volume7d.reduce((s, d) => s + (Number(d.orders || 0) || 0), 0),
                      })
                    : '\u2014'}
                </span>
              </div>
              <div className="mdash-chart-range">{activeRangeLabel}</div>
              <div
                className="mdash-chart-bars"
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
                      <div key={d.date} className="mdash-chart-bar-group">
                        <div
                          title={t('mobile.dashboard.chart.barTitle', {
                            date: d.date,
                            orders: count,
                            revenue: formatCurrency(revenue, metrics?.currency || 'EUR'),
                          })}
                          className="mdash-chart-bar"
                          style={{ height: `${barPx}px` }}
                        />
                        <div className="mdash-chart-bar-label">{count}</div>
                      </div>
                    );
                  })
                ) : (
                  <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>
                    {t('mobile.dashboard.chart.noData')}
                  </div>
                )}
              </div>
            </div>
          </div>
        </details>

        {/* Spacer */}
        <div style={{ height: 24 }} />
      </div>

      {/* Bottom Tab Bar */}
      <nav className="mdash-tab-bar">
        <button type="button" className="mdash-tab-item active" onClick={() => navigateTo('home')}>
          <Home size={22} />
          <span>Home</span>
        </button>
        <button type="button" className="mdash-tab-item" onClick={() => navigateTo('operations-identify')}>
          <Camera size={22} />
          <span>Scanner</span>
        </button>
        <button type="button" className="mdash-tab-item" onClick={() => navigateTo('products')}>
          <Package size={22} />
          <span>{t('mobile.dashboard.kpi.products')}</span>
        </button>
        <button type="button" className="mdash-tab-item" onClick={() => navigateTo('operations-pick')}>
          <ShoppingBag size={22} />
          <span>{t('ops.mode.pick')}</span>
        </button>
        <button type="button" className="mdash-tab-item" onClick={() => navigateTo('search')}>
          <MoreVertical size={22} />
          <span>{t('mobile.dashboard.action.search')}</span>
        </button>
      </nav>
    </div>
  );
};

export default DashboardMobile;
