import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { DashboardMetrics, FinanceMetrics, Product } from '../types';
import { fetchDashboardMetrics, fetchFinanceMetrics, fetchSyncStatus, fetchReorderAlerts, type SyncStatusData } from '../api/client';
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

const colorVal: Record<NonNullable<CardProps['color']>, string> = {
  green: 'text-success',
  blue: 'text-info',
  amber: 'text-warning',
  violet: 'text-accent',
  red: 'text-danger',
  neutral: 'text-txt-primary',
};
const colorBorder: Record<NonNullable<CardProps['color']>, string> = {
  green: 'border-success/20',
  blue: 'border-info/20',
  amber: 'border-warning/20',
  violet: 'border-accent/20',
  red: 'border-danger/20',
  neutral: 'border-app-border',
};
const colorBg: Record<NonNullable<CardProps['color']>, string> = {
  green: 'bg-success-dim',
  blue: 'bg-info-dim',
  amber: 'bg-warning-dim',
  violet: 'bg-accent-dim',
  red: 'bg-danger-dim',
  neutral: 'bg-app-surface',
};

const Card: React.FC<CardProps> = ({
  label, value, sub, badge, color = 'neutral', loading, onClick, size = 'normal',
}) => {
  const valClass = size === 'hero' ? 'text-4xl' : size === 'sm' ? 'text-xl' : 'text-2xl lg:text-3xl';
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { type: 'button', onClick } : {})}
      className={`relative rounded-2xl border p-5 text-left flex flex-col gap-1 transition-colors
        ${colorBg[color]} ${colorBorder[color]}
        ${onClick ? 'cursor-pointer hover:brightness-110 active:scale-[0.99]' : ''}
      `}
    >
      {badge && (
        <span className="absolute top-3 right-3 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-app-elevated text-txt-muted">
          {badge}
        </span>
      )}
      <p className="text-xs text-txt-muted font-medium">{label}</p>
      {loading ? (
        <Skel w="w-28" h={size === 'hero' ? 'h-10' : 'h-8'} />
      ) : (
        <p className={`font-bold ${valClass} ${colorVal[color]} tabular-nums leading-none`}>{value}</p>
      )}
      {!loading && sub && (
        <p className="text-xs text-txt-muted leading-snug mt-0.5">{sub}</p>
      )}
      {loading && <Skel w="w-16" h="h-3" />}
    </Tag>
  );
};

// ─── Order pipeline ───────────────────────────────────────────────────────────
const STEPS = [
  { key: 'neu', label: 'Offen', dot: 'bg-amber-400', text: 'text-amber-400' },
  { key: 'kommissioniert', label: 'Komm.', dot: 'bg-blue-400', text: 'text-blue-400' },
  { key: 'verpackt', label: 'Verpackt', dot: 'bg-blue-400', text: 'text-blue-400' },
  { key: 'versendet', label: 'Versendet', dot: 'bg-sky-400', text: 'text-sky-400' },
  { key: 'zugestellt', label: 'Zugestellt', dot: 'bg-success', text: 'text-success' },
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

// ─── SVG Dual-Axis Chart ──────────────────────────────────────────────────────
interface ChartDay {
  key: string;
  label: string;
  count: number;
  revenue: number;
}

const DualChart: React.FC<{
  data: ChartDay[];
  currency: string;
  loading?: boolean;
}> = ({ data, currency, loading }) => {
  const [hovered, setHovered] = useState<number | null>(null);
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const W = 560, H = 160;
  const PAD = { top: 14, right: 52, bottom: 26, left: 40 };
  const PW = W - PAD.left - PAD.right;
  const PH = H - PAD.top - PAD.bottom;

  const n = data.length || 1;
  const maxOrders = Math.max(1, ...data.map(d => d.count));
  const maxRevenue = Math.max(1, ...data.map(d => d.revenue));

  const slotW = PW / n;
  const barW = Math.max(4, slotW * 0.55);
  const barX = (i: number) => PAD.left + slotW * i + (slotW - barW) / 2;
  const barTop = (v: number) => PAD.top + PH - Math.max(3, (v / maxOrders) * PH);
  const barH = (v: number) => Math.max(3, (v / maxOrders) * PH);

  const lineX = (i: number) => PAD.left + slotW * i + slotW / 2;
  const lineY = (v: number) => PAD.top + PH - (v / maxRevenue) * PH;

  const linePath = data.length > 1
    ? data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${lineX(i)} ${lineY(d.revenue)}`).join(' ')
    : '';
  const fillPath = data.length > 1
    ? `${linePath} L ${lineX(n - 1)} ${PAD.top + PH} L ${lineX(0)} ${PAD.top + PH} Z`
    : '';

  const orderTicks = [0, 0.5, 1].map(f => ({
    y: PAD.top + PH - f * PH,
    v: Math.round(f * maxOrders),
  }));
  const revTicks = [0, 0.5, 1].map(f => ({
    y: PAD.top + PH - f * PH,
    v: f * maxRevenue,
  }));

  const fmtRevAxis = (v: number) => {
    if (v >= 1000) return `${(v / 1000).toFixed(0)}k`;
    return v.toFixed(0);
  };

  if (loading) {
    return (
      <div className="w-full h-40 flex items-end gap-1.5 px-2 pb-4">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="flex-1 animate-pulse rounded-t bg-app-border/50"
            style={{ height: `${Math.random() * 60 + 20}%` }} />
        ))}
      </div>
    );
  }

  if (!data.length) {
    return (
      <div className="w-full h-40 flex items-center justify-center text-sm text-txt-muted">
        Keine Daten für diesen Zeitraum
      </div>
    );
  }

  const handleTouchStart = (e: React.TouchEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const touch = e.touches[0];
    const svgX = ((touch.clientX - rect.left) / rect.width) * W;
    const slotIdx = Math.floor((svgX - PAD.left) / slotW);
    if (slotIdx >= 0 && slotIdx < n) {
      if (touchTimerRef.current) clearTimeout(touchTimerRef.current);
      setHovered(slotIdx);
      touchTimerRef.current = setTimeout(() => setHovered(null), 2000);
    }
  };

  return (
    <div className="relative w-full select-none">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height: '160px' }}
        onMouseLeave={() => setHovered(null)}
        onTouchStart={handleTouchStart}
      >
        <defs>
          <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34d399" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Grid */}
        {orderTicks.map((t, i) => (
          <line key={i} x1={PAD.left} y1={t.y} x2={W - PAD.right} y2={t.y}
            stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
        ))}

        {/* Revenue fill */}
        {fillPath && <path d={fillPath} fill="url(#revGrad)" />}

        {/* Hover zone + bars */}
        {data.map((d, i) => (
          <g key={d.key}
            onMouseEnter={() => setHovered(i)}
            style={{ cursor: 'pointer' }}
          >
            {/* Hover highlight */}
            {hovered === i && (
              <rect x={PAD.left + slotW * i} y={PAD.top} width={slotW} height={PH}
                fill="rgba(255,255,255,0.03)" rx="3" />
            )}
            {/* Order bar */}
            <rect x={barX(i)} y={barTop(d.count)} width={barW} height={barH(d.count)}
              fill={hovered === i ? '#60a5fa' : '#3b82f6'} rx="2"
              style={{ transition: 'fill 0.1s' }} />
          </g>
        ))}

        {/* Revenue line */}
        {linePath && (
          <path d={linePath} fill="none" stroke="#34d399" strokeWidth="2"
            strokeLinejoin="round" strokeLinecap="round" />
        )}

        {/* Revenue dots */}
        {data.map((d, i) => (
          <circle key={d.key} cx={lineX(i)} cy={lineY(d.revenue)} r={hovered === i ? 4 : 2.5}
            fill={hovered === i ? '#6ee7b7' : '#34d399'}
            style={{ transition: 'r 0.1s, fill 0.1s' }} />
        ))}

        {/* X-axis labels */}
        {data.map((d, i) => {
          // Skip labels when too dense
          const step = n > 20 ? 4 : n > 12 ? 2 : 1;
          if (i % step !== 0) return null;
          return (
            <text key={d.key} x={lineX(i)} y={H - 6}
              textAnchor="middle" fill="#4b5563" fontSize="9" fontFamily="system-ui">
              {d.label}
            </text>
          );
        })}

        {/* Left Y-axis (orders) */}
        {orderTicks.map((t, i) => (
          <text key={i} x={PAD.left - 5} y={t.y + 3.5}
            textAnchor="end" fill="#4b5563" fontSize="9" fontFamily="system-ui">
            {t.v}
          </text>
        ))}

        {/* Right Y-axis (revenue) */}
        {revTicks.map((t, i) => (
          <text key={i} x={W - PAD.right + 5} y={t.y + 3.5}
            textAnchor="start" fill="#059669" fontSize="9" fontFamily="system-ui">
            {fmtRevAxis(t.v)}
          </text>
        ))}

        {/* Axis border */}
        <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + PH}
          stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
        <line x1={W - PAD.right} y1={PAD.top} x2={W - PAD.right} y2={PAD.top + PH}
          stroke="rgba(16,185,129,0.2)" strokeWidth="1" />
      </svg>

      {/* Hover tooltip */}
      {hovered !== null && data[hovered] && (
        <div
          className="absolute pointer-events-none z-10 bg-app-elevated border border-app-border rounded-lg px-3 py-2 text-xs shadow-app"
          style={{
            left: `${((hovered + 0.5) / n) * 100}%`,
            top: '4px',
            transform: hovered > n / 2 ? 'translateX(-110%)' : 'translateX(10%)',
          }}
        >
          <p className="text-txt-primary font-semibold mb-1">{data[hovered].label}</p>
          <p className="text-info">{fmtNum(data[hovered].count)} Aufträge</p>
          <p className="text-success">{fmtCur(data[hovered].revenue, currency)}</p>
        </div>
      )}
    </div>
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
      const [mResult, fResult, sResult, aResult] = await Promise.allSettled([
        fetchDashboardMetrics({ days: 7, preset: activePreset, from_date: fromDate, to_date: toDate }, { timeoutMs: long ? 90000 : 28000 }),
        fetchFinanceMetrics(activePreset, { timeoutMs: 40000, from_date: fromDate, to_date: toDate }),
        fetchSyncStatus(),
        fetchReorderAlerts(),
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
    const chart: ChartDay[] = days.map(d => {
      const dt = (() => { try { return new Date(d.date); } catch { return null; } })();
      const label = (() => {
        if (!dt) return d.date;
        if (bucket === 'month') return dt.toLocaleDateString('de-DE', { month: 'short' });
        if (bucket === 'week') return dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
        if (bucket === 'hour') return dt.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        if (n <= 14) return dt.toLocaleDateString('de-DE', { weekday: 'short' });
        return dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
      })();
      return { key: d.date, label, count: Number(d.orders || 0), revenue: Number(d.revenue || 0) };
    });
    // Derive order count from chart data (date-filtered from BaseLinker), NOT from
    // status_breakdown which counts ALL orders globally regardless of time window.
    const totalOrdersInWindow = chart.reduce((s, d) => s + d.count, 0);
    return {
      neu: bd?.neu ?? 0,
      kommissioniert: bd?.kommissioniert ?? 0,
      verpackt: (bd as any)?.verpackt ?? 0,
      versendet: bd?.versendet ?? 0,
      zugestellt: bd?.zugestellt ?? 0,
      totalOrdersInWindow,
      revenueYtd: metrics?.revenue?.payout_brutto_ytd ?? metrics?.revenue?.all_non_cancelled_total ?? 0,
      revenueWindow: metrics?.revenue?.payout_brutto_window ?? metrics?.revenue?.window_non_cancelled_total ?? 0,
      returnsTotal: metrics?.orders?.returns_total ?? 0,
      returnsMonth: metrics?.orders?.returns_month ?? 0,
      returnsWindowValue: (metrics as any)?.returns?.window?.value_by_currency?.EUR ?? 0,
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
    const target = statusKey === 'neu' ? 'inventory' : 'products';
    window.location.hash = `#/${target}?orderStatus=${encodeURIComponent(statusKey)}`;
  }, []);

  const nowStr = lastRefreshed?.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) ?? null;

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5 pb-8">

      {/* ══ Header ══════════════════════════════════════════════════════ */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-txt-muted">
          {nowStr ? `Stand: ${nowStr}` : 'Wird geladen…'}
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

      {/* ══ 1. JAHRESÜBERBLICK ═══════════════════════════════════════════ */}
      <Section title="Jahresüberblick">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card
            label="Kontostand"
            value={totalBalance !== null ? fmtCur(totalBalance, 'EUR') : '—'}
            sub="SevDesk"
            color={totalBalance !== null && totalBalance < 0 ? 'red' : 'violet'}
            loading={financeLoading}
            size="hero"
          />
          <Card
            label="Jahresumsatz"
            value={fmtCur(ord.revenueYtd, ord.currency, true)}
            sub="Brutto"
            color="green"
            loading={metricsLoading}
            size="hero"
          />
          <Card
            label="Versand (Jahr)"
            value={shippingYtd !== null ? fmtCur(shippingYtd, 'EUR', true) : '—'}
            sub={shippingYtd !== null ? (
              <span className="flex flex-col gap-0.5">
                <span>{fmtNum(finance?.shipping_ytd?.parcel_count ?? 0)} Sendungen</span>
                {((finance?.shipping_ytd?.dhl_count ?? 0) > 0 || (finance?.shipping_ytd?.dpd_count ?? 0) > 0) && (
                  <span className="text-[10px] text-txt-muted">
                    {(finance?.shipping_ytd?.dhl_count ?? 0) > 0 && `DHL ${fmtNum(finance.shipping_ytd.dhl_count)}`}
                    {(finance?.shipping_ytd?.dhl_count ?? 0) > 0 && (finance?.shipping_ytd?.dpd_count ?? 0) > 0 && ' · '}
                    {(finance?.shipping_ytd?.dpd_count ?? 0) > 0 && `DPD ${fmtNum(finance.shipping_ytd.dpd_count)}`}
                  </span>
                )}
              </span>
            ) : undefined}
            color="amber"
            loading={financeLoading && shippingYtd === null}
            size="hero"
          />
          <Card
            label="Retouren (gesamt)"
            value={fmtNum(ord.returnsTotal)}
            color={ord.returnsTotal > 0 ? 'red' : 'neutral'}
            loading={metricsLoading}
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

      {/* ══ 2. BESTAND ════════════════════════════════════════════════════ */}
      <Section title="Bestand">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card
            label="Im Bestand"
            value={fmtNum(inv.inStock)}
            sub={`von ${fmtNum(inv.total)} Produkten`}
            color="blue"
          />
          <Card
            label="Einheiten"
            value={fmtNum(inv.available)}
            sub={`${fmtNum(inv.reserved)} reserviert`}
            color="blue"
          />
          <Card
            label="Bestandswert"
            value={fmtCur(inv.totalValue, inv.primaryCur, true)}
            color="green"
          />
          <Card
            label="Synchronisierung"
            value={`${fmtNum(inv.sync.synced)} / ${fmtNum(inv.total)}`}
            sub={inv.sync.failed > 0 ? `${inv.sync.failed} Fehler` : inv.sync.pending > 0 ? `${inv.sync.pending} ausstehend` : undefined}
            color={inv.sync.failed > 0 ? 'red' : inv.sync.pending > 0 ? 'amber' : 'green'}
          />
        </div>
      </Section>

      {/* ══ 2b. SYNC-HEALTH ══════════════════════════════════════════════ */}
      <Section title="Marketplace Sync" badge={syncStatus && syncStatus.summary.totalErrors > 0 ? `${syncStatus.summary.totalErrors} Fehler` : undefined}>
        {syncLoading ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="rounded-2xl border border-app-border bg-app-surface p-5 h-24 animate-pulse" />
            ))}
          </div>
        ) : syncStatus ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {/* Per-channel cards */}
            {(['ebay', 'kaufland', 'baselinker'] as const).map(ch => {
              const c = syncStatus.channels[ch];
              if (!c) return (
                <Card key={ch} label={ch.charAt(0).toUpperCase() + ch.slice(1)} value="—" sub="Nicht verbunden" color="neutral" size="sm" />
              );
              const hasErrors = c.errorCount > 0;
              const ago = c.lastSync ? (() => {
                const diff = Date.now() - new Date(c.lastSync).getTime();
                const mins = Math.floor(diff / 60000);
                if (mins < 1) return 'gerade eben';
                if (mins < 60) return `vor ${mins} Min.`;
                const hrs = Math.floor(mins / 60);
                if (hrs < 24) return `vor ${hrs} Std.`;
                return `vor ${Math.floor(hrs / 24)} Tagen`;
              })() : null;
              return (
                <Card
                  key={ch}
                  label={ch.charAt(0).toUpperCase() + ch.slice(1)}
                  value={`${c.successCount}/${c.totalCount}`}
                  sub={ago ? `Letzter Sync: ${ago}${hasErrors ? ` · ${c.errorCount} Fehler` : ''}` : undefined}
                  color={hasErrors ? 'red' : c.totalCount > 0 ? 'green' : 'neutral'}
                  size="sm"
                />
              );
            })}
            {/* Reservations card */}
            <Card
              label="Reservierungen"
              value={fmtNum(syncStatus.reservations.count)}
              sub={`${fmtNum(syncStatus.reservations.totalQuantity)} Einheiten reserviert`}
              color={syncStatus.reservations.count > 0 ? 'amber' : 'neutral'}
              size="sm"
            />
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {(['ebay', 'kaufland', 'baselinker'] as const).map(ch => (
              <Card key={ch} label={ch.charAt(0).toUpperCase() + ch.slice(1)} value="—" sub="Kein Sync in 24h" color="neutral" size="sm" />
            ))}
            <Card label="Reservierungen" value="0" sub="Keine aktiven Reservierungen" color="neutral" size="sm" />
          </div>
        )}
      </Section>

      {/* ══ 3. AUFTRAGSFLUSS ═══════════════════════════════════════════ */}
      <Section title="Auftragsfluss" badge={!metricsLoading && ord.neu > 0 ? `${ord.neu} offen` : undefined}>
        <div className="rounded-lg border border-app-border bg-app-surface p-5">
          <Pipeline
            bd={{ neu: ord.neu, kommissioniert: ord.kommissioniert, verpackt: ord.verpackt, versendet: ord.versendet, zugestellt: ord.zugestellt }}
            loading={metricsLoading}
            onClickStatus={navigateTo}
          />
        </div>
      </Section>

      {/* ══ 4. KENNZAHLEN · ZEITRAUM + CHART ══════════════════════════ */}
      <Section title={`Kennzahlen · ${presetLabel}`}>
        <div className="grid grid-cols-3 gap-3 mb-4">
          <Card
            label="Umsatz"
            value={fmtCur(ord.revenueWindow, ord.currency, true)}
            sub={`${fmtNum(ord.totalOrdersInWindow)} Aufträge`}
            color="green"
            loading={metricsLoading}
          />
          <Card
            label="Versand"
            value={shippingWindow !== null ? fmtCur(shippingWindow, 'EUR', true) : '—'}
            sub={shippingWindow !== null ? (
              <span className="flex flex-col gap-0.5">
                <span>{fmtNum(finance?.shipping?.parcel_count ?? 0)} Sendungen</span>
                {((finance?.shipping?.dhl_count ?? 0) > 0 || (finance?.shipping?.dpd_count ?? 0) > 0) && (
                  <span className="text-[10px] text-txt-muted">
                    {(finance?.shipping?.dhl_count ?? 0) > 0 && `DHL ${finance.shipping.dhl_count}`}
                    {(finance?.shipping?.dhl_count ?? 0) > 0 && (finance?.shipping?.dpd_count ?? 0) > 0 && ' · '}
                    {(finance?.shipping?.dpd_count ?? 0) > 0 && `DPD ${finance.shipping.dpd_count}`}
                  </span>
                )}
              </span>
            ) : undefined}
            color="amber"
            loading={financeLoading && shippingWindow === null}
          />
          <Card
            label="Retouren"
            value={fmtNum(ord.returnsTotal)}
            color={ord.returnsTotal > 0 ? 'red' : 'neutral'}
            loading={metricsLoading}
          />
        </div>

        {/* Chart */}
        <div className="rounded-lg border border-app-border bg-app-surface p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-xs font-semibold text-txt-primary">Auftragsvolumen & Umsatz</p>
              <p className="text-[10px] text-txt-muted">{presetLabel}</p>
            </div>
            <div className="flex items-center gap-4 text-[10px] text-txt-muted">
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-3 h-3 rounded-sm bg-info" />
                Aufträge (links)
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-3 h-1.5 rounded-full bg-success" />
                Umsatz (rechts)
              </span>
            </div>
          </div>
          <DualChart data={ord.chart} currency={ord.currency} loading={metricsLoading} />
        </div>
      </Section>

      {/* ══ 5. NACHBESTELLUNGS-WARNUNGEN ══════════════════════════ */}
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
                      onClick={() => onSelectProduct(a.productId)}
                    >
                      <td className="px-4 py-2 text-txt-primary font-medium truncate max-w-[200px]">
                        {a.name || a.productId?.slice(0, 12)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-warning font-semibold">
                        {a.currentStock ?? '—'}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-txt-muted">
                        {typeof a.velocity === 'number' ? a.velocity.toFixed(1) : '—'}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <span className={`font-mono font-semibold ${(a.daysUntilStockout ?? 999) < 7 ? 'text-danger' : 'text-warning'}`}>
                          {typeof a.daysUntilStockout === 'number'
                            ? `${a.daysUntilStockout} Tage`
                            : '—'}
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

    </div>
  );
};

export default Dashboard;
