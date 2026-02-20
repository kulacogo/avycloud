import React from 'react';

type NoticeTone = 'info' | 'success' | 'warning' | 'error';

const toneStyles: Record<NoticeTone, { box: string; title: string; body: string }> = {
  info: {
    box: 'bg-sky-900/20 ring-sky-700/40',
    title: 'text-sky-200',
    body: 'text-slate-200',
  },
  success: {
    box: 'bg-emerald-900/20 ring-emerald-700/40',
    title: 'text-emerald-200',
    body: 'text-slate-200',
  },
  warning: {
    box: 'bg-amber-900/20 ring-amber-700/40',
    title: 'text-amber-200',
    body: 'text-slate-200',
  },
  error: {
    box: 'bg-rose-900/25 ring-rose-700/40',
    title: 'text-rose-200',
    body: 'text-rose-100',
  },
};

export const Notice: React.FC<{
  tone?: NoticeTone;
  title?: React.ReactNode;
  children?: React.ReactNode;
  details?: React.ReactNode;
  onDismiss?: () => void;
  className?: string;
}> = ({ tone = 'info', title, children, details, onDismiss, className }) => {
  const styles = toneStyles[tone];
  const role = tone === 'error' ? 'alert' : 'status';
  const ariaLive = tone === 'error' ? 'assertive' : 'polite';

  return (
    <div
      role={role}
      aria-live={ariaLive}
      className={`rounded-xl p-3 text-sm ring-1 ${styles.box} ${className || ''}`.trim()}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {title ? <div className={`font-semibold ${styles.title}`}>{title}</div> : null}
          {children ? <div className={`mt-1 ${styles.body}`}>{children}</div> : null}
          {details ? (
            <details className="mt-2">
              <summary className="cursor-pointer select-none text-xs text-slate-300 hover:text-white">
                Details
              </summary>
              <div className="mt-2 whitespace-pre-wrap break-words text-xs text-slate-200">{details}</div>
            </details>
          ) : null}
        </div>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-slate-200 hover:bg-white/10"
            aria-label="Hinweis schließen"
          >
            ✕
          </button>
        ) : null}
      </div>
    </div>
  );
};

