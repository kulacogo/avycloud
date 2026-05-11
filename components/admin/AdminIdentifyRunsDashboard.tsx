import React from "react";
import {
  adminListIdentifyRuns,
  adminListLlmParity,
  type AdminIdentifyRun,
  type AdminIdentifyRunsResponse,
  type AdminLlmParityResponse,
  type AdminLlmParityRow,
} from "../../api/client";

type TabKey = "runs" | "parity";

const DOMAINS: ReadonlyArray<string> = [
  "identity",
  "category",
  "attributes",
  "seo",
  "pricing",
  "image",
  "gpsr",
  "critic",
];

const REFRESH_INTERVAL_MS = 15000;

const isoDaysAgo = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
};

const todayIso = (): string => new Date().toISOString().slice(0, 10);

const formatPct = (n: number | null): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${Math.round(n * 100)}%`;
};

const formatNum = (n: number | null, digits = 2): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
};

const formatDate = (iso: string | null): string => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
};

const clamp01 = (n: number | null): number => {
  if (n == null || !Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
};

const Bar: React.FC<{ value: number | null; ariaLabel: string; tone?: "accent" | "success" | "warning" | "danger" }> = ({
  value,
  ariaLabel,
  tone = "accent",
}) => {
  const v = clamp01(value);
  const pct = Math.round(v * 100);
  const toneBg =
    tone === "success"
      ? "bg-success"
      : tone === "warning"
        ? "bg-warning"
        : tone === "danger"
          ? "bg-danger"
          : "bg-accent";
  return (
    <div
      className="relative h-2 w-full overflow-hidden rounded-full bg-app-elevated"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={ariaLabel}
    >
      <div className={`h-full ${toneBg}`} style={{ width: `${pct}%` }} />
    </div>
  );
};

const StatusPill: React.FC<{ status: "ok" | "failed" | "skipped" | "unknown"; label: string }> = ({ status, label }) => {
  const cls =
    status === "ok"
      ? "bg-success-dim text-success"
      : status === "failed"
        ? "bg-danger-dim text-danger"
        : status === "skipped"
          ? "bg-warning-dim text-warning"
          : "bg-app-elevated text-txt-muted";
  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}
      aria-label={`${label}: ${status}`}
      title={`${label}: ${status}`}
    >
      {label}
    </span>
  );
};

const RangeSlider: React.FC<{
  id: string;
  label: string;
  minValue: number;
  maxValue: number;
  onChange: (next: { min: number; max: number }) => void;
}> = ({ id, label, minValue, maxValue, onChange }) => {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${id}-min`} className="text-[11px] font-semibold text-txt-muted">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={`${id}-min`}
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={minValue}
          onChange={(e) => {
            const v = Math.min(Number(e.target.value), maxValue);
            onChange({ min: v, max: maxValue });
          }}
          className="w-24"
          aria-label={`${label} minimum`}
        />
        <span className="w-10 text-right text-[11px] tabular-nums text-txt-secondary">{minValue.toFixed(2)}</span>
        <span className="text-txt-muted">–</span>
        <input
          id={`${id}-max`}
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={maxValue}
          onChange={(e) => {
            const v = Math.max(Number(e.target.value), minValue);
            onChange({ min: minValue, max: v });
          }}
          className="w-24"
          aria-label={`${label} maximum`}
        />
        <span className="w-10 text-right text-[11px] tabular-nums text-txt-secondary">{maxValue.toFixed(2)}</span>
      </div>
    </div>
  );
};

type WorkerStatus = "ok" | "failed" | "skipped" | "unknown";

const deriveWorkerStatus = (run: AdminIdentifyRun, domain: string): WorkerStatus => {
  const w = run.workerSummary?.[domain];
  if (!w) return "skipped";
  if (w.ok === true) return "ok";
  if (w.ok === false) return "failed";
  if (w.confidence != null) return "ok";
  return "unknown";
};

const RunsDetailDrawer: React.FC<{ run: AdminIdentifyRun | null; onClose: () => void }> = ({ run, onClose }) => {
  if (!run) return null;
  const cassini = run.cassiniSubscores;
  return (
    <div className="fixed inset-0 z-50 flex">
      <div
        className="flex-1 bg-app-bg/70 backdrop-blur-sm"
        onClick={onClose}
        role="presentation"
        aria-hidden="true"
      />
      <aside
        className="flex h-full w-full max-w-2xl flex-col gap-4 overflow-y-auto bg-app-surface p-5 border-l border-app-border shadow-app"
        aria-label="Identify run detail"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-txt-muted">Run detail</div>
            <div className="text-sm font-semibold text-txt-primary">
              {run.productId || "—"}{" "}
              {run.sku ? <span className="text-txt-muted">· {run.sku}</span> : null}
            </div>
            <div className="mt-1 text-[11px] text-txt-muted">
              {run.pipeline ? run.pipeline.toUpperCase() : "—"} · {formatDate(run.checkedAtIso)}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-app-elevated px-3 py-1.5 text-xs font-semibold text-txt-secondary hover:bg-white/10"
          >
            Close
          </button>
        </div>

        {cassini ? (
          <section className="rounded-xl bg-app-bg/40 p-3 border border-app-border">
            <div className="text-xs font-semibold text-txt-secondary">Cassini subscores</div>
            <div className="mt-2 space-y-2">
              {(
                [
                  ["title", cassini.title],
                  ["description", cassini.description],
                  ["image", cassini.image],
                  ["specifics", cassini.specifics],
                  ["compliance", cassini.compliance],
                ] as Array<[string, number | null]>
              ).map(([k, v]) => (
                <div key={k} className="flex items-center gap-2 text-[11px]">
                  <span className="w-24 text-txt-muted">{k}</span>
                  <div className="flex-1">
                    <Bar value={v} ariaLabel={`Cassini ${k}`} tone="accent" />
                  </div>
                  <span className="w-12 text-right tabular-nums text-txt-secondary">{formatPct(v)}</span>
                </div>
              ))}
              <div className="flex items-center gap-2 pt-1 text-[11px] font-semibold text-txt-primary">
                <span className="w-24">overall</span>
                <div className="flex-1">
                  <Bar value={cassini.overall} ariaLabel="Cassini overall" tone="success" />
                </div>
                <span className="w-12 text-right tabular-nums">{formatPct(cassini.overall)}</span>
              </div>
            </div>
          </section>
        ) : null}

        {run.issues && run.issues.length ? (
          <section className="rounded-xl bg-app-bg/40 p-3 border border-app-border">
            <div className="text-xs font-semibold text-txt-secondary">Issues ({run.issues.length})</div>
            <ul className="mt-2 space-y-1.5">
              {run.issues.map((issue, i) => (
                <li key={i} className="rounded-md bg-app-surface p-2 text-[11px] border border-app-border">
                  <div className="flex items-start gap-2">
                    <span
                      className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${
                        issue.severity === "error"
                          ? "bg-danger-dim text-danger"
                          : issue.severity === "warning"
                            ? "bg-warning-dim text-warning"
                            : "bg-info-dim text-info"
                      }`}
                    >
                      {issue.severity || "info"}
                    </span>
                    <span className="text-txt-secondary">{issue.rule || "rule"}</span>
                    {issue.leitfaden_section ? (
                      <a
                        href={`#leitfaden-${issue.leitfaden_section}`}
                        className="ml-auto text-accent underline decoration-accent/40 underline-offset-2"
                        title={`Open Leitfaden section ${issue.leitfaden_section}`}
                      >
                        Leitfaden §{issue.leitfaden_section}
                      </a>
                    ) : null}
                  </div>
                  {issue.message ? (
                    <div className="mt-1 text-txt-primary">{String(issue.message)}</div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {run.conflicts && run.conflicts.length ? (
          <section className="rounded-xl bg-app-bg/40 p-3 border border-app-border">
            <div className="text-xs font-semibold text-txt-secondary">Conflicts ({run.conflicts.length})</div>
            <ul className="mt-2 space-y-1">
              {run.conflicts.map((c, i) => (
                <li key={i} className="rounded-md bg-app-surface p-2 text-[11px] text-txt-secondary border border-app-border">
                  <pre className="whitespace-pre-wrap break-words text-[10px] text-txt-muted">
                    {typeof c === "string" ? c : JSON.stringify(c, null, 2)}
                  </pre>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="rounded-xl bg-app-bg/40 p-3 border border-app-border">
          <div className="text-xs font-semibold text-txt-secondary">Raw identify metadata</div>
          <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-app-bg p-2 text-[10px] text-txt-muted border border-app-border">
            {JSON.stringify(
              {
                pipeline: run.pipeline,
                productId: run.productId,
                sku: run.sku,
                checkedAtIso: run.checkedAtIso,
                confidence: run.confidence,
                workerSummary: run.workerSummary,
                criticScore: run.criticScore,
                cassiniSubscores: run.cassiniSubscores,
              },
              null,
              2
            )}
          </pre>
        </section>
      </aside>
    </div>
  );
};

const IdentifyRunsTab: React.FC = () => {
  const [data, setData] = React.useState<AdminIdentifyRunsResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [lastUpdatedIso, setLastUpdatedIso] = React.useState<string | null>(null);
  const [drawerRun, setDrawerRun] = React.useState<AdminIdentifyRun | null>(null);

  const [confRange, setConfRange] = React.useState<{ min: number; max: number }>({ min: 0, max: 1 });
  const [cassiniRange, setCassiniRange] = React.useState<{ min: number; max: number }>({ min: 0, max: 1 });
  const [dateFrom, setDateFrom] = React.useState<string>(() => isoDaysAgo(30));
  const [dateTo, setDateTo] = React.useState<string>(() => todayIso());
  const [domainFilters, setDomainFilters] = React.useState<Set<string>>(() => new Set());
  const [pipeline, setPipeline] = React.useState<"v3" | "v4" | "all">("all");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Server-side: confidence + first selected domain + pipeline + date.
      // For multiselect, we still need client-side post-filter.
      const firstDomain = domainFilters.size === 1 ? Array.from(domainFilters)[0] : null;
      const next = await adminListIdentifyRuns({
        confidence_min: confRange.min > 0 ? confRange.min : null,
        confidence_max: confRange.max < 1 ? confRange.max : null,
        cassini_min: cassiniRange.min > 0 ? cassiniRange.min : null,
        cassini_max: cassiniRange.max < 1 ? cassiniRange.max : null,
        domain: firstDomain,
        dateFrom: dateFrom ? `${dateFrom}T00:00:00.000Z` : null,
        dateTo: dateTo ? `${dateTo}T23:59:59.999Z` : null,
        pipeline,
        pageSize: 100,
      });
      setData(next);
      setLastUpdatedIso(new Date().toISOString());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [confRange, cassiniRange, dateFrom, dateTo, domainFilters, pipeline]);

  React.useEffect(() => {
    let ignore = false;
    (async () => {
      if (ignore) return;
      await load();
    })();
    const t = window.setInterval(() => {
      load().catch(() => {});
    }, REFRESH_INTERVAL_MS);
    return () => {
      ignore = true;
      window.clearInterval(t);
    };
  }, [load]);

  const filteredRuns = React.useMemo(() => {
    const runs = data?.runs || [];
    return runs.filter((r) => {
      const cas = r.cassiniSubscores?.overall ?? null;
      if (cassiniRange.min > 0 && (cas == null || cas < cassiniRange.min)) return false;
      if (cassiniRange.max < 1 && cas != null && cas > cassiniRange.max) return false;
      if (domainFilters.size > 1) {
        const allPresent = Array.from(domainFilters).every((d) =>
          Object.prototype.hasOwnProperty.call(r.workerSummary || {}, d)
        );
        if (!allPresent) return false;
      }
      return true;
    });
  }, [data, cassiniRange, domainFilters]);

  const toggleDomain = (d: string) => {
    setDomainFilters((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-app-surface p-5 border border-app-border">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-txt-primary">Identify runs audit</div>
            <div className="text-xs text-txt-muted">
              {lastUpdatedIso ? `Updated ${new Date(lastUpdatedIso).toLocaleTimeString()}` : "—"}
              {data ? ` · ${filteredRuns.length} of ${data.total}` : ""}
            </div>
          </div>
          <button
            type="button"
            onClick={() => load()}
            disabled={loading}
            className="rounded-xl bg-app-elevated px-3 py-2 text-xs font-semibold text-txt-secondary hover:bg-white/10 disabled:opacity-60"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {error ? (
          <div className="mt-3 rounded-xl bg-danger-dim p-3 text-sm text-danger ring-1 ring-danger/40">{error}</div>
        ) : null}

        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <RangeSlider
            id="confidence"
            label="Confidence aggregate"
            minValue={confRange.min}
            maxValue={confRange.max}
            onChange={setConfRange}
          />
          <RangeSlider
            id="cassini"
            label="Cassini overall"
            minValue={cassiniRange.min}
            maxValue={cassiniRange.max}
            onChange={setCassiniRange}
          />
          <div className="flex flex-col gap-1">
            <label htmlFor="runs-date-from" className="text-[11px] font-semibold text-txt-muted">
              Date range
            </label>
            <div className="flex items-center gap-2">
              <input
                id="runs-date-from"
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="rounded-xl bg-app-bg/40 px-2 py-1 text-xs text-txt-primary border border-app-border"
                aria-label="Date from"
              />
              <span className="text-txt-muted">–</span>
              <input
                id="runs-date-to"
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="rounded-xl bg-app-bg/40 px-2 py-1 text-xs text-txt-primary border border-app-border"
                aria-label="Date to"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1 xl:col-span-2">
            <span className="text-[11px] font-semibold text-txt-muted">Domains (all must be present)</span>
            <div className="flex flex-wrap gap-1.5">
              {DOMAINS.map((d) => {
                const active = domainFilters.has(d);
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => toggleDomain(d)}
                    aria-pressed={active}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-semibold border ${
                      active
                        ? "bg-accent text-txt-primary border-accent"
                        : "bg-app-bg/40 text-txt-secondary border-app-border hover:bg-app-bg/60"
                    }`}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold text-txt-muted">Pipeline</span>
            <div className="flex gap-1.5">
              {(["all", "v4", "v3"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPipeline(p)}
                  aria-pressed={pipeline === p}
                  className={`rounded-xl px-3 py-1 text-xs font-semibold border ${
                    pipeline === p
                      ? "bg-accent text-txt-primary border-accent"
                      : "bg-app-bg/40 text-txt-secondary border-app-border hover:bg-app-bg/60"
                  }`}
                >
                  {p.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl bg-app-surface border border-app-border">
        <table className="w-full min-w-[1100px] text-left text-xs">
          <thead className="bg-app-bg/40">
            <tr>
              <th scope="col" className="px-3 py-2 font-semibold text-txt-muted">Product</th>
              <th scope="col" className="px-3 py-2 font-semibold text-txt-muted">Confidence</th>
              <th scope="col" className="px-3 py-2 font-semibold text-txt-muted">Cassini</th>
              <th scope="col" className="px-3 py-2 font-semibold text-txt-muted">Ready</th>
              <th scope="col" className="px-3 py-2 font-semibold text-txt-muted">Workers</th>
              <th scope="col" className="px-3 py-2 font-semibold text-txt-muted">Critic</th>
              <th scope="col" className="px-3 py-2 font-semibold text-txt-muted">Autosaved</th>
              <th scope="col" className="px-3 py-2 font-semibold text-txt-muted">Checked</th>
            </tr>
          </thead>
          <tbody>
            {filteredRuns.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-txt-muted">
                  {loading ? "Loading…" : "No runs match the current filters."}
                </td>
              </tr>
            ) : (
              filteredRuns.map((run) => (
                <tr
                  key={`${run.productId}-${run.checkedAtIso}`}
                  className="cursor-pointer border-t border-app-border hover:bg-app-bg/40"
                  onClick={() => setDrawerRun(run)}
                >
                  <td className="px-3 py-2 align-top">
                    <div className="font-semibold text-txt-primary">{run.productId || "—"}</div>
                    {run.sku ? <div className="text-[10px] text-txt-muted">{run.sku}</div> : null}
                    {run.pipeline ? (
                      <div className="mt-0.5 inline-flex rounded-md bg-app-elevated px-1.5 py-0.5 text-[10px] font-semibold text-txt-secondary">
                        {run.pipeline.toUpperCase()}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="flex items-center gap-2">
                      <Bar value={run.confidence.aggregate} ariaLabel="Confidence aggregate" />
                      <span className="w-10 text-right tabular-nums text-txt-secondary">
                        {formatPct(run.confidence.aggregate)}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="flex items-center gap-2">
                      <Bar value={run.cassiniSubscores?.overall ?? null} ariaLabel="Cassini overall" tone="success" />
                      <span className="w-10 text-right tabular-nums text-txt-secondary">
                        {formatPct(run.cassiniSubscores?.overall ?? null)}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2 align-top">
                    {run.confidence.readyForPublish === true ? (
                      <span className="text-success" aria-label="Ready for publish">✓</span>
                    ) : run.confidence.readyForPublish === false ? (
                      <span className="text-danger" aria-label="Not ready for publish">✗</span>
                    ) : (
                      <span className="text-txt-muted">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="flex flex-wrap gap-1">
                      {DOMAINS.map((d) => (
                        <StatusPill key={d} status={deriveWorkerStatus(run, d)} label={d.slice(0, 3)} />
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="flex items-center gap-2">
                      <Bar value={run.criticScore} ariaLabel="Critic score" tone="warning" />
                      <span className="w-10 text-right tabular-nums text-txt-secondary">
                        {formatPct(run.criticScore)}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2 align-top">
                    {run.autosaved === true ? (
                      <span className="text-success" aria-label="Autosaved">✓</span>
                    ) : run.autosaved === false ? (
                      <span className="text-danger" aria-label="Not autosaved">✗</span>
                    ) : (
                      <span className="text-txt-muted">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top text-txt-muted">{formatDate(run.checkedAtIso)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <RunsDetailDrawer run={drawerRun} onClose={() => setDrawerRun(null)} />
    </div>
  );
};

type DomainAggregate = { domain: string; meanByPipeline: Map<string, number | null>; alert: boolean };

const ParityBarChart: React.FC<{ rows: AdminLlmParityRow[]; alertDomains: Set<string> }> = ({ rows, alertDomains }) => {
  const pipelines = React.useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => set.add(r.pipeline));
    return Array.from(set).sort();
  }, [rows]);

  const byDomain = React.useMemo<DomainAggregate[]>(() => {
    const map = new Map<string, DomainAggregate>();
    rows.forEach((r) => {
      const slot = map.get(r.domain) || {
        domain: r.domain,
        meanByPipeline: new Map<string, number | null>(),
        alert: alertDomains.has(r.domain),
      };
      slot.meanByPipeline.set(r.pipeline, r.mean_quality);
      map.set(r.domain, slot);
    });
    return Array.from(map.values()).sort((a, b) => a.domain.localeCompare(b.domain));
  }, [rows, alertDomains]);

  if (!byDomain.length) {
    return <div className="text-xs text-txt-muted">No parity data for the current filter window.</div>;
  }

  const pipelineTone = (idx: number): "accent" | "success" | "warning" | "danger" => {
    const tones: Array<"accent" | "success" | "warning" | "danger"> = ["accent", "success", "warning", "danger"];
    return tones[idx % tones.length];
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-txt-muted">
        {pipelines.map((p, i) => {
          const tone = pipelineTone(i);
          const bg =
            tone === "success" ? "bg-success" : tone === "warning" ? "bg-warning" : tone === "danger" ? "bg-danger" : "bg-accent";
          return (
            <span key={p} className="inline-flex items-center gap-1.5">
              <span className={`h-2 w-3 rounded-sm ${bg}`} aria-hidden="true" />
              <span className="text-txt-secondary">{p}</span>
            </span>
          );
        })}
      </div>
      <div className="space-y-2">
        {byDomain.map((agg) => (
          <div key={agg.domain} className="rounded-xl bg-app-bg/40 p-3 border border-app-border">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-txt-secondary">{agg.domain}</div>
              {agg.alert ? (
                <span
                  className="rounded-md bg-danger-dim px-1.5 py-0.5 text-[10px] font-semibold text-danger"
                  aria-label={`Drift alert for ${agg.domain}`}
                >
                  Drift
                </span>
              ) : null}
            </div>
            <div className="mt-2 space-y-1.5">
              {pipelines.map((p, i) => {
                const v = agg.meanByPipeline.get(p) ?? null;
                return (
                  <div key={p} className="flex items-center gap-2 text-[11px]">
                    <span className="w-28 truncate text-txt-muted">{p}</span>
                    <div className="flex-1">
                      <Bar value={v} ariaLabel={`${agg.domain} ${p} mean quality`} tone={pipelineTone(i)} />
                    </div>
                    <span className="w-10 text-right tabular-nums text-txt-secondary">{formatPct(v)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const LlmParityTab: React.FC = () => {
  const [data, setData] = React.useState<AdminLlmParityResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [lastUpdatedIso, setLastUpdatedIso] = React.useState<string | null>(null);
  const [domain, setDomain] = React.useState<string>("");
  const [dateFrom, setDateFrom] = React.useState<string>(() => isoDaysAgo(30));
  const [dateTo, setDateTo] = React.useState<string>(() => todayIso());

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await adminListLlmParity({
        domain: domain || null,
        dateFrom: dateFrom ? `${dateFrom}T00:00:00.000Z` : null,
        dateTo: dateTo ? `${dateTo}T23:59:59.999Z` : null,
      });
      setData(next);
      setLastUpdatedIso(new Date().toISOString());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [domain, dateFrom, dateTo]);

  React.useEffect(() => {
    let ignore = false;
    (async () => {
      if (ignore) return;
      await load();
    })();
    const t = window.setInterval(() => {
      load().catch(() => {});
    }, REFRESH_INTERVAL_MS);
    return () => {
      ignore = true;
      window.clearInterval(t);
    };
  }, [load]);

  const alertDomains = React.useMemo(() => {
    const s = new Set<string>();
    (data?.drift_alerts || []).forEach((a) => s.add(a.domain));
    return s;
  }, [data]);

  const overallMeanQuality = React.useMemo(() => {
    const rows = data?.pipelines || [];
    let sum = 0;
    let count = 0;
    rows.forEach((r) => {
      if (r.mean_quality != null) {
        sum += r.mean_quality;
        count += 1;
      }
    });
    return count ? sum / count : null;
  }, [data]);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-app-surface p-5 border border-app-border">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-txt-primary">LLM quality parity</div>
            <div className="text-xs text-txt-muted">
              {lastUpdatedIso ? `Updated ${new Date(lastUpdatedIso).toLocaleTimeString()}` : "—"}
              {data ? ` · ${data.total} events · mean ${formatPct(overallMeanQuality)}` : ""}
            </div>
          </div>
          <button
            type="button"
            onClick={() => load()}
            disabled={loading}
            className="rounded-xl bg-app-elevated px-3 py-2 text-xs font-semibold text-txt-secondary hover:bg-white/10 disabled:opacity-60"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {error ? (
          <div className="mt-3 rounded-xl bg-danger-dim p-3 text-sm text-danger ring-1 ring-danger/40">{error}</div>
        ) : null}

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="parity-domain" className="text-[11px] font-semibold text-txt-muted">
              Domain
            </label>
            <select
              id="parity-domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="rounded-xl bg-app-bg/40 px-2 py-1 text-xs text-txt-primary border border-app-border"
            >
              <option value="">(all)</option>
              {DOMAINS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="parity-date-from" className="text-[11px] font-semibold text-txt-muted">
              From
            </label>
            <input
              id="parity-date-from"
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="rounded-xl bg-app-bg/40 px-2 py-1 text-xs text-txt-primary border border-app-border"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="parity-date-to" className="text-[11px] font-semibold text-txt-muted">
              To
            </label>
            <input
              id="parity-date-to"
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="rounded-xl bg-app-bg/40 px-2 py-1 text-xs text-txt-primary border border-app-border"
            />
          </div>
        </div>
      </div>

      {data?.drift_alerts && data.drift_alerts.length ? (
        <div className="rounded-2xl bg-app-surface p-3 border border-app-border">
          <div className="text-xs font-semibold text-txt-secondary">Drift alerts ({data.drift_alerts.length})</div>
          <ul className="mt-2 space-y-1">
            {data.drift_alerts.map((a, i) => (
              <li
                key={`${a.domain}-${i}`}
                className="flex flex-wrap items-center gap-2 rounded-md bg-danger-dim p-2 text-[11px] text-danger ring-1 ring-danger/40"
              >
                <span className="font-semibold">{a.domain}</span>
                <span>gap {formatPct(a.gap)}</span>
                <span className="text-txt-secondary">
                  best <strong>{a.best_pipeline}</strong> {formatPct(a.best_mean_quality)} ·
                  worst <strong>{a.worst_pipeline}</strong> {formatPct(a.worst_mean_quality)}
                </span>
                <span className="ml-auto text-txt-muted">threshold {formatPct(a.threshold)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="rounded-2xl bg-app-surface p-5 border border-app-border">
        <div className="text-xs font-semibold text-txt-secondary">Per domain × pipeline (mean quality)</div>
        <div className="mt-3">
          <ParityBarChart rows={data?.pipelines || []} alertDomains={alertDomains} />
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl bg-app-surface border border-app-border">
        <table className="w-full min-w-[700px] text-left text-xs">
          <thead className="bg-app-bg/40">
            <tr>
              <th scope="col" className="px-3 py-2 font-semibold text-txt-muted">Pipeline</th>
              <th scope="col" className="px-3 py-2 font-semibold text-txt-muted">Domain</th>
              <th scope="col" className="px-3 py-2 font-semibold text-txt-muted">Mean quality</th>
              <th scope="col" className="px-3 py-2 font-semibold text-txt-muted">Mean latency (ms)</th>
              <th scope="col" className="px-3 py-2 font-semibold text-txt-muted">Mean cost (USD)</th>
              <th scope="col" className="px-3 py-2 font-semibold text-txt-muted">Events</th>
              <th scope="col" className="px-3 py-2 font-semibold text-txt-muted">Models</th>
            </tr>
          </thead>
          <tbody>
            {(data?.pipelines || []).length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-txt-muted">
                  {loading ? "Loading…" : "No parity data for the current filter window."}
                </td>
              </tr>
            ) : (
              (data?.pipelines || []).map((row, i) => (
                <tr key={`${row.pipeline}-${row.domain}-${i}`} className="border-t border-app-border">
                  <td className="px-3 py-2 text-txt-primary">{row.pipeline}</td>
                  <td className="px-3 py-2 text-txt-secondary">{row.domain}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Bar value={row.mean_quality} ariaLabel={`${row.pipeline} ${row.domain} quality`} />
                      <span className="w-10 text-right tabular-nums text-txt-secondary">
                        {formatPct(row.mean_quality)}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2 tabular-nums text-txt-secondary">
                    {formatNum(row.mean_latency_ms, 0)}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-txt-secondary">
                    {row.mean_cost_usd != null ? `$${formatNum(row.mean_cost_usd, 4)}` : "—"}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-txt-secondary">{row.count}</td>
                  <td className="px-3 py-2 text-[11px] text-txt-muted">
                    {row.models && row.models.length ? row.models.join(", ") : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export const AdminIdentifyRunsDashboard: React.FC = () => {
  const [tab, setTab] = React.useState<TabKey>("runs");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setTab("runs")}
          aria-pressed={tab === "runs"}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === "runs" ? "bg-accent text-txt-primary" : "bg-app-surface text-txt-secondary hover:bg-white/10"
          }`}
        >
          Identify-Runs
        </button>
        <button
          type="button"
          onClick={() => setTab("parity")}
          aria-pressed={tab === "parity"}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            tab === "parity" ? "bg-accent text-txt-primary" : "bg-app-surface text-txt-secondary hover:bg-white/10"
          }`}
        >
          Quality-Parity
        </button>
      </div>

      {tab === "runs" ? <IdentifyRunsTab /> : <LlmParityTab />}
    </div>
  );
};

export default AdminIdentifyRunsDashboard;
