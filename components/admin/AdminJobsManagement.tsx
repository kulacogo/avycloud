import React, { useEffect, useMemo, useState } from 'react';
import { adminGetJobsStatus, adminRunGpsrWebEnrichJob } from '../../api/client';
import { Spinner } from '../Spinner';
import { Notice } from '../ui/Notice';

export const AdminJobsManagement: React.FC = () => {
  const [apply, setApply] = useState(true);
  const [limit, setLimit] = useState(200);
  const [concurrency, setConcurrency] = useState(2);
  const [minQty, setMinQty] = useState(1);
  const [requireBin, setRequireBin] = useState(true);
  const [debug, setDebug] = useState(false);
  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [status, setStatus] = useState<any>(null);

  const payload = useMemo(
    () => ({
      apply,
      limit,
      concurrency,
      minQty,
      requireBin,
      debug,
    }),
    [apply, limit, concurrency, minQty, requireBin, debug]
  );

  const runGpsrJob = async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    setLastResult(null);
    try {
      const res = await adminRunGpsrWebEnrichJob(payload);
      setLastResult(res);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  };

  const refreshStatus = async () => {
    if (statusLoading) return;
    setStatusLoading(true);
    setError(null);
    try {
      const data = await adminGetJobsStatus();
      setStatus(data);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setStatusLoading(false);
    }
  };

  useEffect(() => {
    refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-700/60 bg-slate-900/50 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-white">Jobs</h3>
            <p className="mt-1 text-sm text-slate-300">
              Manuelle Trigger für Backend-Jobs (Cloud Run Jobs). Für GPSR gilt: Filter ist intern{' '}
              <span className="font-mono">Menge ≥ minQty</span> &amp; <span className="font-mono">needsGpsr</span> –{' '}
              <span className="font-mono">BIN</span> ist optional (Require BIN).
            </p>
          </div>
          <button
            type="button"
            onClick={refreshStatus}
            disabled={statusLoading}
            className="inline-flex items-center gap-2 rounded-xl bg-slate-800/80 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-60"
          >
            {statusLoading ? <Spinner className="w-4 h-4" /> : null}
            Status aktualisieren
          </button>
        </div>
        {status?.rulebookApply?.runningCount ? (
          <div className="mt-3">
            <Notice
              tone="info"
              title={`Rulebook Apply läuft: ${status.rulebookApply.runningCount} Job(s)`}
              details={`Tipp: Admin → Rulebook → Apply Job Status zeigt Details pro Job. (Hier: Kurzstatus)`}
            />
          </div>
        ) : null}
        {status?.gpsrWebEnrich?.latestRun ? (
          <div className="mt-3">
            <Notice
              tone="info"
              title="GPSR Web Enrich: letzter Start"
              details={`at: ${status.gpsrWebEnrich.latestRun.createdAt || '—'} | op: ${
                status.gpsrWebEnrich.latestRun.operationName || '—'
              } | done: ${
                typeof status.gpsrWebEnrich.operation?.done === 'boolean' ? String(status.gpsrWebEnrich.operation.done) : '—'
              }`}
            />
          </div>
        ) : null}
      </div>

      <div className="rounded-xl border border-slate-700/60 bg-slate-900/50 p-4 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h4 className="text-base font-semibold text-white">GPSR Web Enrichment (initial)</h4>
            <p className="text-xs text-slate-400">
              Startet den Cloud Run Job. Parameter werden als Env-Overrides übergeben (falls Container-Name konfiguriert ist).
            </p>
          </div>
          <button
            type="button"
            onClick={runGpsrJob}
            disabled={running}
            className="inline-flex items-center gap-2 rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-60"
          >
            {running ? <Spinner className="w-4 h-4" /> : null}
            Start
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-200">
            <input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} />
            Änderungen speichern (write)
          </label>

          <label className="flex flex-col gap-1 text-sm text-slate-200">
            <span className="text-[11px] uppercase tracking-wide text-slate-400">limit</span>
            <input
              type="number"
              min={1}
              max={20000}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value) || 1)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm text-slate-200">
            <span className="text-[11px] uppercase tracking-wide text-slate-400">concurrency</span>
            <input
              type="number"
              min={1}
              max={10}
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value) || 1)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm text-slate-200">
            <span className="text-[11px] uppercase tracking-wide text-slate-400">minQty</span>
            <input
              type="number"
              min={1}
              max={9999}
              value={minQty}
              onChange={(e) => setMinQty(Number(e.target.value) || 1)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            />
          </label>

          <label className="flex items-center gap-2 text-sm text-slate-200">
            <input type="checkbox" checked={requireBin} onChange={(e) => setRequireBin(e.target.checked)} />
            Require BIN
          </label>

          <label className="flex items-center gap-2 text-sm text-slate-200">
            <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} />
            Debug
          </label>
        </div>

        {error ? <Notice tone="error" title="Fehler" details={error} /> : null}

        {lastResult ? (
          <div className="rounded-lg border border-slate-700/60 bg-slate-950/40 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-300">Result</p>
            <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs text-slate-200">
              {JSON.stringify(lastResult, null, 2)}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );
};

