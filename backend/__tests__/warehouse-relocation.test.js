/**
 * Integration regressions for already-counted stock detached during a move.
 * Local Firestore fixture adapted from warehouse-stock-in-idempotency.test.js;
 * runs the actual warehouse implementation without production I/O.
 */

process.env.USE_PRODUCTS_V2 = 'true';
process.env.GOOGLE_CLOUD_PROJECT = 'avycloud-test';

const path = require('path');

// ─── In-Memory-Firestore ────────────────────────────────────────────────────

const store = {
  products_v2: {},
  products: {},
  warehouseBins: {},
  warehouseEvents: {},
  stock_in_claims: {},
  inventory_ledger: {},
};

let nowMs = Date.UTC(2026, 5, 5, 12, 0, 0);

const FakeTimestamp = {
  now: () => ({
    seconds: Math.floor(nowMs / 1000),
    nanoseconds: 0,
    toDate: () => new Date(nowMs),
    toMillis: () => nowMs,
  }),
  fromDate: (d) => ({
    seconds: Math.floor(d.getTime() / 1000),
    nanoseconds: 0,
    toDate: () => d,
    toMillis: () => d.getTime(),
  }),
};

function getPath(obj, dotted) {
  return String(dotted)
    .split('.')
    .reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

function setPath(obj, dotted, value) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

let autoId = 0;

function ensureColl(name) {
  if (!store[name]) store[name] = {};
  return store[name];
}

class FakeDocRef {
  constructor(collName, id) {
    this.collName = collName;
    this.id = id;
    this.path = `${collName}/${id}`;
  }

  snapshot() {
    const data = ensureColl(this.collName)[this.id];
    return {
      exists: data !== undefined,
      id: this.id,
      ref: this,
      data: () => data,
    };
  }

  async get() {
    return this.snapshot();
  }

  async set(data, opts) {
    const coll = ensureColl(this.collName);
    if (opts && opts.merge && coll[this.id]) {
      coll[this.id] = { ...coll[this.id], ...data };
    } else {
      coll[this.id] = { ...data };
    }
  }

  async update(data) {
    const coll = ensureColl(this.collName);
    if (coll[this.id] === undefined) throw new Error(`NOT_FOUND: ${this.path}`);
    const next = { ...coll[this.id] };
    for (const [key, value] of Object.entries(data)) {
      if (key.includes('.')) setPath(next, key, value);
      else next[key] = value;
    }
    coll[this.id] = next;
  }

  async delete() {
    delete ensureColl(this.collName)[this.id];
  }
}

class FakeQuery {
  constructor(collName, filters = [], lim = null) {
    this.collName = collName;
    this.filters = filters;
    this.lim = lim;
  }

  where(field, op, value) {
    return new FakeQuery(this.collName, [...this.filters, { field, op, value }], this.lim);
  }

  orderBy() { return this; }

  select() { return this; }

  limit(n) { return new FakeQuery(this.collName, this.filters, n); }

  async get() {
    const coll = ensureColl(this.collName);
    let docs = Object.keys(coll).map((id) => new FakeDocRef(this.collName, id).snapshot());
    for (const f of this.filters) {
      docs = docs.filter((d) => {
        const actual = getPath(d.data(), f.field);
        if (f.op === 'array-contains') return Array.isArray(actual) && actual.includes(f.value);
        return actual === f.value;
      });
    }
    if (this.lim !== null) docs = docs.slice(0, this.lim);
    return { docs, empty: docs.length === 0, size: docs.length, forEach: (cb) => docs.forEach(cb) };
  }
}

class FakeCollection extends FakeQuery {
  doc(id) {
    autoId += 1;
    return new FakeDocRef(this.collName, id || `auto-${autoId}`);
  }

  async add(data) {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
}

const fakeDb = {
  collection: (name) => new FakeCollection(name),
  batch: () => {
    const ops = [];
    return {
      set: (ref, data, opts) => ops.push(() => ref.set(data, opts)),
      update: (ref, data) => ops.push(() => ref.update(data)),
      delete: (ref) => ops.push(() => ref.delete()),
      commit: async () => { for (const op of ops) await op(); },
    };
  },
  runTransaction: async (fn) => {
    const writes = [];
    const tx = {
      get: async (refOrQuery) => refOrQuery.get(),
      set: (ref, data, opts) => writes.push(() => ref.set(data, opts)),
      update: (ref, data) => writes.push(() => ref.update(data)),
      delete: (ref) => writes.push(() => ref.delete()),
    };
    const result = await fn(tx);
    // Commit-Semantik: Writes landen erst NACH dem Callback (ein Early-Return
    // im Dedup-Pfad darf beweisbar nichts schreiben).
    for (const w of writes) await w();
    return result;
  },
};

function FakeFirestore() { return fakeDb; }
FakeFirestore.Timestamp = FakeTimestamp;
FakeFirestore.FieldValue = { serverTimestamp: () => null, delete: () => null, increment: (n) => n };

function patchCache(moduleName, exports) {
  let key;
  try { key = require.resolve(moduleName); } catch (_) { return; }
  require.cache[key] = { id: key, filename: key, loaded: true, exports, children: [], paths: [] };
}

patchCache('@google-cloud/firestore', {
  Firestore: FakeFirestore,
  Timestamp: FakeTimestamp,
  FieldValue: FakeFirestore.FieldValue,
});
patchCache('@google-cloud/storage', { Storage: function Storage() { return { bucket: () => ({}) }; } });
patchCache('google-auth-library', { GoogleAuth: function GoogleAuth() { return { getClient: async () => ({}) }; } });

// lib/firestore.js — getProduct/adjustPendingIntakeQuantity + firestore-Handle
const firestoreLibPath = path.resolve(__dirname, '../lib/firestore.js');
require.cache[firestoreLibPath] = {
  id: firestoreLibPath,
  filename: firestoreLibPath,
  loaded: true,
  children: [],
  paths: [],
  exports: {
    firestore: fakeDb,
    PRODUCTS_COLLECTION: 'products_v2',
    getProduct: async (id) => {
      const data = store.products_v2[id];
      return data ? { id, ...data } : null;
    },
    adjustPendingIntakeQuantity: async () => {},
  },
};

// sync-event-bus: stock:changed beobachten, ohne den echten Bus zu starten
const emitSyncEvent = vi.fn();
const busPath = path.resolve(__dirname, '../services/sync-event-bus.js');
require.cache[busPath] = {
  id: busPath,
  filename: busPath,
  loaded: true,
  children: [],
  paths: [],
  exports: { emitSyncEvent, registerSyncHandlers: () => {}, syncEventBus: { on: () => {} } },
};

const { bookStockIn, refreshProductInventory, decrementProductByIdOrSku, assignProductToBin } = require('../lib/warehouse');

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ACTOR = { uid: 'user-1', email: 'lager@trendocean.de' };

function seedProduct(id, sku, { pendingIntake = 10 } = {}) {
  store.products_v2[id] = {
    id,
    tenantId: 'default',
    identification: { sku, name: `Artikel ${sku}` },
    details: { identifiers: { sku }, images: [] },
    inventory: { quantity: 0 },
    ops: { pending_intake_quantity: pendingIntake },
    storage: null,
    storageBins: [],
  };
}

function seedBin(code) {
  store.warehouseBins[code] = {
    code,
    zone: 'S',
    etage: 'EG',
    gang: 1,
    regal: 1,
    ebene: 'A',
    products: [],
    productCount: 0,
    childBinCodes: [],
    firstStoredAt: null,
    lastStoredAt: null,
  };
}

function qtyOf(productId) {
  return store.products_v2[productId]?.inventory?.quantity;
}

function binQtyOf(binCode, productId) {
  const entry = (store.warehouseBins[binCode]?.products || []).find((p) => p.productId === productId);
  return entry ? entry.quantity : 0;
}

function stockInEvents() {
  return Object.values(store.warehouseEvents).filter((e) => e.type === 'stock_in');
}

function stow(overrides = {}) {
  const { requestId = null, sku = 'SKU-1', binCode = 'SEG0101A', quantity = 3, actor = ACTOR } = overrides;
  return bookStockIn({
    sku,
    binCode,
    quantity,
    meta: {
      source: 'api',
      action: 'stock-in',
      tenantId: 'default',
      ...(requestId ? { requestId } : {}),
      ...(actor ? { actor } : {}),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.products_v2 = {};
  store.products = {};
  store.warehouseBins = {};
  store.warehouseEvents = {};
  store.stock_in_claims = {};
  store.inventory_ledger = {};
  nowMs = Date.UTC(2026, 5, 5, 12, 0, 0);
  vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
  process.env.STOCK_LEDGER = 'true';
  delete process.env.STOCK_IN_DEDUP;
  delete process.env.STOCK_IN_DEDUP_WINDOW_SECONDS;
  seedProduct('prod-1', 'SKU-1');
  seedBin('SEG0101A');
});

afterEach(() => {
  vi.restoreAllMocks();
});


function relocated({ quantity = 5, unassigned = 4 } = {}) {
  const p = store.products_v2['prod-1'];
  p.inventory = { quantity, quantitySource: 'ledger' };
  p.ops = { pending_intake_quantity: 0, relocation: { unassignedQuantity: unassigned, operationId: 'move-1', reason: 'Umzug', updatedAt: '2026-09-22T00:00:00Z' } };
  store.warehouseEvents.baseline = { productId: 'prod-1', delta: quantity, type: 'baseline' };
  const located = quantity - unassigned;
  if (located > 0) {
    seedBin('LEG0205C');
    store.warehouseBins.LEG0205C.products = [{ productId: 'prod-1', sku: 'SKU-1', quantity: located }];
    p.storageBins = [{ code: 'LEG0205C', quantity: located }];
    p.storage = { binCode: 'LEG0205C', quantity: located };
  }
}

describe('Umzugsbestand ohne BIN', () => {
  it('lagert vorhandene Menge neutral ein und dedupliziert denselben Auftrag', async () => {
    relocated();
    await stow({ requestId: 'reloc-1', quantity: 3 });
    expect(qtyOf('prod-1')).toBe(5);
    expect(store.products_v2['prod-1'].ops.relocation.unassignedQuantity).toBe(1);
    expect(stockInEvents()[0]).toMatchObject({ delta: 0, relocatedQuantity: 3 });
    await stow({ requestId: 'reloc-1', quantity: 3 });
    expect(qtyOf('prod-1')).toBe(5);
    expect(store.products_v2['prod-1'].ops.relocation.unassignedQuantity).toBe(1);
  });
  it('bucht nur die über Umzugsbestand hinausgehende Menge neu', async () => {
    relocated();
    await stow({ requestId: 'reloc-excess', quantity: 6 });
    expect(qtyOf('prod-1')).toBe(7);
    expect(stockInEvents()[0]).toMatchObject({ delta: 2, relocatedQuantity: 4 });
    expect(store.products_v2['prod-1'].ops.relocation.unassignedQuantity).toBe(0);
  });
  it.each([
    { source: 'returns-restock', returnId: 'return-1' },
    { source: 'cancel-recredit', orderId: 'order-1' },
    { source: 'inventory', action: 'inventory-correction' },
    { source: 'api', action: 'stock-in', orderId: 'order-1', flow: 'stow' },
    { source: 'cli', flow: 'repair' },
  ])('verbraucht bei echtem Zugang keinen Umzugsbestand: %j', async (meta) => {
    relocated();
    await bookStockIn({ productId: 'prod-1', binCode: 'SEG0101A', quantity: 2, meta: { ...meta, requestId: 'real-in' } });
    expect(qtyOf('prod-1')).toBe(7);
    expect(store.products_v2['prod-1'].ops.relocation.unassignedQuantity).toBe(4);
    expect(stockInEvents()[0].delta).toBe(2);
  });
  it('erhält unzugeordnete Menge bei Projektion ohne Ledger', async () => {
    relocated();
    process.env.STOCK_LEDGER = 'false';
    await refreshProductInventory('prod-1');
    expect(qtyOf('prod-1')).toBe(5);
    expect(store.products_v2['prod-1'].storageBins).toHaveLength(1);
  });
  it('verwirft bei Ledgerfehler keine unzugeordnete Menge', async () => {
    relocated();
    const core = require('../lib/stock-core');
    vi.spyOn(core, 'sumProductLedger').mockRejectedValueOnce(new Error('ledger unavailable'));
    await expect(refreshProductInventory('prod-1')).rejects.toThrow('ledger unavailable');
    expect(qtyOf('prod-1')).toBe(5);
  });
  it('verbraucht nach vorhandenen BINs die unzugeordnete Menge beim Versand', async () => {
    relocated();
    await decrementProductByIdOrSku('prod-1', 3);
    expect(qtyOf('prod-1')).toBe(2);
    expect(store.products_v2['prod-1'].ops.relocation.unassignedQuantity).toBe(2);
    expect(Object.values(store.warehouseEvents).find(e => e.type === 'order_decrement')).toMatchObject({ delta: -3, relocatedQuantity: 2 });
    await stow({ requestId: 'post-ship-stow', quantity: 2 });
    expect(qtyOf('prod-1')).toBe(2);
  });
  it('verbraucht Umzugsbestand bei direkter BIN-Zuordnung genau einmal', async () => {
    relocated();
    await assignProductToBin('SEG0101A', 'prod-1', 3);
    expect(qtyOf('prod-1')).toBe(5);
    expect(store.products_v2['prod-1'].ops.relocation.unassignedQuantity).toBe(1);
    await assignProductToBin('SEG0101A', 'prod-1', 3);
    expect(store.products_v2['prod-1'].ops.relocation.unassignedQuantity).toBe(1);
  });
});


it('zählt BINs und unzugeordneten Umzugsbestand zusammen bei Reconciliation', () => {
  patchCache(path.resolve(__dirname, '../services/stock-sync-dispatcher.js'), {});
  const { checkBinDrift } = require('../services/stock-reconciliation');
  relocated();
  expect(checkBinDrift(store.products_v2['prod-1'])).toBeNull();
  store.products_v2['prod-1'].inventory.quantity = 6;
  expect(checkBinDrift(store.products_v2['prod-1'])).toMatchObject({ expected: 5, actual: 6, delta: -1 });
});

it('bucht nach restlosem neutralen Einlagern weitere neue Ware normal hinzu', async () => {
  relocated({ quantity: 3, unassigned: 3 });
  await stow({ requestId: 'all-moved', quantity: 3 });
  await stow({ requestId: 'fresh-stock', quantity: 2 });
  expect(qtyOf('prod-1')).toBe(5);
  expect(stockInEvents().map(e => e.delta)).toEqual([0, 2]);
});

it('bucht Versand vollständig aus Umzugsbestand ohne jeden BIN', async () => {
  relocated({ quantity: 4, unassigned: 4 });
  await decrementProductByIdOrSku('prod-1', 2);
  expect(qtyOf('prod-1')).toBe(2);
  expect(store.products_v2['prod-1'].storageBins).toEqual([]);
  expect(store.products_v2['prod-1'].ops.relocation.unassignedQuantity).toBe(2);
});

it('bricht bei ungültigem Umzugsbestand ohne Teilmutation ab', async () => {
  relocated();
  store.products_v2['prod-1'].ops.relocation.unassignedQuantity = -1;
  await expect(stow({ requestId: 'invalid', quantity: 2 })).rejects.toThrow('Ungültiger Umzugsbestand');
  expect(qtyOf('prod-1')).toBe(5);
  expect(binQtyOf('SEG0101A', 'prod-1')).toBe(0);
  expect(stockInEvents()).toHaveLength(0);
});

it('überschreibt eine parallel abgeschlossene Räumung nicht mit alten BINs', async () => {
  relocated({ quantity: 5, unassigned: 0 });
  const originalSnapshot = FakeDocRef.prototype.snapshot;
  const originalUpdate = FakeDocRef.prototype.update;
  let moved = false;
  vi.spyOn(FakeDocRef.prototype, 'snapshot').mockImplementation(function () {
    const snap = originalSnapshot.call(this);
    if (this.collName === 'products_v2') snap.updateTime = moved ? 'version-after-move' : 'version-before-move';
    return snap;
  });
  vi.spyOn(FakeDocRef.prototype, 'update').mockImplementation(async function (data, precondition) {
    if (this.collName === 'products_v2' && data.storageBins && !moved) {
      expect(precondition).toEqual({ lastUpdateTime: 'version-before-move' });
      moved = true;
      store.products_v2['prod-1'] = { ...store.products_v2['prod-1'], storage: null, storageBins: [], ops: { relocation: { unassignedQuantity: 5, operationId: 'concurrent-move' } } };
      store.warehouseBins.LEG0205C.products = [];
      const conflict = new Error('document changed'); conflict.code = 9; throw conflict;
    }
    if (this.collName === 'products_v2' && data.storageBins) {
      expect(precondition).toEqual({ lastUpdateTime: 'version-after-move' });
    }
    return originalUpdate.call(this, data);
  });
  await refreshProductInventory('prod-1');
  expect(qtyOf('prod-1')).toBe(5);
  expect(store.products_v2['prod-1'].storage).toBeNull();
  expect(store.products_v2['prod-1'].storageBins).toEqual([]);
  expect(store.products_v2['prod-1'].ops.relocation.unassignedQuantity).toBe(5);
});

it('meldet nach gebuchtem Versand keinen Projektionsfehler als erneute Entnahme zurück', async () => {
  relocated({ quantity: 4, unassigned: 4 });
  const ledgerRead = vi.spyOn(require('../lib/stock-core'), 'sumProductLedger').mockRejectedValue(new Error('ledger unavailable'));
  await decrementProductByIdOrSku('prod-1', 2);
  expect(qtyOf('prod-1')).toBe(2);
  expect(ledgerRead).not.toHaveBeenCalled();
  expect(emitSyncEvent).toHaveBeenCalledWith('stock:changed', expect.objectContaining({ before: 4, after: 2 }));
});

it('lässt gebuchten Versand auch bei Notifyfehler erfolgreich', async () => {
  relocated({ quantity: 4, unassigned: 4 });
  vi.spyOn(require('../lib/stock-change-events'), 'notifyStockChange').mockRejectedValueOnce(new Error('notify unavailable'));
  await expect(decrementProductByIdOrSku('prod-1', 2)).resolves.toBeUndefined();
  expect(qtyOf('prod-1')).toBe(2);
  expect(Object.values(store.warehouseEvents).filter(e => e.type === 'order_decrement')).toHaveLength(1);
});
