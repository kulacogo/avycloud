import React, { useCallback, useEffect, useState, lazy, Suspense } from "react";

/**
 * Die Hilfe wird erst geladen, wenn sie geöffnet wird.
 *
 * Sie bringt die Markdown-Anzeige mit (112 KB), die sonst bei JEDEM Start
 * mitgeladen wurde — obwohl die Hilfe fast nie offen ist.
 */
const HelpDrawer = lazy(() => import("./HelpDrawer"));

export const HELP_OPEN_EVENT = "open-help-drawer";

const hashHasHelpSlug = (): boolean => {
  if (typeof window === "undefined") return false;
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return false;
  if (/^help=[^&/?]+/i.test(raw)) return true;
  const queryPart = raw.split("?")[1];
  if (!queryPart) return false;
  try {
    const params = new URLSearchParams(queryPart);
    return Boolean(params.get("help"));
  } catch {
    return false;
  }
};

export const HelpProvider: React.FC = () => {
  const [open, setOpen] = useState<boolean>(false);

  const handleOpen = useCallback(() => setOpen(true), []);
  const handleClose = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const listener = () => handleOpen();
    window.addEventListener(HELP_OPEN_EVENT, listener);
    return () => window.removeEventListener(HELP_OPEN_EVENT, listener);
  }, [handleOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (hashHasHelpSlug()) {
      setOpen(true);
    }
    const onHashChange = () => {
      if (hashHasHelpSlug()) setOpen(true);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Nichts nachladen, solange die Hilfe zu ist.
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <HelpDrawer open={open} onClose={handleClose} />
    </Suspense>
  );
};

export default HelpProvider;
