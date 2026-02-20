import React from 'react';

type NoticeTone = 'info' | 'success' | 'warning' | 'error';

const toneStyles: Record<NoticeTone, { box: string; title: string; body: string }> = {
  info: {
    box: 'bg-[var(--avy-purple-glow)] ring-[var(--avy-purple)]/30',
    title: 'text-[color:var(--avy-purple-light)]',
    body: 'text-[color:var(--text-primary)]',
  },
  success: {
    box: 'bg-[var(--success-bg)] ring-[var(--success-border)]',
    title: 'text-[color:var(--success)]',
    body: 'text-[color:var(--text-primary)]',
  },
  warning: {
    box: 'bg-[var(--warning-bg)] ring-[var(--warning-border)]',
    title: 'text-[color:var(--warning)]',
    body: 'text-[color:var(--text-primary)]',
  },
  error: {
    box: 'bg-[var(--error-bg)] ring-[var(--error-border)]',
    title: 'text-[color:var(--error)]',
    body: 'text-[color:var(--error)]',
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
              <summary className="cursor-pointer select-none text-xs text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)]">
                Details
              </summary>
              <div className="mt-2 whitespace-pre-wrap break-words text-xs text-[color:var(--text-primary)]">{details}</div>
            </details>
          ) : null}
        </div>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-[color:var(--text-primary)] hover:bg-[var(--surface-hover)]"
            aria-label="Hinweis schließen"
          >
            ✕
          </button>
        ) : null}
      </div>
    </div>
  );
};

