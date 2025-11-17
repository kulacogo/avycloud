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
      <div className="flex flex-col gap-3 rounded-2xl border border-slate-700 bg-slate-800/80 px-4 py-3 shadow-lg shadow-black/10 backdrop-blur">
        <div className="flex items-center gap-3">
          {ACTIVE_PHASES.has(status.phase) && <Spinner className="w-4 h-4 text-sky-400" />}
          <div>
            <p className="text-sm font-semibold text-slate-100">{label}</p>
            <p className="text-xs text-slate-400">{detail}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
          {status.model && (
            <span>
              Modell:{' '}
              <span className="font-mono text-slate-100">
                {status.model}
              </span>
            </span>
          )}
          {showCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center rounded-full border border-slate-500 px-3 py-1 text-xs font-semibold text-slate-100 hover:border-red-400 hover:text-red-200 transition-colors"
            >
              Vorgang abbrechen
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

