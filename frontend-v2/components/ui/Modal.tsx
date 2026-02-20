import React, { useEffect, useCallback, useRef } from 'react';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

export const Modal: React.FC<ModalProps> = React.memo(
  ({ open, onClose, title, children, footer, className = '' }) => {
    const overlayRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);

    /* Close on Escape */
    const handleKeyDown = useCallback(
      (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          onClose();
        }
      },
      [onClose]
    );

    useEffect(() => {
      if (open) {
        document.addEventListener('keydown', handleKeyDown);
        document.body.style.overflow = 'hidden';
      }
      return () => {
        document.removeEventListener('keydown', handleKeyDown);
        document.body.style.overflow = '';
      };
    }, [open, handleKeyDown]);

    /* Close on overlay click */
    const handleOverlayClick = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (e.target === overlayRef.current) {
          onClose();
        }
      },
      [onClose]
    );

    if (!open) return null;

    return (
      <div
        ref={overlayRef}
        onClick={handleOverlayClick}
        className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[200] flex items-start justify-center pt-[15vh] animate-fade-in"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div
          ref={contentRef}
          className={`
            bg-[var(--surface)] border border-[var(--border)]
            rounded-2xl shadow-lg
            max-w-[560px] w-[90vw] overflow-hidden
            animate-slide-down
            ${className}
          `.trim()}
        >
          {/* Header */}
          {title && (
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
              <h2 className="text-base font-semibold text-[var(--text-primary)]">{title}</h2>
              <button
                type="button"
                onClick={onClose}
                className="
                  w-7 h-7 flex items-center justify-center rounded-md
                  text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]
                  hover:bg-[var(--surface-secondary)] transition-colors duration-150
                "
                aria-label="Close"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          {/* Body */}
          <div className="px-6 py-5">{children}</div>

          {/* Footer */}
          {footer && (
            <div className="flex items-center justify-end gap-2.5 px-6 py-4 border-t border-[var(--border)] bg-[var(--surface-secondary)]">
              {footer}
            </div>
          )}
        </div>
      </div>
    );
  }
);

Modal.displayName = 'Modal';
