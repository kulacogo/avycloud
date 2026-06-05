import React from "react";
import { cn } from "./cn";

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  label?: string;
  error?: string;
  helpText?: string;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
  inputSize?: "sm" | "md" | "lg";
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, helpText, iconLeft, iconRight, inputSize = "md", className, id, ...props }, ref) => {
    const inputId = id || (label ? `input-${label.replace(/\s+/g, "-").toLowerCase()}` : undefined);

    const sizeStyles: Record<string, string> = {
      sm: "h-8 text-xs px-3",
      md: "h-10 text-sm px-3",
      lg: "h-12 text-sm px-4",
    };

    return (
      <div className="space-y-1.5">
        {label && (
          <label htmlFor={inputId} className="block text-xs font-medium uppercase tracking-wide text-txt-muted">
            {label}
          </label>
        )}
        <div className="relative">
          {iconLeft && (
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-txt-muted pointer-events-none">{iconLeft}</span>
          )}
          <input
            ref={ref}
            id={inputId}
            className={cn(
              "w-full rounded-xl bg-app-elevated border text-txt-primary placeholder:text-txt-muted transition-colors",
              "focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent",
              error ? "border-danger focus:ring-danger focus:border-danger" : "border-app-border",
              sizeStyles[inputSize],
              Boolean(iconLeft) && "pl-9",
              Boolean(iconRight) && "pr-9",
              props.disabled && "opacity-50 cursor-not-allowed",
              className
            )}
            aria-invalid={error ? "true" : undefined}
            aria-describedby={error ? `${inputId}-error` : helpText ? `${inputId}-help` : undefined}
            {...props}
          />
          {iconRight && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-txt-muted pointer-events-none">{iconRight}</span>
          )}
        </div>
        {error && (
          <p id={`${inputId}-error`} className="text-xs text-danger" role="alert">
            {error}
          </p>
        )}
        {helpText && !error && (
          <p id={`${inputId}-help`} className="text-xs text-txt-muted">
            {helpText}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = "Input";
export default Input;
