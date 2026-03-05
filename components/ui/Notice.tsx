import React from 'react';

type NoticeTone = 'info' | 'success' | 'warning' | 'error';

const toneStyles: Record<NoticeTone, { box: string; title: string; body: string }> = {
  info: {
    box: 'bg-accent-dim ring-accent/30',
    title: 'text-accent',
    body: 'text-txt-secondary',
  },
  success: {
    box: 'bg-success-dim ring-success/30',
    title: 'text-success',
    body: 'text-txt-secondary',
  },
  warning: {
    box: 'bg-amber-900/20 ring-amber-700/40',
    title: 'text-amber-200',
    body: 'text-txt-secondary',
  },
  error: {
    box: 'bg-danger-dim ring-danger/30',
    title: 'text-danger',
    body: 'text-danger',
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
              <summary className="cursor-pointer select-none text-xs text-txt-secondary hover:text-txt-primary">
                Details
              </summary>
              <div className="mt-2 whitespace-pre-wrap break-words text-xs text-txt-secondary">{details}</div>
            </details>
          ) : null}
        </div>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-txt-secondary hover:bg-white/10"
            aria-label="Hinweis schließen"
          >
            ✕
          </button>
        ) : null}
      </div>
    </div>
  );
};

