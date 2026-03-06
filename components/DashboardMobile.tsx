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

const PRESETS = [
  { id: 'today', label: 'Heute' },
  { id: 'last7', label: '7 Tage' },
  { id: 'month_to_date', label: 'Monat' },
  { id: 'last_month', label: 'Vormonat' },
  { id: 'year_to_date', label: 'Dieses Jahr' },
  { id: 'last_year', label: 'Vorjahr' },
];

const safeCur = (c?: string) =>
  /^[A-Z]{3}$/.test((c || '').toUpperCase()) ? (c as string).toUpperCase() : 'EUR';

const fmtCur = (v: number, c = 'EUR') => {
  try {
    return new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: safeCur(c),
      maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2,
    }).format(v);
  } catch {
    return `${v.toFixed(0)} ${c}`;
  }
};
const fmtNum = (n: number) => new Intl.NumberFormat('de-DE').format(n);

// ─── Skeleton ─────────────────────────────────────────────────────────────────
const Skel: React.FC<{ w?: string; h?: string }> = ({ w = 'w-20', h = 'h-7' }) => (
  <div className={`animate-pulse rounded bg-white/6 ${w} ${h}`} />
);

// ─── Tile ─────────────────────────────────────────────────────────────────────
interface TileProps {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  color?: 'default' | 'warn' | 'success' | 'violet' | 'red' | 'blue';
  onClick?: () => void;
  loading?: boolean;
}

const toneBase: Record<NonNullable<TileProps['color']>, string> = {
  default: 'bg-app-elevated border border-app-border',
  warn: 'bg-amber-600/90 border border-amber-500/30',
  success: 'bg-success border border-success/30',
  violet: 'bg-blue-800/60 border border-blue-500/20',
  red: 'bg-danger-dim border border-danger/30',
  blue: 'bg-accent-dim border border-accent/20',
};

const Tile: React.FC<TileProps> = ({ label, value, sub, color = 'default', onClick, loading }) => {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { type: 'button', onClick } : {})}
      className={`w-full rounded-2xl p-4 text-left transition active:scale-[0.98] ${toneBase[color]}`}
    >
      <p className="text-[10px] uppercase tracking-widest opacity-60 font-semibold">{label}</p>
      {loading ? <Skel /> : (
        <p className="text-2xl font-bold text-txt-primary mt-1 tabular-nums leading-tight">{value}</p>
      )}
      {sub && !loading && (
        <p className="text-[11px] mt-1 opacity-70 leading-snug">{sub}</p>
      )}
    </Tag>
  );
};

// ─── Row divider ──────────────────────────────────────────────────────────────
const RowLabel: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex items-center gap-2 mt-1">
    <span className="text-[10px] uppercase tracking-widest text-txt-muted font-bold">{label}</span>
    <div className="flex-1 h-px bg-app-elevated" />
  </div>
);

// ─── Mini bar chart (touch-interactive) ──────────────────────────────────────
const MiniChart: React.FC<{
  days: Array<{ date: string; orders: number; revenue: number }>;
  currency: string;
}> = ({ days, currency }) => {
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const max = Math.max(1, ...days.map(d => Number(d.orders || 0)));
  const maxRev = Math.max(1, ...days.map(d => Number(d.revenue || 0)));
  const total = days.reduce((s, d) => s + Number(d.orders || 0), 0);
  const totalRev = days.reduce((s, d) => s + Number(d.revenue || 0), 0);
  const sel = selectedIdx !== null ? days[selectedIdx] : null;
  return (
    <div>
      {/* Selected bar detail */}
      {sel && (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-accent-dim border border-accent/20 px-3 py-2 text-[11px] font-semibold text-accent">
          <span>{sel.date}</span>
          <span>{Number(sel.orders || 0)} Aufträge · {fmtCur(Number(sel.revenue || 0), currency)}</span>
        </div>
      )}
      <div
        className="flex items-end"
        style={{
          gap: days.length > 14 ? '2px' : '4px',
          height: `${Math.min(120, Math.max(72, days.length <= 7 ? 100 : 80))}px`,
        }}
      >
        {days.map((d, idx) => {
          const c = Number(d.orders || 0);
          const r = Number(d.revenue || 0);
          const bh = Math.max(4, Math.round((c / max) * 100));
          const rh = Math.max(2, Math.round((r / maxRev) * 100));
          const isSelected = selectedIdx === idx;
          return (
            <div key={d.date}
              className="relative flex-1 flex flex-col items-center justify-end h-full cursor-pointer"
              onClick={() => setSelectedIdx(isSelected ? null : idx)}
              onTouchEnd={(e) => { e.preventDefault(); setSelectedIdx(isSelected ? null : idx); }}
            >
              <div className="absolute bottom-0 w-full bg-success-dim rounded-t transition-opacity duration-200"
                style={{ height: `${rh}%`, opacity: selectedIdx !== null && !isSelected ? 0.3 : 1 }} />
              <div className="relative w-full rounded-t transition-all duration-200"
                style={{
                  height: `${bh}%`,
                  backgroundColor: isSelected ? 'rgb(56 189 248)' : 'rgba(56, 189, 248, 0.8)',
                  opacity: selectedIdx !== null && !isSelected ? 0.3 : 1,
                }} />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5">
        <span className="text-[10px] text-txt-muted">{total} Aufträge</span>
      </div>
    </div>
  );
};

// ─── Main ─────────────────────────────────────────────────────────────────────
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

  const [internalPreset, setInternalPreset] = useState('month_to_date');
  const isMonthPreset = (v: string) => /^month_\d{4}_\d{2}$/.test(v);
  const activePreset = useMemo(() => {
    const raw = typeof rangePreset === 'string' ? rangePreset.trim() : '';
    return raw && (PRESETS.some(p => p.id === raw) || isMonthPreset(raw)) ? raw : internalPreset;
  }, [rangePreset, internalPreset]);

  // Generate month options from Nov 2025 to current month (newest first)
  const monthOptions = useMemo(() => {
    const opts: { id: string; label: string }[] = [];
    const now = new Date();
    const start = new Date(Date.UTC(2025, 10, 1)); // Nov 2025
    let d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    while (d >= start) {
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth();
      const id = `month_${y}_${String(m + 1).padStart(2, '0')}`;
      const label = d.toLocaleString('de-DE', { month: 'short', year: '2-digit', timeZone: 'UTC' });
      opts.push({ id, label });
      d = new Date(Date.UTC(y, m - 1, 1));
    }
    return opts;
  }, []);

  const setPreset = useCallback((next: string) => {
    if (onRangePresetChange) onRangePresetChange(next);
    else setInternalPreset(next);
  }, [onRangePresetChange]);

  const loadAll = useCallback(async ({ withSync }: { withSync: boolean }) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const long = activePreset === 'year_to_date' || activePreset === 'last_year';
    try {
      const [, ordRes, metRes, finRes] = await Promise.allSettled([
        withSync ? syncOrdersApi({ timeoutMs: 20000 }).catch(() => null) : null,
        fetchOrdersApi(100, { timeoutMs: 20000 }),
        fetchDashboardMetrics({ days: 7, preset: activePreset }, { timeoutMs: long ? 60000 : 20000 }),
        fetchFinanceMetrics(activePreset, { timeoutMs: 35000 }),
      ]);
      if (unmountedRef.current) return;
      if (ordRes.status === 'fulfilled') {
        const seen = new Set<string>();
        setOrders((ordRes.value ?? []).filter((o: Order) => {
          const k = o.baselinkerOrderKey || `${o.baselinkerId}::${o.orderSource}`;
          return seen.has(k) ? false : (seen.add(k), true);
        }));
      }
      if (metRes.status === 'fulfilled') { setMetrics(metRes.value); setMetricsLoading(false); }
      else setMetricsLoading(false);
      if (finRes.status === 'fulfilled') { setFinance(finRes.value); setFinanceLoading(false); }
      else setFinanceLoading(false);
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
    const long = activePreset === 'year_to_date' || activePreset === 'last_year';
    const id = setInterval(() => void loadAll({ withSync: false }), long ? 5 * 60_000 : 60_000);
    return () => { unmountedRef.current = true; clearInterval(id); };
  }, [loadAll, activePreset]);

  const nav = useCallback((view: string) => {
    if (onNavigate) { onNavigate(view); return; }
    const map: Record<string, string> = {
      search: '#/search',
      'operations-pick': '#/operations/pick',
      'operations-stow': '#/operations/stow',
      'operations-identify': '#/operations/identify',
    };
    window.location.hash = map[view] || `#/${view}`;
  }, [onNavigate]);

  // ─── Derived ─────────────────────────────────────────────────────────────────
  const openOrders = useMemo(() => orders.filter(o => o.status === 'new'), [orders]);

  const nextPick = useMemo(() => {
    const norm = (v?: string | null) =>
      (v || '').replace(/\s+/g, '').toUpperCase().replace(/^SKU[-_\s]*/i, '');
    for (const order of openOrders) {
      const items: any[] = Array.isArray((order as any).items) ? (order as any).items : [];
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
        const bin = bins.sort(
          (a, b) => (b.quantity - a.quantity) || compareBinCodesForPickRoute(a.code, b.code)
        )[0];
        return { sku, binCode: bin?.code || prod?.storage?.binCode || hint?.binCode || '', qty };
      }
    }
    return null;
  }, [openOrders, products]);

  const stowBacklog = useMemo(
    () => products.filter(p => getProductPhysicalQuantity(p) > 0 && !p.storage?.binCode).length,
    [products]
  );

  const invValue = useMemo(() =>
    products.filter(p => (p.details?.pricing?.lowest_price?.amount || 0) > 0).reduce(
      (s, p) => s + getProductAvailableQuantity(p) * (p.details?.pricing?.lowest_price?.amount || 0), 0
    ), [products]);

  const currency = safeCur(metrics?.currency);
  const chartDays = metrics?.volume_7d?.days ?? [];
  const revenueWindow = metrics?.revenue?.payout_brutto_window ?? metrics?.revenue?.window_non_cancelled_total ?? 0;
  const revenueYtd = metrics?.revenue?.payout_brutto_ytd ?? metrics?.revenue?.all_non_cancelled_total ?? 0;
  const returnsTotal = metrics?.orders?.returns_total ?? 0;
  // Shipping: SendCloud returns netto, multiply by 1.19 for brutto
  const shippingWindowNetto = finance?.shipping?.total_cost ?? null;
  const shippingYtdNetto = finance?.shipping_ytd?.total_cost ?? null;
  const shippingWindow = shippingWindowNetto !== null ? Math.round(shippingWindowNetto * 1.19 * 100) / 100 : null;
  const shippingYtd = shippingYtdNetto !== null ? Math.round(shippingYtdNetto * 1.19 * 100) / 100 : null;
  const totalBalance = finance?.total_balance ?? null;
  // Use chart data sum for order count (date-filtered), not global status_breakdown
  const totalOrders = (chartDays as any[]).reduce((s: number, d: any) => s + (Number(d?.orders) || 0), 0);
  const presetLabel = metrics?.range?.label ?? PRESETS.find(p => p.id === activePreset)?.label ?? activePreset;

  // ─── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-3 max-w-xl mx-auto pb-6">

      {/* Header */}
      <div className="flex items-center justify-between gap-2 pt-1">
        <div>
          <h1 className="text-xl font-bold text-txt-primary">Dashboard</h1>
          {lastUpdated && (
            <p className="text-[10px] text-txt-muted">
              {lastUpdated.toLocaleTimeString(intlLocale, { hour: '2-digit', minute: '2-digit' })}
              {' · BaseLinker'}
            </p>
          )}
        </div>
        <select
          value={activePreset}
          onChange={e => setPreset(e.target.value)}
          className="text-xs rounded-lg bg-app-elevated border border-app-border px-2 py-1.5 text-txt-secondary outline-none"
        >
          {PRESETS.map(p => (
            <option key={p.id} value={p.id} className="bg-app-bg">{p.label}</option>
          ))}
          <optgroup label="── Monat ──" className="bg-app-bg">
            {monthOptions.map(m => (
              <option key={m.id} value={m.id} className="bg-app-bg">{m.label}</option>
            ))}
          </optgroup>
        </select>
      </div>

      {products.length === 0 && (
        <div className="rounded-2xl border border-app-border bg-app-surface p-4 text-sm text-txt-muted">
          {isLoading ? 'Lade Produkte…' : 'Keine Produkte geladen.'}
        </div>
      )}

      {/* ── Operative ─────────────────────────────────── */}
      <RowLabel label="Aktionen" />
      <div className="grid grid-cols-2 gap-2.5">
        <Tile
          color="warn"
          label="Offene Aufträge"
          value={openOrders.length}
          sub={openOrders.length === 0
            ? 'Alles erledigt'
            : nextPick
              ? `→ ${nextPick.binCode || '—'} · ${nextPick.sku}`
              : `${openOrders.length} zu picken`}
          onClick={() => nav('operations-pick')}
        />
        <Tile
          color="success"
          label="Einlagern"
          value={stowBacklog}
          sub="Produkte ohne Lagerplatz"
          onClick={() => nav('operations-stow')}
        />
        <Tile
          label="Suche"
          value="Suchen →"
          sub="Produkt / EAN"
          onClick={() => nav('search')}
        />
        <Tile
          color="blue"
          label="Identifizieren"
          value="Scan →"
          sub="Barcode / Foto"
          onClick={() => nav('operations-identify')}
        />
      </div>

      {/* ── Finanzen (hero) ────────────────────────────── */}
      <RowLabel label="Finanzen" />
      <div className="rounded-2xl border border-app-border bg-app-surface p-4">
        <p className="text-[10px] uppercase tracking-widest text-txt-muted font-bold">Gesamtsaldo</p>
        {financeLoading ? <Skel w="w-32" h="h-8" /> : (
          <p className={`text-3xl font-bold tabular-nums mt-1 ${totalBalance !== null && totalBalance < 0 ? 'text-danger' : 'text-txt-primary'}`}>
            {totalBalance !== null ? fmtCur(totalBalance, 'EUR') : '—'}
          </p>
        )}
        {financeLoading ? <Skel w="w-24" h="h-3" className="mt-2" /> : (
          <p className="text-xs text-txt-muted mt-1">
            {finance?.accounts?.length
              ? `${finance.accounts.length} ${finance.accounts.length > 1 ? 'Konten' : 'Konto'} · SevDesk`
              : finance?.errors?.length ? 'SevDesk nicht verfügbar' : 'SevDesk'}
          </p>
        )}
      </div>

      {/* ── Zeitraum ──────────────────────────────────── */}
      <RowLabel label={presetLabel} />
      <div className="grid grid-cols-2 gap-2.5">
        <Tile
          label="Umsatz Brutto"
          value={metricsLoading ? '…' : fmtCur(revenueWindow, currency)}
          sub={`${fmtNum(totalOrders)} Aufträge`}
          loading={metricsLoading}
        />
        <Tile
          label="Retouren"
          value={metricsLoading ? '…' : fmtNum(returnsTotal)}
          sub="Bereits abgezogen"
          color={returnsTotal > 0 ? 'red' : 'default'}
          loading={metricsLoading}
        />
        <Tile
          label="Versandkosten"
          value={financeLoading && shippingWindow === null ? '…' : shippingWindow !== null ? fmtCur(shippingWindow, 'EUR') : '—'}
          sub={<span className="flex flex-col gap-0.5">
            <span>{fmtNum(finance?.shipping?.parcel_count ?? 0)} Sendungen</span>
            {((finance?.shipping?.dhl_count ?? 0) > 0 || (finance?.shipping?.dpd_count ?? 0) > 0) && (
              <span className="text-[10px] text-txt-muted">
                {(finance?.shipping?.dhl_count ?? 0) > 0 && `DHL ${finance.shipping.dhl_count}`}
                {(finance?.shipping?.dhl_count ?? 0) > 0 && (finance?.shipping?.dpd_count ?? 0) > 0 && ' · '}
                {(finance?.shipping?.dpd_count ?? 0) > 0 && `DPD ${finance.shipping.dpd_count}`}
              </span>
            )}
          </span>}
          loading={financeLoading && shippingWindow === null}
        />
      </div>

      {/* Mini chart */}
      {chartDays.length > 0 && (
        <div className="rounded-2xl bg-app-surface border border-app-border px-4 py-3">
          <MiniChart days={chartDays as any} currency={currency} />
        </div>
      )}

      {/* ── Jahresüberblick ───────────────────────────── */}
      <RowLabel label="Dieses Jahr" />
      <div className="grid grid-cols-2 gap-2.5">
        <Tile
          label="Umsatz Dieses Jahr"
          value={metricsLoading ? '…' : fmtCur(revenueYtd, currency)}
          sub="Brutto"
          loading={metricsLoading}
        />
        <Tile
          label="Versandkosten Dieses Jahr"
          value={shippingYtd !== null ? fmtCur(shippingYtd, 'EUR') : '—'}
          sub={<span className="flex flex-col gap-0.5">
            <span>{fmtNum(finance?.shipping_ytd?.parcel_count ?? 0)} Sendungen</span>
            {((finance?.shipping_ytd?.dhl_count ?? 0) > 0 || (finance?.shipping_ytd?.dpd_count ?? 0) > 0) && (
              <span className="text-[10px] text-txt-muted">
                {(finance?.shipping_ytd?.dhl_count ?? 0) > 0 && `DHL ${fmtNum(finance.shipping_ytd.dhl_count)}`}
                {(finance?.shipping_ytd?.dhl_count ?? 0) > 0 && (finance?.shipping_ytd?.dpd_count ?? 0) > 0 && ' · '}
                {(finance?.shipping_ytd?.dpd_count ?? 0) > 0 && `DPD ${fmtNum(finance.shipping_ytd.dpd_count)}`}
              </span>
            )}
          </span>}
          loading={financeLoading && shippingYtd === null}
        />
      </div>

      {/* ── Bestand ───────────────────────────────────── */}
      <RowLabel label="Bestand" />
      <div className="grid grid-cols-2 gap-2.5">
        <Tile
          label="Im Bestand"
          value={products.filter(p => getProductPhysicalQuantity(p) > 0).length}
          sub={`von ${products.length} Produkten`}
        />
        <Tile
          label="Einheiten"
          value={fmtNum(products.reduce((s, p) => s + getProductAvailableQuantity(p), 0))}
          sub="Verfügbar"
        />
        <Tile
          label="Bestandswert"
          value={fmtCur(invValue, 'EUR')}
          sub="Verkaufspreis · Verfügbar"
        />
        <Tile
          label="Sync"
          value={`${products.filter(p => p.ops?.sync_status === 'synced').length} / ${products.length}`}
          sub={products.filter(p => p.ops?.sync_status === 'failed').length > 0
            ? `${products.filter(p => p.ops?.sync_status === 'failed').length} Fehler`
            : 'Synchronisiert'}
          color={products.filter(p => p.ops?.sync_status === 'failed').length > 0 ? 'red' : 'default'}
        />
      </div>

    </div>
  );
};

export default DashboardMobile;
