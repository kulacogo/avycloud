import React, { useState, useRef, useCallback } from "react";
import { cn } from "./cn";

export interface TooltipProps {
  content: React.ReactNode;
  position?: "top" | "bottom" | "left" | "right";
  delay?: number;
  children: React.ReactElement;
  className?: string;
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  position = "top",
  delay = 300,
  children,
  className,
}) => {
  const [visible, setVisible] = useState(false);
  const showTimer = useRef<ReturnType<typeof setTimeout>>();
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();

  const show = useCallback(() => {
    clearTimeout(hideTimer.current);
    showTimer.current = setTimeout(() => setVisible(true), delay);
  }, [delay]);

  const hide = useCallback(() => {
    clearTimeout(showTimer.current);
    hideTimer.current = setTimeout(() => setVisible(false), 100);
  }, []);

  const positionStyles: Record<string, string> = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
    left: "right-full top-1/2 -translate-y-1/2 mr-2",
    right: "left-full top-1/2 -translate-y-1/2 ml-2",
  };

  const arrowStyles: Record<string, string> = {
    top: "top-full left-1/2 -translate-x-1/2 border-t-app-elevated border-x-transparent border-b-transparent",
    bottom: "bottom-full left-1/2 -translate-x-1/2 border-b-app-elevated border-x-transparent border-t-transparent",
    left: "left-full top-1/2 -translate-y-1/2 border-l-app-elevated border-y-transparent border-r-transparent",
    right: "right-full top-1/2 -translate-y-1/2 border-r-app-elevated border-y-transparent border-l-transparent",
  };

  return (
    <span className="relative inline-flex" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      {visible && (
        <span
          role="tooltip"
          className={cn(
            "absolute z-50 px-2.5 py-1.5 text-xs font-medium text-txt-primary bg-app-elevated border border-app-border rounded-lg shadow-lg max-w-[250px] whitespace-normal pointer-events-none",
            positionStyles[position],
            className
          )}
        >
          {content}
          <span className={cn("absolute w-0 h-0 border-4", arrowStyles[position])} aria-hidden="true" />
        </span>
      )}
    </span>
  );
};

Tooltip.displayName = "Tooltip";
export default Tooltip;
