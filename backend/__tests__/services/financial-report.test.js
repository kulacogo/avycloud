'use strict';

const { buildProductCostIndex } = require('../../lib/cogs');
const { aggregateOrders } = require('../../services/financial-report');

const idx = buildProductCostIndex([
  { identification: { sku: 'A' }, details: { pricing: { buyPrice: 5 } } },
  { identification: { sku: 'B' }, details: { pricing: { buyPrice: 10 } } },
]);

const ORDERS = [
  { createdAt: '2026-06-10T08:00:00Z', marketplace: 'ebay', totalAmount: 60, items: [{ sku: 'A', quantity: 3, priceBrutto: 20 }] },
  { createdAt: '2026-06-11T08:00:00Z', marketplace: 'kaufland', totalAmount: 40, items: [{ sku: 'B', quantity: 2, priceBrutto: 20 }] },
  { createdAt: '2026-06-12T08:00:00Z', marketplace: 'ebay', omsStatus: 'cancelled', totalAmount: 999, items: [{ sku: 'A', quantity: 1, priceBrutto: 20 }] },
  { createdAt: '2026-05-01T08:00:00Z', marketplace: 'ebay', totalAmount: 500, items: [{ sku: 'A', quantity: 1, priceBrutto: 20 }] },
];

const WINDOW = { fromIso: '2026-06-01T00:00:00Z', toIso: '2026-06-13T00:00:00Z', bucket: 'day' };

describe('aggregateOrders — windowing & cancellation', () => {
  it('excludes orders outside the window and cancelled orders', () => {
    const r = aggregateOrders(ORDERS, idx, WINDOW);
    expect(r.totalItemRevenue).toBe(100); // 60 + 40 ; cancelled (999) and May (500) excluded
    expect(r.orderCount).toBe(2);
  });
});

describe('aggregateOrders — COGS & coverage', () => {
  it('sums COGS across matched items', () => {
    const r = aggregateOrders(ORDERS, idx, WINDOW);
    expect(r.cogs).toBe(35); // 3*5 + 2*10
    expect(r.matchedRevenue).toBe(100);
  });

  it('reports coverage as matched / total item revenue', () => {
    const partialIdx = buildProductCostIndex([{ identification: { sku: 'A' }, details: { pricing: { buyPrice: 5 } } }]);
    const r = aggregateOrders(ORDERS, partialIdx, WINDOW);
    // Only SKU-A has cost data → matched 60 of 100 → 60%
    expect(r.matchedRevenue).toBe(60);
    expect(r.totalItemRevenue).toBe(100);
  });
});

describe('aggregateOrders — marketplace split', () => {
  it('splits umsatz / units / cogs by marketplace', () => {
    const r = aggregateOrders(ORDERS, idx, WINDOW);
    expect(r.byMarketplace.ebay).toMatchObject({ orders: 1, units: 3, umsatz: 60, cogs: 15 });
    expect(r.byMarketplace.kaufland).toMatchObject({ orders: 1, units: 2, umsatz: 40, cogs: 20 });
  });
});

describe('aggregateOrders — time-series buckets', () => {
  it('buckets daily with umsatz, cogs and rohertrag', () => {
    const r = aggregateOrders(ORDERS, idx, WINDOW);
    const byDate = Object.fromEntries(r.buckets.map((b) => [b.date, b]));
    expect(byDate['2026-06-10']).toMatchObject({ umsatz: 60, cogs: 15, rohertrag: 45 });
    expect(byDate['2026-06-11']).toMatchObject({ umsatz: 40, cogs: 20, rohertrag: 20 });
    expect(byDate['2026-06-12']).toBeUndefined(); // cancelled
  });

  it('buckets monthly when bucket = month', () => {
    const wide = { fromIso: '2026-01-01T00:00:00Z', toIso: '2026-07-01T00:00:00Z', bucket: 'month' };
    const r = aggregateOrders(ORDERS, idx, wide);
    const byMonth = Object.fromEntries(r.buckets.map((b) => [b.date, b]));
    expect(byMonth['2026-06']).toMatchObject({ umsatz: 100, cogs: 35 });
    expect(byMonth['2026-05']).toMatchObject({ umsatz: 500, cogs: 5 }); // May order now in window
  });
});
