/**
 * Regression test — Pick-Modul Bug 2026-05-03.
 *
 * Symptom: "Pick failed: Firestore transaction requires all reads to be
 * executed before all writes." beim Kommissionieren eines Auftrags.
 *
 * Root Cause: `bookStockOut` schrieb `tx.update(productRef)`/`tx.update(binRef)`/
 * `tx.set(warehouseEvent)` BEVOR es ueber `claimOrderStockDecrementInTx`
 * den `tx.get(orderRef)` ausfuehrte. Firestore-SDK enforced "alle Reads
 * vor allen Writes".
 *
 * Fix: `bookStockOut` liest `orderRef` jetzt parallel zu `productRef`/`binRef`
 * am Anfang der Tx und schreibt den Claim am Ende ueber `writeOrderClaimInTx`.
 *
 * Dieser Test mockt Firestore mit einer Tx-Implementation, die EXAKT die
 * Read-before-Write-Regel der echten SDK durchsetzt. Wuerde der Bug
 * jemals zurueckkommen, schlaegt dieser Test fehl bevor der Fehler die
 * Produktion erreicht.
 *
 * Siehe CLAUDE.md Punkt 13 (Stock Single Writer Invariant).
 */

'use strict';

const path = require('path');

// ─── 1. Tx-Mock mit Read-before-Write-Enforcement ─────────────────────────

const TX_RBW_ERROR =
  'Firestore transactions require all reads to be executed before all writes.';

/**
 * Erstellt eine Mock-Tx, die das echte Firestore-Verhalten simuliert:
 * jeder `tx.get` nach einem `tx.update`/`tx.set`/`tx.create`/`tx.delete`
 * wirft den exakten Produktions-Fehler.
 */
function makeStrictTx({ docs }) {
  let writes = 0;
  const calls = [];

  function lookup(refId) {
    return docs.get(refId) || { exists: false, data: () => ({}) };
  }

  return {
    get: vi.fn(async (ref) => {
      if (writes > 0) throw new Error(TX_RBW_ERROR);
      calls.push({ op: 'get', id: ref.__id });
      const snap = lookup(ref.__id);
      return {
        exists: snap.exists !== false,
        data: () => snap.data ? snap.data() : snap,
      };
    }),
    update: vi.fn((ref, patch) => {
      writes += 1;
      calls.push({ op: 'update', id: ref.__id, patch });
    }),
    set: vi.fn((ref, value) => {
      writes += 1;
      calls.push({ op: 'set', id: ref.__id, value });
    }),
    create: vi.fn((ref, value) => {
      writes += 1;
      calls.push({ op: 'create', id: ref.__id, value });
    }),
    delete: vi.fn((ref) => {
      writes += 1;
      calls.push({ op: 'delete', id: ref.__id });
    }),
    __calls: calls,
    __writes: () => writes,
  };
}

// ─── 2. Firestore-Mock mit gemeinsamem doc-Speicher ───────────────────────

const _docs = new Map();
let _capturedTx = null;

function setDoc(collectionName, docId, data) {
  _docs.set(`${collectionName}/${docId}`, { exists: true, data: () => data });
}

function clearDocs() {
  _docs.clear();
  _capturedTx = null;
}

function makeDocRef(collectionName, docId) {
  const id = docId || `auto-${Math.random().toString(36).slice(2, 8)}`;
  const fullId = `${collectionName}/${id}`;
  const ref = {
    __id: fullId,
    id,
    get: vi.fn(async () => {
      const snap = _docs.get(fullId);
      return snap ? { exists: true, data: snap.data } : { exists: false, data: () => ({}) };
    }),
    update: vi.fn(async (patch) => {
      const cur = _docs.get(fullId);
      const prev = cur ? cur.data() : {};
      _docs.set(fullId, { exists: true, data: () => ({ ...prev, ...patch }) });
    }),
    set: vi.fn(async (data) => {
      _docs.set(fullId, { exists: true, data: () => data });
    }),
  };
  return ref;
}

function makeCollection(collectionName) {
  return {
    doc: vi.fn((docId) => makeDocRef(collectionName, docId)),
    add: vi.fn(async () => ({ id: 'auto-id' })),
    where: vi.fn(function whereFn() { return this; }),
    orderBy: vi.fn(function orderByFn() { return this; }),
    limit: vi.fn(function limitFn() { return this; }),
    get: vi.fn(async () => {
      const docs = [];
      const prefix = `${collectionName}/`;
      for (const [key, snap] of _docs.entries()) {
        if (!key.startsWith(prefix)) continue;
        const id = key.slice(prefix.length);
        docs.push({
          id,
          ref: makeDocRef(collectionName, id),
          data: snap.data,
          exists: snap.exists !== false,
          get: (field) => snap.data()?.[field],
        });
      }
      return {
        docs,
        empty: docs.length === 0,
        size: docs.length,
        forEach: (cb) => docs.forEach(cb),
      };
    }),
  };
}

const mockFirestoreInstance = {
  collection: vi.fn((name) => makeCollection(name)),
  doc: vi.fn((p) => {
    const [coll, id] = String(p).split('/');
    return makeDocRef(coll, id);
  }),
  batch: vi.fn(() => ({
    set: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    commit: vi.fn(async () => []),
  })),
  runTransaction: vi.fn(async (fn) => {
    const docsSnapshot = new Map(_docs);
    const tx = makeStrictTx({ docs: docsSnapshot });
    _capturedTx = tx;
    return fn(tx);
  }),
};

function MockFirestore() { return mockFirestoreInstance; }
MockFirestore.Firestore = MockFirestore;
MockFirestore.Timestamp = {
  now: () => {
    const date = new Date('2026-05-03T07:00:00.000Z');
    return { seconds: Math.floor(date.getTime() / 1000), nanoseconds: 0, toDate: () => date };
  },
  fromDate: (d) => ({ seconds: Math.floor(d.getTime() / 1000), nanoseconds: 0, toDate: () => d }),
};
MockFirestore.FieldValue = {
  serverTimestamp: () => null,
  increment: (n) => n,
  delete: () => null,
};

// ─── 3. Patch require.cache BEFORE warehouse.js loads ─────────────────────

const firestoreNpmPath = require.resolve('@google-cloud/firestore');
require.cache[firestoreNpmPath] = {
  id: firestoreNpmPath,
  filename: firestoreNpmPath,
  loaded: true,
  children: [],
  paths: [],
  exports: {
    Firestore: MockFirestore,
    Timestamp: MockFirestore.Timestamp,
    FieldValue: MockFirestore.FieldValue,
  },
};

const firestoreLibPath = path.resolve(__dirname, '../lib/firestore.js');
require.cache[firestoreLibPath] = {
  id: firestoreLibPath,
  filename: firestoreLibPath,
  loaded: true,
  children: [],
  paths: [],
  exports: {
    getProduct: vi.fn().mockResolvedValue(null),
    adjustPendingIntakeQuantity: vi.fn().mockResolvedValue(),
    firestore: mockFirestoreInstance,
    PRODUCTS_COLLECTION: 'products',
  },
};

const stockChangeEventsPath = path.resolve(__dirname, '../lib/stock-change-events.js');
require.cache[stockChangeEventsPath] = {
  id: stockChangeEventsPath,
  filename: stockChangeEventsPath,
  loaded: true,
  children: [],
  paths: [],
  exports: { notifyStockChange: vi.fn().mockResolvedValue() },
};

// ─── 4. Load module under test ────────────────────────────────────────────

const { bookStockOut } = require('../lib/warehouse');

// ─── 5. Helpers ────────────────────────────────────────────────────────────

function seedHappyPath({ orderClaimed = false, orderExists = true } = {}) {
  clearDocs();
  // Note: USE_PRODUCTS_V2 is undefined in test env → warehouse.js uses
  // the legacy 'products' collection.
  setDoc('products', 'PROD-1', {
    id: 'PROD-1',
    identification: { sku: 'SKU-PICK-001' },
    details: { identifiers: { sku: 'SKU-PICK-001' } },
    inventory: { quantity: 5 },
    storage: {
      binCode: 'XGA0101A',
      zone: 'X',
      etage: 'GA',
      gang: 1,
      regal: 1,
      ebene: 'A',
      quantity: 5,
      assigned_at: '2026-05-01T00:00:00.000Z',
    },
    storageBins: [
      { code: 'XGA0101A', quantity: 5, zone: 'X', etage: 'GA', gang: 1, regal: 1, ebene: 'A' },
    ],
  });

  setDoc('warehouseBins', 'XGA0101A', {
    code: 'XGA0101A',
    zone: 'X',
    etage: 'GA',
    gang: 1,
    regal: 1,
    ebene: 'A',
    products: [
      { productId: 'PROD-1', sku: 'SKU-PICK-001', quantity: 5, name: 'Test Produkt' },
    ],
    productCount: 5,
  });

  if (orderExists) {
    const orderData = {
      tenantId: 'default',
      items: [{ sku: 'SKU-PICK-001', quantity: 1 }],
    };
    if (orderClaimed) {
      orderData.stockDecrementedAt = '2026-05-02T10:00:00.000Z';
      orderData.stockDecrementedBy = 'pick';
      orderData.stockDecrementedSkus = ['SKU-PICK-001'];
    }
    setDoc('orders', 'ORDER-PICK-1', orderData);
  }
}

// ─── 6. Tests ─────────────────────────────────────────────────────────────

describe('bookStockOut: Firestore-Tx Read-before-Write (Regression Pick-Bug 2026-05-03)', () => {
  beforeEach(() => {
    clearDocs();
  });

  it('führt alle tx.get-Aufrufe vor allen tx.update/tx.set-Aufrufen aus (mit meta.orderId)', async () => {
    seedHappyPath();

    await bookStockOut({
      productId: 'PROD-1',
      binCode: 'XGA0101A',
      quantity: 1,
      meta: { orderId: 'ORDER-PICK-1', source: 'api' },
    });

    expect(_capturedTx).not.toBeNull();
    const calls = _capturedTx.__calls;

    const firstWriteIdx = calls.findIndex(
      (c) => c.op === 'update' || c.op === 'set' || c.op === 'create' || c.op === 'delete'
    );
    const lastReadIdx = calls.map((c) => c.op).lastIndexOf('get');

    expect(firstWriteIdx).toBeGreaterThan(-1);
    expect(lastReadIdx).toBeGreaterThan(-1);
    expect(lastReadIdx).toBeLessThan(firstWriteIdx);
  });

  it('liest orderRef in der Read-Phase und schreibt den Claim in der Write-Phase', async () => {
    seedHappyPath();

    await bookStockOut({
      productId: 'PROD-1',
      binCode: 'XGA0101A',
      quantity: 1,
      meta: { orderId: 'ORDER-PICK-1' },
    });

    const calls = _capturedTx.__calls;
    const orderGets = calls.filter((c) => c.op === 'get' && c.id === 'orders/ORDER-PICK-1');
    const orderUpdates = calls.filter((c) => c.op === 'update' && c.id === 'orders/ORDER-PICK-1');

    expect(orderGets.length).toBe(1);
    expect(orderUpdates.length).toBe(1);
    expect(orderUpdates[0].patch).toMatchObject({
      stockDecrementedBy: 'pick',
      stockDecrementedSkus: ['SKU-PICK-001'],
    });
    expect(typeof orderUpdates[0].patch.stockDecrementedAt).toBe('string');
  });

  it('wirft NICHT mehr "Firestore transactions require all reads…" beim Pick-with-Order', async () => {
    seedHappyPath();

    await expect(
      bookStockOut({
        productId: 'PROD-1',
        binCode: 'XGA0101A',
        quantity: 1,
        meta: { orderId: 'ORDER-PICK-1' },
      })
    ).resolves.toBeDefined();
  });

  it('schreibt KEINEN neuen Claim, wenn Order bereits geclaimt ist (idempotent)', async () => {
    seedHappyPath({ orderClaimed: true });

    await bookStockOut({
      productId: 'PROD-1',
      binCode: 'XGA0101A',
      quantity: 1,
      meta: { orderId: 'ORDER-PICK-1' },
    });

    const calls = _capturedTx.__calls;
    const orderUpdates = calls.filter((c) => c.op === 'update' && c.id === 'orders/ORDER-PICK-1');
    expect(orderUpdates.length).toBe(0);
  });

  it('wirft fail-fast wenn referenzierte Order nicht existiert (HARDEN-8 2026-05-20)', async () => {
    // HARDEN-8 (2026-05-20): vor diesem Fix decrementierte bookStockOut den
    // Bestand SILENT auch wenn die als orderId angegebene Order nicht in der DB
    // existierte. Folge: orphan-decrement OHNE `stockDecrementedAt`-Marker →
    // `_onOrderShipped` decrementiert beim Ship-Trigger ein zweites Mal
    // (double-decrement, CLAUDE.md Punkt 13).
    // Nach dem Fix: fail-fast Throw mit klarer Fehlermeldung.
    seedHappyPath({ orderExists: false });

    await expect(
      bookStockOut({
        productId: 'PROD-1',
        binCode: 'XGA0101A',
        quantity: 1,
        meta: { orderId: 'ORDER-PICK-1' },
      })
    ).rejects.toThrow(/Order.*nicht gefunden.*Stock-Decrement abgebrochen/i);

    // Wichtig: kein Order-Update geschrieben (Tx wurde aborted).
    const calls = _capturedTx?.__calls || [];
    const orderUpdates = calls.filter((c) => c.op === 'update' && c.id === 'orders/ORDER-PICK-1');
    expect(orderUpdates.length).toBe(0);
  });

  it('manueller Stock-Out ohne meta.orderId triggert KEIN Order-Read und KEINEN Claim', async () => {
    seedHappyPath({ orderExists: false });

    await bookStockOut({
      productId: 'PROD-1',
      binCode: 'XGA0101A',
      quantity: 1,
      meta: { source: 'manual' },
    });

    const calls = _capturedTx.__calls;
    const orderTouches = calls.filter((c) => String(c.id || '').startsWith('orders/'));
    expect(orderTouches.length).toBe(0);
  });
});

// ─── 7. Sanity-Test: Mock-Tx selbst enforced read-before-write ────────────

describe('makeStrictTx: simuliert echte Firestore-Constraint', () => {
  it('wirft "Firestore transactions require all reads…" wenn tx.get nach tx.update kommt', async () => {
    const tx = makeStrictTx({ docs: new Map() });
    tx.update({ __id: 'a/1' }, { x: 1 });
    await expect(tx.get({ __id: 'b/1' })).rejects.toThrow(
      /Firestore transactions require all reads to be executed before all writes/i
    );
  });

  it('wirft auch wenn tx.get nach tx.set kommt', async () => {
    const tx = makeStrictTx({ docs: new Map() });
    tx.set({ __id: 'a/1' }, { x: 1 });
    await expect(tx.get({ __id: 'b/1' })).rejects.toThrow(
      /all reads to be executed before all writes/i
    );
  });

  it('akzeptiert beliebige Read-then-Write-Reihenfolge', async () => {
    const docs = new Map([['a/1', { exists: true, data: () => ({ v: 1 }) }]]);
    const tx = makeStrictTx({ docs });
    const snap = await tx.get({ __id: 'a/1' });
    expect(snap.exists).toBe(true);
    tx.update({ __id: 'a/1' }, { v: 2 });
  });
});
