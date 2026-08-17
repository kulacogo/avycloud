'use strict';

/**
 * Welche Retouren dürfen vom Umsatz abgezogen werden?
 *
 * Gemessen am 17.08.2026 über alle 31 Retouren: **8 davon hängen an Aufträgen
 * mit `omsStatus='cancelled'`** — zusammen 1.120,66 € von 2.210,53 €, also
 * **50,7 % der abgezogenen Summe**.
 *
 * Stornierte Aufträge sind im Umsatz aber nie enthalten: sowohl
 * `services/financial-report.js` als auch `lib/firestore.js` überspringen sie
 * beim Aufsummieren. Ihr Betrag wurde also ein zweites Mal abgezogen — der
 * Gewinn im Bericht war um genau diesen Betrag zu niedrig.
 *
 * Wirkung der Korrektur (gemessen):
 *   Juli 2026:   1.430,63 €  →    748,21 €
 *   August 2026:   779,90 €  →    341,66 €
 *
 * FAIL-OPEN: Eine Retoure ohne bekannten Auftrag zählt weiter. Lieber einmal zu
 * viel abziehen als eine echte Retoure verlieren — der umgekehrte Fehler wäre
 * ein zu schön gerechneter Gewinn.
 *
 * Gegenfalle, ausdrücklich NICHT tun: Kaufland-Stornos (1.802,81 €) zusätzlich
 * als Retoure aufnehmen. Das wäre derselbe Fehler noch einmal, nur größer.
 */

/** Auftragszustände, deren Umsatz gar nicht erst gebucht wurde. */
const NICHT_IM_UMSATZ = new Set(['cancelled', 'canceled', 'storniert']);

function normalize(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

/**
 * Ist der Umsatz dieses Auftrags im Bericht enthalten?
 *
 * @param {object|null|undefined} order  Auftragsdaten, oder null wenn unbekannt.
 * @returns {boolean} true, wenn der Auftrag im Umsatz steckt (dann darf die
 *   Retoure abgezogen werden).
 */
function auftragZaehltImUmsatz(order) {
  if (!order) return true; // unbekannt → fail-open
  const status = normalize(order.omsStatus || order.status);
  if (!status) return true;
  return !NICHT_IM_UMSATZ.has(status);
}

/**
 * Darf diese Retoure vom Umsatz abgezogen werden?
 *
 * @param {object} ret                 Das Retouren-Dokument.
 * @param {Map<string, object>} orders orderId → Auftragsdaten (soweit bekannt).
 */
function retoureDarfAbgezogenWerden(ret, orders) {
  if (!ret) return false;
  const orderId = String(ret.orderId || '').trim();
  if (!orderId) return true; // kein Auftrag bekannt → fail-open
  if (!orders || typeof orders.get !== 'function') return true;
  if (!orders.has(orderId)) return true; // Auftrag nicht gefunden → fail-open
  return auftragZaehltImUmsatz(orders.get(orderId));
}

module.exports = {
  auftragZaehltImUmsatz,
  retoureDarfAbgezogenWerden,
  NICHT_IM_UMSATZ,
};
