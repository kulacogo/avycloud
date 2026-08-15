/**
 * Weitergabe des Suchbegriffs aus der oberen Leiste an die Produkttabelle.
 *
 * Vorher schrieb die Leiste den Begriff nur in den Sitzungsspeicher und
 * navigierte auf "Produkte". Die Tabelle liest diesen Speicher aber
 * ausschließlich beim ersten Aufbau (`useState`-Startwert). Stand man schon auf
 * "Produkte", war die Tabelle längst aufgebaut — das Feld leerte sich, die
 * Liste blieb unverändert, und der Begriff sprang erst an, wenn man die Seite
 * verließ und zurückkam.
 *
 * Ein Speicher-Schlüssel ist keine Benachrichtigung. Darum jetzt beides:
 * der Speicher trägt den Begriff über einen Neuaufbau hinweg, das Ereignis
 * erreicht alles, was schon lauscht.
 */
export const GLOBAL_SEARCH_STORAGE_KEY = "avystock:admin-table:search";
const GLOBAL_SEARCH_EVENT = "avycloud:global-search";

const bus = new EventTarget();

function storage(): Storage | null {
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
  } catch {
    // Zugriff kann in abgeschotteten Kontexten werfen (Safari, private Fenster).
    return null;
  }
}

/** Sendet den Begriff an alle lauschenden Ansichten und merkt ihn für später. */
export function publishGlobalSearch(term: string): void {
  const value = String(term ?? "");
  try {
    storage()?.setItem(GLOBAL_SEARCH_STORAGE_KEY, value);
  } catch {
    // Ohne Speicher wird trotzdem zugestellt — die Zustellung ist das Wichtige.
  }
  bus.dispatchEvent(new CustomEvent(GLOBAL_SEARCH_EVENT, { detail: value }));
}

/** Meldet einen Empfänger an. Rückgabe: Abmelde-Funktion für den Aufräum-Effekt. */
export function subscribeGlobalSearch(handler: (term: string) => void): () => void {
  const listener = (event: Event) => handler(String((event as CustomEvent).detail ?? ""));
  bus.addEventListener(GLOBAL_SEARCH_EVENT, listener);
  return () => bus.removeEventListener(GLOBAL_SEARCH_EVENT, listener);
}

/** Startwert für eine Ansicht, die erst nach dem Absenden aufgebaut wird. */
export function readInitialGlobalSearch(): string {
  try {
    return storage()?.getItem(GLOBAL_SEARCH_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}
