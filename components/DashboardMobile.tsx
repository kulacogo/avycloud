import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DashboardMetrics, FinanceMetrics, Order, Product } from '../types';
import { getProductAvailableQuantity, getProductPhysicalQuantity } from '../utils/product';
import {
  fetchDashboardMetrics,
  fetchFinanceMetrics,
  fetchOrders as fetchOrdersApi,
  syncOrders as syncOrdersApi,
} from '../api/client';
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

const PRESETS: Array<{ id: string; label: string }> = [
  { id: 'today', label: 'Heute' },
  { id: 'last7', label: '7 Tage' },
  { id: 'month_to_date', label: 'Monat' },
  { id: 'last_month', label: 'Vormonat' },
  { id: 'year_to_date', label: 'YTD' },
  { id: 'last_year', label: 'Vorjahr' },
];

const safeCur = (c?: string) => (/^[A-Z]{3}$/.test((c || '').toUpperCase()) ? c!.toUpperCase() : 'EUR');

const fmt = (v: number, c = 'EUR') => {
  try {
    return new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: safeCur(c),
      maximumFractionDigits: 0,
    }).format(v);
  } catch {
    return `${v.toFixed(0)} ${c}`;
  }
};

// ─── Micro components ────────────────────────────────────────────────────────

const Skeleton: React.FC<{ w?: string; h?: string }> = ({ w = 'w-16', h = 'h-5' }) => (
  <div className={`animate-pulse rounded bg-white/8 ${w} ${h}`} />
);

interface TileProps {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'default' | 'warn' | 'success' | 'violet' | 'sky';
  onClick?: () => void;
  loading?: boolean;
  disabled?: boolean;
}

const toneClasses: Record<NonNullable<TileProps['tone']>, string> = {
  default: 'bg-slate-800 border border-white/5',
  warn: 'bg-amber-600',
  success: 'bg-emerald-600',
  violet: 'bg-violet-700/60 border border-violet-500/20',
  sky: 'bg-sky-700/60 border border-sky-500/20',
};

const Tile: React.FC<TileProps> = ({ label, value, sub, tone = 'default', onClick, loading, disabled }) => {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { type: 'button', onClick, disabled: disabled ?? false } : {})}
      className={`w-full rounded-2xl p-4 text-left ${toneClasses[tone]} transition active:scale-[0.985] disabled:opacity-40`}
    >
      <p className="text-[10px] uppercase tracking-widest opacity-70 font-medium">{label}</p>
      {loading ? (
        <Skeleton w="w-20" h="h-7" />
      ) : (
        <p className="text-2xl font-bold text-white mt-1 tabular-nums leading-tight">{value}</p>
      )}
      {sub && !loading && (
        <p className="text-[11px] mt-1 opacity-70 leading-snug">{sub}</p>
      )}
    </Tag>
  );
};

const Divider: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex items-center gap-2 mt-1">
    <span className="text-[10px] uppercase tracking-widest text-slate-600 font-semibold">{label}</span>
    <div className="flex-1 h-px bg-slate-700/60" />
  </div>
);

// ─── Mini bar chart ──────────────────────────────────────────────────────────

const MiniChart: React.FC<{
  days: Array<{ date: string; orders: number; revenue: number }>;
  currency: string;
}> = ({ days, currency }) => {
  const max = Math.max(1, ...days.map(d => d.orders));
  const total = days.reduce((s, d) => s + d.orders, 0);
  return (
    <div>
      <div className="flex items-end gap-1 h-14">
        {days.map((d) => {
          const h = Math.max(4, Math.round((d.orders / max) * 100));
          return (
            <div key={d.date} className="flex-1 flex flex-col items-center justify-end gap-0.5">
              <div
                className="w-full bg-sky-500/80 rounded-t"
                style={{ height: `${h}%` }}
                title={`${d.date}: ${d.orders} Aufträge · ${fmt(d.revenue, currency)}`}
              />
            </div>
          );
        })}
      </div>
      <p className="text-[10px] text-slate-600 mt-1 text-right">{total} Aufträge gesamt</p>
    </div>
  );
};

// ─── Main component ──────────────────────────────────────────────────────────

const DashboardMobile: React.FC<DashboardMobileProps> = ({
  products,
  onRefreshProducts,
  onNavigate,
  isLoading,
  rangePreset,
  onRangePresetChange,
}) => {
  const { locale } = useI18n();
  const intlLocale = locale === 'de' ? 'de-DE' : locale === 'tr' ? 'tr-TR' : 'en-GB';

  const [orders, setOrders] = useState<Order[]>([]);
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [finance, setFinance] = useState<FinanceMetrics | null>(null);
  const [financeLoading, setFinanceLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const inFlightRef = useRef(false);
  const unmountedRef = useRef(false);

  const [internalPreset, setInternalPreset] = useState('last7');
  const activePreset = useMemo(() => {
    const raw = typeof rangePreset === 'string' ? rangePreset.trim() : '';
    return raw && PRESETS.some(p => p.id === raw) ? raw : internalPreset;
  }, [rangePreset, internalPreset]);

  const setPreset = useCallback((next: string) => {
    if (onRangePresetChange) onRangePresetChange(next);
    else setInternalPreset(next);
  }, [onRangePresetChange]);

  const loadAll = useCallback(async ({ withSync }: { withSync: boolean }) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const longRange = activePreset === 'year_to_date' || activePreset === 'last_year';

      // Kick off all loads in parallel
      const [, ordersData, metricsData, financeData] = await Promise.allSettled([
        withSync ? syncOrdersApi({ timeoutMs: 20000 }).catch(() => null) : Promise.resolve(null),
        fetchOrdersApi(100, { timeoutMs: 20000 }),
        fetchDashboardMetrics({ days: 7, preset: activePreset }, { timeoutMs: longRange ? 60000 : 20000 }),
        fetchFinanceMetrics(activePreset, { timeoutMs: 35000 }),
      ]);

      if (unmountedRef.current) return;

      if (ordersData.status === 'fulfilled') {
        const raw = (ordersData.value ?? []) as Order[];
        // Deduplicate
        const seen = new Set<string>();
        setOrders(raw.filter(o => {
          const k = o.baselinkerOrderKey || `${o.baselinkerId}::${o.orderSource}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        }));
      }
      if (metricsData.status === 'fulfilled') {
        setMetrics(metricsData.value);
        setMetricsLoading(false);
      } else {
        setMetricsLoading(false);
      }
      if (financeData.status === 'fulfilled') {
        setFinance(financeData.value);
        setFinanceLoading(false);
      } else {
        setFinanceLoading(false);
      }

      setLastUpdated(new Date());
    } finally {
      inFlightRef.current = false;
    }
  }, [activePreset]);

  useEffect(() => {
    unmountedRef.current = false;
    setMetricsLoading(true);
    setFinanceLoading(true);
    void loadAll({ withSync: true });
    const interval = setInterval(
      () => void loadAll({ withSync: false }),
      activePreset === 'year_to_date' || activePreset === 'last_year' ? 5 * 60_000 : 60_000
    );
    return () => {
      unmountedRef.current = true;
      clearInterval(interval);
    };
  }, [loadAll, activePreset]);

  const nav = useCallback((view: string) => {
    if (onNavigate) { onNavigate(view); return; }
    const map: Record<string, string> = {
      home: '#/home', search: '#/search',
      'operations-pick': '#/operations/pick',
      'operations-stow': '#/operations/stow',
      'operations-identify': '#/operations/identify',
    };
    window.location.hash = map[view] || `#/${view}`;
  }, [onNavigate]);

  // ─── Derived data ─────────────────────────────────────────────────────────

  const openOrders = useMemo(() => orders.filter(o => o.status === 'new'), [orders]);

  const nextPick = useMemo(() => {
    const norm = (v?: string | null) => (v || '').replace(/\s+/g, '').toUpperCase().replace(/^SKU[-_\s]*/i, '');
    for (const order of openOrders) {
      const items = Array.isArray((order as any).items) ? (order as any).items : [];
      for (const item of items) {
        if (item.pickCompleted) continue;
        const qty = Number(item.quantity || 0);
        if (!qty) continue;
        const sku = norm(item.sku) || norm(item.ean) || item.id;
        const hint = item.pickHint as any;
        const prod = products.find(p => {
          const vals = [
            p.identification?.sku, p.details?.identifiers?.sku,
            p.details?.identifiers?.ean, p.id,
            ...(p.identification?.barcodes || []),
          ].filter(Boolean).map(v => norm(String(v)));
          return vals.includes(sku);
        });
        const bins = (prod?.storageBins || []).filter(b => (b.quantity || 0) > 0);
        const bin = bins.sort((a, b) => (b.quantity - a.quantity) || compareBinCodesForPickRoute(a.code, b.code))[0];
        return {
          sku,
          binCode: bin?.code || prod?.storage?.binCode || hint?.binCode || '',
          name: hint?.productName || prod?.identification?.name || item.name,
          qty,
        };
      }
    }
    return null;
  }, [openOrders, products]);

  const stowBacklog = useMemo(
    () => products.filter(p => getProductPhysicalQuantity(p) > 0 && !p.storage?.binCode).length,
    [products]
  );

  const invValue = useMemo(() => {
    const priced = products.filter(p => (p.details?.pricing?.lowest_price?.amount || 0) > 0);
    return priced.reduce(
      (s, p) => s + getProductAvailableQuantity(p) * (p.details?.pricing?.lowest_price?.amount || 0),
      0
    );
  }, [products]);

  const chartDays = metrics?.volume_7d?.days ?? [];
  const currency = safeCur(metrics?.currency);
  const revenueWindow = metrics?.revenue?.window_non_cancelled_total ?? 0;
  const revenueYtd = metrics?.revenue?.all_non_cancelled_total ?? 0;
  const shippingWindow = finance?.shipping?.total_cost ?? null;
  const shippingYtd = finance?.shipping_ytd?.total_cost ?? null;
  const presetLabel = metrics?.range?.label ?? PRESETS.find(p => p.id === activePreset)?.label ?? activePreset;

  const bd = metrics?.orders?.status_breakdown;
  const totalOrders = (bd?.neu ?? 0) + (bd?.kommissioniert ?? 0) + ((bd as any)?.verpackt ?? 0)
    + (bd?.versendet ?? 0) + (bd?.zugestellt ?? 0);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3 max-w-xl mx-auto pb-6">

      {/* Header */}
      <div className="flex items-center justify-between gap-2 pt-1">
        <div>
          <h1 className="text-xl font-bold text-white">Dashboard</h1>
          {lastUpdated && (
            <p className="text-[10px] text-slate-600">
              {lastUpdated.toLocaleString(intlLocale, { hour: '2-digit', minute: '2-digit' })}
            </p>
          )}
        </div>
        {/* Compact preset selector */}
        <select
          value={activePreset}
          onChange={e => setPreset(e.target.value)}
          className="text-xs rounded-lg bg-slate-800 border border-white/10 px-2 py-1.5 text-slate-200 outline-none"
        >
          {PRESETS.map(p => (
            <option key={p.id} value={p.id} className="bg-slate-900">{p.label}</option>
          ))}
        </select>
      </div>

      {products.length === 0 && (
        <div className="rounded-2xl border border-white/8 bg-slate-800/60 p-4 text-sm text-slate-400">
          {isLoading ? 'Lade Produkte…' : 'Keine Produkte geladen.'}
        </div>
      )}

      {/* ── Operative Aktionen ── */}
      <Divider label="Aktionen" />
      <div className="grid grid-cols-2 gap-2.5">
        <Tile
          tone="warn"
          label="Offene Aufträge"
          value={openOrders.length}
          sub={
            openOrders.length === 0
              ? 'Alles erledigt'
              : nextPick
                ? `Nächster: ${nextPick.binCode || '—'} · ${nextPick.sku}`
                : `${openOrders.length} zu picken`
          }
          onClick={() => nav('operations-pick')}
        />
        <Tile
          tone="success"
          label="Einlagern"
          value={stowBacklog}
          sub="Ohne Lagerplatz"
          onClick={() => nav('operations-stow')}
        />
        <Tile
          label="Suche"
          value="→ Suchen"
          sub="Produkt oder EAN"
          onClick={() => nav('search')}
        />
        <Tile
          tone="sky"
          label="Identifizieren"
          value="→ Scan"
          sub="Barcode / Foto"
          onClick={() => nav('operations-identify')}
        />
      </div>

      {/* ── Zeitraum ── */}
      <Divider label={presetLabel} />
      <div className="grid grid-cols-2 gap-2.5">
        <Tile
          label="Umsatz (Brutto)"
          value={metricsLoading ? '…' : fmt(revenueWindow, currency)}
          sub="inkl. MwSt"
          loading={metricsLoading}
        />
        <Tile
          label="Aufträge"
          value={metricsLoading ? '…' : totalOrders}
          sub="nicht storniert"
          loading={metricsLoading}
        />
        <Tile
          label="Versandkosten"
          value={financeLoading && shippingWindow === null ? '…' : shippingWindow !== null ? fmt(shippingWindow, 'EUR') : '—'}
          sub={`${finance?.shipping?.parcel_count ?? '—'} Sendungen`}
          loading={financeLoading && shippingWindow === null}
          tone="default"
        />
        <Tile
          label="Nach Versand"
          value={
            shippingWindow !== null && !metricsLoading
              ? fmt(revenueWindow - shippingWindow, currency)
              : '—'
          }
          sub="Brutto − Versand"
          loading={(metricsLoading || (financeLoading && shippingWindow === null))}
        />
      </div>

      {/* Mini chart */}
      {chartDays.length > 0 && (
        <div className="rounded-2xl bg-slate-800/60 border border-white/5 p-3">
          <MiniChart days={chartDays as any} currency={currency} />
        </div>
      )}

      {/* ── Finanzen ── */}
      <Divider label="Finanzen & YTD" />
      <div className="grid grid-cols-2 gap-2.5">
        <Tile
          label="Umsatz YTD"
          value={metricsLoading ? '…' : fmt(revenueYtd, currency)}
          sub="Seit 1. Januar"
          loading={metricsLoading}
        />
        <Tile
          label="Versandkosten YTD"
          value={shippingYtd !== null ? fmt(shippingYtd, 'EUR') : '—'}
          loading={financeLoading && shippingYtd === null}
        />
        {finance?.accounts?.map(acc => (
          <Tile
            key={acc.id}
            tone="violet"
            label={acc.name}
            value={fmt(acc.balance, acc.currency)}
            sub="Kontostand"
            loading={financeLoading}
          />
        ))}
        {!financeLoading && (!finance?.accounts || finance.accounts.length === 0) && (
          <Tile
            tone="violet"
            label="Kontostände"
            value="—"
            sub={finance?.errors?.length ? 'SevDesk nicht verfügbar' : 'Keine Konten'}
          />
        )}
      </div>

      {/* ── Bestand ── */}
      <Divider label="Bestand" />
      <div className="grid grid-cols-2 gap-2.5">
        <Tile
          label="Im Bestand"
          value={products.filter(p => getProductPhysicalQuantity(p) > 0).length}
          sub={`von ${products.length} Produkten`}
        />
        <Tile
          label="Einheiten"
          value={products.reduce((s, p) => s + getProductAvailableQuantity(p), 0)}
          sub="Verfügbar"
        />
        <Tile
          label="Bestandswert"
          value={fmt(invValue, 'EUR')}
          sub="Verkaufspreis · Verfügbar"
        />
        <Tile
          label="Sync"
          value={`${products.filter(p => p.ops?.sync_status === 'synced').length} / ${products.length}`}
          sub={
            products.filter(p => p.ops?.sync_status === 'failed').length > 0
              ? `${products.filter(p => p.ops?.sync_status === 'failed').length} fehlerhaft`
              : 'Synchronisiert'
          }
        />
      </div>

    </div>
  );
};

export default DashboardMobile;
