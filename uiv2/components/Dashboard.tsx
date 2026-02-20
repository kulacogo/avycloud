import React, { useEffect, useMemo, useState } from 'react';
import { Package, Warehouse, Clock, RefreshCw, TrendingUp, ScanBarcode, Truck, Store } from 'lucide-react';
import { DashboardMetrics, Product } from '../types';
import { fetchDashboardMetrics } from '../api/client';
import { getProductAvailableQuantity, getProductPhysicalQuantity, getProductReservedQuantity, normalizeSyncStatus } from '../utils/product';

interface DashboardProps {
  products: Product[];
  onSelectProduct: (productId: string) => void;
  onRefreshProducts?: () => void | Promise<void>;
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

const formatCurrency = (value: number, currency: string) => {
  const cur = safeCurrency(currency);
  try {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: cur }).format(value);
  } catch {
    return `${value.toFixed(2)} ${cur}`;
  }
};

const KpiCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  sublabel?: string;
  change?: { text: string; direction: 'up' | 'down' };
}> = ({ icon, label, value, sublabel, change }) => {
  const cardRef = React.useRef<HTMLDivElement>(null);
  const handleMouse = (e: React.MouseEvent) => {
    const el = cardRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mouse-x', `${e.clientX - r.left}px`);
    el.style.setProperty('--mouse-y', `${e.clientY - r.top}px`);
  };

  return (
    <div className="kpi-card" ref={cardRef} onMouseMove={handleMouse}>
      <div className="kpi-top">
        <div className="kpi-label">{icon}{label}</div>
        <TrendingUp size={14} className="kpi-trend-icon" />
      </div>
      <div className="kpi-value">{value}</div>
      {change && (
        <span className={`kpi-change ${change.direction}`}>
          {change.direction === 'up' ? '▲' : '▼'} {change.text}
        </span>
      )}
      {sublabel && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>{sublabel}</div>}
    </div>
  );
};

export const Dashboard: React.FC<DashboardProps> = ({
  products,
  onSelectProduct,
  onRefreshProducts,
  rangePreset,
  onRangePresetChange,
}) => {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [internalPreset, setInternalPreset] = useState('last7');

  const activePreset = useMemo(() => {
    const raw = typeof rangePreset === 'string' ? rangePreset.trim() : '';
    if (raw && DASHBOARD_RANGE_PRESETS.some((p) => p.id === raw)) return raw;
    return internalPreset;
  }, [rangePreset, internalPreset]);

  const setPreset = React.useCallback(
    (next: string) => {
      const v = String(next || '').trim();
      if (!v) return;
      if (onRangePresetChange) {
        onRangePresetChange(v);
      } else {
        setInternalPreset(v);
      }
    },
    [onRangePresetChange]
  );

  const loadMetrics = React.useCallback(async () => {
    setMetricsLoading(true);
    try {
      const data = await fetchDashboardMetrics({ days: 7, preset: activePreset }, { timeoutMs: 25000 });
      setMetrics(data);
      setMetricsError(null);
    } catch (error: any) {
      setMetricsError(error?.message || 'Dashboard-Metriken konnten nicht geladen werden.');
      setMetrics(null);
    } finally {
      setMetricsLoading(false);
    }
  }, [activePreset]);

  useEffect(() => {
    loadMetrics();
  }, [loadMetrics]);

  useEffect(() => {
    const interval = setInterval(() => {
      loadMetrics();
      if (onRefreshProducts) onRefreshProducts();
    }, 60000);
    return () => clearInterval(interval);
  }, [loadMetrics, onRefreshProducts]);

  const allProducts = products;
  const stockedProducts = useMemo(
    () => allProducts.filter((p) => getProductPhysicalQuantity(p) > 0),
    [allProducts]
  );

  const orderMetrics = useMemo(() => {
    const breakdown = metrics?.orders?.status_breakdown || null;
    const chartDays = metrics?.volume_7d?.days || [];
    const bucket = metrics?.range?.bucket || 'day';
    const chartCount = chartDays.length;
    const maxChartCount = Math.max(1, ...chartDays.map((d) => Number(d?.orders || 0) || 0));
    const chart = chartDays.map((d) => {
      const label = (() => {
        try {
          const dt = new Date(d.date);
          if (bucket === 'month') return dt.toLocaleDateString('de-DE', { month: 'short' });
          if (bucket === 'week') return dt.toLocaleDateString('de-DE', { day: '2-digit' });
          if (bucket === 'hour') return dt.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
          if (chartCount <= 14) return dt.toLocaleDateString('de-DE', { weekday: 'short' });
          return dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
        } catch {
          return d.date;
        }
      })();
      return { key: d.date, label, count: Number(d?.orders || 0) || 0 };
    });
    return {
      neu: breakdown?.neu ?? 0,
      kommissioniert: breakdown?.kommissioniert ?? 0,
      verpackt: (breakdown as any)?.verpackt ?? 0,
      versendet: breakdown?.versendet ?? 0,
      zugestellt: breakdown?.zugestellt ?? 0,
      cancelled: breakdown?.cancelled ?? 0,
      other: breakdown?.other ?? 0,
      open: breakdown?.neu ?? 0,
      total:
        (breakdown?.neu ?? 0) +
        (breakdown?.kommissioniert ?? 0) +
        ((breakdown as any)?.verpackt ?? 0) +
        (breakdown?.versendet ?? 0) +
        (breakdown?.zugestellt ?? 0) +
        (breakdown?.other ?? 0),
      chart,
      maxChartCount,
      revenueAllNonCancelled: metrics?.revenue?.all_non_cancelled_total ?? 0,
      revenueWindowNonCancelled: metrics?.revenue?.window_non_cancelled_total ?? 0,
      currency: safeCurrency(metrics?.currency || 'EUR'),
    };
  }, [metrics]);

  const activeRangeLabel =
    metrics?.range?.label ||
    DASHBOARD_RANGE_PRESETS.find((p) => p.id === activePreset)?.label ||
    `Letzte ${metrics?.revenue?.window_days || 7} Tage`;

  const {
    totalProducts,
    totalStocked,
    savedCount,
    inventoryQuantity,
    inventoryValue,
    primaryCurrency,
    valueByCurrency,
  } = useMemo(() => {
    const total = allProducts.length;
    const totalInStock = stockedProducts.length;
    const unsaved = allProducts.filter((p) => !p.ops?.last_saved_iso).length;
    const saved = Math.max(0, total - unsaved);
    let availableQty = 0;
    const valueMap = new Map<string, number>();
    allProducts.forEach((product) => {
      const quantityAvailable = getProductAvailableQuantity(product);
      const price = product.details?.pricing?.lowest_price;
      const itemValue = quantityAvailable * (price?.amount ?? 0);
      const currency = (price?.currency || 'EUR').toUpperCase();
      availableQty += quantityAvailable;
      valueMap.set(currency, (valueMap.get(currency) ?? 0) + itemValue);
    });
    const mostCommonCurrency =
      [...valueMap.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'EUR';
    const combinedValue = [...valueMap.values()].reduce((sum, value) => sum + value, 0);

    return {
      totalProducts: total,
      totalStocked: totalInStock,
      savedCount: saved,
      inventoryQuantity: availableQty,
      inventoryValue: combinedValue,
      primaryCurrency: mostCommonCurrency,
      valueByCurrency: valueMap,
    };
  }, [allProducts, stockedProducts]);

  const navigateToDrilldown = React.useCallback((statusKey: string) => {
    if (typeof window === 'undefined') return;
    const key = String(statusKey || '').trim().toLowerCase();
    if (!key) return;
    const targetView = key === 'neu' ? 'inventory' : 'products';
    window.location.hash = `#/${targetView}?orderStatus=${encodeURIComponent(key)}`;
  }, []);

  const statusCards = useMemo(
    () => [
      { key: 'neu', label: 'Neu', value: orderMetrics.neu, badgeClass: 'new' as const },
      { key: 'kommissioniert', label: 'Kommissioniert', value: orderMetrics.kommissioniert, badgeClass: 'processing' as const },
      { key: 'verpackt', label: 'Verpackt', value: orderMetrics.verpackt, badgeClass: 'processing' as const },
      { key: 'versendet', label: 'Versendet', value: orderMetrics.versendet, badgeClass: 'shipped' as const },
      { key: 'zugestellt', label: 'Zugestellt', value: orderMetrics.zugestellt, badgeClass: 'shipped' as const },
    ],
    [orderMetrics]
  );

  return (
    <div>
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          <div className="page-header-sub">Operations & Inventory Overview</div>
        </div>
        <div className="page-header-actions">
          <select
            value={activePreset}
            onChange={(e) => setPreset(e.target.value)}
            className="btn btn-secondary"
            style={{ appearance: 'auto', paddingRight: 32 }}
            aria-label="Dashboard Zeitraum"
          >
            {DASHBOARD_RANGE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="content">
        {/* KPI Grid */}
        <div className="kpi-grid">
          <KpiCard
            icon={<Package size={15} />}
            label="Inventar (mit Bestand)"
            value={totalStocked.toString()}
          />
          <KpiCard
            icon={<Warehouse size={15} />}
            label="Bestandseinheiten"
            value={inventoryQuantity.toString()}
            sublabel="verfügbar"
          />
          <KpiCard
            icon={<TrendingUp size={15} />}
            label="Bestandswert"
            value={formatCurrency(inventoryValue, primaryCurrency)}
            sublabel={
              valueByCurrency.size > 1
                ? `weitere: ${[...valueByCurrency.entries()]
                    .filter(([c]) => c !== primaryCurrency)
                    .map(([c, a]) => `${c} ${a.toFixed(0)}`)
                    .join(', ')}`
                : undefined
            }
          />
          <KpiCard
            icon={<RefreshCw size={15} />}
            label="Gespeicherte Produkte"
            value={`${savedCount}`}
            sublabel={totalProducts ? `von ${totalProducts}` : undefined}
          />
        </div>

        {/* Main Grid */}
        <div className="main-grid">
          {/* Left: Order Status + Chart */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
            {/* Order Status Card */}
            <div className="card">
              <div className="card-header">
                <span className="card-title">Auftragsstatus</span>
                <span className="card-action" style={{ cursor: 'default' }}>{activeRangeLabel}</span>
              </div>
              <div className="card-body">
                {metricsError && (
                  <div style={{ fontSize: 13, color: 'var(--error)', marginBottom: 12 }}>{metricsError}</div>
                )}
                {metricsLoading ? (
                  <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
                    Lade Auftragszahlen …
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 'var(--space-3)' }}>
                      {statusCards.map((card) => (
                        <button
                          key={card.key}
                          type="button"
                          onClick={() => navigateToDrilldown(card.key)}
                          style={{
                            padding: 'var(--space-3) var(--space-4)',
                            background: 'var(--surface-secondary)',
                            border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-md)',
                            cursor: 'pointer',
                            textAlign: 'left',
                            transition: 'all var(--transition)',
                            fontFamily: 'inherit',
                          }}
                          title="Klicken für Drilldown"
                        >
                          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                            {card.label}
                          </div>
                          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.03em', marginTop: 4 }}>
                            {card.value}
                          </div>
                        </button>
                      ))}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)', marginTop: 'var(--space-5)', paddingTop: 'var(--space-4)', borderTop: '1px solid var(--border)' }}>
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Offen (nur neu)</div>
                        <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.03em', marginTop: 4 }}>{orderMetrics.open}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>Gesamt aktiv: {orderMetrics.total}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Gesamtumsatz</div>
                        <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.03em', marginTop: 4 }}>
                          {formatCurrency(orderMetrics.revenueAllNonCancelled, orderMetrics.currency)}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>
                          {activeRangeLabel}: {formatCurrency(orderMetrics.revenueWindowNonCancelled, orderMetrics.currency)}
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Chart Card */}
            <div className="card">
              <div className="card-header">
                <span className="card-title">Auftragsvolumen</span>
                <span className="card-action" style={{ cursor: 'default' }}>{activeRangeLabel}</span>
              </div>
              <div className="card-body">
                {metricsLoading ? (
                  <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
                    Synchronisiere Diagramm …
                  </div>
                ) : (
                  <div className="chart-area">
                    {orderMetrics.chart.map((day) => (
                      <div key={day.key} className="chart-bar-group">
                        <div
                          className="chart-bar"
                          style={{ height: `${(day.count / orderMetrics.maxChartCount) * 100 || 3}%` }}
                        >
                          <span className="chart-tooltip">{day.count} Aufträge</span>
                        </div>
                        <span className="chart-label">{day.label}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right: Quick Actions */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
            <div className="card">
              <div className="card-header">
                <span className="card-title">Schnellzugriff</span>
              </div>
              <div className="card-body">
                <div className="quick-grid">
                  <a className="quick-action" onClick={() => { window.location.hash = '#/input'; }} style={{ cursor: 'pointer' }}>
                    <div className="quick-action-icon" style={{ background: 'var(--info-bg)' }}>
                      <ScanBarcode size={16} style={{ color: 'var(--info)' }} />
                    </div>
                    <div>
                      <div className="quick-action-title">Identifizieren</div>
                      <div className="quick-action-desc">Produkte scannen</div>
                    </div>
                  </a>
                  <a className="quick-action" onClick={() => { window.location.hash = '#/operations'; }} style={{ cursor: 'pointer' }}>
                    <div className="quick-action-icon" style={{ background: 'var(--success-bg)' }}>
                      <Truck size={16} style={{ color: 'var(--success)' }} />
                    </div>
                    <div>
                      <div className="quick-action-title">Stow / Pick</div>
                      <div className="quick-action-desc">Warehouse Ops</div>
                    </div>
                  </a>
                  <a className="quick-action" onClick={() => { window.location.hash = '#/products'; }} style={{ cursor: 'pointer' }}>
                    <div className="quick-action-icon" style={{ background: 'var(--warning-bg)' }}>
                      <Package size={16} style={{ color: 'var(--warning)' }} />
                    </div>
                    <div>
                      <div className="quick-action-title">Produkte</div>
                      <div className="quick-action-desc">{totalProducts} gesamt</div>
                    </div>
                  </a>
                  <a className="quick-action" onClick={() => { window.location.hash = '#/ebay'; }} style={{ cursor: 'pointer' }}>
                    <div className="quick-action-icon" style={{ background: 'var(--avy-purple-glow)' }}>
                      <Store size={16} style={{ color: 'var(--avy-purple)' }} />
                    </div>
                    <div>
                      <div className="quick-action-title">eBay Sync</div>
                      <div className="quick-action-desc">Listings prüfen</div>
                    </div>
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
