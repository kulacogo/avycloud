import React, { useEffect, useState } from 'react';
import { fetchIdentifyHealth, IdentifyHealthSnapshot } from '../api/client';

const formatPercent = (value: number | null) => {
  if (value === null || Number.isNaN(value)) return '—';
  return `${Math.round(value * 100)}%`;
};

const formatDuration = (ms: number | null | undefined) => {
  if (!ms || ms <= 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
};

const formatRelativeIso = (iso?: string | null) => {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return 'gerade eben';
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `vor ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `vor ${hours} h`;
  return `vor ${Math.floor(hours / 24)} d`;
};

// Color-codes the success rate so a glance is enough to know if the pipeline is healthy.
const successTone = (rate: number | null): { bg: string; text: string; label: string } => {
  if (rate === null) return { bg: 'bg-app-elevated', text: 'text-txt-secondary', label: 'keine Daten' };
  if (rate >= 0.95) return { bg: 'bg-success-dim', text: 'text-success', label: 'gesund' };
  if (rate >= 0.8) return { bg: 'bg-warning-dim', text: 'text-warning', label: 'wackelig' };
  return { bg: 'bg-danger-dim', text: 'text-danger', label: 'kritisch' };
};

interface IdentifyHealthTileProps {
  hours?: number;
  refreshIntervalMs?: number;
}

export const IdentifyHealthTile: React.FC<IdentifyHealthTileProps> = ({
  hours = 24,
  refreshIntervalMs = 60_000,
}) => {
  const [snap, setSnap] = useState<IdentifyHealthSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const load = async () => {
      try {
        const data = await fetchIdentifyHealth({ hours, signal: controller.signal });
        if (!cancelled) {
          setSnap(data);
          setError(null);
          setLoading(false);
        }
      } catch (err: any) {
        if (cancelled || err?.name === 'AbortError') return;
        setError(err?.message || 'Unbekannter Fehler');
        setLoading(false);
      }
    };

    load();
    const id = window.setInterval(load, refreshIntervalMs);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(id);
    };
  }, [hours, refreshIntervalMs]);

  if (loading && !snap) {
    return (
      <div className="rounded-lg border border-app-border bg-app-surface p-4 text-txt-secondary text-sm">
        Lade Identify-Status …
      </div>
    );
  }

  if (error && !snap) {
    return (
      <div className="rounded-lg border border-danger/30 bg-danger-dim p-4 text-danger text-sm">
        Status nicht verfügbar: {error}
      </div>
    );
  }

  if (!snap) return null;

  const tone = successTone(snap.successRate);
  const timeoutCount = snap.byError['HTTP_504'] || 0;
  const errorCount = (snap.byStatus.error || 0) + (snap.byStatus.timeout || 0);
  const duplicateCount = snap.byStatus.duplicate_reused || 0;

  return (
    <div className="rounded-lg border border-app-border bg-app-surface p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-txt-primary">Identify-Pipeline letzte {hours}h</span>
          <span className={`rounded-sm px-2 py-0.5 text-xs font-semibold ${tone.bg} ${tone.text}`}>
            {tone.label}
          </span>
        </div>
        <span className="text-xs text-txt-muted">aktualisiert sich automatisch</span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Erfolgsquote" value={formatPercent(snap.successRate)} sub={`${snap.success}/${snap.total}`} />
        <Stat label="Ø Dauer" value={formatDuration(snap.durations.avgMs)} sub={`P95 ${formatDuration(snap.durations.p95Ms)}`} />
        <Stat label="Fehler" value={String(errorCount)} sub={timeoutCount ? `${timeoutCount} Timeouts` : 'keine Timeouts'} />
        <Stat label="Duplikate" value={String(duplicateCount)} sub="bereits vorhanden" />
      </div>

      {snap.lastFailure && (
        <div className="rounded-md border border-app-border bg-app-bg/40 p-3 text-xs">
          <div className="flex flex-wrap items-center gap-2 text-txt-secondary">
            <span className="font-semibold text-txt-primary">Letzter Fehler:</span>
            <span>{formatRelativeIso(snap.lastFailure.timestampIso)}</span>
            <span className="text-txt-muted">•</span>
            <span className="font-mono text-txt-primary">{snap.lastFailure.errorCode || 'unbekannt'}</span>
            <span className="text-txt-muted">•</span>
            <span>Pipeline: {snap.lastFailure.pipeline}</span>
          </div>
          {snap.lastFailure.errorMessage && (
            <div className="mt-1 text-txt-muted line-clamp-2">{snap.lastFailure.errorMessage}</div>
          )}
        </div>
      )}
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string; sub?: string }> = ({ label, value, sub }) => (
  <div className="rounded-md border border-app-border bg-app-bg/40 px-3 py-2">
    <div className="text-xs text-txt-muted">{label}</div>
    <div className="text-lg font-semibold text-txt-primary leading-tight">{value}</div>
    {sub && <div className="text-xs text-txt-muted mt-0.5">{sub}</div>}
  </div>
);

export default IdentifyHealthTile;
