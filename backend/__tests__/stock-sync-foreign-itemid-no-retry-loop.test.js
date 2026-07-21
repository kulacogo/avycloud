// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// QUOTA-FRESSER-GUARD (2026-07-21): 4 Produkte trugen 389…-Alt-Konto-ItemIDs;
// der Zero-Stock-END darauf scheiterte mit "Auf den Artikel kann nicht
// zugegriffen werden, da entweder das Angebot entfernt wurde oder Sie nicht
// der Verkäufer sind." — das matchte weder isEndedListing noch isRateLimited
// und wurde als generischer Fehler endlos über Drain+Reconciliation retried:
// ~250 sinnlose eBay-Calls/Tag, Mitverursacher des Tageslimit-K.O.
//
// Fix: Fremd-/Entfernt-Fehler sind TERMINAL → stale Pointer bereinigen
// (clearStaleItemId), Ergebnis 'skipped' (kein Drain-Doc, kein Retry).

let endImpl = async () => ({ ack: 'Success' });
let reviseImpl = async () => ({ ack: 'Success' });
const endCalls = [];
const productUpdates = [];

const mockFirestore = {
  collection: vi.fn((name) => {
    if (name === 'products_v2') {
      return {
        doc: vi.fn((id) => ({
          get: async () => ({ exists: false }),
          set: async () => {},
          update: async (payload) => { productUpdates.push({ id, payload }); },
        })),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        get: async () => ({ empty: true, docs: [] }),
      };
    }
    const chain = {
      where: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      get: async () => ({ empty: true, docs: [] }),
      add: vi.fn(async () => {}),
      doc: vi.fn(() => ({ set: async () => {}, update: async () => {}, get: async () => ({ exists: false }) })),
    };
    return chain;
  }),
};

function patch(path, exports) {
  const resolved = require.resolve(path);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
}

patch('../lib/firestore', { firestore: mockFirestore });
patch('../lib/stock-lock', { withStockLock: async (_key, fn) => fn() });
patch('../services/stock-reservation', { getReservedQuantity: async () => 0 });
patch('../lib/ops-alert', { emitOpsAlert: () => {} });
patch('../lib/ebay-trading-api', {
  reviseFixedPriceItem: async () => reviseImpl(),
  endFixedPriceItem: async (...args) => { endCalls.push(args); return endImpl(...args); },
  relistFixedPriceItem: async () => ({ ack: 'Success', itemId: 'X' }),
});

const { syncStockToAllChannels } = require('../services/stock-sync-dispatcher');

const FOREIGN_ERR = 'Auf den Artikel kann nicht zugegriffen werden, da entweder das Angebot entfernt wurde oder Sie nicht der Verkäufer sind.';

beforeEach(() => {
  endCalls.length = 0;
  productUpdates.length = 0;
  endImpl = async () => ({ ack: 'Success' });
  reviseImpl = async () => ({ ack: 'Success' });
});

describe('Fremde/entfernte ItemIDs erzeugen KEINE Retry-Schleife mehr', () => {
  it('Zero-Stock-END auf Alt-Konto-ItemID → skipped (kein Drain-Retry) + Pointer bereinigt', async () => {
    endImpl = async () => { throw new Error(FOREIGN_ERR); };
    const product = {
      id: 'p1', tenantId: 'default',
      identification: { sku: 'SKU-ALT' },
      inventory: { quantity: 0 },
      ops: { ebay: { itemId: '389864203096' } },
    };

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product, reason: 'test' });
    const ebay = results.find((r) => r.channel === 'ebay');

    expect(ebay.status).toBe('skipped');
    expect(ebay.action).toBe('stale_pointer_cleared');
    expect(ebay.retryable).toBeUndefined();
    // Pointer wurde bereinigt → nächster Zyklus versucht es nicht erneut
    const cleared = productUpdates.find((u) => u.payload['ops.ebay.itemId'] === null);
    expect(cleared).toBeTruthy();
  });

  it('Revise auf Alt-Konto-ItemID → ebenfalls terminal skipped + bereinigt', async () => {
    reviseImpl = async () => { throw new Error(FOREIGN_ERR); };
    const product = {
      id: 'p2', tenantId: 'default',
      identification: { sku: 'SKU-ALT2' },
      inventory: { quantity: 2 },
      ops: { ebay: { itemId: '389864185033' } },
    };

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product, reason: 'test' });
    const ebay = results.find((r) => r.channel === 'ebay');

    expect(ebay.status).toBe('skipped');
    expect(ebay.action).toBe('stale_pointer_cleared');
    const cleared = productUpdates.find((u) => u.payload['ops.ebay.itemId'] === null);
    expect(cleared).toBeTruthy();
  });

  it('echte transiente END-Fehler bleiben retrybar (kein Verhaltensbruch)', async () => {
    endImpl = async () => { throw new Error('Internal error to the application'); };
    const product = {
      id: 'p3', tenantId: 'default',
      identification: { sku: 'SKU-T' },
      inventory: { quantity: 0 },
      ops: { ebay: { itemId: '800000000001' } },
    };

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product, reason: 'test' });
    const ebay = results.find((r) => r.channel === 'ebay');
    expect(ebay.status).toBe('error');
  });
});
