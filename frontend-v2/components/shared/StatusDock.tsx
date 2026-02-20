import React from 'react';
import { Spinner } from '../ui/Spinner';

interface StatusDockProps {
  identifyActive: number;
  identifyTotal: number;
  improveActive: number;
  improveTotal: number;
}

const StatusDock: React.FC<StatusDockProps> = ({
  identifyActive,
  identifyTotal,
  improveActive,
  improveTotal,
}) => {
  const hasIdentify = identifyTotal > 0;
  const hasImprove = improveTotal > 0;
  if (!hasIdentify && !hasImprove) return null;

  return (
    <div className="fixed bottom-6 right-6 z-40 flex items-start gap-3 rounded-xl bg-[var(--surface)] border border-[var(--border)] px-4 py-3 shadow-lg max-w-sm">
      <Spinner size="sm" className="mt-0.5" />
      <div className="text-sm text-[var(--text-primary)] space-y-1">
        <p className="font-semibold tracking-[-0.01em]">Jobs laufen ...</p>
        {hasIdentify && (
          <div className="text-xs text-[var(--text-secondary)]">
            Identify: {identifyActive} aktiv / {identifyTotal} gesamt
          </div>
        )}
        {hasImprove && (
          <div className="text-xs text-[var(--text-secondary)]">
            Improve: {improveActive} aktiv / {improveTotal} gesamt
          </div>
        )}
      </div>
    </div>
  );
};

export default StatusDock;
