import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { DashboardMetrics, FinanceMetrics, Product } from '../types';
import { fetchDashboardMetrics, fetchFinanceMetrics, fetchSyncStatus, fetchReorderAlerts, fetchActivityFeed, type SyncStatusData, type ActivityEvent } from '../api/client';
import {
  getProductAvailableQuantity,
  getProductPhysicalQuantity,
  getProductReservedQuantity,
  normalizeSyncStatus,
} from '../utils/product';

// ─── Props ────────────────────────────────────────────────────────────────────
interface DashboardProps {
  products: Product[];
  onSelectProduct: (productId: string) => void;
  onRefreshProducts?: () => void | Promise<void>;
  rangePreset?: string;
  onRangePresetChange?: (preset: string) => void;
}

const PRESETS = [
  { id: 'today', label: 'Heute' },
  { id: 'last7', label: 'Letzte 7 Tage' },
  { id: 'this_week', label: 'Diese Woche' },
  { id: 'month_to_date', label: 'Dieser Monat' },
  { id: 'last_month', label: 'Letzter Monat' },
  { id: 'year_to_date', label: 'Dieses Jahr' },
  { id: 'all_time', label: 'Gesamter Zeitraum' },
  { id: 'custom', label: 'Benutzerdefiniert' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const safeCur = (c?: string) => (/^[A-Z]{3}$/.test((c || '').toUpperCase()) ? c!.toUpperCase() : 'EUR');

const fmtCur = (v: number, c = 'EUR', compact = false) => {
  try {
    return new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: safeCur(c),
      maximumFractionDigits: compact && Math.abs(v) >= 1000 ? 0 : 2,
    }).format(v);
  } catch {
    return `${v.toFixed(2)} ${c}`;
  }
};

const fmtNum = (n: number) => new Intl.NumberFormat('de-DE').format(n);

// ─── Skeleton ─────────────────────────────────────────────────────────────────
const Skel: React.FC<{ w?: string; h?: string; className?: string }> = ({
  w = 'w-24', h = 'h-8', className = '',
}) => <div className={`animate-pulse rounded bg-app-border/50 ${w} ${h} ${className}`} />;

// ─── Metric card ──────────────────────────────────────────────────────────────
interface CardProps {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  badge?: string;
  color?: 'green' | 'blue' | 'amber' | 'violet' | 'red' | 'neutral';
  loading?: boolean;
  onClick?: () => void;
  size?: 'hero' | 'normal' | 'sm';
}

// Calmer dashboard palette: every KPI card sits on the same neutral surface so
// the eye can scan numbers without colour fatigue. Tone is conveyed only via a
// 2px left accent bar + (subtle) value tinting. Keeps both dark and light mode
// readable; the previous full-card tint was unreadable on white in light mode.
const colorVal: Record<NonNullable<CardProps["color"]>, string> = {
  green: "text-success",
  blue: "text-info",
  amber: "text-warning",
  violet: "text-accent",
  red: "text-danger",
  neutral: "text-txt-primary",
};
const colorAccentBar: Record<NonNullable<CardProps["color"]>, string> = {
  green: "bg-success",
  blue: "bg-info",
  amber: "bg-warning",
  violet: "bg-accent",
  red: "bg-danger",
  neutral: "bg-app-border",
};

const Card: React.FC<CardProps> = ({
  label, value, sub, badge, color = "neutral", loading, onClick, size = "normal",
}) => {
  const valClass = size === "hero" ? "text-3xl lg:text-4xl" : size === "sm" ? "text-xl" : "text-2xl lg:text-[28px]";
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      {...(onClick ? { type: "button", onClick } : {})}
      className={`relative overflow-hidden rounded-xl border border-app-border bg-app-surface p-5 text-left flex flex-col gap-1.5 transition-colors
        ${onClick ? "cursor-pointer hover:bg-app-elevated active:scale-[0.99]" : ""}
      `}
    >
      {/* 2px accent stripe — the only carrier of "tone" in the card */}
      <span aria-hidden className={`absolute inset-y-0 left-0 w-[3px] ${colorAccentBar[color]}`} />
      {badge && (
        <span className="absolute top-3 right-3 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-app-elevated text-txt-muted">
          {badge}
        </span>
      )}
      <p className="text-xs text-txt-muted font-medium">{label}</p>
      {loading ? (
        <Skel w="w-28" h={size === "hero" ? "h-10" : "h-8"} />
      ) : (
        <p className={`font-semibold ${valClass} ${colorVal[color]} tabular-nums leading-tight`}>{value}</p>
      )}
      {!loading && sub && (
        <div className="text-xs text-txt-muted leading-snug mt-0.5">{sub}</div>
      )}
      {loading && <Skel w="w-16" h="h-3" />}
    </Tag>
  );
};

// ─── Order pipeline ───────────────────────────────────────────────────────────
// Tokens only — see styles/main.css. Pipeline reads as a temperature gradient:
// warning (offen) → muted (in arbeit) → success (versendet/zugestellt).
const STEPS = [
  { key: "neu", label: "Offen", dot: "bg-warning", text: "text-warning" },
  { key: "kommissioniert", label: "Komm.", dot: "bg-info", text: "text-info" },
  { key: "verpackt", label: "Verpackt", dot: "bg-info", text: "text-info" },
  { key: "versendet", label: "Versendet", dot: "bg-success", text: "text-success" },
  { key: "zugestellt", label: "Zugestellt", dot: "bg-success", text: "text-success" },
];

const Pipeline: React.FC<{
  bd: Record<string, number>;
  loading?: boolean;
  onClickStatus: (k: string) => void;
}> = ({ bd, loading, onClickStatus }) => {
  const total = STEPS.reduce((s, st) => s + (bd[st.key] || 0), 0);
  return (
    <div className="space-y-3">
      {!loading && total > 0 && (
        <div className="flex h-1 rounded-full overflow-hidden gap-px bg-app-border">
          {STEPS.map(st => {
            const pct = total > 0 ? ((bd[st.key] || 0) / total) * 100 : 0;
            if (!pct) return null;
            return <div key={st.key} className={`${st.dot} transition-all`} style={{ width: `${pct}%` }} />;
          })}
        </div>
      )}
      {loading && <div className="h-1 w-full rounded-full bg-app-border/50 animate-pulse" />}
      <div className="grid grid-cols-5 gap-2">
        {STEPS.map((st, i) => (
          <button
            key={st.key}
            type="button"
            onClick={() => onClickStatus(st.key)}
            className="group flex flex-col items-center gap-2 rounded-lg bg-app-bg hover:bg-app-elevated border border-app-border py-3 px-2 transition-colors cursor-pointer"
          >
            <div className={`flex items-center gap-1.5 text-xs ${st.text} font-medium`}>
              <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
              {st.label}
            </div>
            {loading ? (
              <Skel w="w-8" h="h-7" />
            ) : (
              <span className="text-2xl font-bold text-txt-primary tabular-nums">{fmtNum(bd[st.key] || 0)}</span>
            )}
            {i < STEPS.length - 1 && (
              <span className="text-app-border text-xs">→</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
};

// ─── Order volume + revenue chart (Recharts) ──────────────────────────────────
//
// Replaces a 200-line hand-rolled SVG with Recharts ComposedChart. Drives the
// hover/touch experience natively, formats Y-axis ticks as integers (no more
// "750.3"), and renders the *running* day with a hatched bar so the user
// immediately sees that today is incomplete data — solves the "heute looks like
// the worst day" UX trap of the previous chart.
interface ChartDay {
  key: string;
  label: string;
  count: number;
  revenue: number;
  isToday: boolean;
}

const fmtAxisCurrency = (v: number) => {
  const n = Math.round(v);
  if (Math.abs(n) >= 1000) return `${Math.round(n / 100) / 10}k`;
  return String(n);
};

const ChartTooltip: React.FC<any> = ({ active, payload, label, currency }) => {
  if (!active || !payload?.length) return null;
  const orders = payload.find((p: any) => p.dataKey === 'count')?.value ?? 0;
  const revenue = payload.find((p: any) => p.dataKey === 'revenue')?.value ?? 0;
  const day: ChartDay | undefined = payload[0]?.payload;
  return (
    <div
      className="rounded-lg border px-3 py-2 text-xs shadow-app"
      style={{
        background: 'var(--elevated)',
        borderColor: 'var(--border)',
        color: 'var(--text-primary)',
      }}
    >
      <p className="font-semibold mb-1">
        {label}
        {day?.isToday && (
          <span className="ml-2 text-[10px] font-normal" style={{ color: 'var(--text-muted)' }}>· läuft</span>
        )}
      </p>
      <p className="flex items-center gap-1.5" style={{ color: 'var(--info)' }}>
        <span className="inline-block w-2 h-2 rounded-sm" style={{ background: 'var(--info)' }} />
        {fmtNum(orders)} Aufträge
      </p>
      <p className="flex items-center gap-1.5" style={{ color: 'var(--success)' }}>
        <span className="inline-block w-2 h-0.5 rounded" style={{ background: 'var(--success)' }} />
        {fmtCur(revenue, currency)}
      </p>
    </div>
  );
};

// Custom bar: hatched fill for the "today/running" bucket so an in-progress day
// is clearly distinguishable from completed days even before hover.
const RunningBar: React.FC<any> = (props) => {
  const { x, y, width, height, payload } = props;
  if (typeof x !== 'number' || typeof y !== 'number' || !width || height < 0) return null;
  const isToday = !!payload?.isToday;
  const fill = isToday ? 'url(#runningHatch)' : 'var(--info)';
  return <rect x={x} y={y} width={width} height={height} fill={fill} rx={3} ry={3} />;
};

const OrderVolumeChart: React.FC<{
  data: ChartDay[];
  currency: string;
  loading?: boolean;
}> = ({ data, currency, loading }) => {
  if (loading) {
    return (
      <div className="w-full h-56 flex items-end gap-1.5 px-2 pb-4">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="flex-1 animate-pulse rounded-t bg-app-border/50"
            style={{ height: `${Math.random() * 60 + 20}%` }} />
        ))}
      </div>
    );
  }

  if (!data.length) {
    return (
      <div className="w-full h-56 flex items-center justify-center text-sm text-txt-muted">
        Keine Daten für diesen Zeitraum
      </div>
    );
  }

  const hasRunningBar = data.some(d => d.isToday);

  return (
    <ResponsiveContainer width="100%" height={240}>
      <ComposedChart data={data} margin={{ top: 16, right: 12, left: 0, bottom: 8 }}>
        <defs>
          {/* 45° diagonal hatch — applied to the running (today) bar */}
          <pattern id="runningHatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--info)" fillOpacity="0.35" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--info)" strokeWidth="3" />
          </pattern>
        </defs>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
          tickLine={false}
          axisLine={{ stroke: 'var(--border)' }}
        />
        <YAxis
          yAxisId="left"
          tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
          width={32}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => fmtAxisCurrency(v)}
          width={42}
        />
        <Tooltip
          cursor={{ fill: 'var(--border)', fillOpacity: 0.25 }}
          content={(props: any) => <ChartTooltip {...props} currency={currency} />}
        />
        <Bar
          yAxisId="left"
          dataKey="count"
          name="Aufträge"
          shape={<RunningBar />}
          isAnimationActive={false}
          maxBarSize={36}
        />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="revenue"
          name="Umsatz"
          stroke="var(--success)"
          strokeWidth={2}
          dot={{ r: 2, fill: 'var(--success)', strokeWidth: 0 }}
          activeDot={{ r: 4, fill: 'var(--success)' }}
          isAnimationActive={false}
        />
        {hasRunningBar && (
          // Footnote rendered by parent — we keep the chart purely visual.
          // (Parent renders the "läuft"-Hinweis under the chart.)
          <></>
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
};

// ─── Divider ──────────────────────────────────────────────────────────────────
const Section: React.FC<{ title: string; badge?: string; children: React.ReactNode }> = ({
  title, badge, children,
}) => (
  <div>
    <div className="flex items-center gap-2 mb-3">
      <h2 className="text-sm font-medium text-txt-muted">{title}</h2>
      {badge && (
        <span className="text-[10px] text-txt-muted font-medium px-1.5 py-0.5 rounded bg-app-elevated">{badge}</span>
      )}
      <div className="flex-1 h-px bg-app-border" />
    </div>
    {children}
  </div>
);


// ─── Date Range Dropdown ──────────────────────────────────────────────────────
const DateRangePicker: React.FC<{
  activePreset: string;
  presetLabel: string;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  customFrom: string;
  customTo: string;
  onCustomChange: (from: string, to: string) => void;
}> = ({ activePreset, presetLabel, onSelect, onRefresh, customFrom, customTo, onCustomChange }) => {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSelect = (id: string) => {
    onSelect(id);
    if (id !== 'custom') setOpen(false);
  };

  return (
    <div ref={ref} className="relative flex items-center gap-2">
      {/* Dropdown trigger */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-app-surface border border-app-border hover:bg-app-elevated transition-all text-sm text-txt-primary font-medium"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="w-4 h-4 text-txt-muted flex-shrink-0">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
        <span className="max-w-[13rem] truncate">{presetLabel}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`w-3.5 h-3.5 text-txt-muted transition-transform flex-shrink-0 ${open ? 'rotate-180' : ''}`}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* Refresh button */}
      <button
        type="button"
        onClick={onRefresh}
        title="Aktualisieren"
        className="w-9 h-9 flex items-center justify-center rounded-md bg-app-surface border border-app-border text-txt-muted hover:text-txt-primary hover:bg-app-elevated transition-all"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
          <path d="M1 4v6h6M23 20v-6h-6" />
          <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 0 1 3.51 15" />
        </svg>
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          className="absolute right-0 top-full mt-2 z-50 bg-app-elevated border border-app-border rounded-lg shadow-app overflow-hidden"
          style={{ minWidth: '16rem' }}
        >
          <div className="p-2">
            <p className="text-xs text-txt-muted font-medium px-2 pt-1 pb-1.5">Zeitraum</p>
            {PRESETS.map(p => (
              <button
                key={p.id}
                type="button"
                onClick={() => handleSelect(p.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-all text-left ${
                  activePreset === p.id
                    ? 'bg-accent-dim text-accent font-medium'
                    : 'text-txt-secondary hover:bg-app-surface hover:text-txt-primary'
                }`}
              >
                {activePreset === p.id ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 text-accent flex-shrink-0">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                ) : <span className="w-3.5 inline-block" />}
                {p.label}
              </button>
            ))}
          </div>

          {/* Custom date range inputs */}
          {activePreset === 'custom' && (
            <div className="border-t border-app-border p-3 space-y-2">
              <p className="text-xs text-txt-muted font-medium px-1">Von – Bis</p>
              <div className="flex gap-2">
                <input
                  type="date"
                  value={customFrom}
                  onChange={e => onCustomChange(e.target.value, customTo)}
                  className="flex-1 bg-app-surface border border-app-border rounded-md px-2 py-1.5 text-xs text-txt-primary focus:outline-none focus:border-accent/50"
                />
                <input
                  type="date"
                  value={customTo}
                  onChange={e => onCustomChange(customFrom, e.target.value)}
                  className="flex-1 bg-app-surface border border-app-border rounded-md px-2 py-1.5 text-xs text-txt-primary focus:outline-none focus:border-accent/50"
                />
              </div>
              <button
                type="button"
                onClick={() => { if (customFrom && customTo) setOpen(false); onRefresh(); }}
                disabled={!customFrom || !customTo}
                className="w-full py-1.5 rounded-md bg-accent-dim text-accent text-xs font-semibold hover:bg-accent/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Anwenden
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Main Component ───────────────────────────────────────────────────────────
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
  const [syncStatus, setSyncStatus] = useState<SyncStatusData | null>(null);
  const [syncLoading, setSyncLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [reorderAlerts, setReorderAlerts] = useState<any[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(true);
  const [activities, setActivities] = useState<ActivityEvent[]>([]);
  const loadingRef = useRef(false);

  const [internalPreset, setInternalPreset] = useState('month_to_date');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  // Refs keep latest date values available inside loadAll without re-creating the callback
  const customFromRef = useRef('');
  const customToRef = useRef('');
  customFromRef.current = customFrom;
  customToRef.current = customTo;

  const activePreset = useMemo(() => {
    const raw = typeof rangePreset === 'string' ? rangePreset.trim() : '';
    return raw && PRESETS.some(p => p.id === raw) ? raw : internalPreset;
  }, [rangePreset, internalPreset]);

  const setPreset = useCallback((next: string) => {
    if (onRangePresetChange) onRangePresetChange(next);
    else setInternalPreset(next);
  }, [onRangePresetChange]);

  const loadAll = useCallback(async () => {
    if (loadingRef.current) return;
    const from = customFromRef.current;
    const to = customToRef.current;
    // For custom preset, require both dates before fetching
    if (activePreset === 'custom' && (!from || !to)) return;
    loadingRef.current = true;
    const long = activePreset === 'year_to_date' || activePreset === 'last_year' || activePreset === 'all_time';
    setMetricsLoading(true);
    setFinanceLoading(true);
    setSyncLoading(true);
    const fromDate = activePreset === 'custom' ? from : undefined;
    const toDate = activePreset === 'custom' ? to : undefined;
    try {
      const [mResult, fResult, sResult, aResult, actResult] = await Promise.allSettled([
        fetchDashboardMetrics({ days: 7, preset: activePreset, from_date: fromDate, to_date: toDate }, { timeoutMs: long ? 90000 : 28000 }),
        fetchFinanceMetrics(activePreset, { timeoutMs: 40000, from_date: fromDate, to_date: toDate }),
        fetchSyncStatus(),
        fetchReorderAlerts(),
        fetchActivityFeed(15),
      ]);
      if (mResult.status === 'fulfilled') {
        setMetrics(mResult.value);
        setMetricsError(null);
      } else {
        setMetricsError((mResult.reason as any)?.message || 'Fehler beim Laden');
      }
      if (fResult.status === 'fulfilled') setFinance(fResult.value);
      if (sResult.status === 'fulfilled') setSyncStatus(sResult.value);
      if (aResult.status === 'fulfilled') setReorderAlerts(aResult.value || []);
      if (actResult.status === 'fulfilled') setActivities(actResult.value || []);
    } finally {
      setMetricsLoading(false);
      setFinanceLoading(false);
      setSyncLoading(false);
      setAlertsLoading(false);
      loadingRef.current = false;
      setLastRefreshed(new Date());
    }
  }, [activePreset]);

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    const long = activePreset === 'year_to_date' || activePreset === 'last_year';
    const ms = long ? 5 * 60_000 : 60_000;
    const id = setInterval(() => { loadAll(); onRefreshProducts?.(); }, ms);
    return () => clearInterval(id);
  }, [loadAll, onRefreshProducts, activePreset]);

  // ─── Inventory stats ────────────────────────────────────────────────────────
  const inv = useMemo(() => {
    let physical = 0, reserved = 0, available = 0;
    const valueMap = new Map<string, number>();
    const sync = { synced: 0, pending: 0, failed: 0 };
    for (const p of products) {
      const ph = getProductPhysicalQuantity(p);
      const res = getProductReservedQuantity(p);
      const avail = getProductAvailableQuantity(p);
      physical += ph; reserved += res; available += avail;
      const price = p.details?.pricing?.lowest_price;
      const cur = safeCur(price?.currency);
      valueMap.set(cur, (valueMap.get(cur) ?? 0) + avail * (price?.amount ?? 0));
      const s = normalizeSyncStatus(p.ops?.sync_status ?? 'pending', p.ops?.last_synced_iso);
      sync[s]++;
    }
    const [[primaryCur] = ['EUR']] = [...valueMap.entries()].sort((a, b) => b[1] - a[1]);
    const totalValue = [...valueMap.values()].reduce((s, v) => s + v, 0);
    const inStock = products.filter(p => getProductPhysicalQuantity(p) > 0).length;
    return { physical, reserved, available, totalValue, primaryCur: primaryCur as string, inStock, total: products.length, sync };
  }, [products]);

  // ─── Order / revenue stats ──────────────────────────────────────────────────
  const ord = useMemo(() => {
    const bd = metrics?.orders?.status_breakdown;
    const days = metrics?.volume_7d?.days ?? [];
    const bucket = metrics?.range?.bucket ?? 'day';
    const n = days.length;
    // Today key in the same UTC YYYY-MM-DD format the backend buckets use, so
    // the running-bar marker survives a UTC↔Berlin DST shift correctly.
    const todayUtcKey = (() => {
      const t = new Date();
      const y = t.getUTCFullYear();
      const m = String(t.getUTCMonth() + 1).padStart(2, '0');
      const d = String(t.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    })();
    const chart: ChartDay[] = days.map(d => {
      const dt = (() => { try { return new Date(d.date); } catch { return null; } })();
      const label = (() => {
        if (!dt) return d.date;
        if (bucket === 'month') return dt.toLocaleDateString('de-DE', { month: 'short' });
        if (bucket === 'week') return dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
        if (bucket === 'hour') return dt.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        // Compact day label: "Fr 02.05" — Wochentag plus date, scannable for any
        // 7–14 day range; falls back to date-only beyond 14 days to stay readable.
        if (n <= 14) {
          const wd = dt.toLocaleDateString('de-DE', { weekday: 'short' });
          const dm = dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
          return `${wd} ${dm}`;
        }
        return dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
      })();
      const isToday = bucket === 'day' && d.date.slice(0, 10) === todayUtcKey;
      return {
        key: d.date,
        label,
        count: Number(d.orders || 0),
        revenue: Number(d.revenue || 0),
        isToday,
      };
    });
    const totalOrdersInWindow = chart.reduce((s, d) => s + d.count, 0);
    return {
      neu: bd?.neu ?? 0,
      kommissioniert: bd?.kommissioniert ?? 0,
      verpackt: (bd as any)?.verpackt ?? 0,
      versendet: bd?.versendet ?? 0,
      zugestellt: bd?.zugestellt ?? 0,
      totalOrdersInWindow,
      // True gross revenue: SUM(order.totalAmount) — net of cancellations and returns,
      // before any marketplace fees. This is what most accountants mean by "Umsatz".
      revenueYtd: metrics?.revenue?.all_non_cancelled_total ?? 0,
      revenueWindow: metrics?.revenue?.window_non_cancelled_total ?? 0,
      // Marketplace payout: what eBay+Kaufland actually transfer to the bank
      // (after fees). Differs from gross by ~14–16% on average; shown as a
      // secondary value so you can see the fee bite without it replacing brutto.
      payoutYtd: metrics?.revenue?.payout_brutto_ytd ?? null,
      payoutWindow: metrics?.revenue?.payout_brutto_window ?? null,
      payoutSource: metrics?.revenue?.payout_source ?? null,
      returnsTotal: metrics?.orders?.returns_total ?? 0,
      returnsYtd: metrics?.orders?.returns_ytd ?? 0,
      returnsWindowCount: metrics?.returns?.window?.count ?? 0,
      returnsWindowValue: metrics?.returns?.window?.value_by_currency?.EUR ?? 0,
      currency: safeCur(metrics?.currency),
      chart,
    };
  }, [metrics]);

  const presetLabel = metrics?.range?.label ?? PRESETS.find(p => p.id === activePreset)?.label ?? activePreset;

  // Finance derived — shipping costs are netto from SendCloud, multiply by 1.19 for brutto
  const shippingWindowNetto = finance?.shipping?.total_cost ?? null;
  const shippingYtdNetto = finance?.shipping_ytd?.total_cost ?? null;
  const shippingWindow = shippingWindowNetto !== null ? Math.round(shippingWindowNetto * 1.19 * 100) / 100 : null;
  const shippingYtd = shippingYtdNetto !== null ? Math.round(shippingYtdNetto * 1.19 * 100) / 100 : null;

  // Total balance (Gesamtsaldo) — combined Sichteinlagen + BusinessCard
  const totalBalance = finance?.total_balance ?? null;


  const navigateTo = useCallback((statusKey: string) => {
    window.location.hash = `#/orders?orderStatus=${encodeURIComponent(statusKey)}`;
  }, []);

  const nowStr = lastRefreshed?.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) ?? null;

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5 pb-8">

      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-txt-muted">
          {nowStr ? `Aktualisiert: ${nowStr}` : 'Wird geladen\u2026'}
        </p>
        <DateRangePicker
          activePreset={activePreset}
          presetLabel={presetLabel}
          onSelect={setPreset}
          onRefresh={loadAll}
          customFrom={customFrom}
          customTo={customTo}
          onCustomChange={(f, t) => { setCustomFrom(f); setCustomTo(t); }}
        />
      </div>

      {metricsError && (
        <div className="rounded-md border border-danger/20 bg-danger-dim px-4 py-2.5 text-sm text-danger">
          {metricsError}
        </div>
      )}

      {/* 1. HERO-KPIs (3 Karten) */}
      <Section title="Jahresüberblick">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Card
            label="Kontostand"
            value={totalBalance !== null ? fmtCur(totalBalance, 'EUR') : '\u2014'}
            sub="SevDesk"
            color={totalBalance !== null && totalBalance < 0 ? 'red' : 'violet'}
            loading={financeLoading}
            size="hero"
          />
          <Card
            label="Jahresumsatz"
            value={fmtCur(ord.revenueYtd, ord.currency, true)}
            sub={(
              <span className="flex flex-col gap-0.5">
                <span>Brutto \u00b7 netto Stornos und Retouren</span>
                {ord.payoutYtd !== null && ord.payoutYtd > 0 && (
                  <span className="text-[10px] text-txt-muted">
                    Auszahlung {fmtCur(ord.payoutYtd, ord.currency, true)}
                    {ord.payoutSource === 'estimated' && ' \u00b7 gesch\u00e4tzt'}
                  </span>
                )}
              </span>
            )}
            color="green"
            loading={metricsLoading}
            size="hero"
          />
          <Card
            label="Versand (Jahr)"
            value={shippingYtd !== null ? fmtCur(shippingYtd, 'EUR', true) : '\u2014'}
            sub={shippingYtd !== null ? (
              <span className="flex flex-col gap-0.5">
                <span>{fmtNum(finance?.shipping_ytd?.parcel_count ?? 0)} Sendungen</span>
                {(() => {
                  const dhl = finance?.shipping_ytd?.dhl_count ?? 0;
                  const dpd = finance?.shipping_ytd?.dpd_count ?? 0;
                  const other = finance?.shipping_ytd?.other_count ?? 0;
                  if (!dhl && !dpd && !other) return null;
                  const parts: string[] = [];
                  if (dhl) parts.push(`DHL ${fmtNum(dhl)}`);
                  if (dpd) parts.push(`DPD ${fmtNum(dpd)}`);
                  if (other) parts.push(`Sonstige ${fmtNum(other)}`);
                  return <span className="text-[10px] text-txt-muted">{parts.join(' · ')}</span>;
                })()}
              </span>
            ) : undefined}
            color="amber"
            loading={financeLoading && shippingYtd === null}
            size="hero"
          />
        </div>
        {finance?.errors && finance.errors.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {finance.errors.map((e, i) => (
              <span key={i} className="text-[11px] text-warning bg-warning-dim border border-warning/20 px-2 py-0.5 rounded">
                {e}
              </span>
            ))}
          </div>
        )}
      </Section>

      {/* 2. KENNZAHLEN + CHART */}
      <Section title={`Kennzahlen · ${presetLabel}`}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
          <Card
            label="Umsatz"
            value={fmtCur(ord.revenueWindow, ord.currency, true)}
            sub={(
              <span className="flex flex-col gap-0.5">
                <span>{fmtNum(ord.totalOrdersInWindow)} Aufträge</span>
                {ord.payoutWindow !== null && ord.payoutWindow > 0 && (
                  <span className="text-[10px] text-txt-muted">
                    Auszahlung {fmtCur(ord.payoutWindow, ord.currency, true)}
                    {ord.payoutSource === "estimated" && " · geschätzt"}
                  </span>
                )}
              </span>
            )}
            color="green"
            loading={metricsLoading}
          />
          <Card
            label="Versand"
            value={shippingWindow !== null ? fmtCur(shippingWindow, 'EUR', true) : '\u2014'}
            sub={shippingWindow !== null ? (
              <span className="flex flex-col gap-0.5">
                <span>{fmtNum(finance?.shipping?.parcel_count ?? 0)} Sendungen</span>
                {(() => {
                  const dhl = finance?.shipping?.dhl_count ?? 0;
                  const dpd = finance?.shipping?.dpd_count ?? 0;
                  const other = finance?.shipping?.other_count ?? 0;
                  if (!dhl && !dpd && !other) return null;
                  const parts: string[] = [];
                  if (dhl) parts.push(`DHL ${fmtNum(dhl)}`);
                  if (dpd) parts.push(`DPD ${fmtNum(dpd)}`);
                  if (other) parts.push(`Sonstige ${fmtNum(other)}`);
                  return <span className="text-[10px] text-txt-muted">{parts.join(' \u00b7 ')}</span>;
                })()}
              </span>
            ) : undefined}
            color="amber"
            loading={financeLoading && shippingWindow === null}
          />
          <Card
            label="Retouren"
            value={fmtNum(ord.returnsWindowCount)}
            sub={ord.returnsWindowValue > 0 ? fmtCur(ord.returnsWindowValue, 'EUR') : undefined}
            color={ord.returnsWindowCount > 0 ? 'red' : 'neutral'}
            loading={metricsLoading}
          />
        </div>

        {/* Chart */}
        <div className="rounded-xl border border-app-border bg-app-surface p-5">
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm font-semibold text-txt-primary">Auftragsvolumen &amp; Umsatz</p>
            <div className="flex items-center gap-4 text-[11px] text-txt-muted">
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-3 h-3 rounded-sm bg-info" />
                Aufträge
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-3 h-1.5 rounded-full bg-success" />
                Umsatz
              </span>
              {ord.chart.some(d => d.isToday) && (
                <span className="flex items-center gap-1.5">
                  <span
                    className="inline-block w-3 h-3 rounded-sm border border-info/40"
                    style={{
                      backgroundImage: 'repeating-linear-gradient(45deg, var(--info) 0 2px, transparent 2px 4px)',
                    }}
                  />
                  läuft
                </span>
              )}
            </div>
          </div>
          <OrderVolumeChart data={ord.chart} currency={ord.currency} loading={metricsLoading} />
          {ord.chart.some(d => d.isToday) && nowStr && (
            <p className="text-[11px] text-txt-muted mt-2">
              Heute · Stand {nowStr} (Tag noch nicht abgeschlossen)
            </p>
          )}
        </div>
      </Section>

      {/* 3. AUFTRAGSFLUSS (kompakt) */}
      <Section title="Auftragsfluss" badge={!metricsLoading && ord.neu > 0 ? `${ord.neu} offen` : undefined}>
        <div className="rounded-lg border border-app-border bg-app-surface px-5 py-3">
          {metricsLoading ? (
            <div className="h-8 w-full rounded bg-app-border/50 animate-pulse" />
          ) : (
            <div className="flex items-center gap-1">
              {STEPS.map((st, i) => {
                const count = ({ neu: ord.neu, kommissioniert: ord.kommissioniert, verpackt: ord.verpackt, versendet: ord.versendet, zugestellt: ord.zugestellt } as Record<string, number>)[st.key] || 0;
                return (
                  <React.Fragment key={st.key}>
                    <button
                      type="button"
                      onClick={() => navigateTo(st.key)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md hover:bg-app-elevated transition-colors cursor-pointer"
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                      <span className="text-xs text-txt-muted">{st.label}</span>
                      <span className={`text-sm font-bold tabular-nums ${st.text}`}>{fmtNum(count)}</span>
                    </button>
                    {i < STEPS.length - 1 && (
                      <span className="text-app-border text-xs select-none">{'\u203A'}</span>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </div>
      </Section>

      {/* 4. BESTAND & SYNC (zwei Subsektionen) */}
      <Section title="Bestand & Sync">
        <div className="rounded-xl border border-app-border bg-app-surface p-5">
          {syncLoading && metricsLoading ? (
            <div className="h-6 w-full rounded bg-app-border/50 animate-pulse" />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4 text-sm">
              {/* Bestand */}
              <div className="space-y-2">
                <p className="text-[11px] font-medium text-txt-muted uppercase tracking-wide">Bestand</p>
                <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
                  <span>
                    <span className="text-base font-semibold text-txt-primary tabular-nums">{fmtNum(inv.inStock)}</span>
                    <span className="text-txt-muted text-xs"> Produkte</span>
                  </span>
                  <span>
                    <span className="text-base font-semibold text-txt-primary tabular-nums">{fmtNum(inv.available)}</span>
                    <span className="text-txt-muted text-xs"> verfügbar</span>
                    {inv.reserved > 0 && (
                      <span className="text-txt-muted text-xs"> · {fmtNum(inv.reserved)} reserviert</span>
                    )}
                  </span>
                  <span>
                    <span className="text-txt-muted text-xs">Wert (VK) </span>
                    <span className="text-base font-semibold text-txt-primary tabular-nums">{fmtCur(inv.totalValue, inv.primaryCur, true)}</span>
                  </span>
                </div>
              </div>
              {/* Marketplace-Sync */}
              <div className="space-y-2 md:border-l md:border-app-border md:pl-8">
                <p className="text-[11px] font-medium text-txt-muted uppercase tracking-wide">Marketplace-Sync (24h)</p>
                <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
                  {syncStatus && (['ebay', 'kaufland'] as const).map(ch => {
                const c = syncStatus.channels[ch];
                if (!c) return (
                  <span key={ch} className="text-xs text-txt-muted">{ch.charAt(0).toUpperCase() + ch.slice(1)} {'\u2014'}</span>
                );
                const hasErrors = c.errorCount > 0;
                return (
                  <span
                    key={ch}
                    className="flex items-center gap-1 text-xs"
                    title="Erfolgreiche/gesamte Sync-Versuche der letzten 24h — NICHT aktive vs. gesamte Listings"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${hasErrors ? 'bg-danger' : 'bg-success'}`} />
                    <span className="text-txt-secondary">{ch.charAt(0).toUpperCase() + ch.slice(1)}</span>
                    <span className={`font-medium ${hasErrors ? 'text-danger' : 'text-success'}`}>
                      {c.successCount}/{c.totalCount}
                    </span>
                    {hasErrors && <span className="text-danger">· {c.errorCount} Fehler</span>}
                  </span>
                );
              })}
                  {typeof syncStatus?.summary?.pendingFailures === "number" && syncStatus.summary.pendingFailures > 0 && (
                    <span
                      className="flex items-center gap-1 rounded-md bg-danger-dim px-1.5 py-0.5 text-xs text-danger"
                      title="Bestands-Syncs, die nie beim Marktplatz ankamen (unabhängig von 24h) — direktes Oversell-Risiko"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-danger" />
                      <span className="font-semibold tabular-nums">{syncStatus.summary.pendingFailures}</span>
                      <span>offene Sync-Fehler</span>
                    </span>
                  )}
                  {!syncStatus && <span className="text-xs text-txt-muted">Kein Status</span>}
                </div>
              </div>
            </div>
          )}
        </div>
      </Section>

      {/* 5. NACHBESTELLUNGS-WARNUNGEN */}
      {!alertsLoading && reorderAlerts.length > 0 && (
        <Section title="Nachbestellungs-Warnungen" badge={String(reorderAlerts.length)}>
          <div className="rounded-lg border border-warning/20 bg-warning-dim/30 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-warning/10">
                    <th className="text-left px-4 py-2 text-xs font-semibold text-txt-muted">Produkt</th>
                    <th className="text-right px-4 py-2 text-xs font-semibold text-txt-muted">Bestand</th>
                    <th className="text-right px-4 py-2 text-xs font-semibold text-txt-muted">Verkauf/Tag</th>
                    <th className="text-right px-4 py-2 text-xs font-semibold text-txt-muted">Reichweite</th>
                  </tr>
                </thead>
                <tbody>
                  {reorderAlerts.slice(0, 10).map((a: any, i: number) => (
                    <tr
                      key={a.productId || i}
                      className="border-b border-warning/10 last:border-b-0 cursor-pointer hover:bg-warning-dim/50 transition"
                      onClick={() => _onSelectProduct(a.productId)}
                    >
                      <td className="px-4 py-2 text-txt-primary font-medium truncate max-w-[200px]">
                        {a.name || a.productId?.slice(0, 12)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-warning font-semibold">
                        {a.currentStock ?? '\u2014'}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-txt-muted">
                        {typeof a.velocity === 'number' ? a.velocity.toFixed(1) : '\u2014'}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <span className={`font-mono font-semibold ${(a.daysUntilStockout ?? 999) < 7 ? 'text-danger' : 'text-warning'}`}>
                          {typeof a.daysUntilStockout === 'number'
                            ? `${a.daysUntilStockout} Tage`
                            : '\u2014'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Section>
      )}

      {/* 6. AKTIVITÄTS-FEED */}
      {activities.length > 0 && (
        <Section title="Aktivitäts-Feed" badge="24h">
          <div className="rounded-lg border border-app-border bg-app-surface overflow-hidden">
            <div className="divide-y divide-app-border max-h-80 overflow-y-auto">
              {activities.map((a) => {
                const typeIcon = { order: '\uD83D\uDCE6', shipment: '\uD83D\uDE9A', return: '\u21A9\uFE0F', sync: '\uD83D\uDD04' }[a.type] || '\u2022';
                const statusColor = a.status === 'error' ? 'text-danger'
                  : a.status === 'shipped' || a.status === 'success' ? 'text-success'
                  : 'text-txt-secondary';
                const timeAgo = (() => {
                  const diff = Date.now() - new Date(a.timestamp).getTime();
                  const mins = Math.floor(diff / 60000);
                  if (mins < 1) return 'gerade eben';
                  if (mins < 60) return `vor ${mins} Min`;
                  const hrs = Math.floor(mins / 60);
                  if (hrs < 24) return `vor ${hrs} Std`;
                  return `vor ${Math.floor(hrs / 24)} Tag(en)`;
                })();
                return (
                  <div key={`${a.type}-${a.id}`} className="px-4 py-2.5 flex items-center gap-3 hover:bg-app-elevated/50 transition-colors">
                    <span className="text-base shrink-0">{typeIcon}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-txt-primary truncate">{a.title}</p>
                      {a.detail && <p className="text-xs text-txt-muted truncate">{a.detail}</p>}
                    </div>
                    <span className={`text-xs font-medium ${statusColor} shrink-0`}>{a.status}</span>
                    <span className="text-xs text-txt-muted shrink-0 tabular-nums">{timeAgo}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </Section>
      )}

    </div>
  );
};

export default Dashboard;
