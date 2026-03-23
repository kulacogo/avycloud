import React from 'react';
import { IdentificationJobStatus } from '../hooks/useIdentification';

interface JobStatusPopupProps {
  jobs: IdentificationJobStatus[];
  onCancel: (localId: string) => void;
  onDismiss: (localId: string) => void;
}

const phaseColor = (job: IdentificationJobStatus) => {
  if (job.phase === 'error') return 'text-danger';
  if (job.phase === 'complete') return 'text-success';
  if (job.phase === 'cancelled') return 'text-amber-300';
  return 'text-accent';
};

const JobStatusPopup: React.FC<JobStatusPopupProps> = ({ jobs, onCancel, onDismiss }) => {
  if (!jobs.length) return null;

  const allFinished = jobs.every((j) => j.finishedAt);
  const successCount = jobs.filter((j) => j.phase === 'complete').length;
  const errorCount = jobs.filter((j) => j.phase === 'error').length;
  const showSummary = allFinished && jobs.length > 1;

  return (
    <div className="fixed bottom-6 right-6 z-50 w-full max-w-sm">
      <div className="rounded-2xl border border-app-border bg-app-bg/95 shadow-lg shadow-black/40 p-4 space-y-3">
        <p className="text-sm font-semibold text-txt-secondary">Produkt-Uploads</p>

        {showSummary && (
          <div className="rounded-xl border border-app-border bg-app-elevated p-3 space-y-1">
            <p className="text-sm font-semibold text-txt-primary">Identifikation abgeschlossen</p>
            {successCount > 0 && (
              <p className="text-xs text-success">{successCount} Produkt{successCount !== 1 ? 'e' : ''} erfolgreich erkannt</p>
            )}
            {errorCount > 0 && (
              <p className="text-xs text-danger">{errorCount} Produkt{errorCount !== 1 ? 'e' : ''} fehlgeschlagen</p>
            )}
            <button
              type="button"
              onClick={() => jobs.forEach((j) => onDismiss(j.localId))}
              className="mt-2 text-xs text-txt-muted hover:text-txt-primary transition-colors"
            >
              Alle schließen
            </button>
          </div>
        )}

        <div className="flex flex-col gap-3 max-h-96 overflow-y-auto pr-2">
          {jobs.map((job) => {
            const isActive =
              !job.finishedAt && job.phase !== 'error' && job.phase !== 'cancelled';
            const icon = job.phase === 'error'
              ? '\u26A0\uFE0F'
              : job.phase === 'complete'
              ? '\u2705'
              : job.phase === 'cancelled'
              ? '\u23F9\uFE0F'
              : '\u23F3';

            return (
              <div
                key={job.localId}
                className="rounded-xl border border-app-border bg-app-elevated p-3 flex flex-col gap-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-txt-primary">{job.label}</p>
                    <p className={`text-xs ${phaseColor(job)}`}>{icon} {job.message}</p>
                  </div>
                  {isActive ? (
                    <button
                      type="button"
                      onClick={() => onCancel(job.localId)}
                      className="text-xs text-danger hover:text-danger transition-colors"
                    >
                      Abbrechen
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onDismiss(job.localId)}
                      className="text-xs text-txt-muted hover:text-txt-primary transition-colors"
                    >
                      Schließen
                    </button>
                  )}
                </div>
                {job.error && (
                  <p className="text-xs text-danger bg-danger-dim border border-danger/30 rounded-lg px-2 py-1">
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


