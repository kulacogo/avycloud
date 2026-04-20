// globals: true in vitest.config.js — describe/it/expect/vi are global

const path = require('path');

// ─── Mock Setup (require.cache patching for CJS) ──────────────────────

// Mock firestore
const mockOrderData = {};
const mockOrderUpdate = vi.fn().mockResolvedValue();
const mockOrderGet = vi.fn();
const mockCollectionAdd = vi.fn().mockResolvedValue();
const mockQueryGet = vi.fn().mockResolvedValue({ empty: true, docs: [] });

const mockFirestore = {
  collection: vi.fn((name) => {
    if (name === 'orders') {
      return {
        doc: vi.fn(() => ({
          get: mockOrderGet,
          update: mockOrderUpdate,
        })),
      };
    }
    if (name === 'stock_operation_failures') {
      return { add: mockCollectionAdd };
    }
    if (name === 'products_v2') {
      return {
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        get: mockQueryGet,
      };
    }
    if (name === 'order_events') {
      return {
        doc: vi.fn(() => ({ set: vi.fn() })),
      };
    }
    return {
      doc: vi.fn(() => ({ get: vi.fn().mockResolvedValue({ exists: false }), set: vi.fn() })),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      get: vi.fn().mockResolvedValue({ empty: true, docs: [] }),
      add: vi.fn().mockResolvedValue(),
    };
  }),
  // Atomic claim: delegiert tx.get() → mockOrderGet und tx.update() → mockOrderUpdate
  runTransaction: vi.fn(async (cb) => {
    const tx = {
      get: () => mockOrderGet(),
      update: (_ref, data) => mockOrderUpdate(data),
      set: vi.fn(),
    };
    return await cb(tx);
  }),
};

// FieldValue Sentinel fuer Delete-Operationen
const mockFieldValueDelete = Symbol('FieldValue.delete');

// Patch @google-cloud/firestore — Firestore must be a constructor (new Firestore())
function MockFirestore() { return mockFirestore; }
const firestorePath = require.resolve('@google-cloud/firestore');
require.cache[firestorePath] = {
  id: firestorePath, filename: firestorePath, loaded: true, children: [], paths: [],
  exports: {
    Firestore: MockFirestore,
    FieldValue: {
      serverTimestamp: vi.fn(),
      delete: vi.fn(() => mockFieldValueDelete),
    },
  },
};

// Patch firebase-admin
const adminPath = require.resolve('firebase-admin');
require.cache[adminPath] = {
  id: adminPath, filename: adminPath, loaded: true, children: [], paths: [],
  exports: {
    initializeApp: vi.fn(), credential: { applicationDefault: vi.fn() },
    firestore: vi.fn(() => mockFirestore),
  },
};

// Patch google-auth-library
const authPath = require.resolve('google-auth-library');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true, children: [], paths: [],
  exports: { GoogleAuth: vi.fn(() => ({ getClient: vi.fn() })) },
};

// Patch @google-cloud/storage
const storagePath = require.resolve('@google-cloud/storage');
require.cache[storagePath] = {
  id: storagePath, filename: storagePath, loaded: true, children: [], paths: [],
  exports: { Storage: vi.fn(() => ({ bucket: vi.fn() })) },
};

// Patch lib/firestore.js
const firestoreLibPath = path.resolve(__dirname, '../lib/firestore.js');
require.cache[firestoreLibPath] = {
  id: firestoreLibPath, filename: firestoreLibPath, loaded: true, children: [], paths: [],
  exports: { firestore: mockFirestore, PRODUCTS_COLLECTION: 'products_v2' },
};

// Patch warehouse
const mockDecrement = vi.fn().mockResolvedValue();
const warehousePath = path.resolve(__dirname, '../lib/warehouse.js');
require.cache[warehousePath] = {
  id: warehousePath, filename: warehousePath, loaded: true, children: [], paths: [],
  exports: { decrementProductByIdOrSku: mockDecrement },
};

// Patch stock-lock
const stockLockPath = path.resolve(__dirname, '../lib/stock-lock.js');
require.cache[stockLockPath] = {
  id: stockLockPath, filename: stockLockPath, loaded: true, children: [], paths: [],
  exports: {
    withStockLock: vi.fn((key, fn) => fn()),
    acquireStockLock: vi.fn(),
  },
};

// Patch stock-reservation
const stockReservationPath = path.resolve(__dirname, '../services/stock-reservation.js');
require.cache[stockReservationPath] = {
  id: stockReservationPath, filename: stockReservationPath, loaded: true, children: [], paths: [],
  exports: {
    reserveStock: vi.fn().mockResolvedValue({}),
    confirmReservation: vi.fn().mockResolvedValue({ confirmed: 0 }),
    releaseReservation: vi.fn().mockResolvedValue({}),
    getReservedQuantity: vi.fn().mockResolvedValue(0),
    expireStaleReservations: vi.fn().mockResolvedValue({ expired: 0 }),
  },
};

// Patch stock-sync-dispatcher
const mockSyncStockWithRetry = vi.fn().mockResolvedValue();
const dispatcherPath = path.resolve(__dirname, '../services/stock-sync-dispatcher.js');
require.cache[dispatcherPath] = {
  id: dispatcherPath, filename: dispatcherPath, loaded: true, children: [], paths: [],
  exports: {
    syncStockWithRetry: mockSyncStockWithRetry,
    syncStockForOrderItems: vi.fn().mockResolvedValue(),
    syncStockToAllChannels: vi.fn().mockResolvedValue(),
    computeAvailableQuantity: vi.fn().mockResolvedValue({ availableQty: 0 }),
  },
};

// Patch marketplace-tracking
const trackingPath = path.resolve(__dirname, '../services/marketplace-tracking.js');
require.cache[trackingPath] = {
  id: trackingPath, filename: trackingPath, loaded: true, children: [], paths: [],
  exports: {
    pushTrackingToMarketplace: vi.fn().mockResolvedValue({ ok: true }),
    ensureMarketplaceTrackingPushed: vi.fn().mockResolvedValue(),
    pushCancellationToMarketplace: vi.fn().mockResolvedValue({ ok: true }),
  },
};

// Patch invoice-engine
const invoicePath = path.resolve(__dirname, '../services/invoice-engine.js');
require.cache[invoicePath] = {
  id: invoicePath, filename: invoicePath, loaded: true, children: [], paths: [],
  exports: { generateInvoice: vi.fn().mockResolvedValue({}) },
};

// Patch error-collector
const errorCollectorPath = path.resolve(__dirname, '../lib/error-collector.js');
require.cache[errorCollectorPath] = {
  id: errorCollectorPath, filename: errorCollectorPath, loaded: true, children: [], paths: [],
  exports: { collectError: vi.fn() },
};

// Now load the module under test
const { processShippedOrder, transitionOrder } = require('../services/order-state-machine');

// ─── Tests ──────────────────────────────────

describe('processShippedOrder idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('decrements stock and sets stockDecrementedAt on first call', async () => {
    mockOrderGet.mockResolvedValue({
      exists: true,
      data: () => ({
        tenantId: 'default',
        items: [{ sku: 'SKU-123', quantity: 1 }],
        // NO stockDecrementedAt → first call
      }),
    });
    // Product exists so marketplace sync can find it
    mockQueryGet.mockResolvedValue({
      empty: false,
      docs: [{ id: 'prod-1', data: () => ({ id: 'prod-1' }) }],
    });

    await processShippedOrder({ orderId: 'order-1', tenantId: 'default' });

    // Should decrement
    expect(mockDecrement).toHaveBeenCalledWith('SKU-123', 1);
    // Should set stockDecrementedAt
    expect(mockOrderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        stockDecrementedAt: expect.any(String),
        stockDecrementedSkus: ['SKU-123'],
      })
    );
    // Should sync to marketplace
    expect(mockSyncStockWithRetry).toHaveBeenCalled();
  });

  it('skips decrement on second call (stockDecrementedAt already set)', async () => {
    mockOrderGet.mockResolvedValue({
      exists: true,
      data: () => ({
        tenantId: 'default',
        items: [{ sku: 'SKU-123', quantity: 1 }],
        stockDecrementedAt: '2026-04-19T12:00:00.000Z',
      }),
    });
    // Product exists so marketplace sync can find it
    mockQueryGet.mockResolvedValue({
      empty: false,
      docs: [{ id: 'prod-1', data: () => ({ id: 'prod-1' }) }],
    });

    await processShippedOrder({ orderId: 'order-1', tenantId: 'default' });

    // Should NOT decrement
    expect(mockDecrement).not.toHaveBeenCalled();
    // Should STILL sync to marketplace (always runs)
    expect(mockSyncStockWithRetry).toHaveBeenCalled();
  });

  it('marketplace sync runs even when already decremented', async () => {
    const mockProduct = { id: 'prod-1', identification: { sku: 'SKU-456' } };
    mockOrderGet.mockResolvedValue({
      exists: true,
      data: () => ({
        tenantId: 'default',
        items: [{ sku: 'SKU-456', quantity: 2 }],
        stockDecrementedAt: '2026-04-19T12:00:00.000Z',
      }),
    });
    mockQueryGet.mockResolvedValue({
      empty: false,
      docs: [{ id: 'prod-1', data: () => mockProduct }],
    });

    await processShippedOrder({ orderId: 'order-2', tenantId: 'default' });

    expect(mockDecrement).not.toHaveBeenCalled();
    expect(mockSyncStockWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'shipped-order-2' })
    );
  });

  it('persists failures in stock_operation_failures', async () => {
    mockOrderGet.mockResolvedValue({
      exists: true,
      data: () => ({
        tenantId: 'default',
        items: [{ sku: 'SKU-FAIL', quantity: 1 }],
      }),
    });
    mockDecrement.mockRejectedValue(new Error('product not found'));

    await processShippedOrder({ orderId: 'order-fail', tenantId: 'default' });

    expect(mockCollectionAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order-fail',
        operation: 'shipped',
        status: 'pending',
        failures: expect.arrayContaining([
          expect.objectContaining({ step: 'decrement', sku: 'SKU-FAIL' }),
        ]),
      })
    );
  });

  it('rolls back stockDecrementedAt claim when ALL decrements fail', async () => {
    mockOrderGet.mockResolvedValue({
      exists: true,
      data: () => ({
        tenantId: 'default',
        items: [{ sku: 'SKU-A', quantity: 1 }, { sku: 'SKU-B', quantity: 1 }],
      }),
    });
    mockDecrement.mockRejectedValue(new Error('not found'));

    const { FieldValue } = require('@google-cloud/firestore');
    await processShippedOrder({ orderId: 'order-allfail', tenantId: 'default' });

    // Flag WIRD initial via Claim gesetzt
    expect(mockOrderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ stockDecrementedAt: expect.any(String) })
    );
    // ABER: Rollback cleart das Flag via FieldValue.delete() nachdem alle Decrements fehlschlugen
    expect(mockOrderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        stockDecrementedAt: mockFieldValueDelete,
        stockDecrementedSkus: mockFieldValueDelete,
      })
    );
  });

  it('sets stockDecrementedAt when PARTIAL failure (some succeed, some fail)', async () => {
    mockOrderGet.mockResolvedValue({
      exists: true,
      data: () => ({
        tenantId: 'default',
        items: [{ sku: 'SKU-OK', quantity: 1 }, { sku: 'SKU-FAIL', quantity: 1 }],
      }),
    });
    // SKU-OK succeeds, SKU-FAIL fails
    mockDecrement
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('not found'));

    await processShippedOrder({ orderId: 'order-partial', tenantId: 'default' });

    // Claim setzt Flag auf Timestamp-String
    expect(mockOrderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ stockDecrementedAt: expect.any(String) })
    );
    // KEIN Rollback via FieldValue.delete() da mindestens 1 SKU erfolgreich war
    expect(mockOrderUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ stockDecrementedAt: mockFieldValueDelete })
    );
    // Failure wird persistiert fuer SKU-FAIL
    expect(mockCollectionAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        failures: expect.arrayContaining([
          expect.objectContaining({ sku: 'SKU-FAIL', step: 'decrement' }),
        ]),
      })
    );
  });

  it('handles double call correctly — only 1 decrement', async () => {
    // First call: no flag
    mockOrderGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        tenantId: 'default',
        items: [{ sku: 'SKU-DOUBLE', quantity: 1 }],
      }),
    });

    await processShippedOrder({ orderId: 'order-double', tenantId: 'default' });
    expect(mockDecrement).toHaveBeenCalledTimes(1);

    // Second call: flag is set
    mockOrderGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        tenantId: 'default',
        items: [{ sku: 'SKU-DOUBLE', quantity: 1 }],
        stockDecrementedAt: '2026-04-19T12:00:00.000Z',
      }),
    });

    await processShippedOrder({ orderId: 'order-double', tenantId: 'default' });
    // Still only 1 decrement total
    expect(mockDecrement).toHaveBeenCalledTimes(1);
  });
});
