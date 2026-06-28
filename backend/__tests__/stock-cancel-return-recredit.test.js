// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// WP4 (symmetric stock re-credit) — Step 2.
//
// Verifiziert die symmetrische Bestands-Gutschrift bei Cancel/Return, GATED
// hinter STOCK_RECREDIT_ENABLED ('false' | 'shadow' | 'true').
//
// Oversell-Safety-Beweis ruht auf:
//   - NIE gutschreiben ohne vorherigen Decrement (stockDecrementedAt-Gate)
//   - HÖCHSTENS eine Gutschrift pro Order (stockRecreditedAt-Marker)
//   - NIEMALS Auto-Gutschrift einer defekten Retoure (B/C-Ware bleibt manuell)
//
// Test-Matrix:
//   (1)  cancel-before-pick → kein Credit
//   (2)  cancel-after-pick → genau ein Credit
//   (3)  cancel zweimal → idempotent, ein Credit
//   (4)  ship-then-cancel → ein Credit
//   (5)  returned-defekt (b/c_ware) → KEIN bookStockIn, kein stockRecreditedAt,
//        Pending-Grading-Marker gesetzt
//   (6)  returned-A-Ware → graded Credit einmal, Doppel-Grading idempotent
//   (7)  Re-Credit emittiert stock:changed + Ledger (via bookStockIn → notifyStockChange)
//   (8)  bookStockIn läuft innerhalb withStockLock
//   (9)  alle Credits scheitern → Claim rollback + stock_operation_failures queued
//   (10) FLAG OFF → null Verhaltensänderung (nur release + resync)
//   (11) shadow → entscheidet + loggt, aber keine Mutation/Marker
//   (12) Force-Negativliste blockt shipped→shipped und completed→picking
//   (13) label-cancel shipped→packed → Re-Credit + Decrement-Marker gelöscht

const path = require('path');

// ─── Mock-Infrastruktur (require.cache-Patching, CJS) ────────────────────

// Order-Doc-Store: simuliert Firestore-Order-State über Tx-Read/Write.
let orderStore = {};            // orderId → data
const orderUpdateCalls = [];    // { orderId, data }
const bookStockInCalls = [];    // { args }
const stockLockCalls = [];      // { key }
const failureDocs = [];         // stock_operation_failures.add() payloads
const notifyStockChangeCalls = []; // stock:changed proxy
const returnsStore = {};        // returnId → data
const returnsAdded = [];        // returns docs created/merged
let syncCalls = [];             // marketplace resync

function resetState() {
  orderStore = {};
  orderUpdateCalls.length = 0;
  bookStockInCalls.length = 0;
  stockLockCalls.length = 0;
  failureDocs.length = 0;
  notifyStockChangeCalls.length = 0;
  syncCalls.length = 0;
  for (const k of Object.keys(returnsStore)) delete returnsStore[k];
  returnsAdded.length = 0;
  productOverrides = {};
  lastProductWhereSku = null;
}

const mockFieldValueDelete = Symbol('FieldValue.delete');

function makeOrderRef(orderId) {
  return {
    id: orderId,
    get: vi.fn(async () => ({
      exists: orderStore[orderId] !== undefined,
      data: () => orderStore[orderId],
    })),
    update: vi.fn(async (data) => {
      orderUpdateCalls.push({ orderId, data });
      const cur = orderStore[orderId] || {};
      const next = { ...cur };
      for (const [k, v] of Object.entries(data)) {
        if (v === mockFieldValueDelete) delete next[k];
        else next[k] = v;
      }
      orderStore[orderId] = next;
    }),
    set: vi.fn(async (data, opts) => {
      const cur = orderStore[orderId] || {};
      orderStore[orderId] = (opts && opts.merge) ? { ...cur, ...data } : { ...data };
    }),
  };
}

function makeReturnRef(returnId) {
  return {
    id: returnId,
    get: vi.fn(async () => ({
      exists: returnsStore[returnId] !== undefined,
      data: () => returnsStore[returnId],
      ref: makeReturnRef(returnId),
    })),
    set: vi.fn(async (data, opts) => {
      const cur = returnsStore[returnId] || {};
      returnsStore[returnId] = (opts && opts.merge) ? { ...cur, ...data } : { ...data };
    }),
    update: vi.fn(async (data) => {
      const cur = returnsStore[returnId] || {};
      returnsStore[returnId] = { ...cur, ...data };
    }),
  };
}

// Optionaler per-SKU Produkt-Override (Test (14) Partial-Failure). Standard:
// jede SKU löst auf SKU-A/prod-1/BIN-A1 auf (Verhalten aller Bestands-Tests
// bleibt unverändert, da where() den SKU-Wert sonst nicht durchreicht).
let productOverrides = {}; // sku → { id, identification, storage?, storageBins? } | null (=not found)
let lastProductWhereSku = null;

function defaultProductDoc() {
  return {
    id: 'prod-1',
    data: () => ({
      id: 'prod-1',
      identification: { sku: 'SKU-A' },
      storage: { binCode: 'BIN-A1' },
      storageBins: [{ code: 'BIN-A1' }],
    }),
  };
}

const mockProductsQuery = {
  where: vi.fn((field, _op, value) => {
    // identification.sku / details.identifiers.sku → SKU-Wert für get() merken.
    if (field === 'identification.sku' || field === 'details.identifiers.sku') {
      lastProductWhereSku = value;
    }
    return mockProductsQuery;
  }),
  limit: vi.fn().mockReturnThis(),
  get: vi.fn(async () => {
    const sku = lastProductWhereSku;
    if (sku && Object.prototype.hasOwnProperty.call(productOverrides, sku)) {
      const ov = productOverrides[sku];
      if (!ov) return { empty: true, docs: [] }; // explizit "nicht gefunden"
      return { empty: false, docs: [{ id: ov.id, data: () => ov }] };
    }
    return { empty: false, docs: [defaultProductDoc()] };
  }),
};

const mockFirestore = {
  collection: vi.fn((name) => {
    if (name === 'orders') {
      return { doc: vi.fn((id) => makeOrderRef(id)) };
    }
    if (name === 'returns') {
      return {
        doc: vi.fn((id) => makeReturnRef(id || `ret-${Date.now()}`)),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        get: vi.fn(async () => ({ empty: true, docs: [] })),
        add: vi.fn(async (data) => { returnsAdded.push(data); return { id: 'ret-new' }; }),
      };
    }
    if (name === 'stock_operation_failures') {
      return { add: vi.fn(async (data) => { failureDocs.push(data); return { id: 'fail-1' }; }) };
    }
    if (name === 'products_v2') {
      return mockProductsQuery;
    }
    if (name === 'order_events') {
      return { doc: vi.fn(() => ({ set: vi.fn() })) };
    }
    if (name === 'return_events') {
      return { add: vi.fn(async () => ({ id: 'ev-1' })) };
    }
    if (name === 'warehouse_movements') {
      return { add: vi.fn(async () => ({ id: 'wm-1' })) };
    }
    return {
      doc: vi.fn((id) => makeOrderRef(id || 'x')),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      get: vi.fn(async () => ({ empty: true, docs: [] })),
      add: vi.fn(async () => ({ id: 'g-1' })),
    };
  }),
  runTransaction: vi.fn(async (cb) => {
    // Tx delegiert auf den Order-Store. Aufrufer übergibt orderRef (makeOrderRef).
    const tx = {
      get: (ref) => ref.get(),
      update: (ref, data) => ref.update(data),
      set: (ref, data, opts) => ref.set(data, opts),
    };
    return await cb(tx);
  }),
};

function MockFirestore() { return mockFirestore; }
const firestorePath = require.resolve('@google-cloud/firestore');
require.cache[firestorePath] = {
  id: firestorePath, filename: firestorePath, loaded: true, children: [], paths: [],
  exports: {
    Firestore: MockFirestore,
    FieldValue: { serverTimestamp: vi.fn(), delete: vi.fn(() => mockFieldValueDelete) },
    Timestamp: { now: vi.fn(() => ({ toDate: () => new Date('2026-06-28T00:00:00.000Z') })) },
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

// bookStockIn-Mock: registriert Aufruf + simuliert notifyStockChange (stock:changed + Ledger).
// Verhalten konfigurierbar über bookStockInBehavior().
let bookStockInShouldThrow = false;
const mockBookStockIn = vi.fn(async (args) => {
  bookStockInCalls.push(args);
  if (bookStockInShouldThrow) {
    throw new Error('bookStockIn simulated failure');
  }
  // Symmetrisch zum echten bookStockIn → refreshProductInventory → notifyStockChange.
  notifyStockChangeCalls.push({
    sku: args.sku, productId: args.productId, delta: args.quantity, source: 'warehouse.refreshProductInventory',
  });
  return { product: { id: args.productId, inventory: { quantity: args.quantity } }, bin: { code: args.binCode } };
});
const mockDecrement = vi.fn().mockResolvedValue();
const warehousePath = path.resolve(__dirname, '../lib/warehouse.js');
require.cache[warehousePath] = {
  id: warehousePath, filename: warehousePath, loaded: true, children: [], paths: [],
  exports: { bookStockIn: mockBookStockIn, decrementProductByIdOrSku: mockDecrement, refreshProductInventory: vi.fn() },
};

const stockLockPath = path.resolve(__dirname, '../lib/stock-lock.js');
require.cache[stockLockPath] = {
  id: stockLockPath, filename: stockLockPath, loaded: true, children: [], paths: [],
  exports: {
    withStockLock: vi.fn(async (key, fn) => { stockLockCalls.push({ key }); return fn(); }),
    acquireStockLock: vi.fn(),
  },
};

const stockReservationPath = path.resolve(__dirname, '../services/stock-reservation.js');
const mockReleaseReservation = vi.fn().mockResolvedValue({ released: 1 });
require.cache[stockReservationPath] = {
  id: stockReservationPath, filename: stockReservationPath, loaded: true, children: [], paths: [],
  exports: {
    reserveStock: vi.fn().mockResolvedValue({}),
    confirmReservation: vi.fn().mockResolvedValue({ confirmed: 0 }),
    releaseReservation: mockReleaseReservation,
    getReservedQuantity: vi.fn().mockResolvedValue(0),
    expireStaleReservations: vi.fn().mockResolvedValue({ expired: 0 }),
  },
};

const mockSyncStockWithRetry = vi.fn(async (args) => { syncCalls.push(args); return { results: [] }; });
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
  exports: {
    generateInvoice: vi.fn().mockResolvedValue({}),
    createCorrectionInvoice: vi.fn().mockResolvedValue({}),
  },
};

const errorCollectorPath = path.resolve(__dirname, '../lib/error-collector.js');
require.cache[errorCollectorPath] = {
  id: errorCollectorPath, filename: errorCollectorPath, loaded: true, children: [], paths: [],
  exports: { collectError: vi.fn() },
};

const htmlEntitiesPath = path.resolve(__dirname, '../lib/html-entities.js');
require.cache[htmlEntitiesPath] = {
  id: htmlEntitiesPath, filename: htmlEntitiesPath, loaded: true, children: [], paths: [],
  exports: { sanitizeText: (s) => s, validateEmail: (s) => s || null },
};

// SUT laden NACH allen Mocks.
const stateMachine = require('../services/order-state-machine');
const { processCancelledOrder, processReturnedOrder, transitionOrder, isForceForbidden } = stateMachine;
const returnsEngine = require('../services/returns-engine');

// ─── Helpers ─────────────────────────────────────────────────────────────

function seedOrder(orderId, data) {
  orderStore[orderId] = { tenantId: 'default', items: [{ sku: 'SKU-A', quantity: 1 }], ...data };
}

function withMode(mode, fn) {
  const prev = process.env.STOCK_RECREDIT_ENABLED;
  process.env.STOCK_RECREDIT_ENABLED = mode;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.STOCK_RECREDIT_ENABLED;
      else process.env.STOCK_RECREDIT_ENABLED = prev;
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
  bookStockInShouldThrow = false;
  delete process.env.STOCK_RECREDIT_ENABLED;
});

// ─── (1) cancel-before-pick → kein Credit ─────────────────────────────────

describe('WP4 re-credit: cancel before pick (never-decremented)', () => {
  it('does NOT bookStockIn when order was never decremented', async () => {
    seedOrder('o1', { /* kein stockDecrementedAt */ });
    await withMode('true', () =>
      processCancelledOrder({ orderId: 'o1', tenantId: 'default', fromStatus: 'confirmed' })
    );
    expect(mockReleaseReservation).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'o1' }));
    expect(mockBookStockIn).not.toHaveBeenCalled();
    expect(orderStore.o1.stockRecreditedAt).toBeUndefined();
  });
});

// ─── (2) cancel-after-pick → genau ein Credit ─────────────────────────────

describe('WP4 re-credit: cancel after pick (decremented)', () => {
  it('books stock back in exactly once and sets recredit marker', async () => {
    seedOrder('o2', {
      stockDecrementedAt: '2026-06-27T10:00:00.000Z',
      stockDecrementedBy: 'pick',
      stockDecrementedSkus: ['SKU-A'],
    });
    await withMode('true', () =>
      processCancelledOrder({ orderId: 'o2', tenantId: 'default', fromStatus: 'picked' })
    );
    expect(mockBookStockIn).toHaveBeenCalledTimes(1);
    expect(mockBookStockIn).toHaveBeenCalledWith(expect.objectContaining({
      sku: 'SKU-A',
      quantity: 1,
      meta: expect.objectContaining({ source: 'cancel-recredit', orderId: 'o2' }),
    }));
    expect(orderStore.o2.stockRecreditedAt).toBeTruthy();
    expect(orderStore.o2.stockRecreditedBy).toBe('cancel');
  });

  it('only credits SKUs present in stockDecrementedSkus', async () => {
    seedOrder('o2b', {
      items: [{ sku: 'SKU-A', quantity: 1 }, { sku: 'SKU-PHANTOM', quantity: 1 }],
      stockDecrementedAt: '2026-06-27T10:00:00.000Z',
      stockDecrementedBy: 'ship',
      stockDecrementedSkus: ['SKU-A'], // SKU-PHANTOM wurde NIE dekrementiert
    });
    await withMode('true', () =>
      processCancelledOrder({ orderId: 'o2b', tenantId: 'default', fromStatus: 'shipped' })
    );
    const creditedSkus = mockBookStockIn.mock.calls.map((c) => c[0].sku);
    expect(creditedSkus).toEqual(['SKU-A']);
    expect(creditedSkus).not.toContain('SKU-PHANTOM');
  });
});

// ─── (3) cancel twice → idempotent ────────────────────────────────────────

describe('WP4 re-credit: cancel twice (idempotent)', () => {
  it('credits exactly once across two cancel invocations', async () => {
    seedOrder('o3', {
      stockDecrementedAt: '2026-06-27T10:00:00.000Z',
      stockDecrementedBy: 'pick',
      stockDecrementedSkus: ['SKU-A'],
    });
    await withMode('true', async () => {
      await processCancelledOrder({ orderId: 'o3', tenantId: 'default', fromStatus: 'picked' });
      await processCancelledOrder({ orderId: 'o3', tenantId: 'default', fromStatus: 'cancelled' });
    });
    expect(mockBookStockIn).toHaveBeenCalledTimes(1);
  });
});

// ─── (4) ship-then-cancel → ein Credit ────────────────────────────────────

describe('WP4 re-credit: ship then cancel', () => {
  it('credits once when a shipped (ship-decremented) order is cancelled', async () => {
    seedOrder('o4', {
      stockDecrementedAt: '2026-06-27T12:00:00.000Z',
      stockDecrementedBy: 'ship',
      stockDecrementedSkus: ['SKU-A'],
    });
    await withMode('true', () =>
      processCancelledOrder({ orderId: 'o4', tenantId: 'default', fromStatus: 'shipped' })
    );
    expect(mockBookStockIn).toHaveBeenCalledTimes(1);
    expect(orderStore.o4.stockRecreditedBy).toBe('cancel');
  });
});

// ─── (5) returned-defekt → KEIN bookStockIn ───────────────────────────────

describe('WP4 re-credit: defective return (oversell guard)', () => {
  it('NEVER books stock in and sets only the pending-grading marker', async () => {
    seedOrder('o5', {
      stockDecrementedAt: '2026-06-27T10:00:00.000Z',
      stockDecrementedBy: 'pick',
      stockDecrementedSkus: ['SKU-A'],
    });
    await withMode('true', () =>
      processReturnedOrder({ orderId: 'o5', tenantId: 'default', fromStatus: 'shipped' })
    );
    expect(mockBookStockIn).not.toHaveBeenCalled();
    // stockDecrementedAt MUSS gesetzt bleiben (nichts darf hinter unserem Rücken gutschreiben)
    expect(orderStore.o5.stockDecrementedAt).toBeTruthy();
    // KEIN stockRecreditedAt (sellable qty unverändert)
    expect(orderStore.o5.stockRecreditedAt).toBeUndefined();
    // Neutraler Pending-Grading-Marker gesetzt
    expect(orderStore.o5.stockReturnPendingGradingAt).toBeTruthy();
    // KEIN Marketplace-Resync (sellable unverändert)
    expect(mockSyncStockWithRetry).not.toHaveBeenCalled();
  });

  it('ensures a returns doc exists for grading', async () => {
    seedOrder('o5b', {
      stockDecrementedAt: '2026-06-27T10:00:00.000Z',
      stockDecrementedBy: 'pick',
      stockDecrementedSkus: ['SKU-A'],
    });
    await withMode('true', () =>
      processReturnedOrder({ orderId: 'o5b', tenantId: 'default', fromStatus: 'delivered' })
    );
    // Ein returns-Doc wurde verlinkt/angelegt (add oder set mit orderId)
    const created = returnsAdded.some((r) => r.orderId === 'o5b')
      || Object.values(returnsStore).some((r) => r && r.orderId === 'o5b');
    expect(created).toBe(true);
  });
});

// ─── (6) returned-A-Ware → graded credit once ─────────────────────────────

describe('WP4 re-credit: graded A-ware return', () => {
  it('credits once on A-ware grading and is idempotent on double-grade', async () => {
    seedOrder('o6', {
      items: [{ sku: 'SKU-A', quantity: 1, name: 'Widget' }],
      stockDecrementedAt: '2026-06-27T10:00:00.000Z',
      stockDecrementedBy: 'pick',
      stockDecrementedSkus: ['SKU-A'],
    });
    returnsStore['r6'] = { orderId: 'o6', tenantId: 'default', product: { sku: 'SKU-A' } };

    await withMode('true', async () => {
      await returnsEngine.restockItem({ returnId: 'r6', orderId: 'o6', itemCondition: 'a_ware', tenantId: 'default' });
      await returnsEngine.restockItem({ returnId: 'r6', orderId: 'o6', itemCondition: 'a_ware', tenantId: 'default' });
    });

    expect(mockBookStockIn).toHaveBeenCalledTimes(1);
    expect(orderStore.o6.stockRecreditedBy).toBe('return');
  });

  it('does NOT credit B-ware and leaves stockRecreditedAt unset', async () => {
    seedOrder('o6b', {
      items: [{ sku: 'SKU-A', quantity: 1 }],
      stockDecrementedAt: '2026-06-27T10:00:00.000Z',
      stockDecrementedBy: 'pick',
      stockDecrementedSkus: ['SKU-A'],
    });
    returnsStore['r6b'] = { orderId: 'o6b', tenantId: 'default', product: { sku: 'SKU-A' } };

    await withMode('true', () =>
      returnsEngine.restockItem({ returnId: 'r6b', orderId: 'o6b', itemCondition: 'b_ware', tenantId: 'default' })
    );

    expect(mockBookStockIn).not.toHaveBeenCalled();
    expect(orderStore.o6b.stockRecreditedAt).toBeUndefined();
  });
});

// ─── (7) credit emits stock:changed + ledger ──────────────────────────────

describe('WP4 re-credit: emits stock:changed + ledger', () => {
  it('triggers notifyStockChange via bookStockIn on cancel re-credit', async () => {
    seedOrder('o7', {
      stockDecrementedAt: '2026-06-27T10:00:00.000Z',
      stockDecrementedBy: 'pick',
      stockDecrementedSkus: ['SKU-A'],
    });
    await withMode('true', () =>
      processCancelledOrder({ orderId: 'o7', tenantId: 'default', fromStatus: 'picked' })
    );
    expect(notifyStockChangeCalls.length).toBe(1);
    expect(notifyStockChangeCalls[0].sku).toBe('SKU-A');
  });
});

// ─── (8) bookStockIn inside withStockLock ─────────────────────────────────

describe('WP4 re-credit: stock lock', () => {
  it('runs bookStockIn inside withStockLock', async () => {
    seedOrder('o8', {
      stockDecrementedAt: '2026-06-27T10:00:00.000Z',
      stockDecrementedBy: 'pick',
      stockDecrementedSkus: ['SKU-A'],
    });
    await withMode('true', () =>
      processCancelledOrder({ orderId: 'o8', tenantId: 'default', fromStatus: 'picked' })
    );
    expect(stockLockCalls.length).toBeGreaterThanOrEqual(1);
    expect(stockLockCalls[0].key).toBe('SKU-A');
    expect(mockBookStockIn).toHaveBeenCalled();
  });
});

// ─── (9) all credits fail → rollback + failure queued ─────────────────────

describe('WP4 re-credit: failure rollback', () => {
  it('rolls back the claim marker and queues stock_operation_failures when all credits fail', async () => {
    bookStockInShouldThrow = true;
    seedOrder('o9', {
      stockDecrementedAt: '2026-06-27T10:00:00.000Z',
      stockDecrementedBy: 'pick',
      stockDecrementedSkus: ['SKU-A'],
    });
    await withMode('true', () =>
      processCancelledOrder({ orderId: 'o9', tenantId: 'default', fromStatus: 'picked' })
    );
    // Claim wurde zurückgerollt → kein stockRecreditedAt mehr
    expect(orderStore.o9.stockRecreditedAt).toBeUndefined();
    // Failure persistiert für den Drain
    expect(failureDocs.length).toBe(1);
    expect(failureDocs[0]).toEqual(expect.objectContaining({
      orderId: 'o9',
      operation: 'cancel-recredit',
      status: 'pending',
    }));
  });
});

// ─── (10) FLAG OFF → zero behavior change ─────────────────────────────────

describe('WP4 re-credit: flag OFF (backward-compat pin)', () => {
  it('does NOT bookStockIn, does NOT touch markers — only release + resync', async () => {
    seedOrder('o10', {
      stockDecrementedAt: '2026-06-27T10:00:00.000Z',
      stockDecrementedBy: 'pick',
      stockDecrementedSkus: ['SKU-A'],
    });
    await withMode('false', () =>
      processCancelledOrder({ orderId: 'o10', tenantId: 'default', fromStatus: 'picked' })
    );
    expect(mockBookStockIn).not.toHaveBeenCalled();
    expect(orderStore.o10.stockRecreditedAt).toBeUndefined();
    // Decrement-Marker unangetastet
    expect(orderStore.o10.stockDecrementedAt).toBe('2026-06-27T10:00:00.000Z');
    // Heutiges Verhalten: release + resync laufen weiter
    expect(mockReleaseReservation).toHaveBeenCalled();
    expect(mockSyncStockWithRetry).toHaveBeenCalled();
  });

  it('default (env unset) behaves as flag OFF', async () => {
    seedOrder('o10b', {
      stockDecrementedAt: '2026-06-27T10:00:00.000Z',
      stockDecrementedBy: 'pick',
      stockDecrementedSkus: ['SKU-A'],
    });
    // STOCK_RECREDIT_ENABLED unset (beforeEach deletes it)
    await processCancelledOrder({ orderId: 'o10b', tenantId: 'default', fromStatus: 'picked' });
    expect(mockBookStockIn).not.toHaveBeenCalled();
    expect(orderStore.o10b.stockRecreditedAt).toBeUndefined();
  });

  it('returned handler with flag OFF does nothing extra', async () => {
    seedOrder('o10c', {
      stockDecrementedAt: '2026-06-27T10:00:00.000Z',
      stockDecrementedBy: 'pick',
      stockDecrementedSkus: ['SKU-A'],
    });
    await withMode('false', () =>
      processReturnedOrder({ orderId: 'o10c', tenantId: 'default', fromStatus: 'shipped' })
    );
    expect(orderStore.o10c.stockReturnPendingGradingAt).toBeUndefined();
    expect(mockBookStockIn).not.toHaveBeenCalled();
  });
});

// ─── (11) shadow mode → decides + logs, no mutation ───────────────────────

describe('WP4 re-credit: shadow mode', () => {
  it('logs the decision but does NOT bookStockIn or set markers', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    seedOrder('o11', {
      stockDecrementedAt: '2026-06-27T10:00:00.000Z',
      stockDecrementedBy: 'pick',
      stockDecrementedSkus: ['SKU-A'],
    });
    await withMode('shadow', () =>
      processCancelledOrder({ orderId: 'o11', tenantId: 'default', fromStatus: 'picked' })
    );
    expect(mockBookStockIn).not.toHaveBeenCalled();
    expect(orderStore.o11.stockRecreditedAt).toBeUndefined();
    const loggedShadow = logSpy.mock.calls.some((c) => String(c[0] || '').includes('[recredit-shadow]'));
    expect(loggedShadow).toBe(true);
    logSpy.mockRestore();
  });
});

// ─── (12) force-negativliste ──────────────────────────────────────────────

describe('WP4 re-credit: FORCE_FORBIDDEN_TRANSITIONS negativliste', () => {
  it('classifies shipped→shipped as forbidden', () => {
    expect(isForceForbidden('shipped', 'shipped')).toBe(true);
  });
  it('classifies completed→picking as forbidden', () => {
    expect(isForceForbidden('completed', 'picking')).toBe(true);
  });
  it('does NOT forbid legitimate force flows (e.g. pending→shipped intake)', () => {
    expect(isForceForbidden('pending', 'shipped')).toBe(false);
    expect(isForceForbidden('shipped', 'packed')).toBe(false);
    expect(isForceForbidden('confirmed', 'shipped')).toBe(false);
  });

  it('transitionOrder with force=true refuses a forbidden stock-affecting move', async () => {
    seedOrder('o12', { omsStatus: 'shipped' });
    const result = await transitionOrder({
      orderId: 'o12', toStatus: 'shipped', force: true, actor: { uid: 'u', email: 'e' },
    });
    expect(result.ok).toBe(false);
  });
});

// ─── (13) label-cancel shipped→packed ─────────────────────────────────────

describe('WP4 re-credit: label-cancel', () => {
  it('re-credits and clears decrement markers when shipped order label is cancelled', async () => {
    seedOrder('o13', {
      stockDecrementedAt: '2026-06-27T12:00:00.000Z',
      stockDecrementedBy: 'ship',
      stockDecrementedSkus: ['SKU-A'],
    });
    await withMode('true', () =>
      stateMachine.processLabelCancelled({ orderId: 'o13', tenantId: 'default', fromStatus: 'shipped' })
    );
    expect(mockBookStockIn).toHaveBeenCalledTimes(1);
    expect(orderStore.o13.stockRecreditedBy).toBe('label-cancel');
    // Decrement-Marker gelöscht, damit ein späteres Re-Ship korrekt decrementiert
    expect(orderStore.o13.stockDecrementedAt).toBeUndefined();
    expect(orderStore.o13.stockDecrementedBy).toBeUndefined();
    expect(orderStore.o13.stockDecrementedSkus).toBeUndefined();
  });

  it('label-cancel is a no-op with flag OFF', async () => {
    seedOrder('o13b', {
      stockDecrementedAt: '2026-06-27T12:00:00.000Z',
      stockDecrementedBy: 'ship',
      stockDecrementedSkus: ['SKU-A'],
    });
    await withMode('false', () =>
      stateMachine.processLabelCancelled({ orderId: 'o13b', tenantId: 'default', fromStatus: 'shipped' })
    );
    expect(mockBookStockIn).not.toHaveBeenCalled();
    expect(orderStore.o13b.stockDecrementedAt).toBe('2026-06-27T12:00:00.000Z');
  });
});

// ─── (14) partial multi-sku failure → each failed sku queued, no silent drop ──
//
// Durability-Gap (adversarial review): bei einem Partial-Multi-SKU-Failure
// (z.B. 1 von 2 SKUs scheitert) blieb der Marker `stockRecreditedAt` gesetzt
// (korrekt — der erfolgreiche Credit IST passiert), ABER der gescheiterte SKU
// wurde STILL fallengelassen — nie gequeued, vom Drain nie recoverbar.
//
// FIX: jeder gescheiterte SKU wird als EIGENES stock_operation_failures-Doc
// persistiert (sku + orderId + qty + binCode, status:'pending'). Der Marker
// bleibt gesetzt (Over-Credit-Schutz für den erfolgreichen SKU). Ein erneuter
// cancel-Event (simulierter Drain-/Webhook-Replay) bucht den erfolgreichen SKU
// NICHT erneut (Already-Recredited-Gate) → kein Doppel-Credit.

describe('WP4 re-credit: partial multi-sku failure (durability)', () => {
  it('partial multi-sku re-credit failure queues each failed sku to stock_operation_failures (no silent drop, no double-credit of the succeeded sku)', async () => {
    // SKU-A löst auf prod-1/BIN-A1 auf → bookStockIn erfolgreich.
    // SKU-B löst auf prod-2 OHNE Bin auf → _resolveRecreditBin = null →
    // 'no_known_bin' → bookStockIn wird für SKU-B NIE aufgerufen → Credit scheitert.
    productOverrides = {
      'SKU-A': {
        id: 'prod-1',
        identification: { sku: 'SKU-A' },
        storage: { binCode: 'BIN-A1' },
        storageBins: [{ code: 'BIN-A1' }],
      },
      'SKU-B': {
        id: 'prod-2',
        identification: { sku: 'SKU-B' },
        // kein storage.binCode, keine storageBins → kein bekannter Bin
      },
    };

    seedOrder('o14', {
      items: [{ sku: 'SKU-A', quantity: 1 }, { sku: 'SKU-B', quantity: 2 }],
      stockDecrementedAt: '2026-06-27T10:00:00.000Z',
      stockDecrementedBy: 'pick',
      stockDecrementedSkus: ['SKU-A', 'SKU-B'],
    });

    await withMode('true', () =>
      processCancelledOrder({ orderId: 'o14', tenantId: 'default', fromStatus: 'picked' })
    );

    // (1) Der erfolgreiche SKU wurde GENAU EINMAL gebucht.
    const bookedSkus = mockBookStockIn.mock.calls.map((c) => c[0].sku);
    expect(bookedSkus).toEqual(['SKU-A']);
    expect(mockBookStockIn).toHaveBeenCalledTimes(1);

    // (2) Der gescheiterte SKU (SKU-B) hat ein durable Failure-Doc — NICHT silently dropped.
    const skuBFailures = failureDocs.filter((d) => d.sku === 'SKU-B');
    expect(skuBFailures.length).toBe(1);
    expect(skuBFailures[0]).toEqual(expect.objectContaining({
      orderId: 'o14',
      operation: 'cancel-recredit',
      sku: 'SKU-B',
      qty: 2,
      status: 'pending',
    }));
    // recredit-Detail-Step ist vorhanden (binCode null, da Bin-Resolve scheiterte).
    const recreditStep = (skuBFailures[0].failures || []).find((f) => f.step === 'recredit');
    expect(recreditStep).toBeTruthy();
    expect(recreditStep.sku).toBe('SKU-B');
    expect(recreditStep.binCode).toBeNull();

    // (3) KEIN Failure-Doc für den erfolgreichen SKU.
    expect(failureDocs.some((d) => d.sku === 'SKU-A')).toBe(false);

    // (4) Marker bleibt gesetzt (der SKU-A-Credit IST passiert → Over-Credit-Schutz).
    expect(orderStore.o14.stockRecreditedAt).toBeTruthy();
    expect(orderStore.o14.stockRecreditedBy).toBe('cancel');

    // (5) Simulierter Drain-/Webhook-Replay des Cancel-Events: der erfolgreiche
    //     SKU darf NICHT erneut gebucht werden (Already-Recredited-Gate).
    mockBookStockIn.mockClear();
    await withMode('true', () =>
      processCancelledOrder({ orderId: 'o14', tenantId: 'default', fromStatus: 'cancelled' })
    );
    expect(mockBookStockIn).not.toHaveBeenCalled();
  });
});
