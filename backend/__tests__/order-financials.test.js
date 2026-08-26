'use strict';

/**
 * Marktplatz-Finanzvorgaenge muessen auf dem AUFTRAG landen.
 *
 * Vorfall 2026-08-18, Kaufland-Auftrag M63HGK5: 499 € verkauft, 10 %
 * Teilerstattung (49,90 €). Die Rechnung wies 499 € aus.
 *
 * Die Rechnung war dabei NICHT schuld: generateInvoice rechnet aus
 * order.items + shippingCost, und auf dem Auftrag stand von der Erstattung
 * kein Wort. syncRefunds erkannte sie zwar im Kaufland-Buchungsbericht
 * ("Erstattung Bestell-Nr. M63HGK5", -49,90 €), legte aber nur eine
 * Glocken-Meldung an und schrieb NICHTS auf orders/{id}.
 *
 * Gemessen ueber 01.05.–30.09.2026: 4 Kaufland-Bestellungen mit Erstattungen
 * ueber 95,83 €, AvyCloud kannte KEINE davon, alle vier hatten eine Rechnung.
 *
 * ZEITLICHE REIHENFOLGE — der Grund, warum ein Korrekturweg Pflicht ist:
 * die Buchung kommt Tage bis Wochen NACH der Bestellung (M63HGK5: bestellt
 * 21.08., gebucht 26.08.). Die Rechnung entsteht beim Versand und kann die
 * Erstattung zum Erstellzeitpunkt gar nicht kennen.
 */

const {
  mergeRefund,
  computeOrderFinancials,
  computeInvoiceAmounts,
} = require('../lib/order-financials');

describe('mergeRefund — Erstattungen sammeln, nie doppelt', () => {
  it('nimmt eine neue Erstattung auf', () => {
    const r = mergeRefund([], { refundId: 'k:M63HGK5:49.90', marketplace: 'kaufland', amount: 49.9, date: '2026-08-26' });
    expect(r.changed).toBe(true);
    expect(r.refunds).toHaveLength(1);
    expect(r.refunds[0].amount).toBe(49.9);
  });

  it('ist idempotent — dieselbe refundId kommt kein zweites Mal rein', () => {
    // Der Buchungsbericht wird alle paar Stunden neu gelesen und liefert
    // dieselbe Zeile wieder. Ohne Idempotenz waechst der Betrag bei jedem Lauf.
    const eins = mergeRefund([], { refundId: 'k:M63HGK5:49.90', marketplace: 'kaufland', amount: 49.9, date: '2026-08-26' });
    const zwei = mergeRefund(eins.refunds, { refundId: 'k:M63HGK5:49.90', marketplace: 'kaufland', amount: 49.9, date: '2026-08-26' });
    expect(zwei.changed).toBe(false);
    expect(zwei.refunds).toHaveLength(1);
  });

  it('nimmt eine ZWEITE, andere Erstattung derselben Bestellung auf', () => {
    // Teilerstattungen koennen mehrfach kommen.
    const eins = mergeRefund([], { refundId: 'k:M63HGK5:49.90', marketplace: 'kaufland', amount: 49.9, date: '2026-08-26' });
    const zwei = mergeRefund(eins.refunds, { refundId: 'k:M63HGK5:20.00', marketplace: 'kaufland', amount: 20, date: '2026-09-02' });
    expect(zwei.changed).toBe(true);
    expect(zwei.refunds).toHaveLength(2);
  });

  it('verwirft Muell statt ihn zu buchen', () => {
    for (const kaputt of [null, {}, { refundId: 'x' }, { refundId: 'x', amount: 0 }, { refundId: 'x', amount: -5 }, { amount: 5 }]) {
      expect(mergeRefund([], kaputt).changed, JSON.stringify(kaputt)).toBe(false);
    }
  });
});

describe('computeOrderFinancials — der aktuelle Betrag des Auftrags', () => {
  it('haelt Brutto, Erstattet und Netto getrennt fest', () => {
    const f = computeOrderFinancials({
      totalAmount: 499,
      refunds: [{ refundId: 'a', amount: 49.9 }],
    });
    expect(f.grossAmount).toBe(499);
    expect(f.refundedTotal).toBe(49.9);
    expect(f.netAmount).toBe(449.1);
  });

  it('summiert mehrere Erstattungen und rundet auf Cent', () => {
    const f = computeOrderFinancials({
      totalAmount: 100,
      refunds: [{ refundId: 'a', amount: 10.005 }, { refundId: 'b', amount: 3.333 }],
    });
    expect(f.refundedTotal).toBe(13.34);
    expect(f.netAmount).toBe(86.66);
  });

  it('faellt nie unter null — eine Erstattung ueber dem Bestellwert macht 0, keinen Minusumsatz', () => {
    const f = computeOrderFinancials({ totalAmount: 50, refunds: [{ refundId: 'a', amount: 80 }] });
    expect(f.netAmount).toBe(0);
    expect(f.overRefunded).toBe(true); // sichtbar, nicht stillschweigend gekappt
  });

  it('ein stornierter Auftrag hat netto 0 — unabhaengig von Erstattungen', () => {
    // MTZXSS5: storniert, 109,95 €, 25,95 € erstattet. Der Umsatz ist 0,
    // nicht 84,00 € — die Ware ging nie raus.
    const f = computeOrderFinancials({ totalAmount: 109.95, refunds: [{ refundId: 'a', amount: 25.95 }], cancelled: true });
    expect(f.netAmount).toBe(0);
    expect(f.cancelled).toBe(true);
  });

  it('ohne Erstattung bleibt alles wie bisher', () => {
    const f = computeOrderFinancials({ totalAmount: 499, refunds: [] });
    expect(f.refundedTotal).toBe(0);
    expect(f.netAmount).toBe(499);
  });
});

describe('computeInvoiceAmounts — die Rechnung zeigt die Erstattung', () => {
  const artikel = [{ name: 'Klimaanlage', sku: 'SKU-1', quantity: 1, priceBrutto: 499 }];

  it('ohne Erstattung exakt das bisherige Verhalten', () => {
    const a = computeInvoiceAmounts({ items: artikel, shippingCost: 0, vatRate: 0.19, refunds: [] });
    expect(a.totalBrutto).toBe(499);
    expect(a.lines).toHaveLength(1);
  });

  it('haengt die Teilerstattung als eigene Minus-Position an', () => {
    // Eigene Position statt stiller Preisminderung: der Kaeufer muss sehen,
    // warum der Betrag von seinem Kaufpreis abweicht.
    const a = computeInvoiceAmounts({ items: artikel, shippingCost: 0, vatRate: 0.19, refunds: [{ refundId: 'a', amount: 49.9 }] });
    expect(a.totalBrutto).toBe(449.1);
    expect(a.lines).toHaveLength(2);
    const minus = a.lines[a.lines.length - 1];
    expect(minus.priceBrutto).toBe(-49.9);
    expect(minus.name).toMatch(/erstattung/i);
  });

  it('rechnet die Umsatzsteuer vom GEMINDERTEN Betrag', () => {
    // Sonst fuehrt die Rechnung mehr USt ab, als eingenommen wurde.
    const a = computeInvoiceAmounts({ items: artikel, shippingCost: 0, vatRate: 0.19, refunds: [{ refundId: 'a', amount: 49.9 }] });
    expect(a.totalNetto).toBe(377.39);
    expect(a.vatAmount).toBe(71.71);
    expect(Math.round((a.totalNetto + a.vatAmount) * 100) / 100).toBe(449.1);
  });

  it('Versandkosten bleiben eine eigene Position, die Erstattung steht dahinter', () => {
    const a = computeInvoiceAmounts({ items: artikel, shippingCost: 5.99, vatRate: 0.19, refunds: [{ refundId: 'a', amount: 49.9 }] });
    expect(a.lines.map((l) => l.name)).toEqual(['Klimaanlage', 'Versandkosten', expect.stringMatching(/erstattung/i)]);
    expect(a.totalBrutto).toBe(455.09);
  });

  it('erzeugt NIE eine Rechnung unter null', () => {
    const a = computeInvoiceAmounts({ items: artikel, shippingCost: 0, vatRate: 0.19, refunds: [{ refundId: 'a', amount: 600 }] });
    expect(a.totalBrutto).toBe(0);
    expect(a.overRefunded).toBe(true);
  });
});

describe('computeInvoiceAmounts — Auftrag ohne Positionen', () => {
  it('faellt auf den Gesamtbetrag zurueck statt 0 € auszuweisen', () => {
    // Bestehendes Verhalten von generateInvoice: `itemsBrutto > 0 ? … :
    // order.totalAmount`. Ohne diesen Zweig entstuenden 0-€-Rechnungen —
    // genau die Klasse, gegen die der Betrags-Guard existiert.
    const a = computeInvoiceAmounts({ items: [], shippingCost: 0, vatRate: 0.19, refunds: [], fallbackTotal: 120, fallbackName: 'Bestellung M1' });
    expect(a.totalBrutto).toBe(120);
    expect(a.lines).toHaveLength(1);
    expect(a.lines[0].name).toBe('Bestellung M1');
  });

  it('zieht die Erstattung auch vom Ersatzbetrag ab', () => {
    const a = computeInvoiceAmounts({ items: [], vatRate: 0.19, refunds: [{ refundId: 'a', amount: 20 }], fallbackTotal: 120 });
    expect(a.totalBrutto).toBe(100);
    expect(a.lines).toHaveLength(2);
  });
});

describe('needsInvoiceCorrection — weicht die Rechnung vom Auftrag ab?', () => {
  const { needsInvoiceCorrection } = require('../lib/order-financials');
  const auftrag = (refunds = []) => ({
    items: [{ name: 'Klimaanlage', quantity: 1, priceBrutto: 499 }],
    shippingCost: 0, vatRate: 0.19, totalAmount: 499, marketplaceRefunds: refunds,
  });

  it('erkennt den Fall M63HGK5: Rechnung 499 €, Auftrag inzwischen 449,10 €', () => {
    const r = needsInvoiceCorrection(auftrag([{ refundId: 'a', amount: 49.9 }]), { amountBrutto: 499 });
    expect(r.needed).toBe(true);
    expect(r.sollBrutto).toBe(449.1);
    expect(r.istBrutto).toBe(499);
    expect(r.differenz).toBe(-49.9);
    expect(r.grund).toMatch(/49\.90/);
  });

  it('ohne Abweichung keine Korrektur', () => {
    expect(needsInvoiceCorrection(auftrag(), { amountBrutto: 499 }).needed).toBe(false);
  });

  it('ein Cent ist Rundung, kein Korrekturgrund', () => {
    expect(needsInvoiceCorrection(auftrag(), { amountBrutto: 499.01 }).needed).toBe(false);
    expect(needsInvoiceCorrection(auftrag(), { amountBrutto: 498.99 }).needed).toBe(false);
  });

  it('zwei Cent sind echtes Geld', () => {
    expect(needsInvoiceCorrection(auftrag(), { amountBrutto: 498.98 }).needed).toBe(true);
  });

  it('liest auch das Alt-Feld amountGross', () => {
    const r = needsInvoiceCorrection(auftrag([{ refundId: 'a', amount: 49.9 }]), { amountGross: 499 });
    expect(r.istBrutto).toBe(499);
    expect(r.needed).toBe(true);
  });
});
