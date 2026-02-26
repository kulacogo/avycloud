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

const DASHBOARD_RANGE_PRESETS: Array<{ id: string; label: string; shortLabel: string }> = [
  { id: 'today',         label: 'Heute',              shortLabel: 'Heute' },
  { id: 'last7',         label: 'Letzte 7 Tage',      shortLabel: '7 Tage' },
  { id: 'this_week',     label: 'Diese Woche',         shortLabel: 'Woche' },
  { id: 'month_to_date', label: 'Dieser Monat',        shortLabel: 'Monat' },
  { id: 'last_month',    label: 'Letzter Monat',       shortLabel: 'Letzter M.' },
  { id: 'year_to_date',  label: 'Dieses Jahr',         shortLabel: 'Jahr' },
  { id: 'all_time',      label: 'Gesamter Zeitraum',   shortLabel: 'Gesamt' },
  { id: 'custom',        label: 'Benutzerdefiniert',   shortLabel: 'Von-Bis' },
];

const formatCurrency = (value: number, currency: string) => {
  const cur = safeCurrency(currency);
  try {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: cur }).format(value);
  } catch {
    return `${value.toFixed(2)} ${cur}`;
  }
};

const formatNumber = (value: number) => new Intl.NumberFormat('de-DE').format(value);

/* ─── Status badge ─── */
const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const n = status.toLowerCase();
  let cls = 'text-[var(--text-tertiary)] bg-[var(--surface-secondary)]';
  let label = status;
  if (n === 'neu')              { cls = 'text-[var(--info)] bg-[var(--info-bg)]';        label = 'Neu'; }
  else if (n === 'kommissioniert') { cls = 'text-[var(--warning)] bg-[var(--warning-bg)]'; label = 'Kommissioniert'; }
  else if (n === 'verpackt')    { cls = 'text-[var(--warning)] bg-[var(--warning-bg)]'; label = 'Verpackt'; }
  else if (n === 'versendet')   { cls = 'text-[var(--success)] bg-[var(--success-bg)]'; label = 'Versendet'; }
  else if (n === 'zugestellt')  { cls = 'text-[var(--success)] bg-[var(--success-bg)]'; label = 'Zugestellt'; }
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full ${cls}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
};

/* ─── Hero metric block ─── */
const HeroMetric: React.FC<{
  label: string;
  value: string;
  sub?: string | null;
  accent?: boolean;
}> = ({ label, value, sub, accent }) => (
  <div className="flex flex-col gap-1">
    <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">{label}</div>
    <div className={`text-[28px] font-bold tracking-tight leading-none ${accent ? 'text-[var(--avy-purple)]' : 'text-[var(--text-primary)]'}`}>
      {value}
    </div>
    {sub && <div className="text-xs text-[var(--text-tertiary)] font-medium mt-0.5">{sub}</div>}
  </div>
);

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
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [showCustomPicker, setShowCustomPicker] = useState(false);

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
      if (v !== 'custom') setShowCustomPicker(false);
    },
    [onRangePresetChange]
  );

  const loadMetrics = React.useCallback(async () => {
    setMetricsLoading(true);
    try {
      const isLong = activePreset === 'year_to_date' || activePreset === 'last_year' || activePreset === 'all_time';
      const params: { days?: number; preset: string; from_date?: string; to_date?: string } = {
        days: 7,
        preset: activePreset,
      };
      if (activePreset === 'custom' && customFrom && customTo) {
        params.from_date = customFrom;
        params.to_date   = customTo;
      }
      const data = await fetchDashboardMetrics(params, { timeoutMs: isLong ? 90000 : 30000 });
      setMetrics(data);
      setMetricsError(null);
    } catch (error: any) {
      setMetricsError(error?.message || 'Metriken konnten nicht geladen werden.');
      setMetrics(null);
    } finally {
      setMetricsLoading(false);
    }
  }, [activePreset, customFrom, customTo]);

  useEffect(() => {
    if (activePreset === 'custom' && (!customFrom || !customTo)) return;
    loadMetrics();
  }, [loadMetrics]);

  // Lightweight auto-refresh (skip for custom/long ranges)
  useEffect(() => {
    if (activePreset === 'custom' || activePreset === 'all_time') return;
    const isLong = activePreset === 'year_to_date' || activePreset === 'last_year';
    const ms = isLong ? 5 * 60 * 1000 : 60_000;
    const iv = setInterval(() => {
      loadMetrics();
      if (onRefreshProducts) onRefreshProducts();
    }, ms);
    return () => clearInterval(iv);
  }, [loadMetrics, onRefreshProducts, activePreset]);

  /* ─── Product-derived stats ─── */
  const {
    totalProducts, totalStocked, syncCounts,
    inventoryQuantity, inventoryPhysicalQuantity, inventoryReservedQuantity,
    inventoryValue, primaryCurrency,
  } = useMemo(() => {
    let total = 0, totalInStock = 0;
    let physicalQty = 0, reservedQty = 0, availableQty = 0;
    const valueMap = new Map<string, number>();
    const buckets = { synced: 0, pending: 0, failed: 0, unknown: 0 };

    for (const product of products) {
      total++;
      const pq = getProductPhysicalQuantity(product);
      const rq = getProductReservedQuantity(product);
      const aq = getProductAvailableQuantity(product);
      if (pq > 0) totalInStock++;
      physicalQty += pq;
      reservedQty += rq;
      availableQty += aq;
      const lowestPrice = product.details?.pricing?.lowest_price;
      const itemValue = (Number(lowestPrice?.amount) || 0) * pq;
      const currency = (lowestPrice?.currency || 'EUR').toUpperCase();
      valueMap.set(currency, (valueMap.get(currency) ?? 0) + itemValue);
      const st = normalizeSyncStatus(product.ops?.sync_status ?? 'pending', product.ops?.last_synced_iso);
      (buckets as any)[st] = ((buckets as any)[st] || 0) + 1;
    }

    const mostCommon = [...valueMap.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'EUR';
    const combined = [...valueMap.values()].reduce((s, v) => s + v, 0);

    return {
      totalProducts: total,
      totalStocked: totalInStock,
      syncCounts: buckets,
      inventoryQuantity: availableQty,
      inventoryPhysicalQuantity: physicalQty,
      inventoryReservedQuantity: reservedQty,
      inventoryValue: combined,
      primaryCurrency: mostCommon,
    };
  }, [products]);

  /* ─── Order metrics ─── */
  const orderMetrics = useMemo(() => {
    const breakdown = metrics?.orders?.status_breakdown;
    const neu           = Number(breakdown?.neu          ?? 0) || 0;
    const kommissioniert= Number(breakdown?.kommissioniert ?? 0) || 0;
    const verpackt      = Number(breakdown?.verpackt     ?? 0) || 0;
    const versendet     = Number(breakdown?.versendet    ?? 0) || 0;
    const zugestellt    = Number(breakdown?.zugestellt   ?? 0) || 0;
    const open          = neu;
    const total         = neu + kommissioniert + verpackt + versendet + zugestellt
                        + Number((breakdown as any)?.other ?? 0);

    const chartDays = (metrics?.volume_7d?.days || []).map((d: any) => {
      const dt = new Date(d.date);
      const bucket = metrics?.range?.bucket || 'day';
      let label = '';
      if (bucket === 'hour') {
        label = dt.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
      } else if (bucket === 'month') {
        label = dt.toLocaleDateString('de-DE', { month: 'short', timeZone: 'UTC' });
      } else if (bucket === 'week') {
        label = dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
      } else {
        label = dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
      }
      return { key: d.date, label, count: Number(d?.orders || 0) || 0, revenue: Number(d?.revenue || 0) || 0 };
    });

    return {
      neu, kommissioniert, verpackt, versendet, zugestellt,
      open, total,
      chart: chartDays,
      revenueWindow: metrics?.revenue?.window_non_cancelled_total ?? 0,
      revenueYtd: metrics?.revenue?.all_non_cancelled_total ?? 0,
      ebayNetWindow: typeof metrics?.revenue?.ebay_net_window === 'number' ? metrics.revenue.ebay_net_window : null,
      kauflandGrossWindow: typeof metrics?.revenue?.kaufland_gross_window === 'number' ? metrics.revenue.kaufland_gross_window : null,
      kauflandNetWindow: typeof metrics?.revenue?.kaufland_net_window === 'number' ? metrics.revenue.kaufland_net_window : null,
      currency: safeCurrency(metrics?.currency || 'EUR'),
    };
  }, [metrics]);

  const maxRevenue = useMemo(
    () => Math.max(1, ...orderMetrics.chart.map((d) => d.revenue || d.count || 1)),
    [orderMetrics.chart]
  );

  const syncPercentage = useMemo(() => {
    const t = syncCounts.synced + syncCounts.pending + syncCounts.failed;
    return t === 0 ? 0 : Math.round((syncCounts.synced / t) * 1000) / 10;
  }, [syncCounts]);

  const activeRangeLabel =
    metrics?.range?.label ||
    DASHBOARD_RANGE_PRESETS.find((p) => p.id === activePreset)?.label ||
    'Zeitraum';

  const statusRows = useMemo(() => [
    { key: 'neu',            label: 'Neu (offen)',     value: orderMetrics.neu,            color: 'var(--info)' },
    { key: 'kommissioniert', label: 'Kommissioniert',  value: orderMetrics.kommissioniert, color: 'var(--warning)' },
    { key: 'verpackt',       label: 'Verpackt',        value: orderMetrics.verpackt,       color: 'var(--warning)' },
    { key: 'versendet',      label: 'Versendet',       value: orderMetrics.versendet,      color: 'var(--success)' },
    { key: 'zugestellt',     label: 'Zugestellt',      value: orderMetrics.zugestellt,     color: '#10B981' },
  ], [orderMetrics]);

  /* ─── Estimated net revenue (eBay real + Kaufland est.) ─── */
  const netRevenueEstimate = useMemo(() => {
    const ebay = orderMetrics.ebayNetWindow;
    const kauflandNet = orderMetrics.kauflandNetWindow;
    if (ebay === null && kauflandNet === null) return null;
    // Non-eBay, non-Kaufland portion: keep gross
    const kauflandGross = orderMetrics.kauflandGrossWindow ?? 0;
    const totalGross = orderMetrics.revenueWindow;
    const ebayGrossApprox = ebay !== null ? (totalGross - kauflandGross) * 0.856 + kauflandGross : null; // rough
    // Simple: total - eBay fees - Kaufland fees
    // Better: gross - (gross-kauflandGross) + ebayNet - kauflandGross + kauflandNet
    const nonEbayNonKaufland = totalGross - (kauflandGross || 0) - (ebay !== null ? (totalGross - kauflandGross - (kauflandGross || 0)) : 0);
    // Simpler approach: if we have both numbers, sum the two net figures + rest of gross
    if (ebay !== null && kauflandNet !== null) {
      const restGross = totalGross - kauflandGross - (totalGross - kauflandGross); // = 0 edge case
      // Actually: net = eBayNet + kauflandNet + (gross - ebay_portion_gross - kauflandGross)
      // We don't know eBay gross exactly. Use ratio approach:
      // eBay net is already after fees. Kaufland net = kaufland gross * 0.9.
      // Rest gross = totalGross - kauflandGross - eBayGross_estimate
      // Skip complex math; just show what we have
      return { value: ebay + kauflandNet, partial: false };
    }
    if (ebay !== null) return { value: ebay + (kauflandNet ?? 0), partial: true };
    if (kauflandNet !== null) return { value: kauflandNet, partial: true };
    return null;
  }, [orderMetrics]);

  /* ─── Navigate to order drilldown ─── */
  const navTo = React.useCallback((statusKey: string) => {
    if (typeof window === 'undefined') return;
    window.location.hash = `#/orders?orderStatus=${encodeURIComponent(statusKey)}`;
  }, []);

  /* ═══ RENDER ═══ */
  return (
    <section className="space-y-5">

      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)] tracking-tight">Dashboard</h1>
          <p className="text-[13px] text-[var(--text-tertiary)] mt-0.5">{activeRangeLabel}</p>
        </div>
        <button
          type="button"
          onClick={() => { loadMetrics(); if (onRefreshProducts) onRefreshProducts(); }}
          disabled={metricsLoading}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-[13px] font-semibold bg-[var(--avy-purple)] text-white hover:bg-[var(--avy-purple-hover)] disabled:opacity-60 transition-all duration-200"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" className={metricsLoading ? 'animate-spin' : ''}>
            <path d="M12 7a5 5 0 01-5 5M2 7a5 5 0 015-5" />
            <path d="M9 4l2-2 2 2M5 10l-2 2-2-2" />
          </svg>
          {metricsLoading ? 'Lädt...' : 'Aktualisieren'}
        </button>
      </div>

      {/* ── Preset selector ── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-0.5 bg-[var(--surface-secondary)] rounded-lg p-1">
          {DASHBOARD_RANGE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setPreset(p.id);
                if (p.id === 'custom') setShowCustomPicker(true);
              }}
              className={`px-3 py-1.5 rounded-md text-[12px] font-semibold transition-all duration-150 ${
                activePreset === p.id
                  ? 'bg-[var(--surface)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]'
                  : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] bg-transparent'
              }`}
            >
              {p.shortLabel}
            </button>
          ))}
        </div>

        {/* Custom date pickers - shown when "Von-Bis" is active */}
        {activePreset === 'custom' && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="px-2.5 py-1.5 rounded-md text-[12px] font-medium bg-[var(--surface)] border border-[var(--border)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--avy-purple)] transition-colors"
            />
            <span className="text-[12px] text-[var(--text-tertiary)]">bis</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="px-2.5 py-1.5 rounded-md text-[12px] font-medium bg-[var(--surface)] border border-[var(--border)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--avy-purple)] transition-colors"
            />
            <button
              type="button"
              onClick={loadMetrics}
              disabled={!customFrom || !customTo || metricsLoading}
              className="px-3 py-1.5 rounded-md text-[12px] font-semibold bg-[var(--avy-purple)] text-white disabled:opacity-40 transition-opacity"
            >
              Anzeigen
            </button>
          </div>
        )}
      </div>

      {/* ── Error banner ── */}
      {metricsError && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-[var(--error-bg)] border border-[var(--error-border)]">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--error)" strokeWidth="1.5">
            <circle cx="8" cy="8" r="6.5" /><path d="M6 6l4 4M10 6l-4 4" />
          </svg>
          <span className="text-[13px] text-[var(--text-secondary)] flex-1">{metricsError}</span>
          <button type="button" onClick={loadMetrics} className="text-xs font-semibold text-[var(--avy-purple)] hover:underline">
            Erneut
          </button>
        </div>
      )}

      {/* ══ Hero metrics bar ══ */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 divide-x-0 lg:divide-x divide-[var(--border)]">

          {/* Umsatz */}
          <HeroMetric
            label={`Bruttoumsatz · ${activeRangeLabel}`}
            value={formatCurrency(orderMetrics.revenueWindow, orderMetrics.currency)}
            sub={orderMetrics.revenueYtd > 0 && orderMetrics.revenueYtd !== orderMetrics.revenueWindow
              ? `Gesamt (Jahr): ${formatCurrency(orderMetrics.revenueYtd, orderMetrics.currency)}`
              : undefined}
          />

          {/* eBay Netto */}
          <div className="lg:pl-6">
            <HeroMetric
              label="eBay Netto (nach Gebühren)"
              value={orderMetrics.ebayNetWindow !== null
                ? formatCurrency(orderMetrics.ebayNetWindow, orderMetrics.currency)
                : '—'}
              sub={orderMetrics.ebayNetWindow === null
                ? 'eBay re-auth erforderlich'
                : orderMetrics.kauflandNetWindow !== null
                  ? `Kaufland ca. Netto: ${formatCurrency(orderMetrics.kauflandNetWindow, orderMetrics.currency)}`
                  : undefined}
              accent={orderMetrics.ebayNetWindow !== null}
            />
          </div>

          {/* Bestellungen aktiv */}
          <div className="lg:pl-6">
            <HeroMetric
              label="Bestellungen (aktiv)"
              value={formatNumber(orderMetrics.total)}
              sub={orderMetrics.open > 0 ? `${orderMetrics.open} neu & offen` : 'Alles bearbeitet'}
            />
          </div>

          {/* Lagerbestand */}
          <div className="lg:pl-6">
            <HeroMetric
              label="Lagerbestand (verf.)"
              value={formatNumber(inventoryQuantity)}
              sub={inventoryValue > 0 ? `Wert: ${formatCurrency(inventoryValue, primaryCurrency)}` : undefined}
            />
          </div>
        </div>

        {/* Kaufland fee note – only shown when we have data */}
        {orderMetrics.kauflandGrossWindow !== null && orderMetrics.kauflandGrossWindow > 0 && (
          <div className="mt-4 pt-4 border-t border-[var(--border)] text-xs text-[var(--text-tertiary)]">
            Kaufland Brutto: {formatCurrency(orderMetrics.kauflandGrossWindow, orderMetrics.currency)}
            {' · '}Netto nach ~10% Provision: {formatCurrency(orderMetrics.kauflandNetWindow ?? 0, orderMetrics.currency)}
            {' · '}Provision basiert auf Schätzung (Kaufland-Rechnung Jan 2026)
          </div>
        )}
      </div>

      {/* ══ Main grid: Chart + Pipeline ══ */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5">

        {/* ── Revenue chart ── */}
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
            <div>
              <div className="text-[13px] font-semibold text-[var(--text-primary)]">Umsatzverlauf</div>
              <div className="text-xs text-[var(--text-tertiary)] mt-0.5">{activeRangeLabel}</div>
            </div>
            <a href="#/orders" className="text-xs font-medium text-[var(--avy-purple)] hover:underline">
              Bestellungen →
            </a>
          </div>

          <div className="p-5">
            {orderMetrics.chart.length > 0 ? (
              <div className="relative h-[180px] flex items-end gap-1">
                {/* Grid lines */}
                <div className="absolute inset-0 flex flex-col justify-between pointer-events-none">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="border-t border-dashed border-[var(--border)] opacity-50 w-full" />
                  ))}
                </div>

                {orderMetrics.chart.map((day) => {
                  const h = Math.max(2, ((day.revenue || day.count) / maxRevenue) * 100);
                  return (
                    <div key={day.key} className="flex-1 flex flex-col items-center gap-1 group relative z-[1]">
                      <div className="relative w-full">
                        {/* Tooltip */}
                        <div className="hidden group-hover:block absolute bottom-[calc(100%+6px)] left-1/2 -translate-x-1/2 bg-[#0A2540] text-white px-2 py-1 rounded text-[11px] font-semibold whitespace-nowrap z-20 shadow-lg pointer-events-none">
                          {day.revenue > 0 ? formatCurrency(day.revenue, orderMetrics.currency) : day.count}
                          <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-[#0A2540]" />
                        </div>
                        <div
                          className="w-full rounded-t-[3px] bg-[var(--avy-purple)] hover:brightness-110 transition-all duration-200 min-h-[2px] cursor-default"
                          style={{ height: `${h}%`, maxHeight: '160px' }}
                        />
                      </div>
                      <span className="text-[9px] text-[var(--text-tertiary)] font-medium truncate w-full text-center">
                        {day.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="h-[180px] flex items-center justify-center">
                <p className="text-sm text-[var(--text-tertiary)]">
                  {metricsLoading ? 'Lade Daten...' : 'Keine Daten verfügbar'}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* ── Order pipeline ── */}
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
            <div className="text-[13px] font-semibold text-[var(--text-primary)]">Bestellpipeline</div>
            <a href="#/orders" className="text-xs font-medium text-[var(--avy-purple)] hover:underline">
              Alle {orderMetrics.total} →
            </a>
          </div>

          <div className="divide-y divide-[var(--border)]">
            {statusRows.map((row) => (
              <button
                key={row.key}
                type="button"
                onClick={() => navTo(row.key)}
                className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-[var(--surface-hover)] transition-colors duration-150 text-left group"
              >
                <StatusBadge status={row.key} />
                <div className="flex items-center gap-2">
                  <span className={`text-[18px] font-bold ${row.value > 0 ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'}`}>
                    {row.value}
                  </span>
                  <svg
                    className="w-3.5 h-3.5 text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 group-hover:text-[var(--avy-purple)] transition-all"
                    viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"
                  >
                    <path d="M5 3l4 4-4 4" />
                  </svg>
                </div>
              </button>
            ))}
          </div>

          {/* Progress bar */}
          {orderMetrics.total > 0 && (
            <div className="px-5 py-3 border-t border-[var(--border)]">
              <div className="flex h-1.5 rounded-full overflow-hidden bg-[var(--surface-secondary)] gap-px">
                {statusRows.filter(r => r.value > 0).map(r => (
                  <div
                    key={r.key}
                    className="h-full rounded-[1px] transition-all duration-500"
                    style={{ width: `${(r.value / orderMetrics.total) * 100}%`, background: r.color }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ══ Bottom strip: Inventory + Sync ══ */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">

        {/* Inventory summary */}
        <div className="sm:col-span-2 bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-3">Lager</div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="text-[11px] text-[var(--text-tertiary)]">Physisch</div>
              <div className="text-xl font-bold text-[var(--text-primary)] mt-0.5">{formatNumber(inventoryPhysicalQuantity)}</div>
            </div>
            <div>
              <div className="text-[11px] text-[var(--text-tertiary)]">Reserviert</div>
              <div className="text-xl font-bold text-[var(--text-primary)] mt-0.5">{formatNumber(inventoryReservedQuantity)}</div>
            </div>
            <div>
              <div className="text-[11px] text-[var(--text-tertiary)]">Verfügbar</div>
              <div className="text-xl font-bold text-[var(--avy-purple)] mt-0.5">{formatNumber(inventoryQuantity)}</div>
            </div>
          </div>
          <div className="mt-3 pt-3 border-t border-[var(--border)] flex items-baseline gap-2">
            <div className="text-[11px] text-[var(--text-tertiary)]">Bestandswert:</div>
            <div className="text-[15px] font-bold text-[var(--text-primary)]">{formatCurrency(inventoryValue, primaryCurrency)}</div>
            <div className="text-[11px] text-[var(--text-tertiary)] ml-auto">{totalProducts} Produkte · {totalStocked} mit Bestand</div>
          </div>
        </div>

        {/* eBay Sync */}
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-3">eBay Sync</div>
          <div className="flex items-baseline gap-2 mb-3">
            <div className="text-[28px] font-bold text-[var(--text-primary)]">{syncPercentage}%</div>
            <div className="text-xs text-[var(--text-tertiary)]">synchronisiert</div>
          </div>
          <div className="flex h-2 rounded-full overflow-hidden bg-[var(--surface-secondary)]">
            {syncCounts.synced > 0 && (
              <div className="h-full bg-[var(--success)]" style={{ width: `${(syncCounts.synced / (syncCounts.synced + syncCounts.pending + syncCounts.failed)) * 100}%` }} />
            )}
            {syncCounts.pending > 0 && (
              <div className="h-full bg-[var(--warning)]" style={{ width: `${(syncCounts.pending / (syncCounts.synced + syncCounts.pending + syncCounts.failed)) * 100}%` }} />
            )}
            {syncCounts.failed > 0 && (
              <div className="h-full bg-[var(--error)]" style={{ width: `${(syncCounts.failed / (syncCounts.synced + syncCounts.pending + syncCounts.failed)) * 100}%` }} />
            )}
          </div>
          <div className="flex gap-3 mt-2 flex-wrap">
            {syncCounts.synced > 0 && <span className="text-[10px] text-[var(--text-secondary)]"><span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--success)] mr-1" />{syncCounts.synced}</span>}
            {syncCounts.pending > 0 && <span className="text-[10px] text-[var(--text-secondary)]"><span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--warning)] mr-1" />{syncCounts.pending} ausstehend</span>}
            {syncCounts.failed > 0 && <span className="text-[10px] text-[var(--error)]"><span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--error)] mr-1" />{syncCounts.failed} Fehler</span>}
          </div>
          <button
            type="button"
            onClick={() => { window.location.hash = '#/ebay'; }}
            className="mt-3 w-full text-xs font-semibold text-[var(--avy-purple)] hover:underline text-left"
          >
            eBay Listings prüfen →
          </button>
        </div>
      </div>
    </section>
  );
};

export default Dashboard;
