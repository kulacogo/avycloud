// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// Regression-Test fuer CLAUDE.md Punkt 13 (Stock Single Writer Invariant).
// Verhindert das Doppel-Decrement-Szenario, das am 2026-04-29 mit
// SKU-0000108900 und SKU-0000041030 zur Listing-Beendigung trotz
// physisch noch vorhandener Einheit fuehrte.
//
// Zwei Test-Suiten:
//   A) Unit-Test fuer `claimOrderStockDecrementInTx` (Helper, isoliert)
//   B) Integration: `processShippedOrder` skipped Phase A wenn Pick-Flow
//      bereits geclaimt hat (stockDecrementedBy='pick').

const path = require('path');

// ─── A) Unit-Test fuer claimOrderStockDecrementInTx ──────────────────────

describe('claimOrderStockDecrementInTx (lib/order-stock-claim.js)', () => {
  // Lazy-load to avoid any cross-test require.cache pollution.
  let claimOrderStockDecrementInTx;
  beforeAll(() => {
    ({ claimOrderStockDecrementInTx } = require('../lib/order-stock-claim'));
  });

  function makeTx({ existingData = null, exists = true } = {}) {
    const update = vi.fn();
    const get = vi.fn().mockResolvedValue({
      exists,
      data: () => existingData,
    });
    return {
      update,
      get,
      tx: { get, update, set: vi.fn() },
    };
  }

  it('claims when stockDecrementedAt is not set', async () => {
    const { tx, update } = makeTx({ existingData: { items: [{ sku: 'SKU-A' }] } });
    const orderRef = { id: 'order-1' };
    const result = await claimOrderStockDecrementInTx({
      tx,
      orderRef,
      by: 'pick',
      skus: ['SKU-A'],
      nowIso: '2026-04-29T10:00:00.000Z',
    });
    expect(result.claimed).toBe(true);
    expect(result.alreadyClaimed).toBe(false);
    expect(result.by).toBe('pick');
    expect(update).toHaveBeenCalledWith(orderRef, {
      stockDecrementedAt: '2026-04-29T10:00:00.000Z',
      stockDecrementedBy: 'pick',
      stockDecrementedSkus: ['SKU-A'],
    });
  });

  it('does NOT claim when stockDecrementedAt already set (returns alreadyClaimed)', async () => {
    const { tx, update } = makeTx({
      existingData: {
        stockDecrementedAt: '2026-04-29T05:00:00.000Z',
        stockDecrementedBy: 'pick',
      },
    });
    const orderRef = { id: 'order-2' };
    const result = await claimOrderStockDecrementInTx({
      tx,
      orderRef,
      by: 'ship',
      skus: ['SKU-X'],
    });
    expect(result.claimed).toBe(false);
    expect(result.alreadyClaimed).toBe(true);
    expect(result.at).toBe('2026-04-29T05:00:00.000Z');
    expect(result.by).toBe('pick');
    expect(update).not.toHaveBeenCalled();
  });

  it('returns reason=order-not-found when order does not exist', async () => {
    const { tx, update } = makeTx({ exists: false });
    const result = await claimOrderStockDecrementInTx({
      tx,
      orderRef: { id: 'missing' },
      by: 'pick',
      skus: [],
    });
    expect(result.claimed).toBe(false);
    expect(result.alreadyClaimed).toBe(false);
    expect(result.reason).toBe('order-not-found');
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects invalid by-Wert', async () => {
    const { tx } = makeTx();
    await expect(
      claimOrderStockDecrementInTx({ tx, orderRef: { id: 'x' }, by: 'manual' })
    ).rejects.toThrow(/invalid by/);
  });

  it('rejects missing tx/orderRef', async () => {
    await expect(claimOrderStockDecrementInTx({ orderRef: {}, by: 'pick' })).rejects.toThrow(/invalid tx/);
    const { tx } = makeTx();
    await expect(claimOrderStockDecrementInTx({ tx, by: 'pick' })).rejects.toThrow(/orderRef missing/);
  });

  it('handles missing skus argument gracefully', async () => {
    const { tx, update } = makeTx({ existingData: {} });
    const orderRef = { id: 'order-3' };
    const result = await claimOrderStockDecrementInTx({
      tx,
      orderRef,
      by: 'pick',
      nowIso: '2026-04-29T10:00:00.000Z',
    });
    expect(result.claimed).toBe(true);
    expect(update).toHaveBeenCalledWith(orderRef, {
      stockDecrementedAt: '2026-04-29T10:00:00.000Z',
      stockDecrementedBy: 'pick',
      stockDecrementedSkus: [],
    });
  });
});

// ─── B) Integration: processShippedOrder skipped Phase A bei Pick-Claim ──

// Mock setup analog zu stock-shipped-idempotency.test.js
const mockOrderUpdate = vi.fn().mockResolvedValue();
const mockOrderGet = vi.fn();
const mockCollectionAdd = vi.fn().mockResolvedValue();
const mockQueryGet = vi.fn().mockResolvedValue({
  empty: false,
  docs: [{ id: 'prod-1', data: () => ({ id: 'prod-1', identification: { sku: 'SKU-PICK' } }) }],
});

const mockFirestore = {
  collection: vi.fn((name) => {
    if (name === 'orders') {
      return {
        doc: vi.fn(() => ({ get: mockOrderGet, update: mockOrderUpdate })),
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
      return { doc: vi.fn(() => ({ set: vi.fn() })) };
    }
    return {
      doc: vi.fn(() => ({ get: vi.fn().mockResolvedValue({ exists: false }), set: vi.fn() })),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      get: vi.fn().mockResolvedValue({ empty: true, docs: [] }),
      add: vi.fn().mockResolvedValue(),
    };
  }),
  runTransaction: vi.fn(async (cb) => {
    const tx = {
      get: () => mockOrderGet(),
      update: (_ref, data) => mockOrderUpdate(data),
      set: vi.fn(),
    };
    return await cb(tx);
  }),
};

const mockFieldValueDelete = Symbol('FieldValue.delete');

function MockFirestore() { return mockFirestore; }
const firestorePath = require.resolve('@google-cloud/firestore');
require.cache[firestorePath] = {
  id: firestorePath, filename: firestorePath, loaded: true, children: [], paths: [],
  exports: {
    Firestore: MockFirestore,
    FieldValue: { serverTimestamp: vi.fn(), delete: vi.fn(() => mockFieldValueDelete) },
  },
};

const adminPath = require.resolve('firebase-admin');
require.cache[adminPath] = {
  id: adminPath, filename: adminPath, loaded: true, children: [], paths: [],
  exports: { initializeApp: vi.fn(), credential: { applicationDefault: vi.fn() }, firestore: vi.fn(() => mockFirestore) },
};

const authPath = require.resolve('google-auth-library');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true, children: [], paths: [],
  exports: { GoogleAuth: vi.fn(() => ({ getClient: vi.fn() })) },
};

const storagePath = require.resolve('@google-cloud/storage');
require.cache[storagePath] = {
  id: storagePath, filename: storagePath, loaded: true, children: [], paths: [],
  exports: { Storage: vi.fn(() => ({ bucket: vi.fn() })) },
};

const firestoreLibPath = path.resolve(__dirname, '../lib/firestore.js');
require.cache[firestoreLibPath] = {
  id: firestoreLibPath, filename: firestoreLibPath, loaded: true, children: [], paths: [],
  exports: { firestore: mockFirestore, PRODUCTS_COLLECTION: 'products_v2' },
};

const mockDecrement = vi.fn().mockResolvedValue();
const warehousePath = path.resolve(__dirname, '../lib/warehouse.js');
require.cache[warehousePath] = {
  id: warehousePath, filename: warehousePath, loaded: true, children: [], paths: [],
  exports: { decrementProductByIdOrSku: mockDecrement },
};

const stockLockPath = path.resolve(__dirname, '../lib/stock-lock.js');
require.cache[stockLockPath] = {
  id: stockLockPath, filename: stockLockPath, loaded: true, children: [], paths: [],
  exports: { withStockLock: vi.fn((key, fn) => fn()), acquireStockLock: vi.fn() },
};

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

const trackingPath = path.resolve(__dirname, '../services/marketplace-tracking.js');
require.cache[trackingPath] = {
  id: trackingPath, filename: trackingPath, loaded: true, children: [], paths: [],
  exports: {
    pushTrackingToMarketplace: vi.fn().mockResolvedValue({ ok: true }),
    ensureMarketplaceTrackingPushed: vi.fn().mockResolvedValue(),
    pushCancellationToMarketplace: vi.fn().mockResolvedValue({ ok: true }),
  },
};

const invoicePath = path.resolve(__dirname, '../services/invoice-engine.js');
require.cache[invoicePath] = {
  id: invoicePath, filename: invoicePath, loaded: true, children: [], paths: [],
  exports: { generateInvoice: vi.fn().mockResolvedValue({}) },
};

const errorCollectorPath = path.resolve(__dirname, '../lib/error-collector.js');
require.cache[errorCollectorPath] = {
  id: errorCollectorPath, filename: errorCollectorPath, loaded: true, children: [], paths: [],
  exports: { collectError: vi.fn() },
};

const { processShippedOrder } = require('../services/order-state-machine');

describe('processShippedOrder skips Phase A when Pick-Flow already claimed (CLAUDE.md Punkt 13)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips decrementProductByIdOrSku when stockDecrementedAt set by pick-flow', async () => {
    // Order wurde bereits beim Pick (bookStockOut(meta.orderId)) geclaimt
    mockOrderGet.mockResolvedValue({
      exists: true,
      data: () => ({
        tenantId: 'default',
        items: [{ sku: 'SKU-0000108900', quantity: 1 }],
        stockDecrementedAt: '2026-04-29T07:49:18.000Z',
        stockDecrementedBy: 'pick',
        stockDecrementedSkus: ['SKU-0000108900'],
      }),
    });

    await processShippedOrder({ orderId: 'ebay__23-14548-94458', tenantId: 'default' });

    // KEIN zweiter Decrement (Phase A skipped)
    expect(mockDecrement).not.toHaveBeenCalled();
    // Marketplace-Sync laeuft trotzdem
    expect(mockSyncStockWithRetry).toHaveBeenCalled();
    // KEIN neuer Claim (Marker bleibt bestehen)
    const updateCallsWithClaim = mockOrderUpdate.mock.calls.filter(
      (call) => call[0] && Object.prototype.hasOwnProperty.call(call[0], 'stockDecrementedAt')
    );
    expect(updateCallsWithClaim).toHaveLength(0);
  });

  it('still decrements when no claim exists (normal ship-flow)', async () => {
    mockOrderGet.mockResolvedValue({
      exists: true,
      data: () => ({
        tenantId: 'default',
        items: [{ sku: 'SKU-NORMAL', quantity: 1 }],
        // KEIN stockDecrementedAt → ship-flow muss decrementieren
      }),
    });

    await processShippedOrder({ orderId: 'order-normal', tenantId: 'default' });

    expect(mockDecrement).toHaveBeenCalledWith('SKU-NORMAL', 1);
    // Setzt stockDecrementedBy='ship'
    expect(mockOrderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        stockDecrementedAt: expect.any(String),
        stockDecrementedBy: 'ship',
        stockDecrementedSkus: ['SKU-NORMAL'],
      })
    );
  });

  it('marketplace-sync runs once even if pick already claimed (idempotent re-trigger)', async () => {
    mockOrderGet.mockResolvedValue({
      exists: true,
      data: () => ({
        tenantId: 'default',
        items: [{ sku: 'SKU-RESYNC', quantity: 1 }],
        stockDecrementedAt: '2026-04-29T07:00:00.000Z',
        stockDecrementedBy: 'pick',
      }),
    });

    await processShippedOrder({ orderId: 'order-resync', tenantId: 'default' });

    expect(mockDecrement).not.toHaveBeenCalled();
    expect(mockSyncStockWithRetry).toHaveBeenCalledTimes(1);
    expect(mockSyncStockWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'shipped-order-resync' })
    );
  });
});
