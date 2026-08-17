'use strict';

/**
 * Regression tests for two returns-engine bugs (2026-07):
 *
 *  1) runRefundPush() treated EVERY issueMarketplaceRefund() result as success.
 *     But issueEbayRefund/issueKauflandRefund DO NOT throw on API failure — they
 *     return { ok:false, error }. So a failed refund was marked
 *     marketplaceRefundPushed:true and never retried (retry query filters
 *     marketplaceRefundPushed != true). Fix: only mark on r.ok === true.
 *
 *  2) restockItem() booked back the ORDERED quantity (order.items[].quantity)
 *     instead of the RETURNED quantity (ret.product.quantity). On a partial
 *     return (N ordered, fewer returned) that over-credited stock → oversell.
 *
 * Pattern: require.cache patching (no vi.mock for CJS). See refund-sync.test.js.
 */

require('../api/_patchGcp');

function patchCache(name, exportsObj) {
  const key = require.resolve(name);
  require.cache[key] = { id: key, filename: key, loaded: true, exports: exportsObj, children: [], paths: [] };
}

// ── In-memory Firestore fake (multi-collection) ──
function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

let bookStockInCalls = [];
let tokenProvider = async () => ({ accessToken: 'tkn', apiBaseUrl: 'https://apiz.ebay.test' });

function makeFakeDb(data) {
  const setCalls = [];
  const adds = {};
  function docRef(coll, id) {
    return {
      id,
      get: async () => ({ exists: !!(data[coll] && id in data[coll]), id, data: () => data[coll]?.[id] }),
      set: async (d) => {
        setCalls.push({ collection: coll, id, data: d });
        data[coll] = data[coll] || {};
        data[coll][id] = { ...(data[coll][id] || {}), ...d };
      },
      update: async (d) => {
        setCalls.push({ collection: coll, id, data: d, op: 'update' });
        data[coll] = data[coll] || {};
        data[coll][id] = { ...(data[coll][id] || {}), ...d };
      },
    };
  }
  function makeQuery(coll, filters, lim) {
    return {
      where: (field, _op, val) => makeQuery(coll, [...filters, { field, val }], lim),
      limit: (n) => makeQuery(coll, filters, n),
      orderBy: () => makeQuery(coll, filters, lim),
      get: async () => {
        let ids = Object.keys(data[coll] || {}).filter((id) =>
          filters.every((f) => getPath(data[coll][id], f.field) === f.val)
        );
        if (lim != null) ids = ids.slice(0, lim);
        const docs = ids.map((id) => ({ id, data: () => data[coll][id], ref: docRef(coll, id) }));
        return { docs, empty: docs.length === 0 };
      },
    };
  }
  return {
    collection: (coll) => ({
      where: (field, _op, val) => makeQuery(coll, [{ field, val }], null),
      doc: (id) => docRef(coll, id),
      add: async (d) => {
        adds[coll] = adds[coll] || [];
        adds[coll].push(d);
        return { id: `auto-${adds[coll].length}` };
      },
    }),
    _setCalls: setCalls,
    _adds: adds,
  };
}

// Stable proxy: returns-engine destructures `firestore` ONCE at module load, so
// we hand it a stable object that delegates to the per-test currentDb at call time.
let currentDb;
const firestoreProxy = {
  collection: (...args) => currentDb.collection(...args),
  runTransaction: (...args) => currentDb.runTransaction(...args),
};
patchCache('../../lib/firestore', {
  firestore: firestoreProxy,
  PRODUCTS_COLLECTION: 'products_v2',
});
patchCache('../../lib/warehouse', {
  bookStockIn: async (args) => { bookStockInCalls.push(args); return { product: { inventory: { quantity: 99 } } }; },
});
patchCache('../../lib/ebay-oauth', {
  getValidEbayAccessToken: async () => tokenProvider(),
});

const engine = require('../../services/returns-engine');

beforeEach(() => {
  bookStockInCalls = [];
  tokenProvider = async () => ({ accessToken: 'tkn', apiBaseUrl: 'https://apiz.ebay.test' });
  // Der eigene Erstattungs-Versand ist seit 2026-08-17 standardmaessig AUS
  // (eBay/Kaufland erstatten selbst — ein zweiter Weg zahlt doppelt aus).
  // Diese Tests pruefen das Verhalten des Pfads, wenn er BEWUSST eingeschaltet
  // ist; sonst wuerde runRefundPush sofort mit skipped:true zurueckkehren.
  process.env.MARKETPLACE_REFUND_PUSH = 'on';
});

afterEach(() => {
  delete process.env.MARKETPLACE_REFUND_PUSH;
});

describe('runRefundPush — failed refund must NOT be marked as pushed', () => {
  it('does not set marketplaceRefundPushed when the marketplace refund returns { ok:false }', async () => {
    // eBay return WITHOUT marketplaceReturnId → issueEbayRefund returns
    // { ok:false, error:'No eBay return ID' } (deterministic, no network).
    currentDb = makeFakeDb({
      returns: {
        'ret-fail': {
          tenantId: 'default',
          status: 'erstattet',
          marketplace: 'ebay',
          marketplaceRefundPushed: false,
          marketplaceReturnId: null,
        },
      },
    });

    const res = await engine.runRefundPush({ tenantId: 'default' });

    expect(res.processed).toBe(1);
    expect(res.success).toBe(0);
    expect(res.errors.length).toBe(1);
    // The critical assertion: no write flipped marketplaceRefundPushed to true.
    const markedPushed = currentDb._setCalls.some(
      (c) => c.id === 'ret-fail' && c.data && c.data.marketplaceRefundPushed === true
    );
    expect(markedPushed).toBe(false);
  });

  it('marks marketplaceRefundPushed:true only when the refund actually succeeds', async () => {
    global.fetch = async () => ({ ok: true, status: 200, text: async () => '' });
    currentDb = makeFakeDb({
      returns: {
        'ret-ok': {
          tenantId: 'default',
          status: 'erstattet',
          marketplace: 'ebay',
          marketplaceRefundPushed: false,
          marketplaceReturnId: 'EB-OK-1',
          refundAmount: 12.5,
        },
      },
    });

    const res = await engine.runRefundPush({ tenantId: 'default' });

    expect(res.success).toBe(1);
    expect(res.errors.length).toBe(0);
    const markedPushed = currentDb._setCalls.some(
      (c) => c.id === 'ret-ok' && c.data && c.data.marketplaceRefundPushed === true
    );
    expect(markedPushed).toBe(true);
  });

  it('does NOT mark pushed when the eBay API responds with an error (caught → ok:false)', async () => {
    global.fetch = async () => ({ ok: false, status: 500, text: async () => 'server error' });
    currentDb = makeFakeDb({
      returns: {
        'ret-api-err': {
          tenantId: 'default',
          status: 'teilweise_erstattet',
          marketplace: 'ebay',
          marketplaceRefundPushed: false,
          marketplaceReturnId: 'EB-ERR-1',
          refundAmount: 5,
          refundType: 'partial',
        },
      },
    });

    const res = await engine.runRefundPush({ tenantId: 'default' });

    expect(res.success).toBe(0);
    expect(res.errors.length).toBe(1);
    const markedPushed = currentDb._setCalls.some(
      (c) => c.id === 'ret-api-err' && c.data && c.data.marketplaceRefundPushed === true
    );
    expect(markedPushed).toBe(false);
  });
});

describe('restockItem — books the RETURNED quantity, not the ORDERED quantity', () => {
  function seed({ orderedQty, returnedQty }) {
    return makeFakeDb({
      orders: { 'ord-1': { items: [{ sku: 'SKU1', name: 'Widget', quantity: orderedQty }] } },
      returns: { 'ret-1': { product: { sku: 'SKU1', name: 'Widget', quantity: returnedQty } } },
      products_v2: {
        p1: { id: 'p1', identification: { sku: 'SKU1' }, tenantId: 'default', storage: { binCode: 'A-01' } },
      },
    });
  }

  it('partial return (5 ordered, 2 returned) books back only 2', async () => {
    currentDb = seed({ orderedQty: 5, returnedQty: 2 });

    await engine.restockItem({ returnId: 'ret-1', orderId: 'ord-1', itemCondition: 'a_ware', tenantId: 'default' });

    expect(bookStockInCalls.length).toBe(1);
    expect(bookStockInCalls[0].quantity).toBe(2);
    expect(currentDb._adds.warehouse_movements[0].quantity).toBe(2);
  });

  it('full return (3 ordered, 3 returned) books back 3', async () => {
    currentDb = seed({ orderedQty: 3, returnedQty: 3 });

    await engine.restockItem({ returnId: 'ret-1', orderId: 'ord-1', itemCondition: 'a_ware', tenantId: 'default' });

    expect(bookStockInCalls[0].quantity).toBe(3);
  });

  it('caps at ordered quantity if the returned quantity is somehow larger', async () => {
    currentDb = seed({ orderedQty: 2, returnedQty: 9 });

    await engine.restockItem({ returnId: 'ret-1', orderId: 'ord-1', itemCondition: 'a_ware', tenantId: 'default' });

    expect(bookStockInCalls[0].quantity).toBe(2);
  });

  it('falls back to ordered quantity when the return has no product.quantity', async () => {
    currentDb = makeFakeDb({
      orders: { 'ord-1': { items: [{ sku: 'SKU1', name: 'Widget', quantity: 4 }] } },
      returns: { 'ret-1': { product: { sku: 'SKU1', name: 'Widget' } } }, // no quantity
      products_v2: {
        p1: { id: 'p1', identification: { sku: 'SKU1' }, tenantId: 'default', storage: { binCode: 'A-01' } },
      },
    });

    await engine.restockItem({ returnId: 'ret-1', orderId: 'ord-1', itemCondition: 'a_ware', tenantId: 'default' });

    expect(bookStockInCalls[0].quantity).toBe(4);
  });
});
