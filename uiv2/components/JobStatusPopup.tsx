import React from 'react';
import { IdentificationJobStatus } from '../hooks/useIdentification';

interface JobStatusPopupProps {
  jobs: IdentificationJobStatus[];
  onCancel: (localId: string) => void;
  onDismiss: (localId: string) => void;
}

const phaseColor = (job: IdentificationJobStatus) => {
  if (job.phase === 'error') return 'text-[color:var(--error)]';
  if (job.phase === 'complete') return 'text-[color:var(--success)]';
  if (job.phase === 'cancelled') return 'text-[color:var(--warning)]';
  return 'text-[color:var(--avy-purple-light)]';
};

const JobStatusPopup: React.FC<JobStatusPopupProps> = ({ jobs, onCancel, onDismiss }) => {
  if (!jobs.length) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 w-full max-w-sm">
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-secondary)]/95 shadow-2xl shadow-black/40 p-4 space-y-3">
        <p className="text-sm font-semibold text-[color:var(--text-primary)]">Produkt-Uploads</p>
        <div className="flex flex-col gap-3 max-h-96 overflow-y-auto pr-2">
          {jobs.map((job) => {
            const isActive =
              !job.finishedAt && job.phase !== 'error' && job.phase !== 'cancelled';
            const icon = job.phase === 'error'
              ? '⚠️'
              : job.phase === 'complete'
              ? '✅'
              : job.phase === 'cancelled'
              ? '⏹️'
              : '⏳';

            return (
              <div
                key={job.localId}
                className="rounded-xl border border-[var(--border)] bg-[var(--surface-hover)]/80 p-3 flex flex-col gap-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[color:var(--text-primary)]">{job.label}</p>
                    <p className={`text-xs ${phaseColor(job)}`}>{icon} {job.message}</p>
                  </div>
                  {isActive ? (
                    <button
                      type="button"
                      onClick={() => onCancel(job.localId)}
                      className="text-xs text-[color:var(--error)] hover:text-[color:var(--error)] transition-colors"
                    >
                      Abbrechen
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onDismiss(job.localId)}
                      className="text-xs text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)] transition-colors"
                    >
                      Schließen
                    </button>
                  )}
                </div>
                {job.error && (
                  <p className="text-xs text-[color:var(--error)] bg-[var(--error-bg)] border border-[var(--error-border)] rounded-lg px-2 py-1">
                    {job.error}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default JobStatusPopup;


