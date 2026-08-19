/**
 * Hinweis, warum ein Artikelzustand nicht zur Auswahl steht.
 *
 * Zwei verschiedene Gründe, die für den Bediener gleich aussehen — er sieht
 * nur, dass etwas fehlt:
 *
 * 1. eBay bietet den Zustand in dieser Kategorie gar nicht an.
 * 2. eBay hat ihn beim Einstellen zurückgewiesen (Fehler 21555). AvyCloud merkt
 *    sich das und blendet ihn danach aus, damit nicht bei jedem Versuch dasselbe
 *    Angebot scheitert.
 *
 * Fall 2 ist der verwirrende: Der Zustand steht in eBays eigener Liste für die
 * Kategorie, verschwindet aber trotzdem. Gemessen am 20.08.2026 betrifft das
 * „Vom Verkäufer generalüberholt" (2500) in den Kategorien 185112 und 43509.
 *
 * Ohne diesen Hinweis sucht man den Fehler bei sich — genau das ist passiert.
 */

/** Anzeigenamen der eBay-Zustände, soweit für den Hinweis gebraucht. */
const NAMEN: Record<string, string> = {
  "1000": "Neu",
  "1500": "Neu: Sonstige",
  "1750": "Neu mit Fehlern",
  "1900": "Unbenutzt",
  "2000": "Zertifiziert generalüberholt",
  "2500": "Vom Verkäufer generalüberholt",
  "2750": "Neuwertig",
  "2990": "Gebraucht - Hervorragend",
  "3000": "Gebraucht",
  "3010": "Gebraucht - Akzeptabel",
  "4000": "Sehr gut",
  "5000": "Gut",
  "6000": "Akzeptabel",
  "7000": "Als Ersatzteil / defekt",
};

export function conditionName(id: string): string {
  const key = String(id ?? "").trim();
  return NAMEN[key] || key;
}

/**
 * Baut den Hinweistext für zurückgewiesene Zustände.
 * Leerer String, wenn es nichts zu sagen gibt.
 */
export function rejectedConditionNotice(rejected: string[] | null | undefined): string {
  if (!Array.isArray(rejected) || rejected.length === 0) return "";
  const namen = rejected
    .map((id) => conditionName(id))
    .filter(Boolean);
  if (namen.length === 0) return "";
  const liste = namen.length === 1
    ? `„${namen[0]}"`
    : namen.map((n) => `„${n}"`).join(" und ");
  const verb = namen.length === 1 ? "steht" : "stehen";
  return `${liste} ${verb} hier nicht zur Auswahl — eBay hat diesen Zustand in dieser Kategorie beim Einstellen abgelehnt.`;
}

/** Wann der Zustands-Katalog zuletzt von eBay geholt wurde, in Klartext. */
export function catalogAgeNotice(syncedAt: string | null | undefined, now: number = Date.now()): string {
  if (!syncedAt) return "";
  const ts = new Date(syncedAt).getTime();
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const tage = Math.floor((now - ts) / 86400000);
  if (tage < 0) return "";
  if (tage === 0) return "Liste heute von eBay geholt.";
  if (tage === 1) return "Liste gestern von eBay geholt.";
  return `Liste vor ${tage} Tagen von eBay geholt.`;
}
