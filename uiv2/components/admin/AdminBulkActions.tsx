import React from 'react';
import { adminGetBulkJob, adminRunBulkAction } from '../../api/client';
import { Spinner } from '../Spinner';
import { Notice } from '../ui/Notice';

type Action = 'title' | 'price' | 'category' | 'ktype' | 'export_marketplace';

export const AdminBulkActions: React.FC = () => {
  const [action, setAction] = React.useState<Action>('price');
  const [apply, setApply] = React.useState(true);
  const [limit, setLimit] = React.useState(500);
  const [offset, setOffset] = React.useState(0);
  const [debug, setDebug] = React.useState(false);
  const [maxAgeDays, setMaxAgeDays] = React.useState(0);
  const [includeUi, setIncludeUi] = React.useState(false);

  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [jobId, setJobId] = React.useState<string | null>(null);
  const [job, setJob] = React.useState<any>(null);

  const canRun = !running;

  const run = async () => {
    if (!canRun) return;
    setRunning(true);
    setError(null);
    setJob(null);
    setJobId(null);
    try {
      const res = await adminRunBulkAction({
        action,
        apply,
        limit,
        offset,
        debug,
        maxAgeDays: action === 'price' ? maxAgeDays : undefined,
        includeUi: action === 'title' ? includeUi : undefined,
      });
      setJobId(res.jobId);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  };

  const refreshJob = React.useCallback(async () => {
    if (!jobId) return;
    try {
      const data = await adminGetBulkJob(jobId);
      setJob(data);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, [jobId]);

  React.useEffect(() => {
    if (!jobId) return;
    refreshJob();
    const t = setInterval(() => refreshJob(), 2500);
    return () => clearInterval(t);
  }, [jobId, refreshJob]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--border)]/60 bg-[var(--surface-secondary)]/50 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-[color:white]">Bulk Actions</h3>
            <p className="mt-1 text-sm text-[color:var(--text-secondary)]">
              Konsolidierte Bulk-Tasks für Produkt-Details (Titel/Preis/Kategorie). Läuft asynchron als Admin-Job.
            </p>
          </div>
          <button
            type="button"
            onClick={run}
            disabled={running}
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--avy-purple)] px-4 py-2 text-sm font-semibold text-[color:white] hover:bg-[var(--avy-purple-hover)] disabled:opacity-60"
          >
            {running ? <Spinner className="h-4 w-4" /> : null}
            Start
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 md:grid-cols-6 gap-3">
          <label className="flex flex-col gap-1 text-sm text-[color:var(--text-primary)] md:col-span-2">
            <span className="text-[11px] uppercase tracking-wide text-[color:var(--text-tertiary)]">Action</span>
            <select
              value={action}
              onChange={(e) => setAction(e.target.value as Action)}
              className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[color:var(--text-primary)]"
            >
              <option value="price">Preis refresh (NEW-only)</option>
              <option value="title">Titel normalisieren (Policy)</option>
              <option value="category">Kategorie IDs backfill (eBay/Kaufland)</option>
              <option value="ktype">K‑Typ (noch nicht konsolidiert)</option>
              <option value="export_marketplace">Export Marketplace (CSV+JSON)</option>
            </select>
          </label>

          <label className="flex items-center gap-2 text-sm text-[color:var(--text-primary)] md:col-span-1">
            <input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} />
            Write
          </label>

          <label className="flex flex-col gap-1 text-sm text-[color:var(--text-primary)]">
            <span className="text-[11px] uppercase tracking-wide text-[color:var(--text-tertiary)]">limit</span>
            <input
              type="number"
              min={1}
              max={20000}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value) || 1)}
              className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[color:var(--text-primary)]"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm text-[color:var(--text-primary)]">
            <span className="text-[11px] uppercase tracking-wide text-[color:var(--text-tertiary)]">offset</span>
            <input
              type="number"
              min={0}
              value={offset}
              onChange={(e) => setOffset(Math.max(0, Number(e.target.value) || 0))}
              className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[color:var(--text-primary)]"
            />
          </label>

          <label className="flex items-center gap-2 text-sm text-[color:var(--text-primary)]">
            <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} />
            Debug
          </label>
        </div>

        {action === 'price' ? (
          <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="flex flex-col gap-1 text-sm text-[color:var(--text-primary)]">
              <span className="text-[11px] uppercase tracking-wide text-[color:var(--text-tertiary)]">maxAgeDays (0 = nur missing)</span>
              <input
                type="number"
                min={0}
                max={365}
                value={maxAgeDays}
                onChange={(e) => setMaxAgeDays(Math.max(0, Number(e.target.value) || 0))}
                className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[color:var(--text-primary)]"
              />
            </label>
          </div>
        ) : null}

        {action === 'title' ? (
          <div className="mt-3">
            <label className="flex items-center gap-2 text-sm text-[color:var(--text-primary)]">
              <input type="checkbox" checked={includeUi} onChange={(e) => setIncludeUi(e.target.checked)} />
              Auch UI-saved Produkte anfassen (includeUi)
            </label>
          </div>
        ) : null}

        {error ? <div className="mt-4"><Notice tone="error" title="Fehler" details={error} /></div> : null}
      </div>

      {jobId ? (
        <div className="rounded-xl border border-[var(--border)]/60 bg-[var(--surface-secondary)]/50 p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-[color:white]">Job</p>
              <p className="text-xs text-[color:var(--text-tertiary)] font-mono">{jobId}</p>
            </div>
            <button
              type="button"
              onClick={refreshJob}
              className="inline-flex items-center gap-2 rounded-xl bg-[var(--surface-hover)]/80 px-3 py-2 text-sm font-semibold text-[color:var(--text-primary)] hover:bg-[var(--surface)]"
            >
              Refresh
            </button>
          </div>
          {job ? (
            <pre className="overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--border)]/60 bg-[var(--bg)]/40 p-3 text-xs text-[color:var(--text-primary)]">
              {JSON.stringify(job, null, 2)}
            </pre>
          ) : (
            <div className="text-xs text-[color:var(--text-tertiary)]">Loading…</div>
          )}
        </div>
      ) : null}
    </div>
  );
};

