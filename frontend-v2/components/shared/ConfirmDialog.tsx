import React from 'react';
import { useI18n } from '../../i18n';

type ConfirmTone = 'default' | 'danger';

const focusableSelector =
  [
    'a[href]',
    'button:not([disabled])',
    'textarea:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

function getFocusableElements(container: HTMLElement | null) {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (el) => !el.hasAttribute('disabled') && el.tabIndex >= 0 && !el.getAttribute('aria-hidden')
  );
}

export const ConfirmDialog: React.FC<{
  open: boolean;
  title: string;
  description?: React.ReactNode;
  details?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
  confirmDisabled?: boolean;
  confirmBusy?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}> = ({
  open,
  title,
  description,
  details,
  confirmLabel,
  cancelLabel,
  tone = 'default',
  confirmDisabled,
  confirmBusy,
  onConfirm,
  onCancel,
}) => {
  const { t } = useI18n();
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const cancelRef = React.useRef<HTMLButtonElement | null>(null);
  const confirmRef = React.useRef<HTMLButtonElement | null>(null);
  const lastActiveRef = React.useRef<HTMLElement | null>(null);
  const titleId = React.useId();
  const descId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    lastActiveRef.current = (document.activeElement as HTMLElement) || null;
    // Focus management per WAI-ARIA APG: focus should move inside dialog.
    // For destructive dialogs, it's safer to focus the least-destructive action (Cancel).
    const target = tone === 'danger' ? cancelRef.current : confirmRef.current || cancelRef.current;
    window.setTimeout(() => target?.focus(), 0);
    return () => {
      // Return focus to invoker
      window.setTimeout(() => lastActiveRef.current?.focus?.(), 0);
    };
  }, [open, tone]);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusables = getFocusableElements(dialogRef.current);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (!active || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (!active || active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  React.useEffect(() => {
    if (!open) return;
    // prevent background scroll
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  if (!open) return null;

  const confirmClasses =
    tone === 'danger'
      ? 'bg-[var(--error)] hover:bg-[var(--error)]/90 text-white'
      : 'bg-[var(--avy-purple)] hover:bg-[var(--avy-purple-hover)] text-white hover:shadow-[0_4px_12px_rgba(99,91,255,0.3)]';
  const cancelText = cancelLabel ?? t('common.cancel');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className="w-full max-w-lg rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-lg"
      >
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <h3 id={titleId} className="text-lg font-semibold text-[var(--text-primary)] tracking-[-0.02em]">
              {title}
            </h3>
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md px-2 py-1 text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)] transition-colors duration-150"
              aria-label={t('common.close')}
            >
              ✕
            </button>
          </div>

          {description ? (
            <div id={descId} className="text-sm text-[var(--text-secondary)]">
              {description}
            </div>
          ) : null}

          {details ? (
            <details className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3 text-xs text-[var(--text-secondary)]">
              <summary className="cursor-pointer select-none text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors duration-150">
                {t('common.showDetails')}
              </summary>
              <div className="mt-2 whitespace-pre-wrap break-words">{details}</div>
            </details>
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <button
              ref={cancelRef}
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-1.5 text-sm font-semibold text-[var(--text-primary)] hover:border-[var(--border-hover)] transition-colors duration-150"
            >
              {cancelText}
            </button>
            <button
              ref={confirmRef}
              type="button"
              onClick={onConfirm}
              disabled={Boolean(confirmDisabled) || Boolean(confirmBusy)}
              className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition-all duration-200 ${confirmClasses} disabled:opacity-60 disabled:cursor-not-allowed`}
            >
              {confirmBusy ? t('common.loading') : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
