'use strict';

/**
 * Retouren an stornierten Auftraegen wurden ein ZWEITES Mal abgezogen.
 *
 * Gemessen 2026-08-17 ueber alle 31 Retouren: 8 haengen an Auftraegen mit
 * omsStatus='cancelled', zusammen 1.120,66 € von 2.210,53 € — also 50,7 % der
 * abgezogenen Summe. Der Umsatz stornierter Auftraege ist im Bericht aber gar
 * nicht enthalten (financial-report.js ueberspringt sie beim Summieren).
 *
 * Wirkung: Juli 1.430,63 → 748,21 € · August 779,90 → 341,66 €.
 */

const {
  auftragZaehltImUmsatz,
  retoureDarfAbgezogenWerden,
} = require('../lib/finance-returns-filter');

describe('Auftraege, deren Umsatz gar nicht gebucht wurde', () => {
  it('erkennt stornierte Auftraege', () => {
    expect(auftragZaehltImUmsatz({ omsStatus: 'cancelled' })).toBe(false);
    expect(auftragZaehltImUmsatz({ omsStatus: 'Cancelled' })).toBe(false);
    expect(auftragZaehltImUmsatz({ status: 'storniert' })).toBe(false);
  });

  it('laesst normale Auftraege zaehlen', () => {
    for (const s of ['shipped', 'completed', 'delivered', 'picking', 'returned']) {
      expect(auftragZaehltImUmsatz({ omsStatus: s })).toBe(true);
    }
  });

  it('unbekannt heisst zaehlt — fail-open', () => {
    // Lieber einmal zu viel abziehen als eine echte Retoure verlieren.
    expect(auftragZaehltImUmsatz(null)).toBe(true);
    expect(auftragZaehltImUmsatz({})).toBe(true);
    expect(auftragZaehltImUmsatz({ omsStatus: '' })).toBe(true);
  });
});

describe('Welche Retoure vom Umsatz abgezogen werden darf', () => {
  const auftraege = new Map([
    ['ebay__17-14947-68082', { omsStatus: 'cancelled' }],
    ['ebay__11-11111-11111', { omsStatus: 'shipped' }],
  ]);

  it('zieht eine Retoure an einem stornierten Auftrag NICHT ab — der Vorfall', () => {
    const ret = { orderId: 'ebay__17-14947-68082', refundAmount: 356.94 };
    expect(retoureDarfAbgezogenWerden(ret, auftraege)).toBe(false);
  });

  it('zieht eine Retoure an einem normalen Auftrag ab', () => {
    const ret = { orderId: 'ebay__11-11111-11111', refundAmount: 49.9 };
    expect(retoureDarfAbgezogenWerden(ret, auftraege)).toBe(true);
  });

  it('zieht ab, wenn der Auftrag unbekannt ist — fail-open', () => {
    expect(retoureDarfAbgezogenWerden({ orderId: 'gibt-es-nicht' }, auftraege)).toBe(true);
    expect(retoureDarfAbgezogenWerden({ refundAmount: 10 }, auftraege)).toBe(true);
    expect(retoureDarfAbgezogenWerden({ orderId: 'x' }, null)).toBe(true);
  });

  it('vertraegt eine fehlende Retoure', () => {
    expect(retoureDarfAbgezogenWerden(null, auftraege)).toBe(false);
  });

  it('rechnet den gemessenen Fall korrekt nach', () => {
    // Die acht Retouren aus dem Vorfall, mit ihren echten Betraegen.
    const storniert = [76.49, 101.94, 356.94, 259.90, 229.00, 19.99, 59.41, 16.99];
    const summe = storniert.reduce((s, x) => s + x, 0);
    expect(Number(summe.toFixed(2))).toBe(1120.66);

    const orders = new Map(storniert.map((_, i) => [`o${i}`, { omsStatus: 'cancelled' }]));
    const abgezogen = storniert
      .map((betrag, i) => ({ orderId: `o${i}`, refundAmount: betrag }))
      .filter((r) => retoureDarfAbgezogenWerden(r, orders))
      .reduce((s, r) => s + r.refundAmount, 0);
    expect(abgezogen).toBe(0);
  });
});
