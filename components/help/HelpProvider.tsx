import React, { useCallback, useEffect, useState } from "react";
import HelpDrawer from "./HelpDrawer";

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

  return <HelpDrawer open={open} onClose={handleClose} />;
};

export default HelpProvider;
