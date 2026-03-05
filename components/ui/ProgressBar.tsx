import React from "react";
import { cn } from "./cn";

export interface ProgressBarProps {
  value: number; // 0-100
  variant?: "accent" | "success" | "warning" | "danger";
  label?: string;
  showPercent?: boolean;
  indeterminate?: boolean;
  className?: string;
}

const barColors: Record<string, string> = {
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

export const ProgressBar: React.FC<ProgressBarProps> = ({
  value,
  variant = "accent",
  label,
  showPercent = false,
  indeterminate = false,
  className,
}) => {
  const clamped = Math.max(0, Math.min(100, value));

  return (
    <div className={cn("space-y-1.5", className)}>
      {(label || showPercent) && (
        <div className="flex items-center justify-between text-xs">
          {label && <span className="text-txt-muted">{label}</span>}
          {showPercent && !indeterminate && <span className="text-txt-secondary font-medium">{Math.round(clamped)}%</span>}
        </div>
      )}
      <div className="h-2 rounded-full bg-app-elevated overflow-hidden" role="progressbar" aria-valuenow={indeterminate ? undefined : clamped} aria-valuemin={0} aria-valuemax={100}>
        {indeterminate ? (
          <div className={cn("h-full w-1/3 rounded-full animate-indeterminate", barColors[variant])} />
        ) : (
          <div
            className={cn("h-full rounded-full transition-all duration-300", barColors[variant])}
            style={{ width: `${clamped}%` }}
          />
        )}
      </div>
    </div>
  );
};

ProgressBar.displayName = "ProgressBar";
export default ProgressBar;
