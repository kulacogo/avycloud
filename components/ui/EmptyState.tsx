import React from "react";
import { cn } from "./cn";

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

const DefaultIcon = () => (
  <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="text-txt-muted" aria-hidden="true">
    <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
  </svg>
);

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  className,
}) => (
  <div className={cn("flex flex-col items-center justify-center py-16 px-4 text-center", className)}>
    <div className="mb-4">{icon || <DefaultIcon />}</div>
    <h3 className="text-lg font-semibold text-txt-primary mb-2">{title}</h3>
    {description && <p className="text-sm text-txt-muted max-w-md mb-6">{description}</p>}
    {action && <div>{action}</div>}
  </div>
);

EmptyState.displayName = "EmptyState";
export default EmptyState;
