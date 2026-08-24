/**
 * Reine Rechenregel für den Dezimal-Ziffernblock (Gewichtseingabe).
 *
 * Warum nicht der Mengen-Block (`quantityPad.ts`): der rechnet mit ganzen
 * Zahlen (`Math.floor`). Ein Gewicht ist 2,5 kg.
 *
 * Warum der Wert als ZEICHENKETTE geführt wird und nicht als Zahl: `"2,"` und
 * `"2,0"` ergeben beide die Zahl 2. Würde der Block intern eine Zahl halten,
 * verschwände das gerade getippte Komma bei der nächsten Anzeige und der
 * Bediener könnte keine Nachkommastelle eingeben. Umgewandelt wird deshalb erst
 * beim Bestätigen.
 */

/** Höchstgewicht. SendCloud lehnt Sendungen über 120 kg ab; darüber ist es sicher ein Vertipper. */
export const MAX_WEIGHT_KG = 100;

/** Mehr als drei Nachkommastellen hat keine Waage — und kein Versanddienst wertet sie aus. */
export const MAX_DECIMALS = 3;

/**
 * Ziffer anhängen.
 *
 * `isReplacing` = der angezeigte Wert ist noch ein Vorschlag (geschätztes
 * Gewicht), den der erste Tastendruck ersetzt statt verlängert. Gleiche Regel
 * wie beim Mengenblock — sonst würde aus dem Vorschlag 2 und der Eingabe 3 die
 * Zahl 23.
 */
export function appendDigit(current: string, digit: string, isReplacing = false): string {
  const start = isReplacing ? "" : current;
  const [ganz = "", nach] = start.split(",");

  if (nach !== undefined) {
    if (nach.length >= MAX_DECIMALS) return start;
    return `${ganz},${nach}${digit}`;
  }

  // Führende Nullen vermeiden: aus "0" plus "5" wird "5", nicht "05".
  if (start === "0") return digit;
  // Eine unsinnig lange Zahl gar nicht erst entstehen lassen.
  if (ganz.length >= 4) return start;
  return `${start}${digit}`;
}

/** Komma setzen — höchstens eines, und nie als erstes Zeichen ohne führende Null. */
export function appendSeparator(current: string, isReplacing = false): string {
  const start = isReplacing ? "" : current;
  if (start.includes(",")) return start;
  if (start === "") return "0,";
  return `${start},`;
}

/** Letztes Zeichen löschen. */
export function dropLast(current: string): string {
  return current.slice(0, -1);
}

/**
 * Eingabe in ein Gewicht umwandeln.
 *
 * @returns Kilogramm, oder `null` wenn die Eingabe kein brauchbares Gewicht ist.
 *   `null` bedeutet: Bestätigen bleibt gesperrt. Ein Versandlabel mit falschem
 *   Gewicht kostet echtes Geld (Nachberechnung des Transporteurs), deshalb wird
 *   hier nichts geraten.
 */
export function parseWeight(current: string): number | null {
  const text = String(current || "").trim().replace(",", ".");
  if (!text || text === ".") return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > MAX_WEIGHT_KG) return null;
  return Math.round(n * 1000) / 1000;
}

/** Zahl in die Anzeigeform bringen (deutsches Komma). */
export function formatWeight(kg: number | null | undefined): string {
  if (kg == null || !Number.isFinite(kg) || kg <= 0) return "";
  return String(kg).replace(".", ",");
}
