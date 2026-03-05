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
    // For destructive dialogs, it’s safer to focus the least-destructive action (Cancel).
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
      ? 'bg-danger hover:bg-danger/80 text-txt-primary'
      : 'bg-accent hover:bg-accent/80 text-txt-primary';
  const cancelText = cancelLabel ?? t('common.cancel');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className="w-full max-w-lg rounded-2xl border border-app-border bg-app-bg p-5"
      >
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <h3 id={titleId} className="text-lg font-semibold text-txt-primary">
              {title}
            </h3>
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md px-2 py-1 text-xs font-semibold text-txt-secondary hover:bg-white/10"
              aria-label={t('common.close')}
            >
              ✕
            </button>
          </div>

          {description ? (
            <div id={descId} className="text-sm text-txt-secondary">
              {description}
            </div>
          ) : null}

          {details ? (
            <details className="rounded-xl border border-app-border bg-app-bg/40 p-3 text-xs text-txt-secondary">
              <summary className="cursor-pointer select-none text-txt-secondary">{t('common.showDetails')}</summary>
              <div className="mt-2 whitespace-pre-wrap break-words">{details}</div>
            </details>
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <button
              ref={cancelRef}
              type="button"
              onClick={onCancel}
              className="rounded-xl border border-app-border bg-app-elevated px-3 py-1.5 text-sm font-semibold text-txt-primary hover:bg-white/10"
            >
              {cancelText}
            </button>
            <button
              ref={confirmRef}
              type="button"
              onClick={onConfirm}
              disabled={Boolean(confirmDisabled) || Boolean(confirmBusy)}
              className={`rounded-xl px-4 py-1.5 text-sm font-semibold ${confirmClasses} disabled:opacity-60`}
            >
              {confirmBusy ? t('common.loading') : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

