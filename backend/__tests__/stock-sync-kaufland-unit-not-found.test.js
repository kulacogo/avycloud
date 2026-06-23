// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// REGRESSION GUARD — Kaufland "Unit Not Found" retry loop (diagnosed 2026-06-23).
//
// Two products generated ~117 failed Kaufland syncs / 24h. Root cause: the
// Kaufland unit no longer exists on Kaufland ("Unit Not Found"/404), but the
// local mirror `kauflandUnitsLive` still listed it as active=true. On every sync
// the dispatcher cleared the stale unitId on the product, but the SKU/EAN
// resolver immediately re-pulled the SAME dead unit from the mirror and wrote it
// back → endless loop, flooding stock_sync_log (the activity feed) with errors.
//
// Correct behavior: on a definitive "Unit Not Found", retire the unit — clear it
// on the product AND mark the mirror entry inactive so the resolver stops
// re-selecting it — and record the channel as `skipped` (action: unit_retired),
// NOT a retryable `error`, so it no longer feeds the drain or the feed.
// kaufland-listings-sync re-activates the mirror entry if the unit truly exists,
// so retiring on a (hypothetical) transient 404 self-corrects.

let updateUnitImpl = async () => ({ updated: true });
let setUnitStatusImpl = async () => ({ ok: true });
const writes = [];

const docHandle = (name, id) => ({
  get: async () => ({ exists: false }),
  set: async (data, opts) => { writes.push({ collection: name, docId: id, data, merge: opts?.merge }); },
  update: async (data) => { writes.push({ collection: name, docId: id, data, op: 'update' }); },
});

const mockFirestore = {
  collection: vi.fn((name) => {
    if (name === 'stock_sync_log') {
      return { add: vi.fn(async () => {}) };
    }
    const chain = {
      doc: vi.fn((id) => docHandle(name, id)),
      where: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      get: async () => ({ empty: true, docs: [] }),
      add: vi.fn(async () => {}),
    };
    return chain;
  }),
};

require.cache[require.resolve('../lib/firestore')] = {
  id: require.resolve('../lib/firestore'),
  filename: require.resolve('../lib/firestore'),
  loaded: true,
  exports: { firestore: mockFirestore },
  children: [],
  paths: [],
};

require.cache[require.resolve('../lib/stock-lock')] = {
  id: require.resolve('../lib/stock-lock'),
  filename: require.resolve('../lib/stock-lock'),
  loaded: true,
  exports: { withStockLock: async (_key, fn) => fn() },
  children: [],
  paths: [],
};

require.cache[require.resolve('../services/stock-reservation')] = {
  id: require.resolve('../services/stock-reservation'),
  filename: require.resolve('../services/stock-reservation'),
  loaded: true,
  exports: { getReservedQuantity: async () => 0 },
  children: [],
  paths: [],
};

require.cache[require.resolve('../lib/kaufland-api')] = {
  id: require.resolve('../lib/kaufland-api'),
  filename: require.resolve('../lib/kaufland-api'),
  loaded: true,
  exports: {
    updateUnit: async (...args) => updateUnitImpl(...args),
    setUnitStatus: async (...args) => setUnitStatusImpl(...args),
  },
  children: [],
  paths: [],
};

const { syncStockToAllChannels } = require('../services/stock-sync-dispatcher');

const DEAD_UNIT_ID = '391413730192';

// Kaufland-only product (no eBay itemId → eBay channel is skipped).
function kauflandProduct(quantity) {
  return {
    id: 'prod-kaufland-dead-1',
    tenantId: 'default',
    identification: { sku: 'SKU-DEAD-1', ean: '4045516002427' },
    inventory: { quantity },
    ops: { kaufland: { unitId: DEAD_UNIT_ID } },
  };
}

const kauflandResult = (results) => results.find((r) => r.channel === 'kaufland');
const mirrorWrite = () => writes.find((w) => w.collection === 'kauflandUnitsLive' && w.docId === DEAD_UNIT_ID);
const productWrite = () => writes.find((w) => w.collection === 'products_v2' && w.docId === 'prod-kaufland-dead-1');

describe('stock-sync: Kaufland "Unit Not Found" must retire the unit (break the loop)', () => {
  beforeEach(() => {
    writes.length = 0;
    updateUnitImpl = async () => ({ updated: true });
    setUnitStatusImpl = async () => ({ ok: true });
  });

  it('stock > 0: retires the dead unit and records it as skipped (not a retryable error)', async () => {
    updateUnitImpl = async () => { throw new Error('Unit Not Found'); };
    setUnitStatusImpl = async () => { throw new Error('Unit Not Found'); };

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product: kauflandProduct(5), reason: 'reconcile' });
    const kaufland = kauflandResult(results);

    // Not a retryable failure → won't feed the drain or flag the activity feed.
    expect(kaufland.status).toBe('skipped');
    expect(kaufland.action).toBe('unit_retired');

    // Mirror entry marked inactive so the resolver stops re-selecting the dead unit.
    const mw = mirrorWrite();
    expect(mw).toBeTruthy();
    expect(mw.data.active).toBe(false);

    // Stale unitId cleared on the product.
    const pw = productWrite();
    expect(pw).toBeTruthy();
    expect(pw.data.ops.kaufland.unitId).toBe(null);
  });

  it('zero stock: ONHOLD "Unit Not Found" also retires the unit as skipped', async () => {
    setUnitStatusImpl = async () => { throw new Error('Unit Not Found'); };

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product: kauflandProduct(0), reason: 'reconcile' });
    const kaufland = kauflandResult(results);

    expect(kaufland.status).toBe('skipped');
    expect(kaufland.action).toBe('unit_retired');
    expect(mirrorWrite()?.data.active).toBe(false);
    expect(productWrite()?.data.ops.kaufland.unitId).toBe(null);
  });

  it('does NOT retire on a non-NotFound error (e.g. rate limit) — keeps it retryable', async () => {
    updateUnitImpl = async () => { throw new Error('rate limit exceeded'); };
    setUnitStatusImpl = async () => { throw new Error('rate limit exceeded'); };

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product: kauflandProduct(5), reason: 'reconcile' });
    const kaufland = kauflandResult(results);

    // Transient error stays an error (drain retries); the mirror is untouched.
    expect(kaufland.status).toBe('error');
    expect(mirrorWrite()).toBeFalsy();
  });
});
