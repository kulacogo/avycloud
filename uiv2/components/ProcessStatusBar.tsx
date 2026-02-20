import React from 'react';
import { IdentifyStatus } from '../types';
import { Spinner } from './Spinner';

interface ProcessStatusBarProps {
  status: IdentifyStatus;
  onCancel?: () => void;
}

const PHASE_LABELS: Record<string, string> = {
  upload: 'Uploads laufen',
  queued: 'Job wartet',
  processing: 'AI analysiert',
  enriching: 'Enrichment aktiv',
  complete: 'Fertig',
  error: 'Fehler',
  cancelled: 'Abgebrochen',
  idle: 'Bereit',
};

const ACTIVE_PHASES = new Set(['upload', 'queued', 'processing', 'enriching']);

export const ProcessStatusBar: React.FC<ProcessStatusBarProps> = ({ status, onCancel }) => {
  if (!status || status.phase === 'idle') {
    return null;
  }

  const showCancel = onCancel && ACTIVE_PHASES.has(status.phase);
  const label = PHASE_LABELS[status.phase] || 'Status';
  const detail = status.message || 'Fortschritt wird aktualisiert …';

  return (
    <div className="mb-4">
      <div className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-hover)]/80 px-4 py-3 shadow-lg shadow-black/10 backdrop-blur">
        <div className="flex items-center gap-3">
          {ACTIVE_PHASES.has(status.phase) && <Spinner className="w-4 h-4 text-[color:var(--avy-purple-light)]" />}
          <div>
            <p className="text-sm font-semibold text-[color:var(--text-primary)]">{label}</p>
            <p className="text-xs text-[color:var(--text-tertiary)]">{detail}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-[color:var(--text-tertiary)]">
          {status.model && (
            <span>
              Modell:{' '}
              <span className="font-mono text-[color:var(--text-primary)]">
                {status.model}
              </span>
            </span>
          )}
          {showCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center rounded-full border border-[var(--border-hover)] px-3 py-1 text-xs font-semibold text-[color:var(--text-primary)] hover:border-[var(--error)] hover:text-[color:var(--error)] transition-colors"
            >
              Vorgang abbrechen
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

