import React from 'react';
import { IdentifyStatus } from '../../types';
import { Spinner } from '../ui/Spinner';

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
  const detail = status.message || 'Fortschritt wird aktualisiert ...';
  const isActive = ACTIVE_PHASES.has(status.phase);

  return (
    <div className="mb-4">
      <div className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 shadow-sm">
        {/* Progress bar */}
        {isActive && (
          <div className="h-1.5 w-full rounded-full bg-[var(--surface-secondary)] overflow-hidden">
            <div className="h-full rounded-full bg-gradient-to-r from-[var(--avy-purple)] to-[var(--avy-purple-light)] animate-[pulse_2s_ease-in-out_infinite]" />
          </div>
        )}

        <div className="flex items-center gap-3">
          {isActive && <Spinner size="sm" />}
          <div>
            <p className="text-sm font-semibold text-[var(--text-primary)] tracking-[-0.01em]">
              {label}
            </p>
            <p className="text-xs text-[var(--text-tertiary)]">{detail}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--text-tertiary)]">
          {status.model && (
            <span>
              Modell:{' '}
              <span className="font-mono text-[var(--text-primary)]">
                {status.model}
              </span>
            </span>
          )}
          {showCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center rounded-lg border border-[var(--border)] px-3 py-1 text-xs font-semibold text-[var(--text-primary)] hover:border-[var(--error)] hover:text-[var(--error)] transition-colors duration-150"
            >
              Vorgang abbrechen
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
