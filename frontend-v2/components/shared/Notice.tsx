import React from 'react';

type NoticeTone = 'info' | 'success' | 'warning' | 'error';

const toneStyles: Record<NoticeTone, { box: string; title: string; body: string }> = {
  info: {
    box: 'bg-[var(--info-bg)] ring-[var(--info-border)]',
    title: 'text-[var(--info)]',
    body: 'text-[var(--text-secondary)]',
  },
  success: {
    box: 'bg-[var(--success-bg)] ring-[var(--success-border)]',
    title: 'text-[var(--success)]',
    body: 'text-[var(--text-secondary)]',
  },
  warning: {
    box: 'bg-[var(--warning-bg)] ring-[var(--warning-border)]',
    title: 'text-[var(--warning)]',
    body: 'text-[var(--text-secondary)]',
  },
  error: {
    box: 'bg-[var(--error-bg)] ring-[var(--error-border)]',
    title: 'text-[var(--error)]',
    body: 'text-[var(--text-secondary)]',
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
      className={`rounded-lg p-3 text-sm ring-1 ${styles.box} ${className || ''}`.trim()}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {title ? <div className={`font-semibold ${styles.title}`}>{title}</div> : null}
          {children ? <div className={`mt-1 ${styles.body}`}>{children}</div> : null}
          {details ? (
            <details className="mt-2">
              <summary className="cursor-pointer select-none text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors duration-150">
                Details
              </summary>
              <div className="mt-2 whitespace-pre-wrap break-words text-xs text-[var(--text-secondary)]">
                {details}
              </div>
            </details>
          ) : null}
        </div>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)] transition-colors duration-150"
            aria-label="Hinweis schließen"
          >
            ✕
          </button>
        ) : null}
      </div>
    </div>
  );
};
