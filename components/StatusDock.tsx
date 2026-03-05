import React from 'react';
import { Spinner } from './Spinner';

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
    <div className="fixed bottom-6 right-6 z-40 flex items-start gap-3 rounded-2xl bg-app-bg/90 border border-app-border px-4 py-3 shadow-lg shadow-black/40 max-w-sm">
      <Spinner className="w-5 h-5 text-accent mt-0.5" />
      <div className="text-sm text-txt-primary space-y-1">
        <p className="font-semibold">Jobs laufen …</p>
        {hasIdentify && (
          <div className="text-xs text-txt-secondary">
            Identify: {identifyActive} aktiv / {identifyTotal} gesamt
          </div>
        )}
        {hasImprove && (
          <div className="text-xs text-txt-secondary">
            Improve: {improveActive} aktiv / {improveTotal} gesamt
          </div>
        )}
      </div>
    </div>
  );
};

export default StatusDock;
