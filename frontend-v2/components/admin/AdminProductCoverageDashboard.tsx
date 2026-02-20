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
    <div className="rounded-xl bg-[var(--surface)] p-4 border border-[var(--border)]">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-[var(--text-primary)]">Data coverage</div>
          <div className="text-xs text-[var(--text-tertiary)]">
            {lastUpdatedIso ? `Updated ${new Date(lastUpdatedIso).toLocaleTimeString()}` : '\u2014'}
          </div>
        </div>

        <button
          type="button"
          onClick={() => load()}
          className="rounded-lg bg-[var(--surface-elevated)] px-3 py-2 text-xs font-semibold text-[var(--text-primary)] hover:opacity-80 border border-[var(--border)] disabled:opacity-60 transition"
          disabled={loading}
        >
          {loading ? 'Refreshing\u2026' : 'Refresh'}
        </button>
      </div>

      {/* Error */}
      {error ? (
        <div className="mt-3 rounded-xl bg-[var(--error)]/10 p-3 text-sm text-[var(--error)] border border-[var(--error)]/40">{error}</div>
      ) : null}

      {/* Top-level metric cards */}
      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
        {/* Products card */}
        <div className="rounded-xl bg-[var(--surface-elevated)] p-3 border border-[var(--border)]">
          <div className="text-xs text-[var(--text-tertiary)]">Products</div>
          <div className="mt-1 text-2xl font-bold text-[var(--text-primary)]">{total}</div>
          <div className="mt-1 text-xs text-[var(--text-tertiary)]">
            Title policy ok:{' '}
            <button
              type="button"
              onClick={() => open('Title policy ok', data?.buckets?.titleOkIds)}
              className="text-[var(--text-primary)] underline decoration-[var(--border)] underline-offset-2 hover:decoration-[var(--text-secondary)]"
            >
              {titleOk}
            </button>
            <span className="text-[var(--text-tertiary)]"> \u00b7 </span>
            not ok:{' '}
            <button
              type="button"
              onClick={() => open('Title policy not ok', data?.buckets?.titleNotOkIds)}
              className="text-[var(--text-primary)] underline decoration-[var(--border)] underline-offset-2 hover:decoration-[var(--text-secondary)]"
            >
              {titleNotOk}
            </button>
            <span className="text-[var(--text-tertiary)]"> \u00b7 </span>
            ideal {data?.title.idealMinLen ?? 65}\u2013{data?.title.idealMaxLen ?? 75}:{' '}
            <button
              type="button"
              onClick={() => open('Title ideal length not met', data?.buckets?.titleNotIdealLenIds)}
              className="text-[var(--text-primary)] underline decoration-[var(--border)] underline-offset-2 hover:decoration-[var(--text-secondary)]"
            >
              {Math.max(0, total - titleIdealOk)}
            </button>
          </div>
        </div>

        {/* K-Typ card */}
        <div className="rounded-xl bg-[var(--surface-elevated)] p-3 border border-[var(--border)]">
          <div className="text-xs text-[var(--text-tertiary)]">K\u2011Typ</div>
          <div className="mt-1 text-2xl font-bold text-[var(--text-primary)]">
            <button
              type="button"
              onClick={() => open('K\u2011Typ set', data?.buckets?.ktypWithValueIds)}
              className="underline decoration-[var(--border)] underline-offset-4 hover:decoration-[var(--text-secondary)]"
            >
              {ktyp}
            </button>{' '}
            <span className="text-sm font-semibold text-[var(--text-tertiary)]">
              ({formatPct(ktyp, ktypFitmentTotal || total)})
            </span>
          </div>
          <div className="mt-1 text-xs text-[var(--text-tertiary)]">
            K\u2011Typ set. Denominator: {ktypFitmentTotal ? 'Auto/Moto fitment categories' : 'all products'}.
            {ktypFitmentTotal ? (
              <>
                {' '}
                Missing in fitment:{' '}
                <button
                  type="button"
                  onClick={() => open('K\u2011Typ missing (only Auto/Moto fitment)', data?.buckets?.ktypMissingInFitmentIds)}
                  className="text-[var(--text-primary)] underline decoration-[var(--border)] underline-offset-2 hover:decoration-[var(--text-secondary)]"
                >
                  {data?.buckets?.ktypMissingInFitmentIds?.length ?? Math.max(0, ktypFitmentTotal - ktyp)}
                </button>
              </>
            ) : null}
          </div>
        </div>

        {/* GPSR card */}
        <div className="rounded-xl bg-[var(--surface-elevated)] p-3 border border-[var(--border)]">
          <div className="text-xs text-[var(--text-tertiary)]">GPSR</div>
          <div className="mt-1 text-2xl font-bold text-[var(--text-primary)]">
            <button
              type="button"
              onClick={() => open('GPSR complete (8/8, no placeholders)', data?.buckets?.gpsrFullRequiredNoPlaceholdersIds)}
              className="underline decoration-[var(--border)] underline-offset-4 hover:decoration-[var(--text-secondary)]"
            >
              {gpsrFullNoPH}
            </button>{' '}
            <span className="text-sm font-semibold text-[var(--text-tertiary)]">({formatPct(gpsrFullNoPH, total)})</span>
          </div>
          <div className="mt-1 text-xs text-[var(--text-tertiary)]">
            8/8 required (no placeholders). Any fields:{' '}
            <button
              type="button"
              onClick={() => open('GPSR has any field', [])}
              className="text-[var(--text-primary)]"
              disabled
            >
              {gpsrAny}
            </button>
            , 8/8 incl. placeholders:{' '}
            <button
              type="button"
              onClick={() => open('GPSR 8/8 (including placeholders)', data?.buckets?.gpsrFullRequiredIds)}
              className="text-[var(--text-primary)] underline decoration-[var(--border)] underline-offset-2 hover:decoration-[var(--text-secondary)]"
            >
              {gpsrFull}
            </button>
          </div>
          <div className="mt-1 text-xs text-[var(--text-tertiary)]">
            Candidates needing enrich (BIN+qty{'>='}1):{' '}
            <button
              type="button"
              onClick={() => open('GPSR missing (BIN+qty>=1)', data?.buckets?.gpsrCandidatesNeedingEnrichIds)}
              className="text-[var(--text-primary)] underline decoration-[var(--border)] underline-offset-2 hover:decoration-[var(--text-secondary)]"
            >
              {gpsrNeed}
            </button>
          </div>
        </div>
      </div>

      {/* Price sanity + Main categories row */}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        {/* Price sanity */}
        <div className="rounded-xl bg-[var(--surface-elevated)] p-3 border border-[var(--border)]">
          <div className="text-xs font-semibold text-[var(--text-primary)]">Price sanity (configurable)</div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
            <label className="inline-flex items-center gap-2">
              <span className="text-[var(--text-tertiary)]">Min</span>
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
                className="w-20 rounded-lg bg-[var(--surface)] px-2 py-1 text-[var(--text-primary)] border border-[var(--border)] focus:border-[var(--avy-purple)] focus:outline-none transition"
              />
            </label>
            <label className="inline-flex items-center gap-2">
              <span className="text-[var(--text-tertiary)]">Max</span>
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
                className="w-20 rounded-lg bg-[var(--surface)] px-2 py-1 text-[var(--text-primary)] border border-[var(--border)] focus:border-[var(--avy-purple)] focus:outline-none transition"
              />
            </label>
            <button
              type="button"
              onClick={() => load()}
              className="rounded-lg bg-[var(--avy-purple)] px-2.5 py-1 font-semibold text-white hover:opacity-90 transition"
            >
              Apply
            </button>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => open('Price missing (<= 0 or invalid)', data?.buckets?.priceMissingIds)}
              className="rounded-lg bg-[var(--surface)] p-2 text-left border border-[var(--border)] hover:bg-[var(--surface-elevated)] transition"
            >
              <div className="text-[11px] text-[var(--text-tertiary)]">Missing</div>
              <div className="text-sm font-bold text-[var(--text-primary)]">{data?.price?.missingCount ?? 0}</div>
            </button>
            <button
              type="button"
              onClick={() => open('Price ok', data?.buckets?.priceOkIds)}
              className="rounded-lg bg-[var(--surface)] p-2 text-left border border-[var(--border)] hover:bg-[var(--surface-elevated)] transition"
            >
              <div className="text-[11px] text-[var(--text-tertiary)]">OK</div>
              <div className="text-sm font-bold text-[var(--text-primary)]">{data?.price?.okCount ?? 0}</div>
            </button>
            <button
              type="button"
              onClick={() => open('Price out of range', data?.buckets?.priceOutOfRangeIds)}
              className="rounded-lg bg-[var(--surface)] p-2 text-left border border-[var(--border)] hover:bg-[var(--surface-elevated)] transition"
            >
              <div className="text-[11px] text-[var(--text-tertiary)]">Out of range</div>
              <div className="text-sm font-bold text-[var(--text-primary)]">{data?.price?.outOfRangeCount ?? 0}</div>
            </button>
          </div>
        </div>

        {/* Main categories */}
        <div className="flex-1 rounded-xl bg-[var(--surface-elevated)] p-3 border border-[var(--border)]">
          <div className="text-xs font-semibold text-[var(--text-primary)]">Main categories</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {Object.entries(data?.categories?.mainCategoryCounts || {})
              .sort((a, b) => Number(b[1]) - Number(a[1]))
              .slice(0, 12)
              .map(([cat, count]) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => open(`Category: ${cat}`, data?.buckets?.mainCategoryIds?.[cat])}
                  className="rounded-full bg-[var(--surface)] px-3 py-1 text-xs font-semibold text-[var(--text-primary)] border border-[var(--border)] hover:bg-[var(--surface-elevated)] transition"
                >
                  {cat} <span className="text-[var(--text-tertiary)]">({count})</span>
                </button>
              ))}
          </div>
          <div className="mt-2 text-[11px] text-[var(--text-tertiary)]">Shows top 12; click a chip to open filtered list.</div>
        </div>
      </div>

      {/* GPSR histogram */}
      <div className="mt-4 rounded-xl bg-[var(--surface-elevated)] p-3 border border-[var(--border)]">
        <div className="text-xs font-semibold text-[var(--text-primary)]">GPSR required fields filled (per product, no placeholders)</div>
        <div className="mt-2 grid grid-cols-4 gap-2 md:grid-cols-9">
          {Array.from({ length: 9 }).map((_, i) => {
            const key = String(i);
            const count = Number(hist[key] || 0);
            return (
              <button
                key={key}
                type="button"
                onClick={() => open(`GPSR ${i}/8 filled (no placeholders)`, data?.buckets?.gpsrFilledCountIds?.[key])}
                className="rounded-lg bg-[var(--surface)] p-2 text-left border border-[var(--border)] hover:bg-[var(--surface-elevated)] transition"
              >
                <div className="text-[11px] text-[var(--text-tertiary)]">{i}/8</div>
                <div className="text-sm font-bold text-[var(--text-primary)]">{count}</div>
                <div className="text-[11px] text-[var(--text-tertiary)]">{formatPct(count, histTotal || total)}</div>
              </button>
            );
          })}
        </div>
        <div className="mt-2 text-[11px] text-[var(--text-tertiary)]">
          Info: old "8/8" counts could be higher when placeholders are present. For comparison, "8/8 including placeholders" total is{' '}
          <span className="text-[var(--text-secondary)]">{Number(histIncl['8'] || 0)}</span> / {histInclTotal || total}.
        </div>
      </div>
    </div>
  );
};
