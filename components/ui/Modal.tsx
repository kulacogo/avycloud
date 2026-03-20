import React, { useEffect, useRef, useCallback } from "react";
import { cn } from "./cn";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  size?: "sm" | "md" | "lg" | "full";
  children: React.ReactNode;
  className?: string;
}

const sizeStyles: Record<string, string> = {
  sm: "max-w-[400px]",
  md: "max-w-[560px]",
  lg: "max-w-[720px]",
  full: "max-w-[90vw]",
};

export const Modal: React.FC<ModalProps> = ({ open, onClose, size = "md", children, className }) => {
  const dialogRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      // Focus trap: wrap Tab at modal boundaries
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [onClose]
  );

  // Focus trap: keep focus inside modal
  useEffect(() => {
    if (!open) return;
    document.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";
    // Focus first focusable element
    const timer = setTimeout(() => {
      const focusable = dialogRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      focusable?.focus();
    }, 50);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
      clearTimeout(timer);
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 transition-opacity" onClick={onClose} aria-hidden="true" />

      {/* Dialog */}
      <div
        ref={dialogRef}
        className={cn(
          "relative w-full bg-app-surface border border-app-border rounded-2xl shadow-2xl animate-modal-in",
          sizeStyles[size],
          className
        )}
      >
        {children}
      </div>
    </div>
  );
};

export const ModalHeader: React.FC<{ children: React.ReactNode; onClose?: () => void; className?: string }> = ({
  children,
  onClose,
  className,
}) => (
  <div className={cn("flex items-center justify-between p-5 border-b border-app-border", className)}>
    <h3 className="text-lg font-semibold text-txt-primary">{children}</h3>
    {onClose && (
      <button
        type="button"
        onClick={onClose}
        className="flex items-center justify-center w-8 h-8 rounded-lg text-txt-muted hover:text-txt-primary hover:bg-app-elevated transition-colors"
        aria-label="Schließen"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    )}
  </div>
);

export const ModalBody: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <div className={cn("p-5", className)}>{children}</div>
);

export const ModalFooter: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <div className={cn("flex items-center justify-end gap-3 p-5 border-t border-app-border", className)}>{children}</div>
);

Modal.displayName = "Modal";
export default Modal;
