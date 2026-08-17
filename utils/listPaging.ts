/**
 * Blättern in langen Listen — gemeinsames Verhalten für alle Tabellen.
 *
 * Fünf Ansichten (Produkte, Aufträge, Angebote, Fehler, Lagerbewegungen) haben
 * je eine eigene Paginierung gebaut. Alle hatten dieselbe Lücke: der Klick auf
 * "Weiter" tauscht den Inhalt aus, lässt die Bildlaufposition aber stehen. Wer
 * am Fuß der Liste blättert, landet mitten in der nächsten Seite und muss von
 * Hand hochscrollen, um zu sehen, was überhaupt gekommen ist.
 *
 * Die Regel steht hier an einer Stelle, damit die fünf nicht wieder
 * auseinanderlaufen.
 */

export type ScrollTarget =
  | { scrollIntoView?: (options?: any) => void }
  | null
  | undefined;

/** Nur ein echter Seitenwechsel scrollt — nicht das erste Rendern, nicht ein Neurendern. */
export function shouldScrollToTop(previousPage: number | null | undefined, nextPage: number): boolean {
  if (previousPage == null) return false;
  if (!Number.isFinite(previousPage) || !Number.isFinite(nextPage)) return false;
  return previousPage !== nextPage;
}

/**
 * Zum Listenanfang springen. Respektiert die Systemeinstellung "Bewegung
 * reduzieren" — sonst wird jeder Seitenwechsel für empfindliche Menschen zur
 * Rutschpartie.
 */
export function scrollListToTop(target: ScrollTarget): void {
  const reduziert =
    typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const behavior = reduziert ? "auto" : "smooth";

  if (target && typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ behavior, block: "start" });
    return;
  }
  if (typeof window !== "undefined" && typeof window.scrollTo === "function") {
    window.scrollTo({ top: 0, behavior } as ScrollToOptions);
  }
}
