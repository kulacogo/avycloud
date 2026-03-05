import React from "react";
import { cn } from "./cn";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: "success" | "warning" | "danger" | "info" | "neutral" | "accent";
  size?: "sm" | "md";
  dot?: boolean;
  onRemove?: () => void;
}

const variantStyles: Record<string, string> = {
  success: "bg-success-dim text-success",
  warning: "bg-warning-dim text-warning",
  danger: "bg-danger-dim text-danger",
  info: "bg-info-dim text-info",
  neutral: "bg-app-elevated text-txt-secondary",
  accent: "bg-accent-dim text-accent",
};

const sizeStyles: Record<string, string> = {
  sm: "px-1.5 py-0.5 text-[10px]",
  md: "px-2.5 py-1 text-xs",
};

export const Badge: React.FC<BadgeProps> = ({
  variant = "neutral",
  size = "sm",
  dot,
  onRemove,
  className,
  children,
  ...props
}) => (
  <span
    className={cn(
      "inline-flex items-center gap-1 font-semibold rounded-md whitespace-nowrap",
      variantStyles[variant],
      sizeStyles[size],
      className
    )}
    {...props}
  >
    {dot && (
      <span
        className={cn("w-1.5 h-1.5 rounded-full", {
          success: "bg-success",
          warning: "bg-warning",
          danger: "bg-danger",
          info: "bg-info",
          neutral: "bg-txt-muted",
          accent: "bg-accent",
        }[variant])}
        aria-hidden="true"
      />
    )}
    {children}
    {onRemove && (
      <button
        type="button"
        onClick={onRemove}
        className="ml-0.5 hover:opacity-70 transition-opacity"
        aria-label="Entfernen"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    )}
  </span>
);

Badge.displayName = "Badge";
export default Badge;
