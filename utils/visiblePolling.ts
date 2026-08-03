/**
 * Abfrage-Takt, der in unsichtbaren Tabs pausiert.
 *
 * Hintergrund (Kostenanalyse Juli 2026): Jeder offene Tab holte im
 * 60-Sekunden-Takt die komplette Produktliste. Jeder dieser Abrufe liest alle
 * ~1.700 Produkt-Datensätze — auch in Tabs, die seit Stunden im Hintergrund
 * liegen. Ergebnis: 355 Mio. Firestore-Lesevorgänge im Monat (120,89 €).
 *
 * Verhalten:
 *   - Takt läuft weiter, führt die Abfrage aber nur aus, wenn der Tab sichtbar ist.
 *   - Beim Zurückwechseln auf den Tab wird EINMAL sofort abgefragt, damit der
 *     Nutzer nie veraltete Daten sieht.
 *
 * WICHTIG — im Zweifel wird abgefragt: Kann die Sichtbarkeit nicht ermittelt
 * werden (kein `document`, unbekannter Wert), gilt der Tab als sichtbar. Ein
 * Fehler in dieser Erkennung darf niemals dazu führen, dass die Oberfläche
 * stehen bleibt.
 */

export interface VisiblePollingDeps {
  isVisible: () => boolean;
  onVisibilityChange: (handler: () => void) => () => void;
  setInterval: (fn: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
}

export const browserPollingDeps: VisiblePollingDeps = {
  isVisible: () =>
    typeof document === "undefined" || document.visibilityState !== "hidden",
  onVisibilityChange: (handler) => {
    if (typeof document === "undefined") return () => {};
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  },
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (id) => window.clearInterval(id),
};

/**
 * Startet den Takt. Gibt die Aufräum-Funktion zurück (für useEffect).
 */
export function startVisiblePolling(
  tick: () => void,
  intervalMs: number,
  deps: VisiblePollingDeps = browserPollingDeps,
): () => void {
  let wasHidden = !deps.isVisible();

  const intervalId = deps.setInterval(() => {
    if (!deps.isVisible()) {
      wasHidden = true;
      return;
    }
    wasHidden = false;
    tick();
  }, intervalMs);

  const unsubscribe = deps.onVisibilityChange(() => {
    if (!deps.isVisible()) {
      wasHidden = true;
      return;
    }
    // Nur nach einer Pause sofort nachladen — nicht bei jedem Fokuswechsel.
    if (wasHidden) {
      wasHidden = false;
      tick();
    }
  });

  return () => {
    deps.clearInterval(intervalId);
    unsubscribe();
  };
}
