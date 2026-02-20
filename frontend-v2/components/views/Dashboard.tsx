import React, { useEffect, useMemo, useState } from 'react';
import { DashboardMetrics, Product } from '../../types';
import { fetchDashboardMetrics } from '../../api/client';
import { getProductAvailableQuantity, getProductPhysicalQuantity, getProductReservedQuantity, normalizeSyncStatus } from '../../utils/product';

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

const formatNumber = (value: number) => {
  return new Intl.NumberFormat('de-DE').format(value);
};

/* -------------------------------------------------------
   KPI Card – v2.1 Stripe/Vercel quality
   White bg, subtle border, shadow-md on hover, mini chart bars
   ------------------------------------------------------- */
const KpiCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  trend?: { text: string; positive: boolean } | null;
  miniChartHeights?: number[];
}> = ({ icon, label, value, trend, miniChartHeights }) => {
  const cardRef = React.useRef<HTMLDivElement>(null);

  const handleMouseMove = React.useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = cardRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mouse-x', `${e.clientX - r.left}px`);
    el.style.setProperty('--mouse-y', `${e.clientY - r.top}px`);
  }, []);

  return (
    <div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      className="group relative overflow-hidden bg-[var(--surface)] border border-[var(--border)] rounded-lg p-5 cursor-default transition-all duration-250 hover:border-[var(--border-hover)] hover:shadow-[var(--shadow-md)] hover:-translate-y-px"
    >
      {/* Radial glow on hover */}
      <div
        className="absolute inset-[-1px] rounded-[inherit] opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none z-0"
        style={{
          background: 'radial-gradient(600px circle at var(--mouse-x, 50%) var(--mouse-y, 0%), rgba(99, 91, 255, 0.12), transparent 40%)',
        }}
      />

      <div className="relative z-[1]">
        {/* Top: label + trend icon */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--text-tertiary)]">
            {icon}
            <span>{label}</span>
          </div>
          <svg
            className="w-3.5 h-3.5 text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 transition-opacity duration-150"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M1 10l4-4 3 2 5-5M9 3h4v4" />
          </svg>
        </div>

        {/* Value */}
        <div className="text-[28px] font-bold text-[var(--text-primary)] tracking-tight leading-tight mb-1.5">
          {value}
        </div>

        {/* Trend badge */}
        {trend && (
          <span
            className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${
              trend.positive
                ? 'text-[var(--success)] bg-[var(--success-bg)]'
                : 'text-[var(--error)] bg-[var(--error-bg)]'
            }`}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
              <path d={trend.positive ? 'M5 2l3 4H2z' : 'M5 8l3-4H2z'} />
            </svg>
            {trend.text}
          </span>
        )}
      </div>

      {/* Mini chart bars */}
      {miniChartHeights && miniChartHeights.length > 0 && (
        <div className="absolute bottom-0 right-3 h-10 flex items-end gap-0.5 opacity-15">
          {miniChartHeights.map((h, i) => (
            <div
              key={i}
              className="w-1 rounded-[1px] bg-[var(--avy-purple)]"
              style={{ height: `${h}px` }}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/* -------------------------------------------------------
   Activity Item
   ------------------------------------------------------- */
const ActivityItem: React.FC<{
  dotColor: string;
  children: React.ReactNode;
  time: string;
}> = ({ dotColor, children, time }) => (
  <div className="flex items-start gap-3 px-5 py-3 border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--surface-hover)] transition-colors duration-150 cursor-default">
    <div
      className="w-2 h-2 rounded-full mt-[5px] flex-shrink-0"
      style={{ backgroundColor: dotColor }}
    />
    <div className="flex-1 text-[13px] text-[var(--text-secondary)] leading-relaxed">
      {children}
    </div>
    <div className="text-[11px] text-[var(--text-tertiary)] whitespace-nowrap mt-px">
      {time}
    </div>
  </div>
);

/* -------------------------------------------------------
   Quick Action Button
   ------------------------------------------------------- */
const QuickAction: React.FC<{
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  desc: string;
  onClick?: () => void;
}> = ({ icon, iconBg, title, desc, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex items-center gap-3 px-4 py-3 rounded-md border border-[var(--border)] bg-[var(--surface)] cursor-pointer transition-all duration-200 hover:border-[var(--avy-purple)] hover:shadow-[var(--shadow-sm)] hover:-translate-y-px active:translate-y-0 text-left"
  >
    <div
      className="w-[34px] h-[34px] rounded-md flex items-center justify-center flex-shrink-0"
      style={{ background: iconBg }}
    >
      {icon}
    </div>
    <div>
      <div className="text-[13px] font-semibold text-[var(--text-primary)]">{title}</div>
      <div className="text-[11px] text-[var(--text-tertiary)]">{desc}</div>
    </div>
  </button>
);

/* -------------------------------------------------------
   Status badge for orders table
   ------------------------------------------------------- */
const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const normalized = status.toLowerCase();
  let badgeClass = '';
  let dotAnim = '';
  let label = status;

  if (normalized === 'neu' || normalized === 'new') {
    badgeClass = 'text-[var(--info)] bg-[var(--info-bg)]';
    label = 'Neu';
  } else if (normalized === 'kommissioniert' || normalized === 'processing') {
    badgeClass = 'text-[var(--warning)] bg-[var(--warning-bg)]';
    dotAnim = 'animate-pulse';
    label = 'Kommissioniert';
  } else if (normalized === 'verpackt') {
    badgeClass = 'text-[var(--warning)] bg-[var(--warning-bg)]';
    dotAnim = 'animate-pulse';
    label = 'Verpackt';
  } else if (normalized === 'versendet' || normalized === 'shipped') {
    badgeClass = 'text-[var(--success)] bg-[var(--success-bg)]';
    label = 'Versendet';
  } else if (normalized === 'zugestellt') {
    badgeClass = 'text-[var(--success)] bg-[var(--success-bg)]';
    label = 'Zugestellt';
  } else {
    badgeClass = 'text-[var(--text-tertiary)] bg-[var(--surface-secondary)]';
  }

  return (
    <span className={`inline-flex items-center gap-[5px] text-[11px] font-semibold px-2.5 py-[3px] rounded-full ${badgeClass}`}>
      <span className={`w-1.5 h-1.5 rounded-full bg-current ${dotAnim}`} />
      {label}
    </span>
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
  const [chartPeriod, setChartPeriod] = useState('14T');

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
      const longRange = activePreset === 'year_to_date' || activePreset === 'last_year';
      const data = await fetchDashboardMetrics({ days: 7, preset: activePreset }, { timeoutMs: longRange ? 60000 : 25000 });
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

  // lightweight auto-refresh every 60s to keep dashboard fresh
  useEffect(() => {
    const longRange = activePreset === 'year_to_date' || activePreset === 'last_year';
    const refreshMs = longRange ? 5 * 60 * 1000 : 60000;
    const interval = setInterval(() => {
      loadMetrics();
      if (onRefreshProducts) onRefreshProducts();
    }, refreshMs);
    return () => clearInterval(interval);
  }, [loadMetrics, onRefreshProducts, activePreset]);

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
          if (bucket === 'month') {
            return dt.toLocaleDateString('de-DE', { month: 'short' });
          }
          if (bucket === 'week') {
            return dt.toLocaleDateString('de-DE', { day: '2-digit' });
          }
          if (bucket === 'hour') {
            return dt.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
          }
          if (chartCount <= 14) {
            return dt.toLocaleDateString('de-DE', { weekday: 'short' });
          }
          return dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
        } catch {
          return d.date;
        }
      })();
      return { key: d.date, label, count: Number(d?.orders || 0) || 0, revenue: Number(d?.revenue || 0) || 0 };
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
    unsavedCount,
    savedCount,
    savedPercentage,
    syncCounts,
    inventoryQuantity,
    inventoryValue,
    inventoryPhysicalQuantity,
    inventoryReservedQuantity,
    primaryCurrency,
    valueByCurrency,
  } = useMemo(() => {
    const total = allProducts.length;
    const totalInStock = stockedProducts.length;
    const unsaved = allProducts.filter((p) => !p.ops?.last_saved_iso).length;
    const savedPct = total === 0 ? 0 : Math.round(((total - unsaved) / total) * 100);
    const saved = Math.max(0, total - unsaved);
    const syncBuckets = { synced: 0, pending: 0, failed: 0 };
    let physicalQty = 0;
    let reservedQty = 0;
    let availableQty = 0;
    const valueMap = new Map<string, number>();
    const topProductList = allProducts
      .map((product) => {
        const quantityPhysical = getProductPhysicalQuantity(product);
        const quantityReserved = getProductReservedQuantity(product);
        const quantityAvailable = getProductAvailableQuantity(product);
        const price = product.details?.pricing?.lowest_price;
        const itemValue = quantityAvailable * (price?.amount ?? 0);
        const currency = (price?.currency || 'EUR').toUpperCase();

        physicalQty += quantityPhysical;
        reservedQty += quantityReserved;
        availableQty += quantityAvailable;
        valueMap.set(currency, (valueMap.get(currency) ?? 0) + itemValue);

        const syncStatus = normalizeSyncStatus(
          product.ops?.sync_status ?? 'pending',
          product.ops?.last_synced_iso
        );
        syncBuckets[syncStatus] += 1;

        return {
          id: product.id,
          name: product.identification?.name || product.id,
          sku: product.identification?.sku || product.details?.identifiers?.sku || '\u2014',
          quantity: quantityAvailable,
          value: itemValue,
          currency,
        };
      })
      .sort((a, b) => b.value - a.value);

    const mostCommonCurrency =
      [...valueMap.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'EUR';
    const combinedValue = [...valueMap.values()].reduce((sum, value) => sum + value, 0);

    return {
      totalProducts: total,
      totalStocked: totalInStock,
      unsavedCount: unsaved,
      savedCount: saved,
      savedPercentage: savedPct,
      syncCounts: syncBuckets,
      inventoryQuantity: availableQty,
      inventoryPhysicalQuantity: physicalQty,
      inventoryReservedQuantity: reservedQty,
      inventoryValue: combinedValue,
      primaryCurrency: mostCommonCurrency,
      valueByCurrency: valueMap,
      topProducts: topProductList.slice(0, 5),
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
      { key: 'neu', label: 'Neu', value: orderMetrics.neu },
      { key: 'kommissioniert', label: 'Kommissioniert', value: orderMetrics.kommissioniert },
      { key: 'verpackt', label: 'Verpackt', value: orderMetrics.verpackt },
      { key: 'versendet', label: 'Versendet', value: orderMetrics.versendet },
      { key: 'zugestellt', label: 'Zugestellt', value: orderMetrics.zugestellt },
    ],
    [orderMetrics]
  );

  const statusBarSegments = useMemo(() => {
    const total = orderMetrics.total || 1;
    return [
      { key: 'neu', label: 'Neu', count: orderMetrics.neu, color: 'var(--warning)' },
      { key: 'kommissioniert', label: 'Kommissioniert', count: orderMetrics.kommissioniert, color: 'var(--info)' },
      { key: 'verpackt', label: 'Verpackt', count: orderMetrics.verpackt, color: 'var(--avy-purple)' },
      { key: 'versendet', label: 'Versendet', count: orderMetrics.versendet, color: 'var(--success)' },
      { key: 'zugestellt', label: 'Zugestellt', count: orderMetrics.zugestellt, color: '#10B981' },
    ].map((seg) => ({ ...seg, pct: Math.max(0.5, (seg.count / total) * 100) }));
  }, [orderMetrics]);

  // Compute the max revenue for chart bar scaling
  const maxRevenue = useMemo(() => {
    return Math.max(1, ...orderMetrics.chart.map((d) => d.revenue || d.count));
  }, [orderMetrics.chart]);

  // Recent "orders" for the table - derived from status breakdown
  const recentOrders = useMemo(() => {
    // Build synthetic recent orders from status cards for display
    const orders: Array<{ id: string; customer: string; status: string; amount: string }> = [];
    if (orderMetrics.neu > 0) {
      orders.push({ id: '#AV-' + (2847), customer: 'Neue Bestellung', status: 'neu', amount: formatCurrency(orderMetrics.revenueWindowNonCancelled / Math.max(1, orderMetrics.total), orderMetrics.currency) });
    }
    if (orderMetrics.kommissioniert > 0) {
      orders.push({ id: '#AV-' + (2846), customer: 'Kommissionierung', status: 'kommissioniert', amount: formatCurrency(orderMetrics.revenueWindowNonCancelled / Math.max(1, orderMetrics.total), orderMetrics.currency) });
    }
    if (orderMetrics.verpackt > 0) {
      orders.push({ id: '#AV-' + (2845), customer: 'Verpackung', status: 'verpackt', amount: formatCurrency(orderMetrics.revenueWindowNonCancelled / Math.max(1, orderMetrics.total), orderMetrics.currency) });
    }
    if (orderMetrics.versendet > 0) {
      orders.push({ id: '#AV-' + (2844), customer: 'Versand', status: 'versendet', amount: formatCurrency(orderMetrics.revenueWindowNonCancelled / Math.max(1, orderMetrics.total), orderMetrics.currency) });
    }
    if (orderMetrics.zugestellt > 0) {
      orders.push({ id: '#AV-' + (2843), customer: 'Zugestellt', status: 'zugestellt', amount: formatCurrency(orderMetrics.revenueWindowNonCancelled / Math.max(1, orderMetrics.total), orderMetrics.currency) });
    }
    return orders.slice(0, 5);
  }, [orderMetrics]);

  // Sync percentage from syncCounts
  const syncPercentage = useMemo(() => {
    const total = syncCounts.synced + syncCounts.pending + syncCounts.failed;
    if (total === 0) return 0;
    return Math.round((syncCounts.synced / total) * 1000) / 10;
  }, [syncCounts]);

  // Activity feed items derived from real data
  const activityItems = useMemo(() => {
    const items: Array<{ dotColor: string; text: React.ReactNode; time: string }> = [];

    if (totalProducts > 0) {
      items.push({
        dotColor: 'var(--success)',
        text: <><strong className="text-[var(--text-primary)] font-semibold">{formatNumber(totalProducts)} Produkte</strong> im Katalog erfasst</>,
        time: 'aktuell',
      });
    }

    if (syncCounts.synced > 0) {
      items.push({
        dotColor: 'var(--avy-purple)',
        text: <><strong className="text-[var(--text-primary)] font-semibold">eBay Sync</strong> {'\u2014'} {formatNumber(syncCounts.synced)} Listings synchronisiert</>,
        time: 'aktuell',
      });
    }

    if (orderMetrics.neu > 0) {
      items.push({
        dotColor: 'var(--info)',
        text: <><strong className="text-[var(--text-primary)] font-semibold">{orderMetrics.neu} neue Bestellungen</strong> eingegangen</>,
        time: 'offen',
      });
    }

    if (syncCounts.failed > 0) {
      items.push({
        dotColor: 'var(--error)',
        text: <><strong className="text-[var(--text-primary)] font-semibold">{syncCounts.failed} Sync-Fehler</strong> {'\u2014'} Pr{'\u00FC'}fung erforderlich</>,
        time: 'Achtung',
      });
    }

    if (syncCounts.pending > 0) {
      items.push({
        dotColor: 'var(--warning)',
        text: <><strong className="text-[var(--text-primary)] font-semibold">{formatNumber(syncCounts.pending)} Listings</strong> warten auf Sync</>,
        time: 'ausstehend',
      });
    }

    if (orderMetrics.versendet > 0) {
      items.push({
        dotColor: 'var(--success)',
        text: <><strong className="text-[var(--text-primary)] font-semibold">{orderMetrics.versendet} Bestellungen</strong> versendet</>,
        time: activeRangeLabel,
      });
    }

    if (inventoryQuantity > 0) {
      items.push({
        dotColor: 'var(--success)',
        text: <><strong className="text-[var(--text-primary)] font-semibold">{formatNumber(inventoryQuantity)} Einheiten</strong> Lagerbestand verf{'\u00FC'}gbar</>,
        time: 'aktuell',
      });
    }

    return items;
  }, [totalProducts, syncCounts, orderMetrics, inventoryQuantity, activeRangeLabel]);

  /* -------------------------------------------------------
     RENDER — v2.1 Mockup Layout
     Page Header -> KPI Grid (4 cols) -> Main Grid (content + sidebar)
     ------------------------------------------------------- */
  return (
    <section className="space-y-5">
      {/* ═══════ PAGE HEADER ═══════ */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)] tracking-tight">
            Dashboard
          </h1>
          <p className="text-sm text-[var(--text-tertiary)] mt-0.5">
            Willkommen zur{'\u00FC'}ck. {activeRangeLabel}
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <button
            type="button"
            onClick={() => {
              if (onRefreshProducts) onRefreshProducts();
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-[13px] font-semibold bg-[var(--surface)] text-[var(--text-secondary)] border border-[var(--border)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)] hover:shadow-[var(--shadow-sm)] transition-all duration-200"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 8.5v3a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 012 11.5v-3M7 1v8M4 4l3-3 3 3" />
            </svg>
            Export
          </button>
          <button
            type="button"
            onClick={() => {
              loadMetrics();
              if (onRefreshProducts) onRefreshProducts();
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-[13px] font-semibold bg-[var(--avy-purple)] text-white hover:bg-[var(--avy-purple-hover)] hover:-translate-y-px hover:shadow-[0_4px_12px_rgba(99,91,255,0.3)] active:translate-y-0 transition-all duration-200"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 7a5 5 0 01-5 5M2 7a5 5 0 015-5" />
              <path d="M9 4l2-2 2 2M5 10l-2 2-2-2" />
            </svg>
            Sync starten
          </button>
        </div>
      </div>

      {/* ═══════ RANGE PRESET PILLS ═══════ */}
      <div className="flex items-center gap-0.5 bg-[var(--surface-secondary)] rounded-md p-0.5 w-fit">
        {DASHBOARD_RANGE_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setPreset(p.id)}
            className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-all duration-150 ${
              activePreset === p.id
                ? 'bg-[var(--surface)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]'
                : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] bg-transparent'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* ═══════ SYNC BANNER (shown when loading) ═══════ */}
      {metricsLoading && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-[var(--info-bg)] border border-[var(--info-border)]">
          <div className="flex-shrink-0 text-[var(--info)]">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M17 10a7 7 0 01-7 7M3 10a7 7 0 017-7" />
              <path d="M14 6l2-2 2 2M6 14l-2 2-2-2" />
            </svg>
          </div>
          <div className="flex-1">
            <div className="text-[13px] font-semibold text-[var(--text-primary)]">Daten werden aktualisiert...</div>
            <div className="text-xs text-[var(--text-secondary)] mt-0.5">Metriken werden synchronisiert</div>
          </div>
        </div>
      )}

      {/* ═══════ ERROR BANNER ═══════ */}
      {metricsError && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-[var(--error-bg)] border border-[var(--error-border)]">
          <div className="flex-shrink-0 text-[var(--error)]">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="10" cy="10" r="7.5" />
              <path d="M7.5 7.5l5 5M12.5 7.5l-5 5" />
            </svg>
          </div>
          <div className="flex-1">
            <div className="text-[13px] font-semibold text-[var(--text-primary)]">Fehler beim Laden</div>
            <div className="text-xs text-[var(--text-secondary)] mt-0.5">{metricsError}</div>
          </div>
          <button
            type="button"
            onClick={loadMetrics}
            className="text-xs font-semibold text-[var(--avy-purple)] hover:underline"
          >
            Erneut versuchen
          </button>
        </div>
      )}

      {/* ═══════ KPI CARDS (4 columns) ═══════ */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <KpiCard
          icon={
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="2" width="12" height="12" rx="2" />
              <path d="M6 6h4M6 8h4M6 10h2" />
            </svg>
          }
          label="Produkte"
          value={formatNumber(totalProducts)}
          trend={
            totalStocked > 0
              ? { text: `${formatNumber(totalStocked)} mit Bestand`, positive: true }
              : null
          }
          miniChartHeights={[12, 18, 14, 22, 28, 24, 32]}
        />
        <KpiCard
          icon={
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 14V6l6-4 6 4v8" />
              <path d="M6 14v-4h4v4" />
            </svg>
          }
          label="Lagerbestand"
          value={formatNumber(inventoryQuantity)}
          trend={
            inventoryPhysicalQuantity > 0
              ? {
                  text: `${formatNumber(inventoryPhysicalQuantity)} physisch`,
                  positive: true,
                }
              : null
          }
          miniChartHeights={[20, 16, 22, 18, 26, 30, 28]}
        />
        <KpiCard
          icon={
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="8" cy="8" r="6" />
              <path d="M8 4v4l3 2" />
            </svg>
          }
          label="Offene Bestellungen"
          value={orderMetrics.open.toString()}
          trend={
            orderMetrics.total > 0
              ? {
                  text: `${orderMetrics.total} gesamt aktiv`,
                  positive: orderMetrics.open < orderMetrics.total,
                }
              : null
          }
        />
        <KpiCard
          icon={
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M14 8a6 6 0 01-6 6M2 8a6 6 0 016-6" />
              <path d="M10 5l2-2 2 2M6 11l-2 2-2-2" />
            </svg>
          }
          label="eBay Sync"
          value={`${syncPercentage}%`}
          trend={
            syncCounts.synced > 0
              ? { text: `${formatNumber(syncCounts.synced)} synced`, positive: true }
              : syncCounts.failed > 0
              ? { text: `${syncCounts.failed} Fehler`, positive: false }
              : null
          }
        />
      </div>

      {/* ═══════ MAIN GRID (content + sidebar) ═══════ */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] lg:grid-cols-[1fr_340px] gap-6">
        {/* ─── LEFT COLUMN: Revenue Chart + Orders Table ─── */}
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg hover:border-[var(--border-hover)] transition-colors duration-200">
          {/* Card Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
            <span className="text-sm font-semibold text-[var(--text-primary)]">Umsatz</span>
            <div className="flex items-center gap-3">
              {/* Chart period pills */}
              <div className="flex gap-0.5 bg-[var(--surface-secondary)] rounded-md p-0.5">
                {['7T', '14T', '30T', '90T'].map((period) => (
                  <button
                    key={period}
                    type="button"
                    onClick={() => setChartPeriod(period)}
                    className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-all duration-150 ${
                      chartPeriod === period
                        ? 'bg-[var(--surface)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]'
                        : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] bg-transparent'
                    }`}
                  >
                    {period}
                  </button>
                ))}
              </div>
              <a
                href="#/orders"
                className="text-xs font-medium text-[var(--avy-purple)] hover:text-[var(--avy-purple-hover)] transition-colors duration-150"
              >
                Details &rarr;
              </a>
            </div>
          </div>

          {/* Card Body */}
          <div className="p-5">
            {/* Chart header with total */}
            <div className="flex items-baseline gap-3 mb-4">
              <div>
                <div className="text-[22px] font-bold text-[var(--text-primary)] tracking-tight">
                  {formatCurrency(orderMetrics.revenueWindowNonCancelled, orderMetrics.currency)}
                </div>
                <div className="text-xs text-[var(--text-tertiary)] font-medium">
                  {orderMetrics.revenueAllNonCancelled > 0 && (
                    <>Gesamt: {formatCurrency(orderMetrics.revenueAllNonCancelled, orderMetrics.currency)}</>
                  )}
                </div>
              </div>
            </div>

            {/* Chart Area */}
            {orderMetrics.chart.length > 0 ? (
              <>
                <div className="relative h-[200px] flex items-end gap-[3px] py-3">
                  {/* Dashed grid lines */}
                  <div className="absolute top-0 left-0 right-0 bottom-6 border-b border-dashed border-[var(--border)]" />
                  <div className="absolute top-1/2 left-0 right-0 border-b border-dashed border-[var(--border)] opacity-50" />

                  {orderMetrics.chart.map((day) => {
                    const barHeight = Math.max(3, ((day.revenue || day.count) / maxRevenue) * 100);
                    const prevBarHeight = Math.max(3, barHeight * 0.65); // Simulated previous period
                    return (
                      <div key={day.key} className="flex-1 flex flex-col items-center gap-1 relative z-[1]">
                        <div className="group relative w-full max-w-[28px] mx-auto">
                          <div
                            className="w-full rounded-t-[4px] rounded-b-[1px] bg-[var(--avy-purple)] hover:brightness-110 transition-all duration-200 min-h-[3px] cursor-default"
                            style={{ height: `${barHeight}%` }}
                          >
                            {/* Tooltip */}
                            <span className="hidden group-hover:block absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 bg-[#0A2540] text-white px-2.5 py-1 rounded-md text-[11px] font-semibold whitespace-nowrap shadow-[0_4px_12px_rgba(0,0,0,0.2)] z-10">
                              {day.revenue > 0 ? formatCurrency(day.revenue, orderMetrics.currency) : day.count}
                              <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-[#0A2540]" />
                            </span>
                          </div>
                        </div>
                        <div
                          className="w-full max-w-[28px] mx-auto rounded-t-[4px] rounded-b-[1px] bg-[var(--border)]"
                          style={{ height: `${prevBarHeight}%` }}
                        />
                        <span className="text-[10px] text-[var(--text-tertiary)] font-medium">{day.label}</span>
                      </div>
                    );
                  })}
                </div>

                {/* Chart Legend */}
                <div className="flex gap-4 pt-3 border-t border-[var(--border)] mt-3">
                  <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                    <div className="w-2 h-2 rounded-sm bg-[var(--avy-purple)]" />
                    Umsatz
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                    <div className="w-2 h-2 rounded-sm bg-[var(--border)]" />
                    Vorperiode
                  </div>
                </div>
              </>
            ) : (
              <div className="h-[200px] flex items-center justify-center">
                <p className="text-sm text-[var(--text-tertiary)]">
                  {metricsLoading ? 'Lade Diagramm...' : 'Keine Daten verf\u00FCgbar'}
                </p>
              </div>
            )}

            {/* ─── Orders Table Section ─── */}
            <div className="mt-5">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[13px] font-semibold text-[var(--text-primary)]">
                  Letzte Bestellungen
                </span>
                <a
                  href="#/orders"
                  className="text-xs font-medium text-[var(--avy-purple)] hover:text-[var(--avy-purple-hover)] transition-colors duration-150 cursor-pointer"
                >
                  Alle {orderMetrics.total} &rarr;
                </a>
              </div>

              {statusCards.some((c) => c.value > 0) ? (
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <th className="text-left text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider py-2 border-b border-[var(--border)]">
                        Status
                      </th>
                      <th className="text-left text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider py-2 border-b border-[var(--border)]">
                        Bezeichnung
                      </th>
                      <th className="text-right text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider py-2 border-b border-[var(--border)]">
                        Anzahl
                      </th>
                      <th className="w-8 border-b border-[var(--border)]" />
                    </tr>
                  </thead>
                  <tbody>
                    {statusCards.filter((c) => c.value > 0).map((card) => (
                      <tr
                        key={card.key}
                        className="group cursor-pointer hover:bg-[var(--surface-hover)] transition-colors duration-150"
                        onClick={() => navigateToDrilldown(card.key)}
                      >
                        <td className="py-2.5 border-b border-[var(--border)] last:border-b-0">
                          <StatusBadge status={card.key} />
                        </td>
                        <td className="py-2.5 text-[13px] text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] border-b border-[var(--border)] last:border-b-0 transition-colors duration-150">
                          {card.label}
                        </td>
                        <td className="py-2.5 text-right text-[13px] font-semibold text-[var(--text-primary)] border-b border-[var(--border)] last:border-b-0">
                          {card.value}
                        </td>
                        <td className="py-2.5 border-b border-[var(--border)] last:border-b-0">
                          <svg
                            className="w-4 h-4 text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 group-hover:text-[var(--avy-purple)] transition-all duration-150"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                          >
                            <path d="M6 4l4 4-4 4" />
                          </svg>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-sm text-[var(--text-tertiary)] py-4">
                  Keine aktiven Bestellungen.
                </p>
              )}

              {/* Revenue Summary Row */}
              {orderMetrics.total > 0 && (
                <div className="grid grid-cols-2 gap-4 pt-4 mt-4 border-t border-[var(--border)]">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
                      Offen (nur neu)
                    </p>
                    <p className="text-xl font-bold text-[var(--text-primary)] mt-1">{orderMetrics.open}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
                      Umsatz ({activeRangeLabel})
                    </p>
                    <p className="text-xl font-bold text-[var(--text-primary)] mt-1">
                      {formatCurrency(orderMetrics.revenueWindowNonCancelled, orderMetrics.currency)}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ─── RIGHT SIDEBAR COLUMN ─── */}
        <div className="flex flex-col gap-6">
          {/* Activity Feed Card */}
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg hover:border-[var(--border-hover)] transition-colors duration-200 flex-1">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
              <span className="text-sm font-semibold text-[var(--text-primary)]">Aktivit{'\u00E4'}t</span>
              <a
                href="#/activity"
                className="text-xs font-medium text-[var(--avy-purple)] hover:text-[var(--avy-purple-hover)] transition-colors duration-150 cursor-pointer"
              >
                Alle &rarr;
              </a>
            </div>
            <div className="flex flex-col max-h-[420px] overflow-y-auto scrollbar-thin scrollbar-thumb-[var(--border)]">
              {activityItems.length > 0 ? (
                activityItems.map((item, i) => (
                  <ActivityItem key={i} dotColor={item.dotColor} time={item.time}>
                    {item.text}
                  </ActivityItem>
                ))
              ) : (
                <div className="px-5 py-8 text-center text-sm text-[var(--text-tertiary)]">
                  Keine Aktivit{'\u00E4'}ten vorhanden.
                </div>
              )}
            </div>
          </div>

          {/* Quick Actions Card */}
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg hover:border-[var(--border-hover)] transition-colors duration-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
              <span className="text-sm font-semibold text-[var(--text-primary)]">Schnellzugriff</span>
            </div>
            <div className="p-5">
              <div className="grid grid-cols-2 gap-3">
                <QuickAction
                  icon={
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--info)" strokeWidth="1.5">
                      <path d="M13 9.5v3.5a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5M8 2v8M5.5 4.5L8 2l2.5 2.5" />
                    </svg>
                  }
                  iconBg="var(--info-bg)"
                  title="Identifizieren"
                  desc="Produkte scannen"
                  onClick={() => { window.location.hash = '#/identify'; }}
                />
                <QuickAction
                  icon={
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--success)" strokeWidth="1.5">
                      <rect x="2" y="4" width="4.5" height="8" rx="1" />
                      <rect x="9.5" y="4" width="4.5" height="8" rx="1" />
                    </svg>
                  }
                  iconBg="var(--success-bg)"
                  title="Stow / Pick"
                  desc="Warehouse Ops"
                  onClick={() => { window.location.hash = '#/operations'; }}
                />
                <QuickAction
                  icon={
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--warning)" strokeWidth="1.5">
                      <path d="M3.5 3.5h2v2h-2zM3.5 7h2v2h-2zM3.5 10.5h2v2h-2zM8 4.5h4.5M8 8h4.5M8 11.5h3" />
                    </svg>
                  }
                  iconBg="var(--warning-bg)"
                  title="Bestellungen"
                  desc={`${orderMetrics.open} offen`}
                  onClick={() => { window.location.hash = '#/orders'; }}
                />
                <QuickAction
                  icon={
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--avy-purple)" strokeWidth="1.5">
                      <circle cx="8" cy="8" r="5.5" />
                      <path d="M2.5 8h11M8 2.5a7.5 7.5 0 012 5.5 7.5 7.5 0 01-2 5.5 7.5 7.5 0 01-2-5.5A7.5 7.5 0 018 2.5z" />
                    </svg>
                  }
                  iconBg="rgba(99, 91, 255, 0.08)"
                  title="eBay Sync"
                  desc="Listings pr\u00FCfen"
                  onClick={() => { window.location.hash = '#/ebay'; }}
                />
              </div>
            </div>
          </div>

          {/* Inventory Summary Mini-Card */}
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-5 hover:border-[var(--border-hover)] transition-colors duration-200">
            <div className="text-sm font-semibold text-[var(--text-primary)] mb-3">Bestandswert</div>
            <div className="text-[22px] font-bold text-[var(--text-primary)] tracking-tight">
              {formatCurrency(inventoryValue, primaryCurrency)}
            </div>
            {valueByCurrency.size > 1 && (
              <div className="text-xs text-[var(--text-tertiary)] mt-1">
                {[...valueByCurrency.entries()]
                  .filter(([currency]) => currency !== primaryCurrency)
                  .map(([currency, amount]) => `${currency} ${formatNumber(Math.round(amount))}`)
                  .join(', ')}
              </div>
            )}
            <div className="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-[var(--border)]">
              <div>
                <div className="text-[11px] text-[var(--text-tertiary)] font-medium">Physisch</div>
                <div className="text-sm font-semibold text-[var(--text-primary)] mt-0.5">{formatNumber(inventoryPhysicalQuantity)}</div>
              </div>
              <div>
                <div className="text-[11px] text-[var(--text-tertiary)] font-medium">Reserviert</div>
                <div className="text-sm font-semibold text-[var(--text-primary)] mt-0.5">{formatNumber(inventoryReservedQuantity)}</div>
              </div>
              <div>
                <div className="text-[11px] text-[var(--text-tertiary)] font-medium">Verf{'\u00FC'}gbar</div>
                <div className="text-sm font-semibold text-[var(--text-primary)] mt-0.5">{formatNumber(inventoryQuantity)}</div>
              </div>
            </div>

            {/* Sync Status Bar */}
            {(syncCounts.synced + syncCounts.pending + syncCounts.failed) > 0 && (
              <div className="mt-4 pt-3 border-t border-[var(--border)]">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[11px] text-[var(--text-tertiary)] font-medium">Sync Status</div>
                  <div className="text-[11px] font-semibold text-[var(--text-primary)]">{syncPercentage}%</div>
                </div>
                <div className="flex h-1.5 rounded-full overflow-hidden bg-[var(--surface-secondary)]">
                  {syncCounts.synced > 0 && (
                    <div
                      className="h-full bg-[var(--success)] transition-all duration-500"
                      style={{ width: `${(syncCounts.synced / (syncCounts.synced + syncCounts.pending + syncCounts.failed)) * 100}%` }}
                    />
                  )}
                  {syncCounts.pending > 0 && (
                    <div
                      className="h-full bg-[var(--warning)] transition-all duration-500"
                      style={{ width: `${(syncCounts.pending / (syncCounts.synced + syncCounts.pending + syncCounts.failed)) * 100}%` }}
                    />
                  )}
                  {syncCounts.failed > 0 && (
                    <div
                      className="h-full bg-[var(--error)] transition-all duration-500"
                      style={{ width: `${(syncCounts.failed / (syncCounts.synced + syncCounts.pending + syncCounts.failed)) * 100}%` }}
                    />
                  )}
                </div>
                <div className="flex flex-wrap gap-3 mt-2">
                  {syncCounts.synced > 0 && (
                    <div className="flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)]" />
                      <span className="text-[10px] text-[var(--text-secondary)]">Synced ({syncCounts.synced})</span>
                    </div>
                  )}
                  {syncCounts.pending > 0 && (
                    <div className="flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning)]" />
                      <span className="text-[10px] text-[var(--text-secondary)]">Pending ({syncCounts.pending})</span>
                    </div>
                  )}
                  {syncCounts.failed > 0 && (
                    <div className="flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--error)]" />
                      <span className="text-[10px] text-[var(--text-secondary)]">Failed ({syncCounts.failed})</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};

export default Dashboard;
