/**
 * Tastatur-Verhalten für Overlays (Datenblatt, Dialoge).
 *
 * Ein Overlay, das sich nicht mit Escape schließen lässt, zwingt zur Maus —
 * das Datenblatt war bis 2026-08-17 nur über den Schließen-Knopf oben rechts
 * zu verlassen, obwohl es fast bildschirmfüllend ist.
 *
 * Die Entscheidung liegt hier und nicht in der Komponente, damit sie prüfbar
 * ist: Escape darf NICHT durchschlagen, wenn ein darüberliegender Dialog es
 * schon behandelt hat oder wenn der Mensch gerade in einem Textfeld tippt und
 * dort eine Eingabe abbricht (Autovervollständigung, IME).
 */

export type EscapeCandidate = {
  key: string;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  target?: { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown } | null;
};

/** Elemente, in denen Escape zuerst der Eingabe selbst gehört. */
const TEXT_ENTRY_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function shouldCloseOnEscape(event: EscapeCandidate | null | undefined): boolean {
  if (!event) return false;
  if (event.key !== "Escape" && event.key !== "Esc") return false;
  // Ein untergeordneter Dialog hat den Tastendruck schon verbraucht.
  if (event.defaultPrevented) return false;
  // Laufende Zeichen-Komposition (asiatische Eingabemethoden): Escape bricht
  // dort die Komposition ab, nicht das Overlay.
  if (event.isComposing) return false;

  const target = event.target;
  if (!target) return true;
  if (target.isContentEditable) return false;
  if (typeof target.closest === "function" && target.closest("[data-escape-guard]")) return false;
  const tag = String(target.tagName || "").toUpperCase();
  if (TEXT_ENTRY_TAGS.has(tag)) return false;

  return true;
}
