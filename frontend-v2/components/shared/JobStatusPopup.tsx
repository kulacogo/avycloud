import React from 'react';
import { IdentificationJobStatus } from '../../hooks/useIdentification';

interface JobStatusPopupProps {
  jobs: IdentificationJobStatus[];
  onCancel: (localId: string) => void;
  onDismiss: (localId: string) => void;
}

const phaseColor = (job: IdentificationJobStatus) => {
  if (job.phase === 'error') return 'text-[var(--error)]';
  if (job.phase === 'complete') return 'text-[var(--success)]';
  if (job.phase === 'cancelled') return 'text-[var(--warning)]';
  return 'text-[var(--avy-purple-light)]';
};

const phaseBadge = (job: IdentificationJobStatus) => {
  if (job.phase === 'error')
    return 'bg-[var(--error-bg)] text-[var(--error)] border-[var(--error-border)]';
  if (job.phase === 'complete')
    return 'bg-[var(--success-bg)] text-[var(--success)] border-[var(--success-border)]';
  if (job.phase === 'cancelled')
    return 'bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning-border)]';
  return 'bg-[var(--avy-purple)]/10 text-[var(--avy-purple-light)] border-[var(--avy-purple)]/20';
};

const JobStatusPopup: React.FC<JobStatusPopupProps> = ({ jobs, onCancel, onDismiss }) => {
  if (!jobs.length) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 w-full max-w-sm">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-lg p-4 space-y-3">
        <p className="text-sm font-semibold text-[var(--text-primary)] tracking-[-0.01em]">
          Produkt-Uploads
        </p>
        <div className="flex flex-col gap-3 max-h-96 overflow-y-auto pr-2">
          {jobs.map((job) => {
            const isActive =
              !job.finishedAt && job.phase !== 'error' && job.phase !== 'cancelled';

            return (
              <div
                key={job.localId}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3 flex flex-col gap-2 transition-colors duration-200 hover:border-[var(--border-hover)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-[var(--text-primary)] truncate">
                      {job.label}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <span
                        className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${phaseBadge(job)}`}
                      >
                        {job.phase}
                      </span>
                      <p className={`text-xs ${phaseColor(job)} truncate`}>{job.message}</p>
                    </div>
                  </div>
                  {isActive ? (
                    <button
                      type="button"
                      onClick={() => onCancel(job.localId)}
                      className="shrink-0 text-xs font-semibold text-[var(--error)] hover:text-[var(--text-primary)] transition-colors duration-150"
                    >
                      Abbrechen
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onDismiss(job.localId)}
                      className="shrink-0 text-xs font-semibold text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors duration-150"
                    >
                      Schließen
                    </button>
                  )}
                </div>
                {isActive && (
                  <div className="h-1 w-full rounded-full bg-[var(--border)] overflow-hidden">
                    <div className="h-full rounded-full bg-gradient-to-r from-[var(--avy-purple)] to-[var(--avy-purple-light)] animate-pulse" />
                  </div>
                )}
                {job.error && (
                  <p className="text-xs text-[var(--error)] bg-[var(--error-bg)] border border-[var(--error-border)] rounded-md px-2 py-1">
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
