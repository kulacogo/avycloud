import React, { useCallback } from "react";
import { HELP_OPEN_EVENT } from "./HelpProvider";

interface HelpButtonProps {
  /** Style variant: "floating" (default — bottom-right pill) or "topbar" (inline). */
  variant?: "floating" | "topbar";
}

/**
 * Trigger for the AvyCloud Help Drawer. The component is fully independent of
 * App.tsx — it dispatches a window event that the HelpProvider listens to.
 *
 * Two styles:
 *   - "floating": fixed bottom-right pill (default, used at root of index.tsx)
 *   - "topbar":   inline icon-button (use inside Topbar's right-side cluster)
 */
export const HelpButton: React.FC<HelpButtonProps> = ({ variant = "floating" }) => {
  const handleClick = useCallback(() => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new Event(HELP_OPEN_EVENT));
  }, []);

  if (variant === "topbar") {
    return (
      <button
        type="button"
        onClick={handleClick}
        aria-label="Hilfe öffnen"
        title="Hilfe öffnen"
        className="flex items-center justify-center w-8 h-8 rounded-md text-txt-muted hover:text-txt-primary hover:bg-app-elevated transition-colors focus:outline-none focus:ring-2 focus:ring-accent"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5" />
          <path d="M12 17h.01" />
        </svg>
      </button>
    );
  }

  // floating variant — bottom-right pill, MOBILE only (desktop uses the topbar variant)
  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label="Hilfe öffnen"
      title="Hilfe & Schnellstart"
      className="fixed bottom-20 right-4 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-app-border bg-app-surface text-txt-primary shadow-app transition-all hover:border-accent hover:bg-accent hover:text-white focus:outline-none focus:ring-2 focus:ring-accent md:hidden"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5" />
        <path d="M12 17h.01" />
      </svg>
    </button>
  );
};

export default HelpButton;
