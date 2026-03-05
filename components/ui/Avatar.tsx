import React from "react";
import { cn } from "./cn";

export interface AvatarProps {
  src?: string | null;
  alt?: string;
  initials?: string;
  size?: "sm" | "md" | "lg";
  status?: "online" | "offline";
  className?: string;
}

const sizeStyles: Record<string, string> = {
  sm: "w-8 h-8 text-xs",
  md: "w-10 h-10 text-sm",
  lg: "w-14 h-14 text-base",
};

const statusSizeStyles: Record<string, string> = {
  sm: "w-2.5 h-2.5 -bottom-0.5 -right-0.5",
  md: "w-3 h-3 -bottom-0.5 -right-0.5",
  lg: "w-3.5 h-3.5 bottom-0 right-0",
};

// Simple hash-to-hue for consistent colors per initial set
const initialsToHue = (text: string): number => {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = text.charCodeAt(i) + ((hash << 5) - hash);
  return Math.abs(hash) % 360;
};

export const Avatar: React.FC<AvatarProps> = ({
  src,
  alt,
  initials,
  size = "md",
  status,
  className,
}) => {
  const displayInitials = initials || (alt ? alt.charAt(0).toUpperCase() : "?");
  const hue = initialsToHue(displayInitials);

  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      {src ? (
        <img
          src={src}
          alt={alt || ""}
          className={cn("rounded-full object-cover", sizeStyles[size])}
        />
      ) : (
        <span
          className={cn(
            "rounded-full flex items-center justify-center font-semibold text-white",
            sizeStyles[size]
          )}
          style={{ backgroundColor: `hsl(${hue}, 55%, 50%)` }}
          aria-hidden="true"
        >
          {displayInitials}
        </span>
      )}
      {status && (
        <span
          className={cn(
            "absolute rounded-full border-2 border-app-surface",
            status === "online" ? "bg-success" : "bg-txt-muted",
            statusSizeStyles[size]
          )}
          aria-label={status === "online" ? "Online" : "Offline"}
        />
      )}
    </span>
  );
};

Avatar.displayName = "Avatar";
export default Avatar;
