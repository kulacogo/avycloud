'use strict';

/**
 * Echte Kaufland-Erstattungen aus dem Buchungsbericht.
 *
 * Die Retouren-API gibt keinen Erstattungsbetrag heraus — es gibt schlicht kein
 * Feld dafür (live geprüft: weder Liste noch Detail noch Positionen, und die
 * API selbst nennt bei `embedded` die erlaubten Werte, `refund` ist keiner).
 *
 * Der BUCHUNGSBERICHT dagegen führt echte Geldbewegungen, und zwar mit genau
 * dem Schlüssel, den wir brauchen:
 *
 *   booking_text:  "Erstattung Bestell-Nr. M3GHCL5"
 *   id_order_unit: "314568011900043"     ← Brücke zur Retouren-Position
 *   amount:        "-10,00"
 *
 * ERWARTUNGSHALTUNG — wichtig für die Einordnung: Gemessen am 17.08.2026 über
 * den Zeitraum 01.06.–17.08. hat von 13 Retouren-Positionen **keine einzige**
 * eine Erstattungsbuchung. Die drei vorhandenen Erstattungen (34,93 €) gehören
 * zu anderen Bestellungen.
 *
 * Der Grund steht in denselben Daten: 57 der 66 Buchungen heißen „Freigabe
 * Verkaufserlös". Kaufland gibt den Erlös erst Wochen nach der Lieferung frei.
 * Kommt die Retoure vorher, wird das Geld nie ausgezahlt — statt erstattet. Es
 * entsteht also gar keine Gegenbuchung.
 *
 * Dieser Weg ist deshalb kein Ersatz für die Näherung aus dem Bestellpreis,
 * sondern eine Verbesserung, die greift, sobald Kaufland doch einmal bucht.
 * Dann wird aus einer Schätzung eine gemessene Zahl — sichtbar an `amountBasis`.
 */

/**
 * Buchungstexte, die eine Erstattung bedeuten.
 *
 * Bewusst NICHT über das Vorzeichen erkannt: Gebühren, Werbekosten und
 * Auszahlungen sind ebenfalls negativ. Würde man alle Abgänge als Erstattung
 * werten, käme die Umsatzsteuer durcheinander.
 */
const ERSTATTUNG_RE = /(erstattung|r[uü]ckerstattung|gutschrift|storno)/i;

/** Texte, die trotz Treffer KEINE Erstattung sind. */
const KEINE_ERSTATTUNG_RE = /(freigabe|payout|auszahlung|sponsored|click costs|fees for)/i;

function text(value) {
  return String(value == null ? '' : value);
}

/**
 * Baut einen Index: id_order_unit → erstatteter Betrag in Euro (positiv).
 *
 * @param {Array<{amount_cents?: number, raw?: object}>} bookings Ergebnis von getBookings().
 * @returns {Map<string, number>}
 */
function indexRefundBookingsByOrderUnit(bookings) {
  const index = new Map();
  if (!Array.isArray(bookings)) return index;

  for (const b of bookings) {
    const beschreibung = text(b?.raw?.booking_text || b?.raw?.bookingText || b?.type);
    if (!beschreibung) continue;
    if (KEINE_ERSTATTUNG_RE.test(beschreibung)) continue;
    if (!ERSTATTUNG_RE.test(beschreibung)) continue;

    const cents = Number(b?.amount_cents);
    if (!Number.isFinite(cents) || cents >= 0) continue; // nur Abgänge

    const unit = text(b?.raw?.id_order_unit || b?.raw?.idOrderUnit).trim();
    if (!unit) continue;

    const betrag = Math.abs(cents) / 100;
    index.set(unit, Math.round(((index.get(unit) || 0) + betrag) * 100) / 100);
  }
  return index;
}

/** Bestellnummer aus dem Buchungstext: "Erstattung Bestell-Nr. M63HGK5". */
const BESTELLNR_RE = /Bestell-Nr\.\s*([A-Z0-9]+)/i;

/**
 * Echte KUNDEN-Erstattungen aus dem Buchungsbericht — je Buchung eine Zeile.
 *
 * Anders als getKauflandRefunds() in lib/kaufland-api.js gilt hier:
 *  - die Ausschlussregel greift: "Storno Freigabe Verkaufserloes" ist KEINE
 *    Erstattung, sondern eine zurueckgenommene Erloes-Freigabe. Gemessen am
 *    18.08.2026 waeren das 3 Buchungen ueber 97,23 € gewesen, die den Umsatz
 *    faelschlich gemindert haetten.
 *  - die Bestellnummer wird notfalls aus dem TEXT gelesen. Eine echte
 *    Erstattung ueber 14,95 € (MTZXSS5) hat das Feld `order_id` leer und waere
 *    sonst verlorengegangen.
 *
 * @param {Array<object>} bookings Ergebnis von getBookings().
 * @returns {Array<{refundId: string, orderId: string, amount: number, date: string|null, unit: string|null}>}
 */
function extractCustomerRefunds(bookings) {
  if (!Array.isArray(bookings)) return [];
  const raus = [];
  const gesehen = new Map();

  for (const b of bookings) {
    const beschreibung = text(b?.raw?.booking_text || b?.raw?.bookingText || b?.type);
    if (!beschreibung) continue;
    if (KEINE_ERSTATTUNG_RE.test(beschreibung)) continue;
    if (!ERSTATTUNG_RE.test(beschreibung)) continue;

    const cents = Number(b?.amount_cents);
    if (!Number.isFinite(cents) || cents >= 0) continue; // nur Abgaenge

    const nr = (text(b?.order_id).trim()
      || text(b?.raw?.order_number).trim()
      || (beschreibung.match(BESTELLNR_RE) || [])[1]
      || '').trim();
    if (!nr) continue;

    const betrag = Math.round(Math.abs(cents)) / 100;
    const datum = (text(b?.date).split(' ')[0] || '').split('T')[0] || null;

    // Stabiler Schluessel fuer die Idempotenz. Kaufland vergibt keine
    // Buchungs-ID, also aus Nummer + Betrag + Datum bilden; ein Zaehler haelt
    // zwei betrags- und datumsgleiche Buchungen auseinander.
    const basis = `kaufland:${nr}:${betrag.toFixed(2)}:${datum || '?'}`;
    const lauf = (gesehen.get(basis) || 0) + 1;
    gesehen.set(basis, lauf);

    raus.push({
      refundId: lauf > 1 ? `${basis}#${lauf}` : basis,
      orderId: nr,
      amount: betrag,
      date: datum,
      unit: text(b?.raw?.id_order_unit).trim() || null,
    });
  }
  return raus;
}

module.exports = { indexRefundBookingsByOrderUnit, extractCustomerRefunds, ERSTATTUNG_RE, KEINE_ERSTATTUNG_RE, BESTELLNR_RE };
