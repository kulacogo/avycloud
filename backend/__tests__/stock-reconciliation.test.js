// globals: true in vitest.config.js — describe/it/expect/vi are global

// --- Mock setup ---
const mockSyncLogDocs = [];
const mockMovementDocs = [];
const mockProductDoc = { exists: true, id: 'prod-1', data: () => ({}) };

const mockQueryChain = (docs) => {
  const chain = {
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    get: vi.fn(() => Promise.resolve({
      empty: docs.length === 0,
      docs: [...docs],
    })),
  };
  return chain;
};

const mockFirestore = {
  collection: vi.fn((name) => {
    if (name === 'stock_sync_log') return mockQueryChain(mockSyncLogDocs);
    if (name === 'warehouse_movements') return mockQueryChain(mockMovementDocs);
    if (name === 'stock_reconciliation_log') {
      return { add: vi.fn(() => Promise.resolve({ id: 'log-1' })) };
    }
    if (name === 'products_v2') {
      return {
        doc: vi.fn(() => ({
          get: vi.fn(() => Promise.resolve(mockProductDoc)),
        })),
      };
    }
    return mockQueryChain([]);
  }),
};

// Patch firestore
const firestorePath = require.resolve('../lib/firestore');
const originalFirestoreCache = require.cache[firestorePath];
require.cache[firestorePath] = {
  id: firestorePath,
  filename: firestorePath,
  loaded: true,
  exports: {
    firestore: mockFirestore,
    getAllProducts: vi.fn(() => Promise.resolve([])),
  },
};

// Patch warehouse
const warehousePath = require.resolve('../lib/warehouse');
const originalWarehouseCache = require.cache[warehousePath];
require.cache[warehousePath] = {
  id: warehousePath,
  filename: warehousePath,
  loaded: true,
  exports: {
    refreshProductInventory: vi.fn(() => Promise.resolve()),
  },
};

// Patch stock-sync-dispatcher
const dispatcherPath = require.resolve('../services/stock-sync-dispatcher');
const originalDispatcherCache = require.cache[dispatcherPath];
require.cache[dispatcherPath] = {
  id: dispatcherPath,
  filename: dispatcherPath,
  loaded: true,
  exports: {
    computeAvailableQuantity: vi.fn(() => Promise.resolve({ physicalQty: 10, reservedQty: 0, availableQty: 10 })),
    syncStockToAllChannels: vi.fn(() => Promise.resolve({ results: [] })),
    findProductsBySkuChunk: vi.fn(() => Promise.resolve([])),
  },
};

const {
  checkBinDrift,
  checkMarketplaceDrift,
  reconcileRecentActivity,
} = require('../services/stock-reconciliation');

const { refreshProductInventory } = require('../lib/warehouse');
const { computeAvailableQuantity, syncStockToAllChannels } = require('../services/stock-sync-dispatcher');
const { getAllProducts } = require('../lib/firestore');

describe('stock-reconciliation', () => {
  beforeEach(() => {
    mockSyncLogDocs.length = 0;
    mockMovementDocs.length = 0;
    mockProductDoc.exists = true;
    mockProductDoc.data = () => ({
      identification: { sku: 'SKU-1' },
      inventory: { quantity: 10 },
      storageBins: [{ quantity: 10 }],
    });
    vi.clearAllMocks();
  });

  describe('checkBinDrift', () => {
    it('detects drift when inventory.quantity != sum of storageBins', () => {
      const product = {
        id: 'prod-1',
        identification: { sku: 'SKU-A' },
        inventory: { quantity: 10 },
        storageBins: [{ quantity: 7 }, { quantity: 5 }],
      };
      const drift = checkBinDrift(product);
      expect(drift).not.toBeNull();
      expect(drift.type).toBe('bin_drift');
      expect(drift.expected).toBe(12); // 7 + 5
      expect(drift.actual).toBe(10);
      expect(drift.delta).toBe(2);
    });

    it('returns null when no drift', () => {
      const product = {
        id: 'prod-1',
        inventory: { quantity: 15 },
        storageBins: [{ quantity: 10 }, { quantity: 5 }],
      };
      expect(checkBinDrift(product)).toBeNull();
    });

    it('handles product without storageBins', () => {
      const product = {
        id: 'prod-1',
        inventory: { quantity: 0 },
        storageBins: [],
      };
      expect(checkBinDrift(product)).toBeNull();
    });

    it('treats missing inventory as 0', () => {
      const product = {
        id: 'prod-1',
        storageBins: [{ quantity: 3 }],
      };
      const drift = checkBinDrift(product);
      expect(drift).not.toBeNull();
      expect(drift.expected).toBe(3);
      expect(drift.actual).toBe(0);
    });
  });

  describe('checkMarketplaceDrift', () => {
    it('detects drift when availableQty != last synced value', async () => {
      computeAvailableQuantity.mockResolvedValueOnce({ physicalQty: 10, reservedQty: 0, availableQty: 10 });
      mockSyncLogDocs.push({
        data: () => ({ productId: 'prod-1', availableQuantity: 7, createdAt: new Date().toISOString() }),
      });

      const drift = await checkMarketplaceDrift({ id: 'prod-1', identification: { sku: 'SKU-A' } }, 'default');
      expect(drift).not.toBeNull();
      expect(drift.type).toBe('marketplace_drift');
      expect(drift.expected).toBe(10);
      expect(drift.lastPushed).toBe(7);
      expect(drift.delta).toBe(3);
    });

    it('returns null when no sync_log exists', async () => {
      // mockSyncLogDocs is empty
      const drift = await checkMarketplaceDrift({ id: 'prod-1' }, 'default');
      expect(drift).toBeNull();
    });

    it('returns null when values match', async () => {
      computeAvailableQuantity.mockResolvedValueOnce({ physicalQty: 10, reservedQty: 0, availableQty: 10 });
      mockSyncLogDocs.push({
        data: () => ({ productId: 'prod-1', availableQuantity: 10, createdAt: new Date().toISOString() }),
      });

      const drift = await checkMarketplaceDrift({ id: 'prod-1' }, 'default');
      expect(drift).toBeNull();
    });

    // Vorfall 2026-10-08: ein DAUERHAFT scheiternder Kanal (eBay lehnt „W34 L34"
    // als Groesse ab — listing_config, nicht retryable) galt als Drift und wurde
    // alle 30 min erneut gepusht (1 + 4 Geschwister-Revises ≈ 240 Trading-Aufrufe
    // am Tag fuer EIN Produkt). Nur RETRYABLE Fehlschlaege (Quota, transient)
    // sind ein Drift — ein Konfigurationsfehler heilt nicht durch Wiederholung.
    it('treats a retryable (quota) channel failure in the last sync as drift', async () => {
      computeAvailableQuantity.mockResolvedValueOnce({ physicalQty: 10, reservedQty: 0, availableQty: 10 });
      mockSyncLogDocs.push({
        data: () => ({
          productId: 'prod-1', availableQuantity: 10, createdAt: new Date().toISOString(),
          results: [{ channel: 'ebay', status: 'failed', error: 'eBay Trading skipped for ReviseFixedPriceItem: exceeded usage limit (quota cooldown 120s)' }],
        }),
      });
      const drift = await checkMarketplaceDrift({ id: 'prod-1' }, 'default');
      expect(drift).not.toBeNull();
      expect(drift.lastSyncFailed).toBe(true);
    });

    it('does NOT treat a permanent listing_config failure as drift (no re-push loop)', async () => {
      computeAvailableQuantity.mockResolvedValueOnce({ physicalQty: 10, reservedQty: 0, availableQty: 10 });
      mockSyncLogDocs.push({
        data: () => ({
          productId: 'prod-1', availableQuantity: 10, createdAt: new Date().toISOString(),
          results: [
            { channel: 'ebay', status: 'failed', error: '„W34 L34“ ist kein gültiger Wert für Größe. Wählen Sie einen Wert aus den verfügbaren Optionen aus.' },
            { channel: 'ebay', status: 'failed', error: '"W34 L34" non è un valore valido per Taglia.', action: 'sibling_revise_failed' },
          ],
        }),
      });
      const drift = await checkMarketplaceDrift({ id: 'prod-1' }, 'default');
      expect(drift).toBeNull();
    });

    // Gegenlese 2026-10-08 (HIGH, 4 Pruefer): ein AUTH-Fehlschlag heilt extern
    // (Token neu verbinden) — die veraltete eBay-Menge MUSS danach nachgezogen
    // werden. Nur listing_config ist ein Dauerfehler des Listings selbst.
    it('treats an auth failure in the last sync as drift (heals after reconnect)', async () => {
      computeAvailableQuantity.mockResolvedValueOnce({ physicalQty: 0, reservedQty: 0, availableQty: 0 });
      mockSyncLogDocs.push({
        data: () => ({
          productId: 'prod-1', availableQuantity: 0, createdAt: new Date().toISOString(),
          results: [{ channel: 'ebay', status: 'error', error: 'Die Validierung des Authentifizierungs-Tokens in der API-Anforderung ist fehlgeschlagen.' }],
        }),
      });
      const drift = await checkMarketplaceDrift({ id: 'prod-1' }, 'default');
      expect(drift).not.toBeNull();
      expect(drift.lastSyncFailed).toBe(true);
    });

    it('a failure without any error text is still a drift (conservative)', async () => {
      computeAvailableQuantity.mockResolvedValueOnce({ physicalQty: 10, reservedQty: 0, availableQty: 10 });
      mockSyncLogDocs.push({
        data: () => ({ productId: 'prod-1', availableQuantity: 10, createdAt: new Date().toISOString(), results: [{ channel: 'ebay', status: 'failed' }] }),
      });
      const drift = await checkMarketplaceDrift({ id: 'prod-1' }, 'default');
      expect(drift).not.toBeNull();
    });

    it('a quantity mismatch is still a drift even when the last failure was permanent', async () => {
      computeAvailableQuantity.mockResolvedValueOnce({ physicalQty: 10, reservedQty: 0, availableQty: 4 });
      mockSyncLogDocs.push({
        data: () => ({
          productId: 'prod-1', availableQuantity: 10, createdAt: new Date().toISOString(),
          results: [{ channel: 'ebay', status: 'failed', error: '„W34 L34“ ist kein gültiger Wert für Größe.' }],
        }),
      });
      const drift = await checkMarketplaceDrift({ id: 'prod-1' }, 'default');
      expect(drift).not.toBeNull();
      expect(drift.delta).toBe(-6);
    });
  });

  describe('reconcileRecentActivity', () => {
    it('finds products from stock_sync_log in last hour', async () => {
      mockSyncLogDocs.push(
        { data: () => ({ productId: 'prod-1', createdAt: new Date().toISOString() }) },
        { data: () => ({ productId: 'prod-2', createdAt: new Date().toISOString() }) },
      );

      // Mock product reads for _runDriftChecks — no drifts
      mockProductDoc.data = () => ({
        identification: { sku: 'SKU-1' },
        inventory: { quantity: 10 },
        storageBins: [{ quantity: 10 }],
      });
      computeAvailableQuantity.mockResolvedValue({ physicalQty: 10, reservedQty: 0, availableQty: 10 });

      const result = await reconcileRecentActivity();
      // checked should include the 2 unique productIds
      expect(result.checked).toBe(2);
    });

    it('returns zeros when no activity', async () => {
      // Both collections empty
      const result = await reconcileRecentActivity();
      expect(result.checked).toBe(0);
      expect(result.driftsFound).toBe(0);
      expect(result.drifts).toEqual([]);
    });
  });
});
