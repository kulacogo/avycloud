import React, { useEffect, useMemo, useState } from 'react';
import { Package, Warehouse, Clock, RefreshCw, TrendingUp, ScanBarcode, Truck, Store, Upload, ChevronRight, Globe } from 'lucide-react';
import { DashboardMetrics, Product } from '../types';
import { fetchDashboardMetrics } from '../api/client';
import { getProductAvailableQuantity, getProductPhysicalQuantity, getProductReservedQuantity } from '../utils/product';
import { useAuth } from '../context/AuthContext';

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

const DASHBOARD_RANGE_PRESETS: Array<{ id: string; label: string; pillLabel: string }> = [
  { id: 'last7', label: 'Letzte 7 Tage', pillLabel: '7T' },
  { id: 'last14', label: 'Letzte 14 Tage', pillLabel: '14T' },
  { id: 'month_to_date', label: 'Aktueller Monat', pillLabel: '30T' },
  { id: 'last_month', label: 'Letzter Monat', pillLabel: '90T' },
  { id: 'year_to_date', label: 'Dieses Jahr', pillLabel: '1J' },
  { id: 'today', label: 'Heute', pillLabel: 'Heute' },
];

const CHART_PILLS = [
  { id: 'last7', label: '7T' },
  { id: 'last14', label: '14T' },
  { id: 'month_to_date', label: '30T' },
  { id: 'last_month', label: '90T' },
];

const formatCurrency = (value: number, currency: string) => {
  const cur = safeCurrency(currency);
  try {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: cur }).format(value);
  } catch {
    return `${value.toFixed(2)} ${cur}`;
  }
};

const formatNumber = (n: number) => new Intl.NumberFormat('de-DE').format(n);

const KpiCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  change?: { text: string; direction: 'up' | 'down' };
  miniChartHeights?: number[];
}> = ({ icon, label, value, change, miniChartHeights }) => {
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
      {miniChartHeights && (
        <div className="kpi-mini-chart">
          {miniChartHeights.map((h, i) => (
            <div key={i} className="kpi-mini-bar" style={{ height: `${h}px` }} />
          ))}
        </div>
      )}
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
  const { user } = useAuth();
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [internalPreset, setInternalPreset] = useState('last14');

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
    const maxRevenue = Math.max(1, ...chartDays.map((d) => Number(d?.revenue || d?.orders || 0) || 0));
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
      const revenue = Number(d?.revenue || 0) || 0;
      const orders = Number(d?.orders || 0) || 0;
      return { key: d.date, label, count: orders, revenue };
    });

    const maxChartRevenue = Math.max(1, ...chart.map(d => d.revenue || d.count));

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
      maxChartRevenue,
      revenueAllNonCancelled: metrics?.revenue?.all_non_cancelled_total ?? 0,
      revenueWindowNonCancelled: metrics?.revenue?.window_non_cancelled_total ?? 0,
      currency: safeCurrency(metrics?.currency || 'EUR'),
    };
  }, [metrics]);

  const {
    totalProducts,
    totalStocked,
    inventoryQuantity,
    ebaySyncPercent,
  } = useMemo(() => {
    const total = allProducts.length;
    const totalInStock = stockedProducts.length;
    let availableQty = 0;
    let syncedCount = 0;
    allProducts.forEach((product) => {
      availableQty += getProductAvailableQuantity(product);
      const rawSync = (product as any)?.sync_status || (product as any)?.ebay?.status || '';
      const syncStatus = typeof rawSync === 'string' ? rawSync.toLowerCase() : '';
      if (syncStatus === 'synced' || syncStatus === 'listed' || syncStatus === 'active') syncedCount++;
    });
    const syncPct = total > 0 ? Math.round((syncedCount / total) * 1000) / 10 : 0;

    return {
      totalProducts: total,
      totalStocked: totalInStock,
      inventoryQuantity: availableQty,
      ebaySyncPercent: syncPct,
    };
  }, [allProducts, stockedProducts]);

  // Recent orders from metrics
  const recentOrders = useMemo(() => {
    const orders = (metrics as any)?.recent_orders;
    if (Array.isArray(orders) && orders.length > 0) return orders.slice(0, 5);
    // Placeholder data when no real orders
    return [];
  }, [metrics]);

  // Activity feed
  const activities = useMemo(() => {
    const acts = (metrics as any)?.activities;
    if (Array.isArray(acts) && acts.length > 0) return acts.slice(0, 7);
    return [];
  }, [metrics]);

  const userName = user?.email?.split('@')[0] || 'User';
  const displayName = userName.charAt(0).toUpperCase() + userName.slice(1);

  const getStatusBadgeClass = (status: string) => {
    const s = status?.toLowerCase() || '';
    if (s === 'neu' || s === 'new') return 'new';
    if (s === 'kommissioniert' || s === 'verpackt' || s === 'processing') return 'processing';
    if (s === 'versendet' || s === 'shipped') return 'shipped';
    return 'new';
  };

  const getStatusLabel = (status: string) => {
    const s = status?.toLowerCase() || '';
    if (s === 'neu' || s === 'new') return 'Neu';
    if (s === 'kommissioniert') return 'Kommissioniert';
    if (s === 'verpackt') return 'Verpackt';
    if (s === 'versendet' || s === 'shipped') return 'Versendet';
    return status;
  };

  return (
    <div>
      {/* Page Header — matches mockup */}
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          <div className="page-header-sub">Willkommen zurueck, {displayName}.</div>
        </div>
        <div className="page-header-actions">
          <button className="btn btn-secondary">
            <Upload size={14} />
            Export
          </button>
          <button className="btn btn-primary" onClick={() => onRefreshProducts?.()}>
            <RefreshCw size={14} />
            Sync starten
          </button>
        </div>
      </div>

      <div className="content">
        {/* KPI Grid — 4 cards matching mockup: Produkte, Lagerbestand, Offene Bestellungen, eBay Sync */}
        <div className="kpi-grid">
          <KpiCard
            icon={<Package size={15} />}
            label="Produkte"
            value={formatNumber(totalProducts)}
            change={totalStocked > 0 ? { text: `${totalStocked} mit Bestand`, direction: 'up' } : undefined}
            miniChartHeights={[12, 18, 14, 22, 28, 24, 32]}
          />
          <KpiCard
            icon={<Warehouse size={15} />}
            label="Lagerbestand"
            value={formatNumber(inventoryQuantity)}
            change={inventoryQuantity > 0 ? { text: 'verfuegbar', direction: 'up' } : undefined}
            miniChartHeights={[20, 16, 22, 18, 26, 30, 28]}
          />
          <KpiCard
            icon={<Clock size={15} />}
            label="Offene Bestellungen"
            value={orderMetrics.open.toString()}
            change={orderMetrics.open > 0 ? { text: `${orderMetrics.total} gesamt`, direction: 'down' } : undefined}
          />
          <KpiCard
            icon={<RefreshCw size={15} />}
            label="eBay Sync"
            value={`${ebaySyncPercent}%`}
            change={ebaySyncPercent > 0 ? { text: 'synchronisiert', direction: 'up' } : undefined}
            miniChartHeights={[18, 22, 20, 26, 30, 28, 32]}
          />
        </div>

        {/* Main Grid — left: Umsatz chart + orders table, right: Aktivitaet + Schnellzugriff */}
        <div className="main-grid">
          {/* Left: Umsatz Card */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Umsatz</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div className="chart-period-pills">
                  {CHART_PILLS.map((pill) => (
                    <button
                      key={pill.id}
                      className={`chart-pill ${activePreset === pill.id ? 'active' : ''}`}
                      onClick={() => setPreset(pill.id)}
                    >
                      {pill.label}
                    </button>
                  ))}
                </div>
                <span className="card-action">Details →</span>
              </div>
            </div>
            <div className="card-body">
              {metricsError && (
                <div style={{ fontSize: 13, color: 'var(--error)', marginBottom: 12 }}>{metricsError}</div>
              )}

              {/* Chart Header */}
              <div className="chart-header">
                <div>
                  <div className="chart-total">
                    {formatCurrency(orderMetrics.revenueWindowNonCancelled || orderMetrics.revenueAllNonCancelled, orderMetrics.currency)}
                  </div>
                  <div className="chart-total-sub">
                    {orderMetrics.revenueWindowNonCancelled > 0
                      ? `+${((orderMetrics.revenueWindowNonCancelled / Math.max(1, orderMetrics.revenueAllNonCancelled - orderMetrics.revenueWindowNonCancelled)) * 100).toFixed(1)}% vs. Vorperiode`
                      : 'Keine Daten'}
                  </div>
                </div>
              </div>

              {/* Bar Chart */}
              {metricsLoading ? (
                <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
                  Lade Diagramm …
                </div>
              ) : (
                <div className="chart-area">
                  {orderMetrics.chart.length > 0 ? (
                    orderMetrics.chart.map((day) => {
                      const primaryHeight = Math.max(3, ((day.revenue || day.count) / orderMetrics.maxChartRevenue) * 100);
                      const secondaryHeight = Math.max(2, primaryHeight * 0.65);
                      return (
                        <div key={day.key} className="chart-bar-group">
                          <div
                            className="chart-bar"
                            style={{ height: `${primaryHeight}%` }}
                          >
                            <span className="chart-tooltip">
                              {day.revenue ? formatCurrency(day.revenue, orderMetrics.currency) : `${day.count} Auftraege`}
                            </span>
                          </div>
                          <div
                            className="chart-bar chart-bar-secondary"
                            style={{ height: `${secondaryHeight}%` }}
                          />
                          <span className="chart-label">{day.label}</span>
                        </div>
                      );
                    })
                  ) : (
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
                      Keine Daten vorhanden
                    </div>
                  )}
                </div>
              )}

              {/* Chart Legend */}
              <div className="chart-legend">
                <div className="chart-legend-item">
                  <div className="chart-legend-dot" style={{ background: 'var(--avy-purple)' }} />
                  Umsatz
                </div>
                <div className="chart-legend-item">
                  <div className="chart-legend-dot" style={{ background: 'var(--border)' }} />
                  Vorperiode
                </div>
              </div>

              {/* Orders Table Section */}
              <div className="orders-section">
                <div className="orders-section-header">
                  <span className="orders-section-title">Letzte Bestellungen</span>
                  <span className="card-action" onClick={() => { window.location.hash = '#/products'; }}>
                    Alle {orderMetrics.open > 0 ? orderMetrics.open : ''} →
                  </span>
                </div>
                <table className="orders-table">
                  <thead>
                    <tr>
                      <th>Bestell-Nr</th>
                      <th>Kunde</th>
                      <th>Status</th>
                      <th style={{ textAlign: 'right' }}>Betrag</th>
                      <th style={{ width: 32 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {recentOrders.length > 0 ? (
                      recentOrders.map((order: any, i: number) => (
                        <tr key={order.id || i}>
                          <td><span className="order-id">#{order.id || `AV-${2847 - i}`}</span></td>
                          <td>{order.customer || 'Kunde'}</td>
                          <td>
                            <span className={`status-badge ${getStatusBadgeClass(order.status)}`}>
                              <span className="status-dot" />
                              {getStatusLabel(order.status)}
                            </span>
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--text-primary)' }}>
                            {order.amount ? formatCurrency(order.amount, orderMetrics.currency) : '—'}
                          </td>
                          <td><ChevronRight size={16} className="row-action" /></td>
                        </tr>
                      ))
                    ) : (
                      // Show placeholder rows when no real data
                      <>
                        <tr>
                          <td><span className="order-id">#AV-0000</span></td>
                          <td style={{ color: 'var(--text-tertiary)' }}>Noch keine Bestellungen</td>
                          <td><span className="status-badge draft"><span className="status-dot" />—</span></td>
                          <td style={{ textAlign: 'right', color: 'var(--text-tertiary)' }}>—</td>
                          <td />
                        </tr>
                      </>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Right Column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
            {/* Activity Card */}
            <div className="card" style={{ flex: 1 }}>
              <div className="card-header">
                <span className="card-title">Aktivitaet</span>
                <span className="card-action">Alle →</span>
              </div>
              <div className="activity-list">
                {activities.length > 0 ? (
                  activities.map((act: any, i: number) => (
                    <div key={i} className="activity-item">
                      <div className={`activity-dot ${act.type || 'info'}`} />
                      <div className="activity-text" dangerouslySetInnerHTML={{ __html: act.text || '' }} />
                      <div className="activity-time">{act.time || ''}</div>
                    </div>
                  ))
                ) : (
                  // Placeholder activity items
                  <>
                    <div className="activity-item">
                      <div className="activity-dot success" />
                      <div className="activity-text"><strong>{totalProducts} Produkte</strong> im Katalog</div>
                      <div className="activity-time">aktuell</div>
                    </div>
                    <div className="activity-item">
                      <div className="activity-dot info" />
                      <div className="activity-text"><strong>Lagerbestand</strong> {formatNumber(inventoryQuantity)} Einheiten verfuegbar</div>
                      <div className="activity-time">aktuell</div>
                    </div>
                    <div className="activity-item">
                      <div className="activity-dot warning" />
                      <div className="activity-text"><strong>{orderMetrics.open} Bestellungen</strong> offen</div>
                      <div className="activity-time">aktuell</div>
                    </div>
                    {ebaySyncPercent > 0 && (
                      <div className="activity-item">
                        <div className="activity-dot success" />
                        <div className="activity-text"><strong>eBay Sync</strong> {ebaySyncPercent}% synchronisiert</div>
                        <div className="activity-time">aktuell</div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Quick Actions Card */}
            <div className="card">
              <div className="card-header">
                <span className="card-title">Schnellzugriff</span>
              </div>
              <div className="card-body">
                <div className="quick-grid">
                  <a className="quick-action" onClick={() => { window.location.hash = '#/input'; }}>
                    <div className="quick-action-icon" style={{ background: 'var(--info-bg)' }}>
                      <ScanBarcode size={16} style={{ color: 'var(--info)' }} />
                    </div>
                    <div>
                      <div className="quick-action-title">Identifizieren</div>
                      <div className="quick-action-desc">Produkte scannen</div>
                    </div>
                  </a>
                  <a className="quick-action" onClick={() => { window.location.hash = '#/operations'; }}>
                    <div className="quick-action-icon" style={{ background: 'var(--success-bg)' }}>
                      <Truck size={16} style={{ color: 'var(--success)' }} />
                    </div>
                    <div>
                      <div className="quick-action-title">Stow / Pick</div>
                      <div className="quick-action-desc">Warehouse Ops</div>
                    </div>
                  </a>
                  <a className="quick-action" onClick={() => { window.location.hash = '#/products'; }}>
                    <div className="quick-action-icon" style={{ background: 'var(--warning-bg)' }}>
                      <Package size={16} style={{ color: 'var(--warning)' }} />
                    </div>
                    <div>
                      <div className="quick-action-title">Produkte</div>
                      <div className="quick-action-desc">{totalProducts} gesamt</div>
                    </div>
                  </a>
                  <a className="quick-action" onClick={() => { window.location.hash = '#/ebay'; }}>
                    <div className="quick-action-icon" style={{ background: 'var(--avy-purple-glow)' }}>
                      <Globe size={16} style={{ color: 'var(--avy-purple)' }} />
                    </div>
                    <div>
                      <div className="quick-action-title">eBay Sync</div>
                      <div className="quick-action-desc">Listings pruefen</div>
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
