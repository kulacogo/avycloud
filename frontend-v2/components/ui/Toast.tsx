import React, {
  createContext,
  useContext,
  useCallback,
  useState,
  useRef,
  useEffect,
} from 'react';

/* -------------------------------------------------------
   Types
   ------------------------------------------------------- */
export type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastItem {
  id: string;
  type: ToastType;
  title: string;
  description?: string;
  exiting?: boolean;
}

interface ToastContextValue {
  showToast: (type: ToastType, title: string, description?: string) => void;
}

/* -------------------------------------------------------
   Context
   ------------------------------------------------------- */
const ToastContext = createContext<ToastContextValue | null>(null);

/* -------------------------------------------------------
   Icons per type
   ------------------------------------------------------- */
const iconMap: Record<ToastType, React.ReactNode> = {
  success: (
    <svg className="w-5 h-5 text-[var(--success)]" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
    </svg>
  ),
  error: (
    <svg className="w-5 h-5 text-[var(--error)]" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
    </svg>
  ),
  warning: (
    <svg className="w-5 h-5 text-[var(--warning)]" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.515 2.625H3.72c-1.347 0-2.188-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
    </svg>
  ),
  info: (
    <svg className="w-5 h-5 text-[var(--info)]" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clipRule="evenodd" />
    </svg>
  ),
};

const progressColorMap: Record<ToastType, string> = {
  success: 'bg-[var(--success)]',
  error: 'bg-[var(--error)]',
  warning: 'bg-[var(--warning)]',
  info: 'bg-[var(--info)]',
};

/* -------------------------------------------------------
   Single Toast
   ------------------------------------------------------- */
const DISMISS_MS = 5000;

const ToastItemComponent: React.FC<{
  toast: ToastItem;
  onDismiss: (id: string) => void;
}> = ({ toast, onDismiss }) => {
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    timerRef.current = setTimeout(() => {
      onDismiss(toast.id);
    }, DISMISS_MS);
    return () => clearTimeout(timerRef.current);
  }, [toast.id, onDismiss]);

  return (
    <div
      className={`
        bg-[var(--surface)] border border-[var(--border)] shadow-lg
        rounded-xl p-3 flex gap-2.5
        min-w-[320px] max-w-[420px]
        ${toast.exiting ? 'animate-toast-out' : 'animate-toast-in'}
      `.trim()}
      role="alert"
    >
      {/* Icon */}
      <span className="flex-shrink-0 mt-0.5">{iconMap[toast.type]}</span>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-[var(--text-primary)] leading-snug">
          {toast.title}
        </p>
        {toast.description && (
          <p className="text-xs text-[var(--text-secondary)] mt-0.5 leading-relaxed">
            {toast.description}
          </p>
        )}

        {/* Progress bar */}
        <div className="mt-2.5 h-[3px] rounded-full bg-[var(--surface-secondary)] overflow-hidden">
          <div
            className={`h-full rounded-full animate-shrink ${progressColorMap[toast.type]}`}
          />
        </div>
      </div>

      {/* Dismiss */}
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="
          flex-shrink-0 w-5 h-5 flex items-center justify-center rounded
          text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]
          transition-colors duration-150
        "
        aria-label="Dismiss"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
};

/* -------------------------------------------------------
   ToastProvider
   ------------------------------------------------------- */
export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  let idCounter = useRef(0);

  const showToast = useCallback(
    (type: ToastType, title: string, description?: string) => {
      const id = `toast-${++idCounter.current}-${Date.now()}`;
      setToasts((prev) => [...prev, { id, type, title, description }]);
    },
    []
  );

  const dismissToast = useCallback((id: string) => {
    /* Mark as exiting for animation, then remove after delay */
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, exiting: true } : t))
    );
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 300);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}

      {/* Toast container */}
      {toasts.length > 0 && (
        <div className="fixed bottom-[72px] right-5 z-[1000] flex flex-col-reverse gap-2">
          {toasts.map((toast) => (
            <ToastItemComponent
              key={toast.id}
              toast={toast}
              onDismiss={dismissToast}
            />
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
};

/* -------------------------------------------------------
   Hook
   ------------------------------------------------------- */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a <ToastProvider>');
  }
  return ctx;
}
