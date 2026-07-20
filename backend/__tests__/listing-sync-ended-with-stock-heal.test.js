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

describe('healEndedListingsWithStock — Safety-Net für beendet-trotz-Bestand', () => {
  beforeEach(() => {
    syncCalls.length = 0;
    markerUpdates.length = 0;
    markerProducts = [];
  });

  it('stößt den Relist-Sync für Marker-Produkte mit Bestand an (nur eBay-Kanal)', async () => {
    markerProducts = [{
      id: 'prod-1',
      tenantId: 'default',
      identification: { sku: 'SKU-6656556112' },
      inventory: { quantity: 1 },
      ops: { ebay: { zeroStockEnd: { itemId: '800339004471', at: '2026-07-19T17:25:26Z' } } },
    }];

    await healEndedListingsWithStock();

    expect(syncCalls.length).toBe(1);
    expect(syncCalls[0].product.id).toBe('prod-1');
    expect(syncCalls[0].reason).toBe('ended-with-stock-heal');
    expect(syncCalls[0].onlyChannels).toEqual(['ebay']);
  });

  it('überspringt Marker-Produkte ohne verkäuflichen Bestand (legitim beendet)', async () => {
    markerProducts = [{
      id: 'prod-2',
      tenantId: 'default',
      inventory: { quantity: 1 },
      _testReserved: 1, // available = 0
      ops: { ebay: { zeroStockEnd: { itemId: 'X', at: '2026-07-19T00:00:00Z' } } },
    }];

    await healEndedListingsWithStock();
    expect(syncCalls.length).toBe(0);
  });

  it('überspringt fremde Tenants', async () => {
    markerProducts = [{
      id: 'prod-3',
      tenantId: 'other-tenant',
      inventory: { quantity: 5 },
      ops: { ebay: { zeroStockEnd: { itemId: 'X', at: '2026-07-19T00:00:00Z' } } },
    }];

    await healEndedListingsWithStock();
    expect(syncCalls.length).toBe(0);
  });

  it('lässt >90 Tage alte Marker ohne Bestand verfallen (Relist-Fenster vorbei — Query darf nicht zumüllen)', async () => {
    markerProducts = [{
      id: 'prod-old',
      tenantId: 'default',
      inventory: { quantity: 0 },
      ops: { ebay: { zeroStockEnd: { itemId: 'X', at: '2026-01-01T00:00:00Z' } } },
    }];

    await healEndedListingsWithStock();

    expect(syncCalls.length).toBe(0);
    const expired = markerUpdates.find((u) => u.id === 'prod-old' && u.payload['ops.ebay.zeroStockEnd'] === null);
    expect(expired).toBeTruthy();
    expect(expired.payload['ops.ebay.zeroStockEndExpiredAt']).toBeTruthy();
  });

  it('frischer Marker ohne Bestand bleibt stehen (für später)', async () => {
    markerProducts = [{
      id: 'prod-fresh',
      tenantId: 'default',
      inventory: { quantity: 1 },
      _testReserved: 1,
      ops: { ebay: { zeroStockEnd: { itemId: 'X', at: new Date().toISOString() } } },
    }];

    await healEndedListingsWithStock();
    expect(syncCalls.length).toBe(0);
    expect(markerUpdates.length).toBe(0);
  });

  it('cappt auf max 10 Heals pro Zyklus', async () => {
    markerProducts = Array.from({ length: 15 }, (_, i) => ({
      id: `prod-${i}`,
      tenantId: 'default',
      inventory: { quantity: 1 },
      ops: { ebay: { zeroStockEnd: { itemId: `I${i}`, at: '2026-07-19T00:00:00Z' } } },
    }));

    await healEndedListingsWithStock();
    expect(syncCalls.length).toBe(10);
  });
});
