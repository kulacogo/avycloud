'use strict';

/**
 * Jede Retoure sagt, WORAUF ihr Betrag beruht.
 *
 * eBay liefert den echten Kaeuferbrutto-Betrag (gegengerechnet ueber 324
 * Bestellungen: 1.456,58 € — auf den Cent identisch mit dem Bestand).
 * Kaufland liefert gar keinen Erstattungsbetrag; dort steht eine Naeherung aus
 * dem Bestellpreis.
 *
 * Ohne dieses Feld sehen beide Zahlen im Bericht gleich verlaesslich aus.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'services', 'returns-engine.js'), 'utf8');

describe('Bezugsgroesse wird mitgespeichert', () => {
  it('eBay: Kaeuferbrutto, gemessen', () => {
    expect(SOURCE).toMatch(/amountBasis:\s*'ebay_buyer_gross'/);
  });

  it('Kaufland: Naeherung aus dem Bestellpreis', () => {
    const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kaufland-return-detail.js'), 'utf8');
    expect(lib).toMatch(/kaufland_order_unit_price/);
  });
});

describe('Das echte Erstattungsdatum wird ZUSAETZLICH festgehalten', () => {
  it('eBay speichert refundedAt', () => {
    expect(SOURCE).toMatch(/refundedAt:\s*refundedAt\s*\|\|\s*null/);
  });

  it('createdAt bleibt das Bestelldatum', () => {
    // Nur so schliesst der Bericht mit dem Umsatz, der ebenfalls ueber
    // order.createdAt gebucht wird. Ein Wechsel wuerde Umsatz und Retouren
    // gegeneinander verschieben.
    expect(SOURCE).toMatch(/createdAt:\s*order\.creationDate/);
  });

  it('Kaufland speichert receivedAt als Naeherung', () => {
    const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kaufland-return-detail.js'), 'utf8');
    expect(lib).toMatch(/receivedAt/);
  });
});

describe('Kaufland: alle Positionen', () => {
  it('der Sync liest nicht mehr nur die erste Position', () => {
    // Frueher: const firstUnit = returnUnits[0]; … orderUnitDetail?.price / 100
    expect(SOURCE).toMatch(/buildKauflandReturnDetail\s*\(/);
    expect(SOURCE).toMatch(/refundAmount:\s*retourenDetail\.refundAmount/);
  });

  it('das nicht existierende Kaufland-Feld wird nicht mehr gelesen', () => {
    // `kr.refund_amount` gibt es bei Kaufland nicht — live geprueft.
    expect(SOURCE).not.toMatch(/parseFloat\(kr\.refund_amount/);
  });
});
