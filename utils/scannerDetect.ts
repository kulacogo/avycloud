/**
 * Erkennt, ob ein Handscanner seine Scans als ECHTE Tastenanschläge liefert.
 *
 * WOZU: Das Scan-Fangfeld in Pick/Pack/Stow muss fokussiert und beschreibbar
 * sein, damit ein IME-Scanner (NETUM Q900 / Honeywell) seinen Scan
 * hineinschreiben kann — und genau dafür zeichnet Android die Tastatur. Alle
 * drei bekannten Wege, sie zu unterdrücken (`readOnly`, `inputMode="none"`,
 * `contenteditable` + `virtualkeyboardpolicy`), kappen dieselbe Verbindung.
 *
 * ABER: Ein Scanner, der echte Tastenanschläge sendet, braucht diese Verbindung
 * gar nicht. Kommt ein Scan so an, ist damit BEWIESEN, dass dieses Gerät ohne
 * Tastatur auskommt — und sie darf dauerhaft weg.
 *
 * Die Richtung ist entscheidend: NUR AUFWERTEN, NIE ABWERTEN. Ein Wächter, der
 * bei ausbleibenden Scans zurückschaltet, kann „Modus tötet Scanner" nicht von
 * „gerade scannt niemand" unterscheiden — der wurde 2026-08-04 zu Recht
 * verworfen. Hier gilt das Gegenteil: es wird erst umgeschaltet, wenn der
 * Beweis schon vorliegt.
 */

/**
 * Höchster Abstand zwischen zwei Anschlägen, der noch als Maschine gilt.
 *
 * Ein Scanner tippt seinen Code mit ~5–15 ms je Zeichen. Ein Mensch schafft
 * anhaltend keine 25 Zeichen pro Sekunde — 40 ms ist also weit auf der sicheren
 * Seite und trennt die beiden Fälle sauber.
 */
export const MASCHINEN_ABSTAND_MS = 40;

/**
 * So viele Zeichen müssen am Stück kommen. Ein Barcode hat mindestens sechs
 * Stellen; kürzere Folgen wären zu leicht durch einen Zufall zu erzeugen.
 */
export const MINDEST_ZEICHEN = 6;

export interface TastenBeweis {
  /** Zeichen in der laufenden schnellen Folge. */
  zeichen: number;
  /** Zeitpunkt des letzten Anschlags. */
  zuletzt: number;
}

export const LEERER_BEWEIS: TastenBeweis = { zeichen: 0, zuletzt: 0 };

/**
 * Ist das ein echter Tastenanschlag — oder nur die Begleitmusik einer
 * Bildschirmtastatur?
 *
 * `keyCode === 229` ist Androids Sammelmeldung „die Eingabemethode arbeitet
 * noch": kein echtes Zeichen, sondern genau das Gegenteil des gesuchten
 * Beweises. `key.length === 1` schließt Steuertasten aus (Enter, Shift, Tab).
 */
export function istEchterTastenanschlag(e: {
  key?: string;
  keyCode?: number;
  isComposing?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): boolean {
  if (!e || e.isComposing) return false;
  if (e.keyCode === 229) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  return typeof e.key === "string" && e.key.length === 1;
}

/**
 * Einen Anschlag in den Beweis einrechnen.
 *
 * Ist die Pause zu lang, beginnt die Zählung von vorn — eine über Sekunden
 * verteilte Eingabe ist kein Scan.
 */
export function zaehleAnschlag(
  beweis: TastenBeweis,
  jetzt: number,
): TastenBeweis {
  const abstand = jetzt - beweis.zuletzt;
  const fortsetzung = beweis.zeichen > 0 && abstand <= MASCHINEN_ABSTAND_MS;
  return { zeichen: fortsetzung ? beweis.zeichen + 1 : 1, zuletzt: jetzt };
}

/**
 * Reicht der Beweis?
 *
 * Bewusst streng: eine falsche Erkennung würde die Tastatur bei einem
 * IME-Scanner abschalten und damit das Scannen töten. Ein verpasster Beweis
 * kostet dagegen nur, dass die Tastatur weiter erscheint — der harmlose Fehler.
 */
export function istTastenScanner(
  beweis: TastenBeweis,
  mindestZeichen: number = MINDEST_ZEICHEN,
): boolean {
  return beweis.zeichen >= mindestZeichen;
}
