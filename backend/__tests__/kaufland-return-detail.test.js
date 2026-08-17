'use strict';

/**
 * Kaufland-Retoure vollstaendig zusammensetzen.
 *
 * Abrufweg live am echten Konto ermittelt (17.08.2026):
 *   GET /returns/{id}?embedded=return_units  → Positionen
 *   GET /order-units/{id_order_unit}         → Betraege + Produkt
 *
 * Gemessen: 13 Retouren, 15 Positionen, **zwei mit mehr als einer Position**.
 * Der alte Code las nur return_units[0] und verlor deren Betraege.
 */

const { buildKauflandReturnDetail, centsZuEuro } = require('../lib/kaufland-return-detail');

/** Echte Rohantwort-Form aus der Live-Abfrage. */
const RETOURE_EINE_POSITION = {
  id_return: 1808855,
  ts_created_iso: '2026-08-15T14:44:58Z',
  ts_updated_iso: '2026-08-15T14:45:01Z',
  storefront: 'de',
  status: 'label_generated',
  return_units: [
    {
      id_return: 1808855,
      id_return_unit: 1996601,
      id_order_unit: 314568013967007,
      status: 'need_to_be_returned',
      note: '',
      reason: 'wrong_size',
    },
  ],
};

const ORDER_UNIT = {
  id_order_unit: 314568013967007,
  id_order: 'MUWYWS5',
  status: 'returned',
  price: 2082,          // Cent — Kaeuferbrutto
  revenue_gross: 1760,
  revenue_net: 1479,
  id_offer: 'SKU-8919591829',
  currency: 'EUR',
  vat: 19,
  product: { title: 'PLANAM Norit Kinder Bundhose', eans: ['4030913982243'] },
};

describe('Cent in Euro', () => {
  it('rechnet richtig um', () => {
    expect(centsZuEuro(2082)).toBe(20.82);
    expect(centsZuEuro(0)).toBe(0);
    expect(centsZuEuro(null)).toBe(0);
    expect(centsZuEuro('1760')).toBe(17.6);
  });
});

describe('Eine Position', () => {
  const map = new Map([['314568013967007', ORDER_UNIT]]);

  it('nimmt den Kaeuferbrutto-Preis als Betrag', () => {
    const d = buildKauflandReturnDetail(RETOURE_EINE_POSITION, map);
    expect(d.refundAmount).toBe(20.82);
    expect(d.amountBasis).toBe('kaufland_order_unit_price');
  });

  it('weist die anderen Bezugsgroessen daneben aus', () => {
    const d = buildKauflandReturnDetail(RETOURE_EINE_POSITION, map);
    expect(d.revenueGross).toBe(17.6);
    expect(d.revenueNet).toBe(14.79);
  });

  it('haelt Grund, SKU und Produktnamen fest — die warfen wir bisher weg', () => {
    const d = buildKauflandReturnDetail(RETOURE_EINE_POSITION, map);
    expect(d.reasons).toEqual(['wrong_size']);
    expect(d.skus).toEqual(['SKU-8919591829']);
    expect(d.positionen[0].title).toBe('PLANAM Norit Kinder Bundhose');
    expect(d.positionen[0].ean).toBe('4030913982243');
    expect(d.positionen[0].vat).toBe(19);
  });

  it('erkennt, dass die Ware noch nicht da ist', () => {
    const d = buildKauflandReturnDetail(RETOURE_EINE_POSITION, map);
    expect(d.warePendent).toBe(true);
    expect(d.receivedAt).toBe(null);
  });
});

describe('Mehrere Positionen — der Verlustfall', () => {
  const retoure = {
    id_return: 1806547,
    status: 'package_received',
    ts_updated_iso: '2026-08-10T09:00:00Z',
    return_units: [
      { id_return_unit: 1, id_order_unit: 111, status: 'returned', reason: 'wrong_size' },
      { id_return_unit: 2, id_order_unit: 222, status: 'returned', reason: 'dislike' },
    ],
  };
  const map = new Map([
    ['111', { price: 8411, revenue_gross: 7000, revenue_net: 5882, id_offer: 'SKU-A', currency: 'EUR' }],
    ['222', { price: 8411, revenue_gross: 7000, revenue_net: 5882, id_offer: 'SKU-B', currency: 'EUR' }],
  ]);

  it('summiert ALLE Positionen — vorher fehlten 84,11 €', () => {
    const d = buildKauflandReturnDetail(retoure, map);
    expect(d.refundAmount).toBe(168.22);
    expect(d.positionCount).toBe(2);
  });

  it('sammelt alle Gruende und SKUs', () => {
    const d = buildKauflandReturnDetail(retoure, map);
    expect(d.reasons.sort()).toEqual(['dislike', 'wrong_size']);
    expect(d.skus.sort()).toEqual(['SKU-A', 'SKU-B']);
  });

  it('setzt das Eingangsdatum, sobald das Paket angekommen ist', () => {
    const d = buildKauflandReturnDetail(retoure, map);
    expect(d.receivedAt).toBe('2026-08-10T09:00:00Z');
    expect(d.warePendent).toBe(false);
  });
});

describe('Luecken vertragen', () => {
  it('fehlende Bestellposition ergibt 0, nicht NaN', () => {
    const d = buildKauflandReturnDetail(RETOURE_EINE_POSITION, new Map());
    expect(d.refundAmount).toBe(0);
    expect(d.positionCount).toBe(1);
  });

  it('vertraegt eine Retoure ohne Positionen', () => {
    const d = buildKauflandReturnDetail({ id_return: 1, status: 'package_received' }, new Map());
    expect(d.refundAmount).toBe(0);
    expect(d.positionCount).toBe(0);
  });

  it('vertraegt gar keine Eingabe', () => {
    const d = buildKauflandReturnDetail(null, null);
    expect(d.refundAmount).toBe(0);
    expect(d.positionen).toEqual([]);
  });

  it('findet die Bestellposition auch bei Zahl-Schluessel', () => {
    const d = buildKauflandReturnDetail(RETOURE_EINE_POSITION, new Map([[314568013967007, ORDER_UNIT]]));
    expect(d.refundAmount).toBe(20.82);
  });
});
