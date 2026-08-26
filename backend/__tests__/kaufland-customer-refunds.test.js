'use strict';

/**
 * Nur ECHTE Kunden-Erstattungen aus dem Kaufland-Buchungsbericht.
 *
 * Gemessen am 18.08.2026 ueber 01.05.–30.09. Der bestehende
 * getKauflandRefunds() (lib/kaufland-api.js) hat zwei Fehler, die hier
 * abgefangen werden:
 *
 *  1. Er kennt die Ausschlussregel nicht und wertet
 *     "Storno Freigabe Verkaufserloes zu Bestell-Nr. …" als Erstattung.
 *     Das ist aber KEIN Kundengeld — Kaufland nimmt dort die Freigabe des
 *     Verkaufserloeses zurueck. Gemessen: 3 Buchungen, 97,23 €, die den
 *     Umsatz faelschlich gemindert haetten.
 *
 *  2. Er verlangt ein gefuelltes Feld `order_id`. Eine echte Erstattung ueber
 *     14,95 € (MTZXSS5) hat das Feld LEER — die Bestellnummer steht nur im
 *     Buchungstext. Sie fiel damit unter den Tisch.
 */

const { extractCustomerRefunds } = require('../lib/kaufland-refund-bookings');

const B = (text, cents, extra = {}) => ({
  amount_cents: cents,
  date: '2026-08-26 12:04:12',
  order_id: extra.order_id,
  raw: { booking_text: text, id_order_unit: extra.unit, order_number: extra.order_number },
});

describe('extractCustomerRefunds', () => {
  it('nimmt eine echte Erstattung', () => {
    const r = extractCustomerRefunds([B('Erstattung Bestell-Nr. M63HGK5', -4990, { order_id: 'M63HGK5' })]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ orderId: 'M63HGK5', amount: 49.9, date: '2026-08-26' });
  });

  it('verwirft "Storno Freigabe Verkaufserloes" — das ist kein Kundengeld', () => {
    const r = extractCustomerRefunds([
      B('Storno Freigabe Verkaufserlös zu Bestell-Nr. M5P68L5/314568', -3803, { order_id: 'M5P68L5' }),
      B('Storno Freigabe Verkaufserlös zu Bestell-Nr. MTWR7L5/314568', -3803, { order_id: 'MTWR7L5' }),
      B('Storno Freigabe Verkaufserlös zu Bestell-Nr. MHK7RG5/314568', -2117, { order_id: 'MHK7RG5' }),
    ]);
    expect(r).toHaveLength(0);
  });

  it('liest die Bestellnummer aus dem Text, wenn das Feld leer ist', () => {
    // Genau der Fall MTZXSS5 / -14,95 €.
    const r = extractCustomerRefunds([B('Erstattung Bestell-Nr. MTZXSS5', -1495, {})]);
    expect(r).toHaveLength(1);
    expect(r[0].orderId).toBe('MTZXSS5');
    expect(r[0].amount).toBe(14.95);
  });

  it('haelt zwei Erstattungen derselben Bestellung auseinander', () => {
    const r = extractCustomerRefunds([
      B('Erstattung Bestell-Nr. MTZXSS5', -1100, { order_id: 'MTZXSS5' }),
      B('Erstattung Bestell-Nr. MTZXSS5', -1495, {}),
    ]);
    expect(r).toHaveLength(2);
    expect(new Set(r.map((x) => x.refundId)).size).toBe(2);
    expect(r.reduce((s, x) => s + x.amount, 0)).toBe(25.95);
  });

  it('ignoriert Zugaenge und Nicht-Erstattungen', () => {
    const r = extractCustomerRefunds([
      B('Freigabe Verkaufserlös zu Bestell-Nr. M1 Artikel', 13281, { order_id: 'M1' }),
      B('Payout', -448399, {}),
      B('Erstattung Bestell-Nr. M2', 500, { order_id: 'M2' }), // positiv → kein Abgang
      B('Sponsored Products click costs', -1200, {}),
    ]);
    expect(r).toHaveLength(0);
  });

  it('die refundId ist stabil — derselbe Beleg ergibt denselben Schluessel', () => {
    // Sonst waere die Idempotenz wertlos und der Umsatz saenke bei jedem Lauf.
    const b = B('Erstattung Bestell-Nr. M63HGK5', -4990, { order_id: 'M63HGK5' });
    expect(extractCustomerRefunds([b])[0].refundId).toBe(extractCustomerRefunds([b])[0].refundId);
  });

  it('kommt mit Muell klar, ohne zu werfen', () => {
    expect(extractCustomerRefunds(null)).toEqual([]);
    expect(extractCustomerRefunds([null, {}, { amount_cents: 'x' }])).toEqual([]);
  });
});
