'use strict';

// Pure unit tests for COGS / inventory-value math. No Firestore, no mocks.
const {
  buildProductCostIndex,
  computeOrderCogs,
  computeInventoryValue,
} = require('../../lib/cogs');
const { deriveCostModel } = require('../../lib/cost-model');

function product({ sku, ean, barcodes, buyPrice, sellPrice, lowest, qty } = {}) {
  return {
    identification: { sku: sku || null, barcodes: barcodes || [] },
    details: {
      identifiers: { ean: ean || null },
      pricing: {
        ...(buyPrice != null ? { buyPrice } : {}),
        ...(sellPrice != null ? { sellPrice } : {}),
        ...(lowest != null ? { lowest_price: { amount: lowest, currency: 'EUR' } } : {}),
      },
    },
    inventory: { quantity: qty != null ? qty : 0 },
  };
}

describe('buildProductCostIndex', () => {
  it('indexes a product by its SKU', () => {
    const idx = buildProductCostIndex([product({ sku: 'ABC-1', buyPrice: 4 })]);
    expect(idx.get('ABC-1')).toMatchObject({ buyPrice: 4 });
  });

  it('indexes a product by EAN and by every barcode', () => {
    const idx = buildProductCostIndex([
      product({ sku: 'S1', ean: '4006381333931', barcodes: ['111', '222'], buyPrice: 7 }),
    ]);
    expect(idx.get('4006381333931')).toMatchObject({ buyPrice: 7 });
    expect(idx.get('111')).toMatchObject({ buyPrice: 7 });
    expect(idx.get('222')).toMatchObject({ buyPrice: 7 });
  });

  it('ignores null/empty keys', () => {
    const idx = buildProductCostIndex([product({ sku: null, ean: null, buyPrice: 1 })]);
    expect(idx.has('')).toBe(false);
    expect(idx.size).toBe(0);
  });
});

describe('computeOrderCogs', () => {
  const idx = buildProductCostIndex([
    product({ sku: 'SKU-A', buyPrice: 5, lowest: 99 }),
    product({ sku: 'SKU-B', ean: '900', buyPrice: 0, lowest: 30 }), // has product but NO real cost
    product({ sku: 'SKU-C', ean: '901', buyPrice: 8 }),
  ]);

  it('sums qty * buyPrice for items matched by SKU', () => {
    const order = { items: [{ sku: 'SKU-A', quantity: 3, priceBrutto: 20 }] };
    const r = computeOrderCogs(order, idx);
    expect(r.cogs).toBe(15); // 3 * 5
    expect(r.matchedRevenue).toBe(60); // 3 * 20
    expect(r.matchedItemCount).toBe(1);
    expect(r.unmatchedItemCount).toBe(0);
  });

  it('falls back to EAN when SKU does not match', () => {
    const order = { items: [{ sku: 'UNKNOWN', ean: '901', quantity: 2, priceBrutto: 10 }] };
    const r = computeOrderCogs(order, idx);
    expect(r.cogs).toBe(16); // 2 * 8
    expect(r.matchedItemCount).toBe(1);
  });

  it('treats a matched product WITHOUT a real buyPrice as unmatched cost (honest coverage)', () => {
    // lowest_price must NEVER be used as cost — it is a market price, not what we paid.
    const order = { items: [{ sku: 'SKU-B', quantity: 4, priceBrutto: 25 }] };
    const r = computeOrderCogs(order, idx);
    expect(r.cogs).toBe(0);
    expect(r.matchedItemCount).toBe(0);
    expect(r.unmatchedItemCount).toBe(1);
    expect(r.totalItemRevenue).toBe(100); // revenue still counts toward the denominator
  });

  it('counts revenue of unmatched items toward totalItemRevenue but not matchedRevenue', () => {
    const order = {
      items: [
        { sku: 'SKU-A', quantity: 1, priceBrutto: 20 }, // matched
        { sku: 'NOPE', quantity: 1, priceBrutto: 50 }, // no product at all
      ],
    };
    const r = computeOrderCogs(order, idx);
    expect(r.cogs).toBe(5);
    expect(r.matchedRevenue).toBe(20);
    expect(r.totalItemRevenue).toBe(70);
    expect(r.unmatchedItemCount).toBe(1);
  });

  it('handles missing/empty items array safely', () => {
    expect(computeOrderCogs({}, idx)).toMatchObject({ cogs: 0, matchedRevenue: 0, totalItemRevenue: 0 });
    expect(computeOrderCogs({ items: [] }, idx)).toMatchObject({ cogs: 0 });
  });
});

// Die Paletten-Pauschale ist als Kostenquelle ABGESCHAFFT (Betreiber-Anweisung
// 31.08.2026): "wir koennen nur auf Grundlage der erfassten Einheiten je Los
// rechnen". Palettenpreis und Einheiten je Palette sind dem Betrieb unbekannt —
// der daraus abgeleitete Stueckpreis war erfunden. Ein Posten ohne Los-Preis
// zaehlt jetzt sichtbar als NICHT bepreist.
describe('computeOrderCogs — Kostenmodell ist KEINE Kostenquelle mehr', () => {
  const idx = buildProductCostIndex([
    { identification: { sku: 'REAL' }, details: { pricing: { buyPrice: 5 } } }, // has real EK
    { identification: { sku: 'NOCOST' }, details: { pricing: { lowest_price: { amount: 40 } } } }, // no EK
  ]);
  // ratio = 18.67 / 30 ≈ 0.622
  const model = deriveCostModel({ mode: 'proportional', vatMode: 'netto', palletCostBrutto: 400, unitsPerPallet: 18 }, 30);

  it('schaetzt NICHTS mehr — ein Posten ohne Kostenbasis bleibt unbepreist', () => {
    const order = { items: [{ sku: 'NOCOST', quantity: 2, priceBrutto: 40 }] };
    const r = computeOrderCogs(order, idx, model);
    // Frueher: 2 x (40 x 0,622) ~ 49,80 EUR erfundener Wareneinsatz.
    expect(r.cogs).toBe(0);
    expect(r.estimatedItemCount).toBe(0);
    expect(r.exactItemCount).toBe(0);
    // Sichtbar in der Abdeckungsquote statt still im Wareneinsatz.
    expect(r.unmatchedItemCount).toBe(1);
    expect(r.matchedRevenue).toBe(0);
  });

  it('nutzt weiterhin einen echten Einkaufspreis am Produkt', () => {
    const order = { items: [{ sku: 'REAL', quantity: 3, priceBrutto: 50 }] };
    const r = computeOrderCogs(order, idx, model);
    expect(r.cogs).toBe(15); // 3 * 5 real EK, NOT the estimate
    expect(r.exactItemCount).toBe(1);
    expect(r.estimatedItemCount).toBe(0);
  });

  it('bleibt auch ohne Kostenmodell unbepreist (ehrliche 0 % Abdeckung)', () => {
    const order = { items: [{ sku: 'NOCOST', quantity: 2, priceBrutto: 40 }] };
    const r = computeOrderCogs(order, idx); // no model
    expect(r.cogs).toBe(0);
    expect(r.unmatchedItemCount).toBe(1);
  });
});

describe('computeInventoryValue', () => {
  it('values capital at buyPrice (cost) and potential revenue at sellPrice', () => {
    const r = computeInventoryValue([
      product({ sku: 'A', buyPrice: 5, sellPrice: 12, qty: 10 }),
    ]);
    expect(r.capitalAtCost).toBe(50); // 10 * 5
    expect(r.potentialRevenue).toBe(120); // 10 * 12
    expect(r.articleCount).toBe(1);
    expect(r.articlesWithCost).toBe(1);
    expect(r.unitCount).toBe(10);
  });

  it('NEVER uses lowest_price as a cost basis — capital stays 0 when buyPrice is absent', () => {
    // lowest_price is a market/sell price, not what we paid. Using it as "capital"
    // would fake a cost the seller never incurred. Potential revenue may use it.
    const r = computeInventoryValue([
      product({ sku: 'A', lowest: 9, qty: 2 }), // no buyPrice, no sellPrice
    ]);
    expect(r.capitalAtCost).toBe(0); // honest: no cost data
    expect(r.articlesWithCost).toBe(0);
    expect(r.potentialRevenue).toBe(18); // sell side falls back to lowest (effective listing price)
  });

  it('tracks how many stocked articles actually have a buyPrice (coverage)', () => {
    const r = computeInventoryValue([
      product({ sku: 'A', buyPrice: 4, sellPrice: 10, qty: 2 }), // has cost
      product({ sku: 'B', lowest: 20, qty: 5 }), // no cost, only lowest
    ]);
    expect(r.capitalAtCost).toBe(8); // only A: 2 * 4
    expect(r.articleCount).toBe(2); // both have stock
    expect(r.articlesWithCost).toBe(1); // only A has a buyPrice
    expect(r.potentialRevenue).toBe(120); // A 2*10 + B 5*20
  });

  it('ignores products with zero stock for article count but unit count stays 0', () => {
    const r = computeInventoryValue([
      product({ sku: 'A', buyPrice: 5, qty: 0 }),
      product({ sku: 'B', buyPrice: 5, sellPrice: 7, qty: 3 }),
    ]);
    expect(r.articleCount).toBe(1);
    expect(r.unitCount).toBe(3);
    expect(r.capitalAtCost).toBe(15);
  });

  it('never counts negative stock', () => {
    const r = computeInventoryValue([product({ sku: 'A', buyPrice: 5, qty: -4 })]);
    expect(r.capitalAtCost).toBe(0);
    expect(r.unitCount).toBe(0);
  });

  it('bewertet Bestand OHNE Kostenbasis mit 0 statt mit der Paletten-Pauschale', () => {
    // Frueher steuerte B ueber die Pauschale ~56 EUR bei — aus Zahlen, die der
    // Betrieb gar nicht kennt. Gebundenes Kapital ist "was du bezahlt hast";
    // ohne Beleg dafuer gibt es keinen Wert, nur eine sichtbare Luecke.
    const model = deriveCostModel({ mode: 'proportional', vatMode: 'netto', palletCostBrutto: 400, unitsPerPallet: 18 }, 30);
    const r = computeInventoryValue([
      product({ sku: 'A', buyPrice: 5, sellPrice: 12, qty: 2 }), // echter EK -> 10
      product({ sku: 'B', lowest: 40, qty: 3 }), // kein EK, kein Los -> 0
    ], model);
    expect(r.capitalAtCost).toBe(10);
    expect(r.articlesWithCost).toBe(1);
    expect(r.articlesEstimated).toBe(1); // B: gezaehlt als OHNE Kostenbasis
    expect(r.articlesFromLot).toBe(0);
  });

  it('bewertet Bestand ueber den Los-Preis, wenn einer vorliegt', () => {
    const p = product({ sku: 'C', lowest: 40, qty: 4 });
    p.ops = { sourceLot: 'L-1' };
    const r = computeInventoryValue([p], null, new Map([['L-1', { netto: 2.5 }]]));
    expect(r.capitalAtCost).toBe(10);
    expect(r.articlesFromLot).toBe(1);
    expect(r.articlesEstimated).toBe(0);
  });
});
