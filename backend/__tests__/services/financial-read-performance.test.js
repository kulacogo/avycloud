'use strict';
const project = (data, fields) => {
  if (!fields) return structuredClone(data);
  const result = {};
  for (const field of fields) {
    const keys = field.split('.');
    let v = data;
    for (const k of keys) v = v?.[k];
    if (v === undefined) continue;
    let out = result;
    for (const k of keys.slice(0, -1)) out = out[k] ||= {};
    out[keys.at(-1)] = structuredClone(v);
  }
  return result;
};
const inputs = {
  products_v2: [
    { id: 'p', tenantId: 'default', identification: { sku: 'SKU-1', barcodes: ['123'] }, details: { identifiers: { ean: '123' }, pricing: { buyPrice: 10, sellPrice: 40 } }, inventory: { quantity: 3 }, ops: { sourceLot: 'LOT', data_quality: { huge: 'unused' } } },
    { id: 'p2', identification: { sku: 'SKU-2' }, details: { pricing: { lowest_price: { amount: 30 } } }, inventory: { quantity: 2 }, ops: { sourceLot: 'LOT' } },
  ],
  orders: [
    { id: 'order', tenantId: 'default', createdAt: '2026-09-02T12:00:00Z', marketplace: 'ebay', totalAmount: 80, items: [{ sku: 'SKU-1', quantity: 2, priceBrutto: 40 }] },
    { tenantId: 'default', updatedAt: '2026-09-03T12:00:00Z', source: 'kaufland', totalAmount: 30, items: [{ sku: 'SKU-2', quantity: 1, priceBrutto: 30 }] },
    { tenantId: 'default', createdAt: '2026-09-03T12:00:00Z', statusLabel: 'storniert', totalAmount: 900, items: [] },
  ],
  returns: [{ createdAt: '2026-09-04T12:00:00Z', refundAmount: 5, marketplace: 'ebay' }],
  shipments: [{ createdAt: '2026-09-03T12:00:00Z', carrier: 'dhl', status: 'shipped' }],
  warehouse_lots: [],
  ebayListingsLive: [{ active: true, startTime: '2026-08-01T00:00:00Z' }, { listingStatus: 'Ended', startTime: '2026-09-01T00:00:00Z', endTime: '2026-09-10T00:00:00Z' }],
};
let projected = true, failProducts = false;
let delayedBalances = null;
const starts = new Set();
const masks = new Map();
function collection(name) {
  let fields;
  const ref = {
    where() { return ref; },
    select(...f) { fields = f; masks.set(name, f); return ref; },
    async get() { starts.add(name); return { docs: (inputs[name] || []).map((d, i) => ({ id: d.id || String(i), data: () => project(d, projected ? fields : null) })) }; },
  };
  return ref;
}
const patch = (modulePath, exports) => {
  const id = require.resolve(modulePath);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
patch('../../lib/firestore', {
  firestore: { collection },
  getDashboardMetrics: async () => ({ range: { from_iso: '2026-09-01T00:00:00Z', to_iso: '2026-10-01T00:00:00Z' }, revenue: { window_non_cancelled_total: 110, kaufland_gross_window: 30 } }),
});
patch('../../lib/product-store', { getAllProductsV2ForTenant: async (tenant, options) => {
  expect(tenant).toBe('default');
  if (failProducts) throw new Error('product unavailable');
  const ref = options.queryFn(collection('products_v2'));
  return (await ref.get()).docs.map(d => d.data());
} });
patch('../../lib/sevdesk', {
  getCheckAccountBalances: async () => delayedBalances ? delayedBalances : { total: 100, accounts: [] },
  getShippingCostsFromSevDesk: async () => null,
  getMarketplacePayoutsFromSevDesk: async () => ({ ebay: 60, kaufland: 20, total: 80, tx_count: 2 }),
});
patch('../../lib/sendcloud', { getShippingCostsSummary: async () => null });
patch('../../lib/ebay-finances', { getEbayNetRevenueSummary: async () => null });
patch('../../lib/cost-model-store', { getCostModelConfig: async () => ({}) });
patch('../../lib/lot-metrics-store', { getLotMetricsStore: () => ({ kennzahlen: async () => { starts.add('lots'); return { proLos: {} }; } }) });
patch('../../lib/listing-snapshot', { getListingSnapshotsInRange: async () => { starts.add('snapshots'); return []; }, snapshotAverage: () => ({ days: 0 }) });
patch('../../lib/kaufland-api', { getBookings: async () => { starts.add('bookings'); return { bookings: [] }; } });
const { getFinancialReport } = require('../../services/financial-report');

beforeEach(() => { projected = true; failProducts = false; delayedBalances = null; starts.clear(); masks.clear(); });

test('projected finance inputs preserve the complete report, including missing costs and cancellations', async () => {
  projected = false;
  const full = await getFinancialReport();
  projected = true;
  const slim = await getFinancialReport();
  delete full.generated_at_iso; delete slim.generated_at_iso;
  expect(slim).toEqual(full);
  expect(slim.pnl.orderCount).toBe(2);
  expect(slim.quality.productCount).toBe(2);
  expect(slim.inventory.unitCount).toBe(5);
  expect(masks.get('products_v2')).toContain('tenantId');
  expect(masks.get('products_v2')).not.toContain('ops');
  expect(masks.get('orders')).not.toContain('raw');
});

test('lots, own shipments, snapshots and bookings start before a slow external source finishes', async () => {
  let done;
  delayedBalances = new Promise(resolve => { done = resolve; });
  const report = getFinancialReport();
  await new Promise(resolve => setImmediate(resolve));
  expect([...starts]).toEqual(expect.arrayContaining(['lots', 'shipments', 'snapshots', 'bookings']));
  done({ total: 50, accounts: [] });
  expect((await report).balances.total).toBe(50);
});

test('a failed projected read stays visibly incomplete and does not masquerade as a successful empty catalog', async () => {
  failProducts = true;
  const report = await getFinancialReport();
  expect(report.errors).toContain('Produktkatalog konnte nicht geladen werden — COGS/Bestand unvollständig.');
});
