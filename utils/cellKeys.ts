/**
 * Tastaturbedienung für Tabellenzellen mit Inline-Bearbeitung.
 *
 * Der Auslöser war ein `<div onClick>` ohne tabIndex und ohne Tastatur —
 * im Bearbeiten-Modus kam man also nur mit der Maus in eine Zelle. Für eine
 * Tabelle, in der man Preise und Mengen reihenweise pflegt, ist das der
 * langsamste denkbare Weg: Hand zur Maus, zielen, klicken, tippen, Hand
 * zurück. Bei 40 Zeilen ist das der Unterschied zwischen zwei und zehn
 * Minuten.
 *
 * Konvention aus Tabellenprogrammen: Enter und F2 öffnen, Leertaste ebenfalls
 * (weil das Element sich als Schaltfläche ausgibt).
 */

export type CellKeyEvent = {
  key: string;
  defaultPrevented?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
};

export function shouldOpenCellEditor(event: CellKeyEvent | null | undefined): boolean {
  if (!event) return false;
  if (event.defaultPrevented) return false;
  // Tastenkürzel des Browsers oder der Anwendung nicht kapern.
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  return event.key === "Enter" || event.key === "F2" || event.key === " " || event.key === "Spacebar";
}
