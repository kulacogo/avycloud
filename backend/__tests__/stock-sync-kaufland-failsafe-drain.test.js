const stockQuantities = require('../lib/marketplace-stock-quantity');
stockQuantities.readLocatedQuantity = async product => stockQuantities.locatedQuantity(product);
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
// Betreiberregel 27.09.: Keine automatische Reaktivierung. Deshalb darf ein
// transienter Lesefehler erst recht kein gesundes Angebot pausieren; nur Retry.

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
    storageBins: [{ code: 'A-01', quantity: quantity }],
    ops: { kaufland: { unitId: '391413730199' } },
  };
}

const kauflandResult = (results) => results.find((r) => r.channel === 'kaufland');

describe('stock-sync: Kaufland Fehler gehen ohne Statusmutation in den Drain', () => {
  beforeEach(() => {
    setUnitStatusCalls.length = 0;
    updateUnitImpl = async () => ({ updated: true });
    setUnitStatusImpl = async () => ({ ok: true });
  });

  it('transienter updateUnit-Fehler → keine Pause, Result failed + retryable', async () => {
    updateUnitImpl = async () => { throw new Error('Kaufland API timeout (504)'); };

    const { results } = await syncStockToAllChannels({
      tenantId: 'default', product: kauflandProduct(5), reason: 'test',
    });
    const kaufland = kauflandResult(results);

    // Ein Lesefehler darf kein gesundes Angebot pausieren (CLAUDE Regel 14).
    expect(setUnitStatusCalls).toHaveLength(0);
    expect(kaufland.action).toBe('update_failed_deferred');

    // …aber der Fehler ist ehrlich klassifiziert → Drain übernimmt:
    expect(kaufland.status).toBe('failed');
    expect(kaufland.retryable).toBe(true);
    expect(kaufland.error).toContain('504');
  });

  it('inaktive Unit wird ehrlich als skipped gemeldet', async () => {
    updateUnitImpl = async () => ({ skipped: true, reason: 'manual_reactivation_required' });
    const { results } = await syncStockToAllChannels({ tenantId: 'default', product: kauflandProduct(5) });
    expect(kauflandResult(results)).toMatchObject({ status: 'skipped', action: 'manual_reactivation_required', quantityPushed: 0 });
    expect(setUnitStatusCalls).toHaveLength(0);
  });

  it('erfolgreicher updateUnit bleibt success (kein Overblocking)', async () => {
    const { results } = await syncStockToAllChannels({
      tenantId: 'default', product: kauflandProduct(5), reason: 'test',
    });
    expect(kauflandResult(results).status).toBe('success');
    expect(setUnitStatusCalls.length).toBe(0);
  });
});
