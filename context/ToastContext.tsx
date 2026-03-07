import React, { createContext, useContext, useCallback, useState, useRef } from "react";

export type ToastVariant = "info" | "success" | "warning" | "error";

export interface Toast {
  id: string;
  variant: ToastVariant;
  message: string;
  duration: number;
}

interface ToastContextValue {
  toasts: Toast[];
  addToast: (variant: ToastVariant, message: string, duration?: number) => void;
  removeToast: (id: string) => void;
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
  warning: (message: string, duration?: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let toastCounter = 0;

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const removeToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback((variant: ToastVariant, message: string, duration = 4000) => {
    const id = `toast-${++toastCounter}`;
    const toast: Toast = { id, variant, message, duration };
    setToasts((prev) => [...prev, toast]);

    if (duration > 0) {
      const timer = setTimeout(() => {
        removeToast(id);
      }, duration);
      timersRef.current.set(id, timer);
    }

    return id;
  }, [removeToast]);

  const success = useCallback((msg: string, dur?: number) => addToast("success", msg, dur), [addToast]);
  const error = useCallback((msg: string, dur?: number) => addToast("error", msg, dur ?? 6000), [addToast]);
  const info = useCallback((msg: string, dur?: number) => addToast("info", msg, dur), [addToast]);
  const warning = useCallback((msg: string, dur?: number) => addToast("warning", msg, dur ?? 5000), [addToast]);

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast, success, error, info, warning }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </ToastContext.Provider>
  );
};

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

// ─── Toast Container (renders at bottom-right) ──────────────────

const variantStyles: Record<ToastVariant, { bg: string; text: string; border: string }> = {
  info: { bg: "bg-info-dim", text: "text-info", border: "border-info/30" },
  success: { bg: "bg-success-dim", text: "text-success", border: "border-success/30" },
  warning: { bg: "bg-warning-dim", text: "text-warning", border: "border-warning/30" },
  error: { bg: "bg-danger-dim", text: "text-danger", border: "border-danger/30" },
};

const variantIcons: Record<ToastVariant, React.ReactNode> = {
  info: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
    </svg>
  ),
  success: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><path d="M22 4L12 14.01l-3-3" />
    </svg>
  ),
  warning: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><path d="M12 9v4M12 17h.01" />
    </svg>
  ),
  error: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><path d="M15 9l-6 6M9 9l6 6" />
    </svg>
  ),
};

interface ToastContainerProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-2 pointer-events-none max-w-sm">
      {toasts.map((toast) => {
        const styles = variantStyles[toast.variant];
        return (
          <div
            key={toast.id}
            role="alert"
            className={`pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg animate-slide-in-right ${styles.bg} ${styles.text} ${styles.border}`}
          >
            <span className="shrink-0 mt-0.5">{variantIcons[toast.variant]}</span>
            <div className="flex-1">{toast.message}</div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              className="shrink-0 p-0.5 rounded hover:opacity-70 transition-opacity"
              aria-label="Schließen"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
};

ToastProvider.displayName = "ToastProvider";
