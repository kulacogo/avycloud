'use strict';

/**
 * Der echte Kaufland-Gebührensatz — gemessen statt geraten.
 *
 * Bisher rechnete der Finanzbericht mit einem hinterlegten Satz von 13 %.
 * Der Kaufland-Buchungsbericht liefert die Gebühren aber je Position mit:
 *   `fee_gross` (Gebühr brutto) und `price_gross` (Bruttoumsatz der Position).
 *
 * Gemessen für August 2026 über 48 abgerechnete Positionen:
 *   Gebühren 374,92 € auf 2.423,94 € Umsatz = **15,47 %**, nicht 13 %.
 *
 * Auf den Kaufland-Monatsumsatz gerechnet macht das rund 200 € Unterschied.
 *
 * WARUM EIN SATZ UND NICHT DIE SUMME: Der Buchungsbericht enthält nur
 * Positionen, deren Erlös Kaufland bereits freigegeben hat — das passiert erst
 * Wochen nach der Lieferung. Die Gebührensumme des laufenden Monats steht dort
 * also noch gar nicht. Der gemessene SATZ dagegen ist sofort belastbar und
 * lässt sich auf den vollen Umsatz anwenden.
 *
 * Fällt der Bericht aus oder liegen zu wenige Zeilen vor, bleibt es beim
 * hinterlegten Satz — dann steht in der Oberfläche weiterhin „≈".
 */

/** So viele abgerechnete Positionen müssen es mindestens sein. */
const MIN_POSITIONEN = 10;

/** Plausibilitätsgrenzen: darunter/darüber stimmt etwas nicht. */
const MIN_SATZ = 0.05;
const MAX_SATZ = 0.30;

function zahl(value) {
  // Der Buchungsbericht liefert Euro mit KOMMA ("-10,00"), nicht mit Punkt.
  const n = Number(String(value == null ? '' : value).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Rechnet den Gebührensatz aus den Buchungszeilen aus.
 *
 * @param {Array<{raw?: object}>} bookings Ergebnis von getBookings().
 * @returns {{rate: number, feeSum: number, revenueSum: number, positions: number}|null}
 *   null, wenn zu wenig Daten oder unplausibel — dann NICHT verwenden.
 */
function measureKauflandFeeRate(bookings) {
  if (!Array.isArray(bookings)) return null;

  let feeSum = 0;
  let revenueSum = 0;
  let positions = 0;

  for (const b of bookings) {
    const raw = b && b.raw ? b.raw : null;
    if (!raw) continue;
    const fee = zahl(raw.fee_gross);
    const revenue = zahl(raw.price_gross);
    if (!(fee > 0) || !(revenue > 0)) continue;
    feeSum += fee;
    revenueSum += revenue;
    positions += 1;
  }

  if (positions < MIN_POSITIONEN || revenueSum <= 0) return null;

  const rate = feeSum / revenueSum;
  // Ein Satz ausserhalb dieser Spanne deutet auf falsch gelesene Spalten hin —
  // dann lieber beim hinterlegten Wert bleiben als eine falsche Zahl ausweisen.
  if (!(rate >= MIN_SATZ) || !(rate <= MAX_SATZ)) return null;

  return {
    rate: Math.round(rate * 10000) / 10000,
    feeSum: Math.round(feeSum * 100) / 100,
    revenueSum: Math.round(revenueSum * 100) / 100,
    positions,
  };
}

module.exports = { measureKauflandFeeRate, MIN_POSITIONEN, MIN_SATZ, MAX_SATZ };
