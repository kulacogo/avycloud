import { useEffect, useRef } from "react";

import { registerUnsavedGuard } from "../utils/unsavedGuard";

/**
 * Eine Seite meldet ihre ungespeicherten Änderungen an.
 *
 * Zwei Wege gehen dabei verloren, wenn man sie nicht beide abdeckt:
 *  - Wechsel innerhalb der Anwendung (Seitenleiste) — dafür fragt App.tsx.
 *  - Schließen oder Neuladen des Tabs — dafür `beforeunload` hier.
 *
 * @param id      Eindeutige Kennung der Seite.
 * @param dirty   Ob es gerade ungespeicherte Änderungen gibt.
 */
export function useUnsavedGuard(id: string, dirty: boolean): void {
  // Über eine Ref, damit die Anmeldung nicht bei jeder Tastatureingabe
  // ab- und wieder angemeldet wird.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    const abmelden = registerUnsavedGuard(id, () => dirtyRef.current);
    return abmelden;
  }, [id]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Browser zeigen heute ihren eigenen Text; der Rückgabewert ist nur
      // noch das Signal, überhaupt zu fragen.
      event.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
}
