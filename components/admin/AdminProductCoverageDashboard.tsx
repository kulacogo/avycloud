import React from 'react';
import { adminGetProductCoverageMetrics, type AdminProductCoverageMetrics } from '../../api/client';

const formatPct = (n: number, d: number) => {
  if (!d) return '0%';
  return `${Math.round((n / d) * 100)}%`;
};

const sumHistogram = (h: Record<string, number>) => Object.values(h || {}).reduce((s, v) => s + (Number(v) || 0), 0);

export const AdminProductCoverageDashboard: React.FC = () => {
  const [data, setData] = React.useState<AdminProductCoverageMetrics | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [lastUpdatedIso, setLastUpdatedIso] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await adminGetProductCoverageMetrics();
      setData(next);
      setLastUpdatedIso(new Date().toISOString());
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    let ignore = false;
    (async () => {
      if (ignore) return;
      await load();
    })();
    const t = window.setInterval(() => {
      load().catch(() => {});
    }, 15000);
    return () => {
      ignore = true;
      window.clearInterval(t);
    };
  }, [load]);

  const total = data?.totalProducts || 0;
  const gpsrAny = data?.gpsr.anyFieldPresent || 0;
  const gpsrFull = data?.gpsr.fullRequiredFieldsPresent || 0;
  const gpsrFullNoPH = data?.gpsr.fullRequiredFieldsNoPlaceholders || 0;
  const gpsrNeed = data?.gpsr.candidatesNeedingEnrich || 0;
  const ktyp = data?.ktyp.withValue || 0;
  const titleBad = data?.title.badCount || 0;

  const hist = data?.gpsr.requiredFilledHistogram || {};
  const histTotal = sumHistogram(hist);

  return (
    <div className="rounded-2xl bg-slate-900/60 p-4 ring-1 ring-slate-700/60">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-100">Data coverage</div>
          <div className="text-xs text-slate-400">
            {lastUpdatedIso ? `Updated ${new Date(lastUpdatedIso).toLocaleTimeString()}` : '—'}
          </div>
        </div>

        <button
          type="button"
          onClick={() => load()}
          className="rounded-xl bg-slate-800/80 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-60"
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error ? (
        <div className="mt-3 rounded-xl bg-rose-900/30 p-3 text-sm text-rose-200 ring-1 ring-rose-700/40">{error}</div>
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="rounded-xl bg-slate-800/60 p-3 ring-1 ring-slate-700/50">
          <div className="text-xs text-slate-400">Products</div>
          <div className="mt-1 text-2xl font-bold text-slate-100">{total}</div>
          <div className="mt-1 text-xs text-slate-400">
            Titles outside {data?.title.minLen ?? 20}–{data?.title.maxLen ?? 80}: <span className="text-slate-200">{titleBad}</span>
          </div>
        </div>

        <div className="rounded-xl bg-slate-800/60 p-3 ring-1 ring-slate-700/50">
          <div className="text-xs text-slate-400">K‑Typ</div>
          <div className="mt-1 text-2xl font-bold text-slate-100">
            {ktyp} <span className="text-sm font-semibold text-slate-400">({formatPct(ktyp, total)})</span>
          </div>
          <div className="mt-1 text-xs text-slate-400">Products with K‑Typ attribute set</div>
        </div>

        <div className="rounded-xl bg-slate-800/60 p-3 ring-1 ring-slate-700/50">
          <div className="text-xs text-slate-400">GPSR</div>
          <div className="mt-1 text-2xl font-bold text-slate-100">
            {gpsrFullNoPH}{' '}
            <span className="text-sm font-semibold text-slate-400">({formatPct(gpsrFullNoPH, total)})</span>
          </div>
          <div className="mt-1 text-xs text-slate-400">
            Full required fields (no placeholders). Any: <span className="text-slate-200">{gpsrAny}</span>, Full incl. placeholders:{' '}
            <span className="text-slate-200">{gpsrFull}</span>
          </div>
          <div className="mt-1 text-xs text-slate-400">
            Candidates needing enrich (BIN+qty≥1): <span className="text-slate-200">{gpsrNeed}</span>
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-xl bg-slate-800/40 p-3 ring-1 ring-slate-700/40">
        <div className="text-xs font-semibold text-slate-200">GPSR required fields filled (per product)</div>
        <div className="mt-2 grid grid-cols-4 gap-2 md:grid-cols-9">
          {Array.from({ length: 9 }).map((_, i) => {
            const key = String(i);
            const count = Number(hist[key] || 0);
            return (
              <div key={key} className="rounded-lg bg-slate-900/40 p-2 ring-1 ring-slate-700/40">
                <div className="text-[11px] text-slate-400">{i}/8</div>
                <div className="text-sm font-bold text-slate-100">{count}</div>
                <div className="text-[11px] text-slate-400">{formatPct(count, histTotal || total)}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

