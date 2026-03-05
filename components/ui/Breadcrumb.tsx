import React from "react";
import { cn } from "./cn";

export interface BreadcrumbItem {
  label: string;
  href?: string;
  onClick?: () => void;
}

export interface BreadcrumbProps {
  items: BreadcrumbItem[];
  className?: string;
}

export const Breadcrumb: React.FC<BreadcrumbProps> = ({ items, className }) => (
  <nav aria-label="Breadcrumb" className={cn("flex items-center gap-1.5 text-sm", className)}>
    {items.map((item, i) => {
      const isLast = i === items.length - 1;
      return (
        <React.Fragment key={i}>
          {i > 0 && (
            <span className="text-txt-muted" aria-hidden="true">/</span>
          )}
          {isLast ? (
            <span className="text-txt-muted font-medium" aria-current="page">{item.label}</span>
          ) : item.onClick ? (
            <button
              type="button"
              onClick={item.onClick}
              className="text-txt-secondary hover:text-txt-primary transition-colors"
            >
              {item.label}
            </button>
          ) : (
            <a
              href={item.href || "#"}
              className="text-txt-secondary hover:text-txt-primary transition-colors"
            >
              {item.label}
            </a>
          )}
        </React.Fragment>
      );
    })}
  </nav>
);

Breadcrumb.displayName = "Breadcrumb";
export default Breadcrumb;
