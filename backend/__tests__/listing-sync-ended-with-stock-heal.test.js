// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// Safety-Net-Detektor (Incident 2026-07-19): healEndedListingsWithStock()
// findet Produkte mit ops.ebay.zeroStockEnd-Marker + verkäuflichem Bestand
// und stößt den Stock-Sync an (der über den Marker relistet). Produkte ohne
// Bestand bleiben unangetastet (Marker bleibt für später), fremde Tenants
// werden übersprungen.

const syncCalls = [];
const markerUpdates = [];
let markerProducts = [];

const mockFirestore = {
  collection: vi.fn((name) => {
    if (name === 'products_v2') {
      const chain = {
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        get: async () => ({
          empty: markerProducts.length === 0,
          docs: markerProducts.map((p) => ({ id: p.id, data: () => ({ ...p }) })),
        }),
        doc: vi.fn((id) => ({
          update: async (payload) => { markerUpdates.push({ id, payload }); },
        })),
      };
      return chain;
    }
    const chain = {
      where: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      get: async () => ({ empty: true, docs: [] }),
      add: vi.fn(async () => {}),
      doc: vi.fn(() => ({ get: async () => ({ exists: false }), set: async () => {}, update: async () => {} })),
    };
    return chain;
  }),
};

function patch(path, exports) {
  const resolved = require.resolve(path);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
}

patch('../lib/firestore', { firestore: mockFirestore });
patch('../services/stock-sync-dispatcher', {
  syncStockWithRetry: async (args) => { syncCalls.push(args); return { results: [] }; },
  computeAvailableQuantity: async (product) => {
    const physical = Number(product?.inventory?.quantity ?? 0);
    const reserved = Number(product?._testReserved ?? 0);
    return { physicalQty: physical, reservedQty: reserved, availableQty: Math.max(0, physical - reserved) };
  },
});
// listing-sync-runner zieht beim Laden weitere Module — die hier nicht
// gebrauchten werden auf No-ops gelegt, damit der Import nicht in echte
// Infrastruktur läuft.
patch('../lib/ebay-direct', { syncLiveListingsLight: async () => ({ skipped: true }) });
patch('../services/sync-event-bus', { bus: { emit: () => {} } });

const { healEndedListingsWithStock } = require('../services/listing-sync-runner');

describe('ausgeschaltete automatische Wiederaktivierung', () => {
  it('stößt auch mit positivem Bestand und End-Marker keinen Sync an', async () => {
    markerProducts = [{ id: 'p1', tenantId: 'default', inventory: { quantity: 5 }, ops: { ebay: { zeroStockEnd: { itemId: 'old', at: new Date().toISOString() } } } }];
    const result = await healEndedListingsWithStock();
    expect(syncCalls).toHaveLength(0);
    expect(markerUpdates).toHaveLength(0);
    expect(result).toMatchObject({ disabled: true, reason: 'manual_reactivation_required' });
  });
});
