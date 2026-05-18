import React, { useCallback } from "react";
import { HELP_OPEN_EVENT } from "./HelpProvider";

export const HelpButton: React.FC = () => {
  const handleClick = useCallback(() => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new Event(HELP_OPEN_EVENT));
  }, []);

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label="Hilfe öffnen"
      title="Hilfe öffnen (Hilfe & Knowledge Base)"
      className="fixed bottom-5 right-5 z-40 hidden h-10 w-10 items-center justify-center rounded-full border border-app-border bg-app-surface text-txt-secondary shadow-app transition-colors hover:border-accent hover:bg-accent hover:text-white focus:outline-none focus:ring-2 focus:ring-accent md:flex"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
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
