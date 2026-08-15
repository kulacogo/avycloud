/**
 * Wiederhol-Regel für den Rechte-Abruf (`fetchMyPermissions`).
 *
 * Vorher lief der Abruf genau einmal, und der `catch` schrieb einen komplett
 * LEEREN Rechte-Satz. Der ist von "dieser Mensch darf wirklich nichts" nicht zu
 * unterscheiden — also verschwand nach einem WLAN-Aussetzer am Handscanner der
 * Tab "Operationen" aus der Leiste und in der Seitenleiste fehlten Aufträge,
 * Produkte, Lager und Marktplätze. Ohne Meldung, ohne zweiten Versuch, bis zum
 * manuellen Neuladen.
 *
 * WICHTIG: "unbekannt" darf niemals als "alles erlaubt" gelten. Ein leerer
 * Rechte-Satz ist ein echter, gültiger Zustand (rollenlose Konten bekommen ihn
 * regulär). Deshalb wird hier nur WIEDERHOLT — die Auswertung bleibt streng.
 */
export const MAX_PERMISSION_ATTEMPTS = 3;

/** Fehler mit HTTP-Status, wie ihn die API-Schicht wirft. */
type StatusError = { status?: number };

export function shouldRetryPermissionLoad(error: unknown, attempt: number): boolean {
  if (attempt >= MAX_PERMISSION_ATTEMPTS) return false;
  const status = (error as StatusError | null)?.status;
  // Kein Status = Netzfehler (Verbindung weg) — genau der Fall, der den
  // Handscanner traf.
  if (typeof status !== "number") return true;
  // 401 fährt in der API-Schicht bereits einen Token-Refresh; erneut zu
  // versuchen liefe nach dem Abmelden im Kreis. 403 ist eine Antwort, kein Fehler.
  if (status === 401 || status === 403) return false;
  return status === 429 || status >= 500;
}

export function permissionRetryDelayMs(attempt: number): number {
  return Math.min(4000, 500 * 2 ** (attempt - 1));
}
