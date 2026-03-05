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
    <div className="rounded-2xl bg-app-surface p-5 border border-app-border">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-txt-primary">Data coverage</div>
          <div className="text-xs text-txt-muted">
            {lastUpdatedIso ? `Updated ${new Date(lastUpdatedIso).toLocaleTimeString()}` : '—'}
          </div>
        </div>

        <button
          type="button"
          onClick={() => load()}
          className="rounded-xl bg-app-elevated px-3 py-2 text-xs font-semibold text-txt-secondary hover:bg-app-elevated disabled:opacity-60"
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error ? (
        <div className="mt-3 rounded-xl bg-danger-dim p-3 text-sm text-danger ring-1 ring-danger/40">{error}</div>
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="rounded-xl bg-app-bg/40 p-3 border border-app-border">
          <div className="text-xs text-txt-muted">Products</div>
          <div className="mt-1 text-2xl font-bold text-txt-primary">{total}</div>
          <div className="mt-1 text-xs text-txt-muted">
            Title policy ok:{' '}
            <button
              type="button"
              onClick={() => open('Title policy ok', data?.buckets?.titleOkIds)}
              className="text-txt-secondary underline decoration-txt-muted/60 underline-offset-2 hover:decoration-txt-secondary"
            >
              {titleOk}
            </button>
            <span className="text-txt-muted"> · </span>
            not ok:{' '}
            <button
              type="button"
              onClick={() => open('Title policy not ok', data?.buckets?.titleNotOkIds)}
              className="text-txt-secondary underline decoration-txt-muted/60 underline-offset-2 hover:decoration-txt-secondary"
            >
              {titleNotOk}
            </button>
            <span className="text-txt-muted"> · </span>
            ideal {data?.title.idealMinLen ?? 65}–{data?.title.idealMaxLen ?? 75}:{' '}
            <button
              type="button"
              onClick={() => open('Title ideal length not met', data?.buckets?.titleNotIdealLenIds)}
              className="text-txt-secondary underline decoration-txt-muted/60 underline-offset-2 hover:decoration-txt-secondary"
            >
              {Math.max(0, total - titleIdealOk)}
            </button>
          </div>
        </div>

        <div className="rounded-xl bg-app-bg/40 p-3 border border-app-border">
          <div className="text-xs text-txt-muted">K‑Typ</div>
          <div className="mt-1 text-2xl font-bold text-txt-primary">
            <button
              type="button"
              onClick={() => open('K‑Typ set', data?.buckets?.ktypWithValueIds)}
              className="underline decoration-txt-muted/60 underline-offset-4 hover:decoration-txt-secondary"
            >
              {ktyp}
            </button>{' '}
            <span className="text-sm font-semibold text-txt-muted">
              ({formatPct(ktyp, ktypFitmentTotal || total)})
            </span>
          </div>
          <div className="mt-1 text-xs text-txt-muted">
            K‑Typ set. Denominator: {ktypFitmentTotal ? 'Auto/Moto fitment categories' : 'all products'}.
            {ktypFitmentTotal ? (
              <>
                {' '}
                Missing in fitment:{' '}
                <button
                  type="button"
                  onClick={() => open('K‑Typ missing (only Auto/Moto fitment)', data?.buckets?.ktypMissingInFitmentIds)}
                  className="text-txt-secondary underline decoration-txt-muted/60 underline-offset-2 hover:decoration-txt-secondary"
                >
                  {data?.buckets?.ktypMissingInFitmentIds?.length ?? Math.max(0, ktypFitmentTotal - ktyp)}
                </button>
              </>
            ) : null}
          </div>
        </div>

        <div className="rounded-xl bg-app-bg/40 p-3 border border-app-border">
          <div className="text-xs text-txt-muted">GPSR</div>
          <div className="mt-1 text-2xl font-bold text-txt-primary">
            <button
              type="button"
              onClick={() => open('GPSR complete (8/8, no placeholders)', data?.buckets?.gpsrFullRequiredNoPlaceholdersIds)}
              className="underline decoration-txt-muted/60 underline-offset-4 hover:decoration-txt-secondary"
            >
              {gpsrFullNoPH}
            </button>{' '}
            <span className="text-sm font-semibold text-txt-muted">({formatPct(gpsrFullNoPH, total)})</span>
          </div>
          <div className="mt-1 text-xs text-txt-muted">
            8/8 required (no placeholders). Any fields:{' '}
            <button
              type="button"
              onClick={() => open('GPSR has any field', [])}
              className="text-txt-secondary"
              disabled
            >
              {gpsrAny}
            </button>
            , 8/8 incl. placeholders:{' '}
            <button
              type="button"
              onClick={() => open('GPSR 8/8 (including placeholders)', data?.buckets?.gpsrFullRequiredIds)}
              className="text-txt-secondary underline decoration-txt-muted/60 underline-offset-2 hover:decoration-txt-secondary"
            >
              {gpsrFull}
            </button>
          </div>
          <div className="mt-1 text-xs text-txt-muted">
            Candidates needing enrich (BIN+qty≥1):{' '}
            <button
              type="button"
              onClick={() => open('GPSR missing (BIN+qty≥1)', data?.buckets?.gpsrCandidatesNeedingEnrichIds)}
              className="text-txt-secondary underline decoration-txt-muted/60 underline-offset-2 hover:decoration-txt-secondary"
            >
              {gpsrNeed}
            </button>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="rounded-xl bg-app-surface p-3 border border-app-border">
          <div className="text-xs font-semibold text-txt-secondary">Price sanity (configurable)</div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-txt-secondary">
            <label className="inline-flex items-center gap-2">
              <span className="text-txt-muted">Min</span>
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
                className="w-20 rounded-xl bg-app-bg/40 px-2 py-1 text-txt-primary border border-app-border"
              />
            </label>
            <label className="inline-flex items-center gap-2">
              <span className="text-txt-muted">Max</span>
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
                className="w-20 rounded-xl bg-app-bg/40 px-2 py-1 text-txt-primary border border-app-border"
              />
            </label>
            <button
              type="button"
              onClick={() => load()}
              className="rounded-xl bg-app-elevated border border-white/[0.08] px-2.5 py-1 font-semibold text-txt-primary hover:bg-white/10"
            >
              Apply
            </button>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => open('Price missing (<= 0 or invalid)', data?.buckets?.priceMissingIds)}
              className="rounded-xl bg-app-bg/40 p-2 text-left border border-app-border hover:bg-app-bg/60"
            >
              <div className="text-[11px] text-txt-muted">Missing</div>
              <div className="text-sm font-bold text-txt-primary">{data?.price?.missingCount ?? 0}</div>
            </button>
            <button
              type="button"
              onClick={() => open('Price ok', data?.buckets?.priceOkIds)}
              className="rounded-xl bg-app-bg/40 p-2 text-left border border-app-border hover:bg-app-bg/60"
            >
              <div className="text-[11px] text-txt-muted">OK</div>
              <div className="text-sm font-bold text-txt-primary">{data?.price?.okCount ?? 0}</div>
            </button>
            <button
              type="button"
              onClick={() => open('Price out of range', data?.buckets?.priceOutOfRangeIds)}
              className="rounded-xl bg-app-bg/40 p-2 text-left border border-app-border hover:bg-app-bg/60"
            >
              <div className="text-[11px] text-txt-muted">Out of range</div>
              <div className="text-sm font-bold text-txt-primary">{data?.price?.outOfRangeCount ?? 0}</div>
            </button>
          </div>
        </div>

        <div className="flex-1 rounded-xl bg-app-surface p-3 border border-app-border">
          <div className="text-xs font-semibold text-txt-secondary">Main categories</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {Object.entries(data?.categories?.mainCategoryCounts || {})
              .sort((a, b) => Number(b[1]) - Number(a[1]))
              .slice(0, 12)
              .map(([cat, count]) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => open(`Category: ${cat}`, data?.buckets?.mainCategoryIds?.[cat])}
                  className="rounded-full bg-app-bg/40 px-3 py-1 text-xs font-semibold text-txt-secondary border border-app-border hover:bg-app-bg/60"
                >
                  {cat} <span className="text-txt-muted">({count})</span>
                </button>
              ))}
          </div>
          <div className="mt-2 text-[11px] text-txt-muted">Shows top 12; click a chip to open filtered list.</div>
        </div>
      </div>

      <div className="mt-4 rounded-xl bg-app-surface p-3 border border-app-border">
        <div className="text-xs font-semibold text-txt-secondary">GPSR required fields filled (per product, no placeholders)</div>
        <div className="mt-2 grid grid-cols-4 gap-2 md:grid-cols-9">
          {Array.from({ length: 9 }).map((_, i) => {
            const key = String(i);
            const count = Number(hist[key] || 0);
            return (
              <button
                key={key}
                type="button"
                onClick={() => open(`GPSR ${i}/8 filled (no placeholders)`, data?.buckets?.gpsrFilledCountIds?.[key])}
                className="rounded-xl bg-app-bg/40 p-2 text-left border border-app-border hover:bg-app-bg/60"
              >
                <div className="text-[11px] text-txt-muted">{i}/8</div>
                <div className="text-sm font-bold text-txt-primary">{count}</div>
                <div className="text-[11px] text-txt-muted">{formatPct(count, histTotal || total)}</div>
              </button>
            );
          })}
        </div>
        <div className="mt-2 text-[11px] text-txt-muted">
          Info: old “8/8” counts could be higher when placeholders are present. For comparison, “8/8 including placeholders” total is{' '}
          <span className="text-txt-secondary">{Number(histIncl['8'] || 0)}</span> / {histInclTotal || total}.
        </div>
      </div>
    </div>
  );
};

