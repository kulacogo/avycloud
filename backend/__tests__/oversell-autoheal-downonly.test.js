// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// REGRESSION GUARD — Oversell-Incident 2026-07-11 (SKU-2510094553):
//
// Kauf bei Kaufland 08:12 → Kaufland dekrementiert seine Unit-Menge sofort
// selbst (1→0). Unser Order-Intake importierte die Bestellung erst 08:50.
// Im Fenster dazwischen sah der Auto-Heal "warehouse=1, kaufland=0", hielt
// das für einen Sync-Fehler und pushte 08:14 wieder qty=1 → das ausverkaufte
// Listing war wieder kaufbar → Zweitkauf 08:16 → Oversell.
//
// Erwartung seit Fix:
//   1. decideAutoHealPush: marketplace < available ist NIE ein Push-Grund
//      (mögliche frische Bestellung im Intake-Fenster) — nur SENKEN erlaubt.
//   2. Pro Kanal geklemmt: ein nötiger Down-Push für Kanal A darf Kanal B
//      nicht mit-pushen (Cross-Channel-Re-Arm desselben Fehlers).
//   3. Dispatcher respektiert onlyChannels: gefilterte Kanäle werden weder
//      resolved noch gepusht.

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

// ─── Mocks (vor jedem require der SUTs installieren) ────────────────────────

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

const kauflandCalls = { updateUnit: [], setUnitStatus: [] };
const ebayCalls = { revise: [] };

patchCjsModule('../lib/firestore', { firestore: mockFirestore });
patchCjsModule('../lib/stock-lock', { withStockLock: async (_key, fn) => fn() });
patchCjsModule('../services/stock-reservation', { getReservedQuantity: async () => 0 });
patchCjsModule('../lib/kaufland-api', {
  updateUnit: async (...args) => { kauflandCalls.updateUnit.push(args); return { updated: true }; },
  setUnitStatus: async (...args) => { kauflandCalls.setUnitStatus.push(args); return { ok: true }; },
});
patchCjsModule('../lib/ebay-trading-api', {
  reviseFixedPriceItem: async (...args) => { ebayCalls.revise.push(args); return { ok: true }; },
  endFixedPriceItem: async () => { throw new Error('endFixedPriceItem darf im Test nie laufen'); },
  getEbayItem: async () => ({ ok: true, quantity: 5 }),
});
// listing-sync-runner zieht ebay-direct + sync-event-bus am Modul-Top —
// für die pure decideAutoHealPush-Tests reichen leere Stubs.
patchCjsModule('../lib/ebay-direct', { syncLiveListingsLight: async () => ({}) });
patchCjsModule('../services/sync-event-bus', { bus: { on: () => {}, emit: () => {} } });

const { decideAutoHealPush } = require('../services/listing-sync-runner');
const { syncStockToAllChannels } = require('../services/stock-sync-dispatcher');

// ─── decideAutoHealPush (pure) ───────────────────────────────────────────────

describe('decideAutoHealPush — Auto-Heal darf nur SENKEN', () => {
  it('Incident-Fall: kaufland(0) < available(1) → KEIN Push (Kauf im Intake-Fenster)', () => {
    const d = decideAutoHealPush({ availableQty: 1, ebayMpQty: undefined, kauflandMpQty: 0 });
    expect(d.push).toBe(false);
  });

  it('marketplace > available → Down-Push nur für den betroffenen Kanal', () => {
    const d = decideAutoHealPush({ availableQty: 1, ebayMpQty: 3, kauflandMpQty: 1 });
    expect(d.push).toBe(true);
    expect(d.onlyChannels).toEqual(['ebay']);
    expect(d.isOversell).toBe(false);
  });

  it('Cross-Channel-Guard: ebay muss runter, kaufland ist frisch verkauft (0) → kaufland wird NICHT mitgepusht', () => {
    const d = decideAutoHealPush({ availableQty: 1, ebayMpQty: 2, kauflandMpQty: 0 });
    expect(d.push).toBe(true);
    expect(d.onlyChannels).toEqual(['ebay']);
  });

  it('available=0 und marketplace>0 → Oversell-Down-Push (beide Kanäle wenn beide >0)', () => {
    const d = decideAutoHealPush({ availableQty: 0, ebayMpQty: 2, kauflandMpQty: 1 });
    expect(d.push).toBe(true);
    expect(d.isOversell).toBe(true);
    expect(d.onlyChannels).toEqual(['ebay', 'kaufland']);
  });

  it('alles synchron → kein Push', () => {
    const d = decideAutoHealPush({ availableQty: 2, ebayMpQty: 2, kauflandMpQty: 2 });
    expect(d.push).toBe(false);
  });

  it('defensiv: ungültige availableQty → kein Push', () => {
    expect(decideAutoHealPush({ availableQty: NaN, ebayMpQty: 5, kauflandMpQty: 5 }).push).toBe(false);
    expect(decideAutoHealPush({ availableQty: -1, ebayMpQty: 5 }).push).toBe(false);
  });
});

// ─── Dispatcher: onlyChannels-Filter ─────────────────────────────────────────

function dualChannelProduct(quantity) {
  return {
    id: 'prod-downonly-1',
    tenantId: 'default',
    identification: { sku: 'SKU-DOWNONLY-1', ean: '4045516002427' },
    details: { pricing: { sellPrice: 19.99 } },
    inventory: { quantity },
    ops: {
      ebay: { itemId: '110987654321' },
      kaufland: { unitId: '391413730777' },
    },
  };
}

describe('syncStockToAllChannels — onlyChannels klemmt Kanäle', () => {
  beforeEach(() => {
    kauflandCalls.updateUnit.length = 0;
    kauflandCalls.setUnitStatus.length = 0;
    ebayCalls.revise.length = 0;
  });

  it("onlyChannels=['ebay'] → Kaufland wird weder geupdatet noch ONHOLD gesetzt", async () => {
    const res = await syncStockToAllChannels({
      tenantId: 'default',
      product: dualChannelProduct(1),
      reason: 'auto-heal',
      onlyChannels: ['ebay'],
    });
    expect(ebayCalls.revise.length).toBe(1);
    expect(kauflandCalls.updateUnit.length).toBe(0);
    expect(kauflandCalls.setUnitStatus.length).toBe(0);
    expect(res.results.find((r) => r.channel === 'kaufland')).toBeUndefined();
  });

  it("onlyChannels=['kaufland'] → eBay wird nicht angefasst", async () => {
    await syncStockToAllChannels({
      tenantId: 'default',
      product: dualChannelProduct(1),
      reason: 'auto-heal',
      onlyChannels: ['kaufland'],
    });
    expect(ebayCalls.revise.length).toBe(0);
    expect(kauflandCalls.updateUnit.length).toBe(1);
  });

  it('ohne onlyChannels (Default) → beide Kanäle wie bisher', async () => {
    await syncStockToAllChannels({
      tenantId: 'default',
      product: dualChannelProduct(1),
      reason: 'stock-out',
    });
    expect(ebayCalls.revise.length).toBe(1);
    expect(kauflandCalls.updateUnit.length).toBe(1);
  });
});
