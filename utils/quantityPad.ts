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

export function clampQuantity(value: number, min: number, max?: number): number {
  const minApplied = Math.max(min, value);
  if (typeof max !== "number" || !Number.isFinite(max)) return minApplied;
  return Math.min(max, minApplied);
}
