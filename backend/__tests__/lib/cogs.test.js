'use strict';

// Pure unit tests for COGS / inventory-value math. No Firestore, no mocks.
const {
  buildProductCostIndex,
  computeOrderCogs,
  computeInventoryValue,
} = require('../../lib/cogs');

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
});
