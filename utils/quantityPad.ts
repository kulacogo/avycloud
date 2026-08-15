/**
 * Reine Rechenregel für den Mengen-Ziffernblock (`components/operations/QuantityNumpad.tsx`).
 *
 * Hintergrund: das Feld ist im Einlagern mit 1 vorbelegt. Hängt der erste
 * Tastendruck an diesen Vorgabewert an, wird aus "3" die Zahl 13 — und weil im
 * Einlagern keine Obergrenze gesetzt ist, wandern 13 Stück in den Bestand.
 * Genau die Phantom-Bestände, gegen die STOCK_IN_DEDUP gebaut wurde, nur über
 * den Tipp-Weg statt über Doppelfeuer.
 *
 * `isFirstEntry` bedeutet: seit der letzten Wertänderung VON AUSSEN (Reset nach
 * Buchung, Scan, Auswahl einer Kommissionier-Zeile) hat der Mensch noch nicht
 * getippt. Dann ersetzt seine Ziffer den Vorschlag, statt ihn zu verlängern.
 */
export function nextQuantityFromDigit(input: {
  current: number;
  digit: number;
  isFirstEntry: boolean;
  min: number;
  max?: number;
}): number {
  const { current, digit, isFirstEntry, min, max } = input;
  const base = Number.isFinite(current) ? Math.max(0, Math.floor(current)) : 0;
  const raw = isFirstEntry ? digit : Number(`${base}${digit}`);
  const safe = Number.isFinite(raw) ? raw : 0;
  return clampQuantity(safe, min, max);
}

/**
 * Entscheidet, ob der nächste Tastendruck den angezeigten Wert ERSETZT
 * (statt anzuhängen).
 *
 * Diese Entscheidung MUSS zur Klick-Zeit fallen, nicht beim Zeichnen. Grund:
 * meldet der Ziffernblock denselben Wert zurück, den er schon anzeigt (Vorgabe
 * 1, der Mensch will 15 und tippt zuerst die 1), zeichnet React NICHT neu.
 * Eine beim Zeichnen berechnete Entscheidung bliebe dann auf "erster Tipp"
 * stehen und die 5 danach würde erneut ersetzen — aus 15 würde 5.
 *
 * `hasTyped` = seit der letzten Wertänderung von außen wurde schon getippt.
 * `lastEmitted` = der zuletzt von diesem Feld selbst gemeldete Wert; weicht
 * `current` davon ab, kam der Wert von außen (Reset nach Buchung, Scan,
 * Auswahl einer Kommissionier-Zeile) und der nächste Tipp ersetzt.
 */
export function isReplacingEntry(input: {
  lastEmitted: number | null;
  current: number;
  hasTyped: boolean;
}): boolean {
  const { lastEmitted, current, hasTyped } = input;
  if (lastEmitted === null) return true;
  if (lastEmitted !== current) return true;
  return !hasTyped;
}

export function clampQuantity(value: number, min: number, max?: number): number {
  const minApplied = Math.max(min, value);
  if (typeof max !== "number" || !Number.isFinite(max)) return minApplied;
  return Math.min(max, minApplied);
}
