import React from 'react';
import { IdentificationJobStatus } from '../hooks/useIdentification';

interface JobStatusPopupProps {
  jobs: IdentificationJobStatus[];
  onCancel: (localId: string) => void;
  onDismiss: (localId: string) => void;
}

const phaseColor = (job: IdentificationJobStatus) => {
  if (job.phase === 'error') return 'text-rose-300';
  if (job.phase === 'complete') return 'text-emerald-300';
  if (job.phase === 'cancelled') return 'text-amber-300';
  return 'text-sky-200';
};

const JobStatusPopup: React.FC<JobStatusPopupProps> = ({ jobs, onCancel, onDismiss }) => {
  if (!jobs.length) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 w-full max-w-sm">
      <div className="rounded-2xl border border-slate-700 bg-slate-900/95 shadow-2xl shadow-black/40 p-4 space-y-3">
        <p className="text-sm font-semibold text-slate-200">Produkt-Uploads</p>
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
                className="rounded-xl border border-slate-700 bg-slate-800/80 p-3 flex flex-col gap-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-100">{job.label}</p>
                    <p className={`text-xs ${phaseColor(job)}`}>{icon} {job.message}</p>
                  </div>
                  {isActive ? (
                    <button
                      type="button"
                      onClick={() => onCancel(job.localId)}
                      className="text-xs text-rose-300 hover:text-rose-100 transition-colors"
                    >
                      Abbrechen
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onDismiss(job.localId)}
                      className="text-xs text-slate-400 hover:text-slate-100 transition-colors"
                    >
                      Schließen
                    </button>
                  )}
                </div>
                {job.error && (
                  <p className="text-xs text-rose-300 bg-rose-950/40 border border-rose-900 rounded-lg px-2 py-1">
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

