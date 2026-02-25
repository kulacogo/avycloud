import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { DashboardMetrics, FinanceMetrics, Product } from '../types';
import { fetchDashboardMetrics, fetchFinanceMetrics } from '../api/client';
import {
  getProductAvailableQuantity,
  getProductPhysicalQuantity,
  getProductReservedQuantity,
  normalizeSyncStatus,
} from '../utils/product';

interface DashboardProps {
  products: Product[];
  onSelectProduct: (productId: string) => void;
  onRefreshProducts?: () => void | Promise<void>;
  rangePreset?: string;
  onRangePresetChange?: (preset: string) => void;
}

const PRESETS: Array<{ id: string; label: string; short: string }> = [
  { id: 'today', label: 'Heute', short: 'Heute' },
  { id: 'last7', label: 'Letzte 7 Tage', short: '7T' },
  { id: 'month_to_date', label: 'Dieser Monat', short: 'Monat' },
  { id: 'last_month', label: 'Letzter Monat', short: 'Vormonat' },
  { id: 'year_to_date', label: 'Dieses Jahr', short: 'YTD' },
  { id: 'last_year', label: 'Letztes Jahr', short: 'Vorjahr' },
];

const safeCurrency = (code?: string) => {
  const c = (code || '').toString().trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : 'EUR';
};

const fmt = (value: number, currency = 'EUR') => {
  try {
    return new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: safeCurrency(currency),
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${value.toFixed(0)} ${currency}`;
  }
};

const fmtNum = (n: number) => new Intl.NumberFormat('de-DE').format(n);

// ─── Micro components ────────────────────────────────────────────────────────

const Skeleton: React.FC<{ className?: string; style?: React.CSSProperties }> = ({ className = '', style }) => (
  <div className={`animate-pulse rounded bg-white/5 ${className}`} style={style} />
);

const SectionTitle: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <h2 className={`text-[11px] uppercase tracking-[0.15em] font-semibold text-slate-500 mb-3 ${className}`}>
    {children}
  </h2>
);

interface KpiCardProps {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  accent?: 'green' | 'red' | 'amber' | 'blue' | 'violet' | 'slate' | 'sky';
  onClick?: () => void;
  loading?: boolean;
  badge?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

const accentMap = {
  green: 'text-emerald-400',
  red: 'text-rose-400',
  amber: 'text-amber-400',
  blue: 'text-blue-400',
  violet: 'text-violet-400',
  slate: 'text-slate-200',
  sky: 'text-sky-400',
};

const KpiCard: React.FC<KpiCardProps> = ({
  label,
  value,
  sub,
  accent = 'slate',
  onClick,
  loading = false,
  badge,
  size = 'md',
}) => {
  const valueSize = size === 'lg' ? 'text-4xl' : size === 'sm' ? 'text-2xl' : 'text-3xl';
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { type: 'button', onClick } : {})}
      className={`group relative bg-slate-800/80 rounded-xl border border-white/5 p-4 text-left
        ${onClick ? 'cursor-pointer hover:bg-slate-700/60 hover:border-white/10 transition-colors' : ''}
      `}
    >
      {badge && (
        <span className="absolute top-3 right-3 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-white/10 text-slate-300">
          {badge}
        </span>
      )}
      <p className="text-[11px] uppercase tracking-wide text-slate-500 font-medium">{label}</p>
      {loading ? (
        <Skeleton className="h-8 w-24 mt-2" />
      ) : (
        <p className={`${valueSize} font-bold ${accentMap[accent]} mt-1 leading-none tabular-nums`}>
          {value}
        </p>
      )}
      {sub && !loading && (
        <p className="text-xs text-slate-500 mt-1.5 leading-snug">{sub}</p>
      )}
      {loading && <Skeleton className="h-3 w-16 mt-2" />}
    </Tag>
  );
};

// ─── Bar chart ───────────────────────────────────────────────────────────────

interface ChartDay {
  key: string;
  label: string;
  count: number;
  revenue: number;
}

const BarChart: React.FC<{ data: ChartDay[]; currency: string; loading?: boolean }> = ({
  data,
  currency,
  loading,
}) => {
  const maxCount = Math.max(1, ...data.map((d) => d.count));
  const maxRevenue = Math.max(1, ...data.map((d) => d.revenue));

  if (loading) {
    return (
      <div className="flex items-end gap-1.5 h-28">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="flex-1 flex flex-col items-center gap-1">
            <Skeleton className={`w-full rounded-t`} style={{ height: `${Math.random() * 70 + 20}%` } as any} />
          </div>
        ))}
      </div>
    );
  }

  if (!data.length) {
    return (
      <div className="flex items-center justify-center h-28 text-sm text-slate-500">
        Keine Daten verfügbar
      </div>
    );
  }

  return (
    <div className="flex items-end gap-1 h-28">
      {data.map((d) => {
        const barH = Math.max(4, Math.round((d.count / maxCount) * 100));
        const revH = Math.max(2, Math.round((d.revenue / maxRevenue) * 100));
        return (
          <div
            key={d.key}
            title={`${d.label}: ${d.count} Aufträge · ${fmt(d.revenue, currency)}`}
            className="group flex-1 flex flex-col items-center gap-1 relative"
          >
            {/* Revenue bar (behind, lighter) */}
            <div className="w-full flex items-end h-20 relative">
              <div
                className="absolute bottom-0 w-full bg-emerald-500/20 rounded-t"
                style={{ height: `${revH}%` }}
              />
              {/* Orders bar (front) */}
              <div
                className="relative w-full bg-sky-500 rounded-t transition-all"
                style={{ height: `${barH}%` }}
              />
            </div>
            <span className="text-[10px] text-slate-500 leading-none">{d.label}</span>
            <span className="text-[10px] font-semibold text-slate-300 tabular-nums leading-none">{d.count}</span>
            {/* Hover tooltip */}
            <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 hidden group-hover:block z-10 whitespace-nowrap bg-slate-900 border border-white/10 rounded px-2 py-1 text-[10px] text-slate-200 shadow-lg pointer-events-none">
              <div className="font-semibold">{d.label}</div>
              <div>{d.count} Aufträge</div>
              <div className="text-emerald-400">{fmt(d.revenue, currency)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

// ─── Order pipeline ──────────────────────────────────────────────────────────

const PIPELINE_STEPS = [
  { key: 'neu', label: 'Offen', color: 'bg-amber-500' },
  { key: 'kommissioniert', label: 'Komm.', color: 'bg-blue-500' },
  { key: 'verpackt', label: 'Verpackt', color: 'bg-indigo-500' },
  { key: 'versendet', label: 'Versendet', color: 'bg-violet-500' },
  { key: 'zugestellt', label: 'Zugestellt', color: 'bg-emerald-500' },
];

interface PipelineProps {
  breakdown: Record<string, number>;
  onClickStatus: (key: string) => void;
  loading?: boolean;
}

const OrderPipeline: React.FC<PipelineProps> = ({ breakdown, onClickStatus, loading }) => {
  const total = PIPELINE_STEPS.reduce((s, step) => s + (breakdown[step.key] || 0), 0);

  return (
    <div className="space-y-3">
      {/* Progress bar */}
      {!loading && total > 0 && (
        <div className="flex h-1.5 rounded-full overflow-hidden gap-px">
          {PIPELINE_STEPS.map((step) => {
            const count = breakdown[step.key] || 0;
            const pct = (count / total) * 100;
            if (!pct) return null;
            return (
              <div
                key={step.key}
                className={`${step.color} transition-all`}
                style={{ width: `${pct}%` }}
                title={`${step.label}: ${count}`}
              />
            );
          })}
        </div>
      )}
      {loading && <Skeleton className="h-1.5 w-full rounded-full" />}
      {/* Step cards */}
      <div className="grid grid-cols-5 gap-2">
        {PIPELINE_STEPS.map((step) => {
          const count = breakdown[step.key] || 0;
          return (
            <button
              key={step.key}
              type="button"
              onClick={() => onClickStatus(step.key)}
              className="flex flex-col items-center gap-1.5 p-2 rounded-lg bg-slate-900/60 hover:bg-slate-900/80 border border-white/5 transition-colors cursor-pointer"
            >
              <div className={`w-2 h-2 rounded-full ${step.color}`} />
              <span className="text-[10px] uppercase tracking-wide text-slate-500">{step.label}</span>
              {loading ? (
                <Skeleton className="h-6 w-8" />
              ) : (
                <span className="text-xl font-bold text-white tabular-nums">{fmtNum(count)}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

// ─── Main component ──────────────────────────────────────────────────────────

export const Dashboard: React.FC<DashboardProps> = ({
  products,
  onSelectProduct: _onSelectProduct,
  onRefreshProducts,
  rangePreset,
  onRangePresetChange,
}) => {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [metricsError, setMetricsError] = useState<string | null>(null);

  const [finance, setFinance] = useState<FinanceMetrics | null>(null);
  const [financeLoading, setFinanceLoading] = useState(true);

  const [internalPreset, setInternalPreset] = useState('last7');
  const activePreset = useMemo(() => {
    const raw = typeof rangePreset === 'string' ? rangePreset.trim() : '';
    return raw && PRESETS.some((p) => p.id === raw) ? raw : internalPreset;
  }, [rangePreset, internalPreset]);

  const setPreset = useCallback(
    (next: string) => {
      if (onRangePresetChange) {
        onRangePresetChange(next);
      } else {
        setInternalPreset(next);
      }
    },
    [onRangePresetChange]
  );

  const loadMetrics = useCallback(async () => {
    setMetricsLoading(true);
    try {
      const longRange = activePreset === 'year_to_date' || activePreset === 'last_year';
      const data = await fetchDashboardMetrics(
        { days: 7, preset: activePreset },
        { timeoutMs: longRange ? 60000 : 25000 }
      );
      setMetrics(data);
      setMetricsError(null);
    } catch (e: any) {
      setMetricsError(e?.message || 'Fehler beim Laden der Metriken');
    } finally {
      setMetricsLoading(false);
    }
  }, [activePreset]);

  const loadFinance = useCallback(async () => {
    setFinanceLoading(true);
    try {
      const data = await fetchFinanceMetrics(activePreset, { timeoutMs: 40000 });
      setFinance(data);
    } catch {
      setFinance(null);
    } finally {
      setFinanceLoading(false);
    }
  }, [activePreset]);

  useEffect(() => {
    loadMetrics();
    loadFinance();
  }, [loadMetrics, loadFinance]);

  // Auto-refresh
  useEffect(() => {
    const longRange = activePreset === 'year_to_date' || activePreset === 'last_year';
    const ms = longRange ? 5 * 60 * 1000 : 60_000;
    const id = setInterval(() => {
      loadMetrics();
      loadFinance();
      onRefreshProducts?.();
    }, ms);
    return () => clearInterval(id);
  }, [loadMetrics, loadFinance, onRefreshProducts, activePreset]);

  // ─── Derived inventory stats ──────────────────────────────────────────────

  const inv = useMemo(() => {
    let physical = 0, reserved = 0, available = 0;
    let valueCur = new Map<string, number>();
    const sync = { synced: 0, pending: 0, failed: 0 };

    for (const p of products) {
      const ph = getProductPhysicalQuantity(p);
      const res = getProductReservedQuantity(p);
      const avail = getProductAvailableQuantity(p);
      physical += ph;
      reserved += res;
      available += avail;

      const price = p.details?.pricing?.lowest_price;
      const cur = safeCurrency(price?.currency);
      valueCur.set(cur, (valueCur.get(cur) ?? 0) + avail * (price?.amount ?? 0));

      const s = normalizeSyncStatus(p.ops?.sync_status ?? 'pending', p.ops?.last_synced_iso);
      sync[s]++;
    }

    const [primaryCur] = [...valueCur.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['EUR', 0];
    const totalValue = [...valueCur.values()].reduce((s, v) => s + v, 0);
    const inStock = products.filter((p) => getProductPhysicalQuantity(p) > 0).length;

    return { physical, reserved, available, totalValue, primaryCur, inStock, total: products.length, sync };
  }, [products]);

  // ─── Derived order / revenue stats ───────────────────────────────────────

  const orderStats = useMemo(() => {
    const bd = metrics?.orders?.status_breakdown;
    const chartDays = metrics?.volume_7d?.days ?? [];
    const bucket = metrics?.range?.bucket ?? 'day';
    const bucketCount = chartDays.length;

    const chart: ChartDay[] = chartDays.map((d) => {
      const dt = (() => { try { return new Date(d.date); } catch { return null; } })();
      const label = (() => {
        if (!dt) return d.date;
        if (bucket === 'month') return dt.toLocaleDateString('de-DE', { month: 'short' });
        if (bucket === 'week') return dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
        if (bucket === 'hour') return dt.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        if (bucketCount <= 14) return dt.toLocaleDateString('de-DE', { weekday: 'short' });
        return dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
      })();
      return { key: d.date, label, count: Number(d.orders || 0), revenue: Number(d.revenue || 0) };
    });

    return {
      neu: bd?.neu ?? 0,
      kommissioniert: bd?.kommissioniert ?? 0,
      verpackt: (bd as any)?.verpackt ?? 0,
      versendet: bd?.versendet ?? 0,
      zugestellt: bd?.zugestellt ?? 0,
      cancelled: bd?.cancelled ?? 0,
      revenueYtd: metrics?.revenue?.all_non_cancelled_total ?? 0,
      revenueWindow: metrics?.revenue?.window_non_cancelled_total ?? 0,
      currency: safeCurrency(metrics?.currency),
      chart,
    };
  }, [metrics]);

  const presetLabel =
    metrics?.range?.label ?? PRESETS.find((p) => p.id === activePreset)?.label ?? activePreset;

  const navigateToDrilldown = useCallback((statusKey: string) => {
    const target = statusKey === 'neu' ? 'inventory' : 'products';
    window.location.hash = `#/${target}?orderStatus=${encodeURIComponent(statusKey)}`;
  }, []);

  // ─── Finance helpers ──────────────────────────────────────────────────────

  const shippingWindow = finance?.shipping?.total_cost ?? null;
  const shippingYtd = finance?.shipping_ytd?.total_cost ?? null;
  const revenueAfterShipping =
    shippingWindow !== null ? orderStats.revenueWindow - shippingWindow : null;

  const lastUpdated = metrics?.generated_at_iso
    ? new Date(metrics.generated_at_iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
    : null;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-8 pb-8">

      {/* ── Header ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Operations Dashboard</h1>
          {lastUpdated && (
            <p className="text-xs text-slate-500 mt-0.5">Zuletzt aktualisiert: {lastUpdated}</p>
          )}
        </div>
        {/* Preset tabs */}
        <div className="flex items-center gap-1 flex-wrap">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPreset(p.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                activePreset === p.id
                  ? 'bg-sky-600 text-white'
                  : 'text-slate-400 hover:text-white hover:bg-white/5'
              }`}
            >
              {p.short}
            </button>
          ))}
        </div>
      </div>

      {metricsError && (
        <div className="rounded-xl border border-rose-500/20 bg-rose-900/20 p-3 text-sm text-rose-300">
          {metricsError}
        </div>
      )}

      {/* ── Auftragsfluss ── */}
      <div>
        <SectionTitle>Auftragsfluss — aktuell</SectionTitle>
        <div className="bg-slate-800/60 rounded-2xl border border-white/5 p-5 space-y-4">
          <OrderPipeline
            breakdown={{
              neu: orderStats.neu,
              kommissioniert: orderStats.kommissioniert,
              verpackt: orderStats.verpackt,
              versendet: orderStats.versendet,
              zugestellt: orderStats.zugestellt,
            }}
            onClickStatus={navigateToDrilldown}
            loading={metricsLoading}
          />
          <p className="text-xs text-slate-600">Klicke auf einen Schritt für den Drilldown</p>
        </div>
      </div>

      {/* ── Zeitraum KPIs ── */}
      <div>
        <SectionTitle>Zeitraum — {presetLabel}</SectionTitle>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard
            label="Umsatz (Brutto)"
            value={fmt(orderStats.revenueWindow, orderStats.currency)}
            sub={`inkl. MwSt · ${presetLabel}`}
            accent="green"
            loading={metricsLoading}
            size="md"
          />
          <KpiCard
            label="Versandkosten"
            value={shippingWindow !== null ? fmt(shippingWindow, 'EUR') : '—'}
            sub={finance?.errors?.some(e => e.startsWith('SendCloud')) ? 'SendCloud nicht verfügbar' : `${finance?.shipping?.parcel_count ?? '…'} Sendungen`}
            accent="amber"
            loading={financeLoading && shippingWindow === null}
          />
          <KpiCard
            label="Umsatz nach Versand"
            value={revenueAfterShipping !== null ? fmt(revenueAfterShipping, orderStats.currency) : '—'}
            sub="Brutto − Versandkosten"
            accent={revenueAfterShipping !== null && revenueAfterShipping >= 0 ? 'green' : 'red'}
            loading={metricsLoading || (financeLoading && shippingWindow === null)}
          />
          <KpiCard
            label="Aufträge"
            value={fmtNum(
              orderStats.neu +
                orderStats.kommissioniert +
                orderStats.verpackt +
                orderStats.versendet +
                orderStats.zugestellt
            )}
            sub={`${presetLabel} · nicht storniert`}
            accent="sky"
            loading={metricsLoading}
          />
        </div>
      </div>

      {/* ── Chart ── */}
      <div className="bg-slate-800/60 rounded-2xl border border-white/5 p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-500">Auftragsvolumen</p>
            <p className="text-base font-semibold text-white">{presetLabel}</p>
          </div>
          <div className="flex items-center gap-3 text-[10px] text-slate-500">
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-sm bg-sky-500" />
              Aufträge
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-500/30" />
              Umsatz
            </span>
          </div>
        </div>
        <BarChart
          data={orderStats.chart}
          currency={orderStats.currency}
          loading={metricsLoading}
        />
      </div>

      {/* ── Jahresüberblick + Finanzen ── */}
      <div>
        <SectionTitle>Finanzen & Jahresüberblick</SectionTitle>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {/* YTD Revenue */}
          <KpiCard
            label="Umsatz YTD (Brutto)"
            value={fmt(orderStats.revenueYtd, orderStats.currency)}
            sub="Seit 1. Januar · nicht storniert"
            accent="green"
            loading={metricsLoading}
          />
          {/* YTD Shipping */}
          <KpiCard
            label="Versandkosten YTD"
            value={shippingYtd !== null ? fmt(shippingYtd, 'EUR') : '—'}
            sub={`${finance?.shipping_ytd?.parcel_count ?? '…'} Sendungen`}
            accent="amber"
            loading={financeLoading && shippingYtd === null}
          />
          {/* Bank accounts */}
          {finance?.accounts?.length ? (
            finance.accounts.map((acc) => (
              <KpiCard
                key={acc.id}
                label={acc.name}
                value={fmt(acc.balance, acc.currency)}
                sub="Kontostand"
                accent={acc.balance >= 0 ? 'violet' : 'red'}
                loading={financeLoading}
              />
            ))
          ) : (
            <KpiCard
              label="Kontostände"
              value={financeLoading ? '…' : '—'}
              sub={
                finance?.errors?.some(e => e.startsWith('SevDesk'))
                  ? 'SevDesk nicht verfügbar'
                  : 'Keine Konten konfiguriert'
              }
              accent="violet"
              loading={financeLoading}
            />
          )}
        </div>
        {finance?.errors && finance.errors.length > 0 && (
          <div className="mt-2 space-y-1">
            {finance.errors.map((err, i) => (
              <p key={i} className="text-xs text-amber-500/80">{err}</p>
            ))}
          </div>
        )}
      </div>

      {/* ── Bestand ── */}
      <div>
        <SectionTitle>Bestand</SectionTitle>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard
            label="Produkte im Bestand"
            value={fmtNum(inv.inStock)}
            sub={`von ${fmtNum(inv.total)} gesamt`}
            accent="sky"
          />
          <KpiCard
            label="Verfügbare Einheiten"
            value={fmtNum(inv.available)}
            sub={`${fmtNum(inv.physical)} physisch · ${fmtNum(inv.reserved)} reserviert`}
            accent="sky"
          />
          <KpiCard
            label="Bestandswert"
            value={fmt(inv.totalValue, inv.primaryCur)}
            sub="Verfügbar · Verkaufspreis"
            accent="green"
          />
          <KpiCard
            label="Sync-Status"
            value={`${fmtNum(inv.sync.synced)} / ${fmtNum(inv.total)}`}
            sub={
              <>
                {inv.sync.pending > 0 && (
                  <span className="text-amber-400">{inv.sync.pending} ausstehend</span>
                )}
                {inv.sync.failed > 0 && (
                  <span className="text-rose-400 ml-1">{inv.sync.failed} fehlerhaft</span>
                )}
                {inv.sync.pending === 0 && inv.sync.failed === 0 && 'Alle synchronisiert'}
              </>
            }
            accent={inv.sync.failed > 0 ? 'red' : inv.sync.pending > 0 ? 'amber' : 'green'}
          />
        </div>
      </div>

    </div>
  );
};

export default Dashboard;
