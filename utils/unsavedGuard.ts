/**
 * Ungespeicherte Änderungen — eine Anlaufstelle für die ganze Anwendung.
 *
 * Bis 2026-08-17 gab es das nirgends: keine Seite merkte sich, ob etwas
 * geändert wurde, und es existierte kein einziges `beforeunload`. Wer in den
 * Auftrags- oder Lager-Einstellungen Regeln umbaute und dann in der
 * Seitenleiste woanders hinklickte, verlor alles — ohne Nachfrage, ohne
 * Hinweis, ohne Spur. Dieselbe Klasse Fehler wie beim Datenblatt (Vorfall
 * 2026-08-10): Arbeit verschwindet lautlos, und der Mensch merkt es erst,
 * wenn er die alten Werte wiedersieht.
 *
 * Bewusst als kleine Anmelde-Stelle statt als Kontext: die Seiten sind über
 * das ganze Projekt verteilt und werden nachgeladen; ein Kontext hätte alle
 * darunter neu gerendert.
 */

type DirtyCheck = () => boolean;

const guards = new Map<string, DirtyCheck>();

/**
 * Eine Seite meldet an, dass sie ungespeicherte Änderungen haben kann.
 * Gibt die Abmelde-Funktion zurück.
 */
export function registerUnsavedGuard(id: string, isDirty: DirtyCheck): () => void {
  guards.set(id, isDirty);
  return () => {
    guards.delete(id);
  };
}

/** Hat gerade irgendeine angemeldete Seite ungespeicherte Änderungen? */
export function hasUnsavedChanges(): boolean {
  for (const check of guards.values()) {
    try {
      if (check()) return true;
    } catch {
      // Eine kaputte Prüfung darf die Navigation nicht blockieren.
    }
  }
  return false;
}

/** Nur für Tests: alle Anmeldungen entfernen. */
export function resetUnsavedGuards(): void {
  guards.clear();
}

export const UNSAVED_MESSAGE =
  "Auf dieser Seite gibt es ungespeicherte Änderungen.\n\n"
  + "Wenn du jetzt wechselst, gehen sie verloren.\n\n"
  + "Trotzdem wechseln?";

/**
 * Vor dem Verlassen fragen. Gibt `true` zurück, wenn weitergegangen werden darf.
 *
 * `confirmFn` ist übergebbar, damit die Regel prüfbar bleibt und die
 * Anwendung später einen eigenen Dialog statt window.confirm nutzen kann.
 */
export function confirmLeaveIfUnsaved(
  confirmFn: (message: string) => boolean = (message) =>
    typeof window !== "undefined" ? window.confirm(message) : true,
): boolean {
  if (!hasUnsavedChanges()) return true;
  return confirmFn(UNSAVED_MESSAGE);
}

/** Vergleicht zwei Zustände auf Gleichheit — für "seit dem Laden geändert?". */
export function isChangedSince(baseline: unknown, current: unknown): boolean {
  if (baseline === undefined) return false; // noch nicht geladen
  try {
    return JSON.stringify(baseline) !== JSON.stringify(current);
  } catch {
    return false;
  }
}
