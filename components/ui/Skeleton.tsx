import React from "react";
import { cn } from "./cn";

export interface SkeletonProps {
  variant?: "text" | "card" | "row" | "avatar";
  width?: string;
  height?: string;
  lines?: number;
  className?: string;
}

const shimmer = "animate-pulse bg-app-elevated rounded-lg";

export const Skeleton: React.FC<SkeletonProps> = ({
  variant = "text",
  width,
  height,
  lines = 1,
  className,
}) => {
  if (variant === "avatar") {
    return (
      <div
        className={cn(shimmer, "rounded-full", className)}
        style={{ width: width || "40px", height: height || "40px" }}
        aria-hidden="true"
      />
    );
  }

  if (variant === "card") {
    return (
      <div
        className={cn(shimmer, "rounded-2xl", className)}
        style={{ width: width || "100%", height: height || "120px" }}
        aria-hidden="true"
      />
    );
  }

  if (variant === "row") {
    return (
      <div className={cn("flex items-center gap-3 py-3", className)} aria-hidden="true">
        <div className={cn(shimmer, "rounded-lg")} style={{ width: "40px", height: "40px" }} />
        <div className="flex-1 space-y-2">
          <div className={cn(shimmer)} style={{ width: "60%", height: "12px" }} />
          <div className={cn(shimmer)} style={{ width: "40%", height: "10px" }} />
        </div>
      </div>
    );
  }

  // text
  return (
    <div className={cn("space-y-2", className)} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className={shimmer}
          style={{
            width: width || (i === lines - 1 && lines > 1 ? "70%" : "100%"),
            height: height || "12px",
          }}
        />
      ))}
    </div>
  );
};

/** Renders multiple skeleton table rows for loading states. */
export const SkeletonRows: React.FC<{ count?: number; columns?: number; className?: string }> = ({
  count = 5,
  columns = 6,
  className,
}) => (
  <div className={cn("space-y-1", className)} aria-hidden="true">
    {Array.from({ length: count }).map((_, row) => (
      <div key={row} className="flex items-center gap-3 px-3 py-3 border-b border-app-border/50">
        {Array.from({ length: columns }).map((_, col) => (
          <div key={col} className={cn(shimmer, "flex-1")} style={{ height: "14px" }} />
        ))}
      </div>
    ))}
  </div>
);

Skeleton.displayName = "Skeleton";
export default Skeleton;
