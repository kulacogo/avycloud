import React from 'react';
import { adminGetProductCoverageMetrics, type AdminProductCoverageMetrics } from '../../api/client';

const formatPct = (n: number, d: number) => {
  if (!d) return '0%';
  return `${Math.round((n / d) * 100)}%`;
};

const sumHistogram = (h: Record<string, number>) => Object.values(h || {}).reduce((s, v) => s + (Number(v) || 0), 0);

type DrilldownPayload = { title: string; ids: string[] };

export const AdminProductCoverageDashboard: React.FC<{
  onOpenDrilldown?: (payload: DrilldownPayload) => void;
}> = ({ onOpenDrilldown }) => {
  const [data, setData] = React.useState<AdminProductCoverageMetrics | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [lastUpdatedIso, setLastUpdatedIso] = React.useState<string | null>(null);
  const [minPrice, setMinPrice] = React.useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem('avystock:dashboard:minPrice') || '';
  });
  const [maxPrice, setMaxPrice] = React.useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem('avystock:dashboard:maxPrice') || '';
  });

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await adminGetProductCoverageMetrics({
        minPrice: minPrice.trim() || null,
        maxPrice: maxPrice.trim() || null,
      });
      setData(next);
      setLastUpdatedIso(new Date().toISOString());
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [minPrice, maxPrice]);

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
  const ktypFitmentTotal = data?.ktyp.fitmentTotal || 0;
  const titleOk = data?.title.policyOkCount || 0;
  const titleNotOk = data?.title.policyNotOkCount || 0;
  const titleIdealOk = data?.title.idealLenOkCount || 0;

  const hist = data?.gpsr.requiredFilledHistogram || {};
  const histTotal = sumHistogram(hist);
  const histIncl = data?.gpsr.requiredFilledHistogramIncludingPlaceholders || {};
  const histInclTotal = sumHistogram(histIncl);

  const open = (title: string, ids?: string[]) => {
    if (!onOpenDrilldown) return;
    const list = Array.isArray(ids) ? ids : [];
    onOpenDrilldown({ title, ids: list });
  };

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
            Title policy ok:{' '}
            <button
              type="button"
              onClick={() => open('Title policy ok', data?.buckets?.titleOkIds)}
              className="text-slate-200 underline decoration-slate-500/60 underline-offset-2 hover:decoration-slate-300"
            >
              {titleOk}
            </button>
            <span className="text-slate-500"> · </span>
            not ok:{' '}
            <button
              type="button"
              onClick={() => open('Title policy not ok', data?.buckets?.titleNotOkIds)}
              className="text-slate-200 underline decoration-slate-500/60 underline-offset-2 hover:decoration-slate-300"
            >
              {titleNotOk}
            </button>
            <span className="text-slate-500"> · </span>
            ideal {data?.title.idealMinLen ?? 65}–{data?.title.idealMaxLen ?? 75}:{' '}
            <button
              type="button"
              onClick={() => open('Title ideal length not met', data?.buckets?.titleNotIdealLenIds)}
              className="text-slate-200 underline decoration-slate-500/60 underline-offset-2 hover:decoration-slate-300"
            >
              {Math.max(0, total - titleIdealOk)}
            </button>
          </div>
        </div>

        <div className="rounded-xl bg-slate-800/60 p-3 ring-1 ring-slate-700/50">
          <div className="text-xs text-slate-400">K‑Typ</div>
          <div className="mt-1 text-2xl font-bold text-slate-100">
            <button
              type="button"
              onClick={() => open('K‑Typ set', data?.buckets?.ktypWithValueIds)}
              className="underline decoration-slate-500/60 underline-offset-4 hover:decoration-slate-300"
            >
              {ktyp}
            </button>{' '}
            <span className="text-sm font-semibold text-slate-400">
              ({formatPct(ktyp, ktypFitmentTotal || total)})
            </span>
          </div>
          <div className="mt-1 text-xs text-slate-400">
            K‑Typ set. Denominator: {ktypFitmentTotal ? 'Auto/Moto fitment categories' : 'all products'}.
            {ktypFitmentTotal ? (
              <>
                {' '}
                Missing in fitment:{' '}
                <button
                  type="button"
                  onClick={() => open('K‑Typ missing (only Auto/Moto fitment)', data?.buckets?.ktypMissingInFitmentIds)}
                  className="text-slate-200 underline decoration-slate-500/60 underline-offset-2 hover:decoration-slate-300"
                >
                  {data?.buckets?.ktypMissingInFitmentIds?.length ?? Math.max(0, ktypFitmentTotal - ktyp)}
                </button>
              </>
            ) : null}
          </div>
        </div>

        <div className="rounded-xl bg-slate-800/60 p-3 ring-1 ring-slate-700/50">
          <div className="text-xs text-slate-400">GPSR</div>
          <div className="mt-1 text-2xl font-bold text-slate-100">
            <button
              type="button"
              onClick={() => open('GPSR complete (8/8, no placeholders)', data?.buckets?.gpsrFullRequiredNoPlaceholdersIds)}
              className="underline decoration-slate-500/60 underline-offset-4 hover:decoration-slate-300"
            >
              {gpsrFullNoPH}
            </button>{' '}
            <span className="text-sm font-semibold text-slate-400">({formatPct(gpsrFullNoPH, total)})</span>
          </div>
          <div className="mt-1 text-xs text-slate-400">
            8/8 required (no placeholders). Any fields:{' '}
            <button
              type="button"
              onClick={() => open('GPSR has any field', [])}
              className="text-slate-200"
              disabled
            >
              {gpsrAny}
            </button>
            , 8/8 incl. placeholders:{' '}
            <button
              type="button"
              onClick={() => open('GPSR 8/8 (including placeholders)', data?.buckets?.gpsrFullRequiredIds)}
              className="text-slate-200 underline decoration-slate-500/60 underline-offset-2 hover:decoration-slate-300"
            >
              {gpsrFull}
            </button>
          </div>
          <div className="mt-1 text-xs text-slate-400">
            Candidates needing enrich (BIN+qty≥1):{' '}
            <button
              type="button"
              onClick={() => open('GPSR missing (BIN+qty≥1)', data?.buckets?.gpsrCandidatesNeedingEnrichIds)}
              className="text-slate-200 underline decoration-slate-500/60 underline-offset-2 hover:decoration-slate-300"
            >
              {gpsrNeed}
            </button>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="rounded-xl bg-slate-800/40 p-3 ring-1 ring-slate-700/40">
          <div className="text-xs font-semibold text-slate-200">Price sanity (configurable)</div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-300">
            <label className="inline-flex items-center gap-2">
              <span className="text-slate-400">Min</span>
              <input
                value={minPrice}
                onChange={(e) => {
                  const v = e.target.value;
                  setMinPrice(v);
                  try {
                    window.localStorage.setItem('avystock:dashboard:minPrice', v);
                  } catch {}
                }}
                placeholder="(off)"
                className="w-20 rounded-lg bg-slate-900/40 px-2 py-1 text-slate-100 ring-1 ring-slate-700/50"
              />
            </label>
            <label className="inline-flex items-center gap-2">
              <span className="text-slate-400">Max</span>
              <input
                value={maxPrice}
                onChange={(e) => {
                  const v = e.target.value;
                  setMaxPrice(v);
                  try {
                    window.localStorage.setItem('avystock:dashboard:maxPrice', v);
                  } catch {}
                }}
                placeholder="(off)"
                className="w-20 rounded-lg bg-slate-900/40 px-2 py-1 text-slate-100 ring-1 ring-slate-700/50"
              />
            </label>
            <button
              type="button"
              onClick={() => load()}
              className="rounded-lg bg-slate-700 px-2.5 py-1 font-semibold text-slate-100 hover:bg-slate-600"
            >
              Apply
            </button>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => open('Price missing (<= 0 or invalid)', data?.buckets?.priceMissingIds)}
              className="rounded-lg bg-slate-900/40 p-2 text-left ring-1 ring-slate-700/40 hover:bg-slate-900/60"
            >
              <div className="text-[11px] text-slate-400">Missing</div>
              <div className="text-sm font-bold text-slate-100">{data?.price?.missingCount ?? 0}</div>
            </button>
            <button
              type="button"
              onClick={() => open('Price ok', data?.buckets?.priceOkIds)}
              className="rounded-lg bg-slate-900/40 p-2 text-left ring-1 ring-slate-700/40 hover:bg-slate-900/60"
            >
              <div className="text-[11px] text-slate-400">OK</div>
              <div className="text-sm font-bold text-slate-100">{data?.price?.okCount ?? 0}</div>
            </button>
            <button
              type="button"
              onClick={() => open('Price out of range', data?.buckets?.priceOutOfRangeIds)}
              className="rounded-lg bg-slate-900/40 p-2 text-left ring-1 ring-slate-700/40 hover:bg-slate-900/60"
            >
              <div className="text-[11px] text-slate-400">Out of range</div>
              <div className="text-sm font-bold text-slate-100">{data?.price?.outOfRangeCount ?? 0}</div>
            </button>
          </div>
        </div>

        <div className="flex-1 rounded-xl bg-slate-800/40 p-3 ring-1 ring-slate-700/40">
          <div className="text-xs font-semibold text-slate-200">Main categories</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {Object.entries(data?.categories?.mainCategoryCounts || {})
              .sort((a, b) => Number(b[1]) - Number(a[1]))
              .slice(0, 12)
              .map(([cat, count]) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => open(`Category: ${cat}`, data?.buckets?.mainCategoryIds?.[cat])}
                  className="rounded-full bg-slate-900/40 px-3 py-1 text-xs font-semibold text-slate-200 ring-1 ring-slate-700/40 hover:bg-slate-900/60"
                >
                  {cat} <span className="text-slate-400">({count})</span>
                </button>
              ))}
          </div>
          <div className="mt-2 text-[11px] text-slate-500">Shows top 12; click a chip to open filtered list.</div>
        </div>
      </div>

      <div className="mt-4 rounded-xl bg-slate-800/40 p-3 ring-1 ring-slate-700/40">
        <div className="text-xs font-semibold text-slate-200">GPSR required fields filled (per product, no placeholders)</div>
        <div className="mt-2 grid grid-cols-4 gap-2 md:grid-cols-9">
          {Array.from({ length: 9 }).map((_, i) => {
            const key = String(i);
            const count = Number(hist[key] || 0);
            return (
              <button
                key={key}
                type="button"
                onClick={() => open(`GPSR ${i}/8 filled (no placeholders)`, data?.buckets?.gpsrFilledCountIds?.[key])}
                className="rounded-lg bg-slate-900/40 p-2 text-left ring-1 ring-slate-700/40 hover:bg-slate-900/60"
              >
                <div className="text-[11px] text-slate-400">{i}/8</div>
                <div className="text-sm font-bold text-slate-100">{count}</div>
                <div className="text-[11px] text-slate-400">{formatPct(count, histTotal || total)}</div>
              </button>
            );
          })}
        </div>
        <div className="mt-2 text-[11px] text-slate-500">
          Info: old “8/8” counts could be higher when placeholders are present. For comparison, “8/8 including placeholders” total is{' '}
          <span className="text-slate-300">{Number(histIncl['8'] || 0)}</span> / {histInclTotal || total}.
        </div>
      </div>
    </div>
  );
};

