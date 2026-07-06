// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// REGRESSION GUARD — Kaufland fail-safe ONHOLD darf KEIN Fake-Success sein.
//
// Vorher: schlug updateUnit (Stock > 0) transient fehl (Timeout/5xx/Rate-Limit),
// setzte der Fail-safe die Unit auf ONHOLD und meldete status:'success'
// (action fail_safe_onhold). syncStockWithRetry filtert nur error/failed →
// der eigentliche Update-Fehler erreichte NIE den Drain, kein Retry, und das
// Listing blieb unbegrenzt ONHOLD/unverkäuflich. Exakt das Fake-Success-Muster
// aus dem eBay-Incident 2026-06-16 (c339184), das im Kaufland-Zweig weiterlebte.
//
// Erwartung seit Fix: ONHOLD bleibt als Oversell-Sicherung, aber das Result ist
// status:'failed' + retryable:true + error, damit der Drain updateUnit erneut
// versucht (setzt bei Erfolg automatisch wieder AVAILABLE).

let updateUnitImpl = async () => ({ updated: true });
let setUnitStatusImpl = async () => ({ ok: true });
const setUnitStatusCalls = [];

const mockFirestore = {
  collection: vi.fn((name) => {
    if (name === 'stock_sync_log') {
      return { add: vi.fn(async () => {}) };
    }
    const chain = {
      doc: vi.fn(() => ({ get: async () => ({ exists: false }), update: async () => {}, set: async () => {} })),
      where: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      get: async () => ({ empty: true, docs: [] }),
      add: vi.fn(async () => {}),
    };
    return chain;
  }),
};

function patchCjsModule(modulePath, mockExports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: mockExports,
    children: [],
    paths: [],
  };
}

patchCjsModule('../lib/firestore', { firestore: mockFirestore });
patchCjsModule('../lib/stock-lock', { withStockLock: async (_key, fn) => fn() });
patchCjsModule('../services/stock-reservation', { getReservedQuantity: async () => 0 });
patchCjsModule('../lib/kaufland-api', {
  updateUnit: async (...args) => updateUnitImpl(...args),
  setUnitStatus: async (...args) => { setUnitStatusCalls.push(args); return setUnitStatusImpl(...args); },
});

const { syncStockToAllChannels } = require('../services/stock-sync-dispatcher');

function kauflandProduct(quantity) {
  return {
    id: 'prod-kaufland-failsafe-1',
    tenantId: 'default',
    identification: { sku: 'SKU-FAILSAFE-1', ean: '4045516002427' },
    inventory: { quantity },
    ops: { kaufland: { unitId: '391413730199' } },
  };
}

const kauflandResult = (results) => results.find((r) => r.channel === 'kaufland');

describe('stock-sync: Kaufland fail-safe ONHOLD muss als failed in den Drain', () => {
  beforeEach(() => {
    setUnitStatusCalls.length = 0;
    updateUnitImpl = async () => ({ updated: true });
    setUnitStatusImpl = async () => ({ ok: true });
  });

  it('transienter updateUnit-Fehler → ONHOLD gesetzt, aber Result failed + retryable', async () => {
    updateUnitImpl = async () => { throw new Error('Kaufland API timeout (504)'); };

    const { results } = await syncStockToAllChannels({
      tenantId: 'default', product: kauflandProduct(5), reason: 'test',
    });
    const kaufland = kauflandResult(results);

    // Oversell-Sicherung lief:
    expect(setUnitStatusCalls.length).toBe(1);
    expect(setUnitStatusCalls[0][1]).toBe('ONHOLD');
    expect(kaufland.action).toBe('fail_safe_onhold');

    // …aber der Fehler ist ehrlich klassifiziert → Drain übernimmt:
    expect(kaufland.status).toBe('failed');
    expect(kaufland.retryable).toBe(true);
    expect(kaufland.error).toContain('504');
  });

  it('erfolgreicher updateUnit bleibt success (kein Overblocking)', async () => {
    const { results } = await syncStockToAllChannels({
      tenantId: 'default', product: kauflandProduct(5), reason: 'test',
    });
    expect(kauflandResult(results).status).toBe('success');
    expect(setUnitStatusCalls.length).toBe(0);
  });
});
