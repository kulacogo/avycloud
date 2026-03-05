import React, { useEffect, useState } from "react";
import { cn } from "./cn";

export interface AlertProps {
  variant?: "info" | "success" | "warning" | "error";
  closable?: boolean;
  onClose?: () => void;
  /** Auto-dismiss after ms (toast mode). 0 = no auto-dismiss. */
  autoDismiss?: number;
  className?: string;
  children: React.ReactNode;
}

const variantStyles: Record<string, { bg: string; text: string; border: string }> = {
  info: { bg: "bg-info-dim", text: "text-info", border: "border-info/30" },
  success: { bg: "bg-success-dim", text: "text-success", border: "border-success/30" },
  warning: { bg: "bg-warning-dim", text: "text-warning", border: "border-warning/30" },
  error: { bg: "bg-danger-dim", text: "text-danger", border: "border-danger/30" },
};

const icons: Record<string, React.ReactNode> = {
  info: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
    </svg>
  ),
  success: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><path d="M22 4L12 14.01l-3-3" />
    </svg>
  ),
  warning: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><path d="M12 9v4M12 17h.01" />
    </svg>
  ),
  error: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><path d="M15 9l-6 6M9 9l6 6" />
    </svg>
  ),
};

export const Alert: React.FC<AlertProps> = ({
  variant = "info",
  closable = false,
  onClose,
  autoDismiss = 0,
  className,
  children,
}) => {
  const [dismissed, setDismissed] = useState(false);
  const styles = variantStyles[variant];

  useEffect(() => {
    if (autoDismiss <= 0) return;
    const timer = setTimeout(() => {
      setDismissed(true);
      onClose?.();
    }, autoDismiss);
    return () => clearTimeout(timer);
  }, [autoDismiss, onClose]);

  if (dismissed) return null;

  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-3 rounded-xl border px-4 py-3 text-sm",
        styles.bg,
        styles.text,
        styles.border,
        className
      )}
    >
      <span className="shrink-0 mt-0.5">{icons[variant]}</span>
      <div className="flex-1">{children}</div>
      {closable && (
        <button
          type="button"
          onClick={() => { setDismissed(true); onClose?.(); }}
          className="shrink-0 p-0.5 rounded hover:opacity-70 transition-opacity"
          aria-label="Schließen"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
};

Alert.displayName = "Alert";
export default Alert;
