'use strict';
const project = (data, fields) => {
  if (!fields) return structuredClone(data);
  const result = {};
  for (const field of fields) {
    const parts = field.split('.');
    let value = data;
    for (const part of parts) value = value?.[part];
    if (value === undefined) continue;
    let cursor = result;
    for (const part of parts.slice(0, -1)) cursor = cursor[part] ||= {};
    cursor[parts.at(-1)] = value;
  }
  return result;
};
const listing = { sku: 'SKU-1', title: 'Artikel', active: true, primaryCategoryId: '1', currentPrice: 20, quantityAvailable: 4, viewItemUrl: 'https://www.ebay.de/itm/1', updatedAt: '2026-09-20T10:00:00Z' };
const data = {
  ebayListingsLive: { '1': listing, '2': { ...listing, active: false } },
  ebayListingLinks: { '1': { productId: 'p1', status: 'matched', confidence: .9 }, '2': { productId: 'p2', status: 'matched' } },
  ebayListingGaps: { '1': { gaps: [{ severity: 'critical', status: 'ready_to_sync', raw: 'large' }], updatedAt: '2026-09-19T00:00:00Z' } },
  products_v2: { p1: { inventory: { quantity: 4 }, storageBins: [] }, p2: { inventory: { quantity: 3 } } },
  products: { p1: { storageBins: [{ code: 'OLD', quantity: 7 }] }, p2: { storageBins: [{ code: 'BIN', quantity: 3 }] } },
};
let ignoreProjection = false;
const readCalls = [];
const doc = (collection, id, fields) => ({ id, exists: Boolean(data[collection]?.[id]), data: () => project(data[collection]?.[id] || {}, ignoreProjection ? null : fields) });
const firestore = {
  collection(name) {
    let fields, active, limit = Infinity;
    const query = {
      doc: id => ({ name, id }),
      where(field, op, value) { if (field === 'active') active = value; return query; },
      select(...mask) { fields = mask; return query; },
      limit(n) { limit = n; return query; },
      async get() { return { docs: Object.keys(data[name] || {}).filter(id => active == null || data[name][id].active === active).slice(0, limit).map(id => doc(name, id, fields)) }; },
    };
    return query;
  },
  async getAll(...args) {
    const { fieldMask } = args.pop();
    readCalls.push(...args);
    return args.map(({ name, id }) => doc(name, id, fieldMask));
  },
};
const file = require.resolve('../../lib/firestore');
require.cache[file] = { id: file, filename: file, loaded: true, exports: { firestore, PRODUCTS_COLLECTION: 'products_v2' } };
const { listLiveListings } = require('../../lib/ebay-direct');

test('eBay projected joins preserve every response field and never revive empty V2 bins', async () => {
  ignoreProjection = true;
  const full = await listLiveListings({ limit: 20000, includeInactive: true });
  readCalls.length = 0;
  ignoreProjection = false;
  const slim = await listLiveListings({ limit: 20000, includeInactive: true });
  expect(slim).toEqual(full);
  expect(slim).toHaveLength(2);
  expect(slim.find(r => r.itemId === '1')).toMatchObject({ warehouseStock: 4, binLocation: null, gapCriticalCount: 1, gapReadyCount: 1 });
  expect(slim.find(r => r.itemId === '2')).toMatchObject({ warehouseStock: 3, binLocation: 'BIN' });
  expect(readCalls.filter(r => r.name === 'products')).toEqual([{ name: 'products', id: 'p2' }]);
  expect(await listLiveListings({ search: 'no match' })).toEqual([]);
});
