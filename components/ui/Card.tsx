import React from "react";
import { cn } from "./cn";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "surface" | "elevated" | "outlined";
  padding?: "sm" | "md" | "lg" | "none";
  hoverable?: boolean;
}

const variantStyles: Record<string, string> = {
  surface: "bg-app-surface border border-app-border",
  elevated: "bg-app-elevated border border-app-border",
  outlined: "bg-transparent border border-app-border",
};

const paddingStyles: Record<string, string> = {
  none: "",
  sm: "p-4",
  md: "p-6",
  lg: "p-8",
};

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ variant = "surface", padding = "md", hoverable, className, children, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-2xl transition-colors",
        variantStyles[variant],
        paddingStyles[padding],
        hoverable && "hover:border-accent/30 hover:bg-app-elevated/50 cursor-pointer",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
);

Card.displayName = "Card";

export const CardHeader: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, children, ...props }) => (
  <div className={cn("mb-4", className)} {...props}>{children}</div>
);

export const CardFooter: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, children, ...props }) => (
  <div className={cn("mt-4 pt-4 border-t border-app-border", className)} {...props}>{children}</div>
);

export default Card;
