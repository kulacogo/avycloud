import React from "react";
import { cn } from "./cn";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
}

const variantStyles: Record<string, string> = {
  primary: "bg-accent text-white hover:bg-accent/85 active:bg-accent/75 border border-accent/30 shadow-sm",
  secondary: "bg-transparent text-txt-primary hover:bg-app-elevated border border-app-border",
  ghost: "bg-transparent text-txt-secondary hover:text-txt-primary hover:bg-app-elevated/60 border border-transparent",
  danger: "bg-danger text-white hover:bg-danger/85 active:bg-danger/75 border border-danger/30 shadow-sm",
};

const sizeStyles: Record<string, string> = {
  sm: "h-8 px-3 text-xs gap-1.5 rounded-lg",
  md: "h-10 px-4 text-sm gap-2 rounded-xl",
  lg: "h-12 px-5 text-sm gap-2.5 rounded-xl",
};

const Spinner: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={cn("animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
  </svg>
);

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", loading, iconLeft, iconRight, disabled, className, children, ...props }, ref) => {
    const isDisabled = disabled || loading;
    return (
      <button
        ref={ref}
        disabled={isDisabled}
        className={cn(
          "inline-flex items-center justify-center font-semibold transition-colors whitespace-nowrap select-none",
          variantStyles[variant],
          sizeStyles[size],
          isDisabled && "opacity-50 cursor-not-allowed pointer-events-none",
          className
        )}
        {...props}
      >
        {loading ? <Spinner className="w-4 h-4 shrink-0" /> : iconLeft && <span className="shrink-0">{iconLeft}</span>}
        {children}
        {iconRight && !loading && <span className="shrink-0">{iconRight}</span>}
      </button>
    );
  }
);

Button.displayName = "Button";
export default Button;
