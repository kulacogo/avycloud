/**
 * Regression-Test: Inventur-Abschluss BUCHT wirklich.
 *
 * `POST /api/warehouse/inventories/:id/complete` setzte bis 2026-07-30 nur
 * `status:'completed'` und zeigte die Abweichung rot an — es korrigierte weder
 * BIN noch Bestand. Die Inventur ist der einzige physische Eingang ins System
 * und war damit wirkungslos.
 *
 * Abgedeckt:
 *   - Flag `INVENTORY_COMPLETE_BOOKS` aus  → exakt heutiges Verhalten
 *   - Bin-Produkt: Zaehlwert SENKT Bestand (Oversell-relevant) → bookStockOut,
 *     `stock:changed` + Marktplatz-Push
 *   - Bin-Produkt: Zaehlwert HEBT Bestand → bookStockIn
 *   - Ledger-Produkt (`quantitySource:'ledger'`) → `adjust`-Event ueber
 *     lib/stock-ledger-correction.js, KEIN direkter inventory.quantity-Write
 *   - `complete` zweimal → keine Doppelkorrektur
 *   - Buchungsfehler → Inventur bleibt offen, Wiederholung buchbar
 */

process.env.USE_PRODUCTS_V2 = 'true';
process.env.GOOGLE_CLOUD_PROJECT = 'avycloud-test';

const path = require('path');
const express = require('express');
const request = require('supertest');

// ─── In-Memory-Firestore ────────────────────────────────────────────────────

const store = {
  products_v2: {},
  products: {},
  warehouseBins: {},
  warehouseEvents: {},
  stock_in_claims: {},
  inventory_ledger: {},
  warehouse_inventories: {},
};

const FakeTimestamp = {
  now: () => ({
    seconds: Math.floor(Date.now() / 1000),
    nanoseconds: 0,
    toDate: () => new Date(),
    toMillis: () => Date.now(),
  }),
  fromDate: (d) => ({ seconds: Math.floor(d.getTime() / 1000), nanoseconds: 0, toDate: () => d, toMillis: () => d.getTime() }),
};

function getPath(obj, dotted) {
  return String(dotted).split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
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
    return { exists: data !== undefined, id: this.id, ref: this, data: () => data };
  }

  async get() { return this.snapshot(); }

  async set(data, opts) {
    const coll = ensureColl(this.collName);
    coll[this.id] = opts && opts.merge && coll[this.id] ? { ...coll[this.id], ...data } : { ...data };
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

  async delete() { delete ensureColl(this.collName)[this.id]; }
}

class FakeQuery {
  constructor(collName, filters = [], lim = null) {
    this.collName = collName;
    this.filters = filters;
    this.lim = lim;
  }

  where(field, op, value) { return new FakeQuery(this.collName, [...this.filters, { field, op, value }], this.lim); }

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

function patchLocal(relPath, exports) {
  const abs = path.resolve(__dirname, relPath);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports, children: [], paths: [] };
}

patchLocal('../lib/firestore.js', {
  firestore: fakeDb,
  PRODUCTS_COLLECTION: 'products_v2',
  getProduct: async (id) => {
    const data = store.products_v2[id];
    return data ? { id, ...data } : null;
  },
  adjustPendingIntakeQuantity: async () => {},
});

const emitSyncEvent = vi.fn();
patchLocal('../services/sync-event-bus.js', {
  emitSyncEvent,
  registerSyncHandlers: () => {},
  syncEventBus: { on: () => {} },
});

const syncStockWithRetry = vi.fn().mockResolvedValue({ results: [{ channel: 'ebay', status: 'success' }] });
patchLocal('../services/stock-sync-dispatcher.js', {
  syncStockWithRetry,
  syncStockToAllChannels: vi.fn().mockResolvedValue({ results: [] }),
  syncStockForOrderItems: vi.fn().mockResolvedValue(),
  computeAvailableQuantity: vi.fn().mockResolvedValue({ availableQty: 0 }),
});

patchLocal('../lib/rbac.js', {
  requirePermission: () => (req, res, next) => next(),
  PERMISSIONS: {},
  hasPermission: () => true,
});

patchLocal('../services/label-printer.js', {
  buildBinLabelHtml: async () => '<html></html>',
  buildBinLabelsHtml: async () => '<html></html>',
  buildBinLabelsPdf: async () => Buffer.from(''),
});

const { router: warehouseRouter } = require('../routes/warehouse');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.user = { uid: 'user-1', email: 'lager@trendocean.de', tenantId: 'default' };
  next();
});
app.use('/api/warehouse', warehouseRouter);

// ─── Fixtures ───────────────────────────────────────────────────────────────

function seedProduct(id, sku, { quantity = 0, quantitySource = 'bins', binCode = null } = {}) {
  store.products_v2[id] = {
    id,
    tenantId: 'default',
    identification: { sku, name: `Artikel ${sku}` },
    details: { identifiers: { sku }, images: [] },
    inventory: { quantity, quantitySource },
    ops: { pending_intake_quantity: 0 },
    storage: binCode ? { binCode, quantity, zone: 'S', etage: 'EG', gang: 1, regal: 1, ebene: 'A' } : null,
    storageBins: binCode ? [{ code: binCode, quantity }] : [],
  };
}

function seedBin(code, entries = []) {
  store.warehouseBins[code] = {
    code,
    zone: 'S',
    etage: 'EG',
    gang: 1,
    regal: 1,
    ebene: 'A',
    products: entries,
    productCount: entries.reduce((sum, e) => sum + (Number(e.quantity) || 0), 0),
    childBinCodes: [],
    firstStoredAt: null,
    lastStoredAt: null,
  };
}

function seedInventory(id, counts) {
  store.warehouse_inventories[id] = {
    tenantId: 'default',
    name: 'Inventur Test',
    status: 'active',
    scope: 'full',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    counts,
    summary: { totalItems: counts.length, countedItems: counts.length, totalVariance: 0, completionPct: 0 },
  };
}

function position({ binCode, productId, sku, systemQty, countedQty }) {
  return {
    binCode,
    productId,
    sku,
    productName: `Artikel ${sku}`,
    systemQty,
    countedQty,
    variance: countedQty === null ? null : countedQty - systemQty,
    countedAt: new Date().toISOString(),
  };
}

function qtyOf(productId) { return store.products_v2[productId]?.inventory?.quantity; }
function binQtyOf(binCode, productId) {
  const entry = (store.warehouseBins[binCode]?.products || []).find((p) => p.productId === productId);
  return entry ? entry.quantity : 0;
}
function eventsOfType(type) { return Object.values(store.warehouseEvents).filter((e) => e.type === type); }
function stockChangedEvents() { return emitSyncEvent.mock.calls.filter((c) => c[0] === 'stock:changed'); }

beforeEach(() => {
  vi.clearAllMocks();
  syncStockWithRetry.mockResolvedValue({ results: [{ channel: 'ebay', status: 'success' }] });
  store.products_v2 = {};
  store.products = {};
  store.warehouseBins = {};
  store.warehouseEvents = {};
  store.stock_in_claims = {};
  store.inventory_ledger = {};
  store.warehouse_inventories = {};
  delete process.env.INVENTORY_COMPLETE_BOOKS;
  delete process.env.STOCK_LEDGER;
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Inventur-Abschluss — Flag aus (Default)', () => {
  it('aendert nichts am Bestand (exakt heutiges Verhalten)', async () => {
    seedProduct('prod-1', 'SKU-1', { quantity: 5, binCode: 'SEG0101A' });
    seedBin('SEG0101A', [{ productId: 'prod-1', sku: 'SKU-1', quantity: 5 }]);
    seedInventory('inv-off', [position({ binCode: 'SEG0101A', productId: 'prod-1', sku: 'SKU-1', systemQty: 5, countedQty: 3 })]);

    const res = await request(app).post('/api/warehouse/inventories/inv-off/complete').send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.booked).toBe(false);
    expect(res.body.variances).toHaveLength(1);
    expect(store.warehouse_inventories['inv-off'].status).toBe('completed');
    // Kein Bestands-Eingriff
    expect(qtyOf('prod-1')).toBe(5);
    expect(binQtyOf('SEG0101A', 'prod-1')).toBe(5);
    expect(Object.keys(store.warehouseEvents)).toHaveLength(0);
    expect(syncStockWithRetry).not.toHaveBeenCalled();
    expect(store.warehouse_inventories['inv-off'].counts[0].bookedAt).toBeUndefined();
  });
});

describe('Inventur-Abschluss — Flag an, Bin-Produkt', () => {
  beforeEach(() => {
    process.env.INVENTORY_COMPLETE_BOOKS = 'on';
  });

  it('SENKT den Bestand auf den Zaehlwert und pusht zum Marktplatz (Oversell-Fall)', async () => {
    seedProduct('prod-1', 'SKU-1', { quantity: 5, binCode: 'SEG0101A' });
    seedBin('SEG0101A', [{ productId: 'prod-1', sku: 'SKU-1', quantity: 5 }]);
    seedInventory('inv-down', [position({ binCode: 'SEG0101A', productId: 'prod-1', sku: 'SKU-1', systemQty: 5, countedQty: 3 })]);

    const res = await request(app).post('/api/warehouse/inventories/inv-down/complete').send({});

    expect(res.status).toBe(200);
    expect(res.body.booked).toBe(true);
    expect(res.body.bookingErrors).toEqual([]);
    expect(res.body.bookings[0]).toMatchObject({ status: 'booked', via: 'stock-out', delta: -2, productId: 'prod-1' });

    expect(qtyOf('prod-1')).toBe(3);
    expect(binQtyOf('SEG0101A', 'prod-1')).toBe(3);
    expect(eventsOfType('stock_out')).toHaveLength(1);

    // stock:changed (CLAUDE.md Punkt 10) + Marktplatz-Push
    expect(stockChangedEvents().length).toBeGreaterThanOrEqual(1);
    expect(syncStockWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'default', reason: 'inventory-correction' })
    );

    const stored = store.warehouse_inventories['inv-down'];
    expect(stored.status).toBe('completed');
    expect(stored.counts[0].bookedAt).toBeTruthy();
    expect(stored.counts[0].bookedDelta).toBe(-2);
    expect(stored.counts[0].bookedVia).toBe('stock-out');
  });

  it('HEBT den Bestand auf den Zaehlwert (Fund im Regal)', async () => {
    seedProduct('prod-2', 'SKU-2', { quantity: 2, binCode: 'SEG0101A' });
    seedBin('SEG0101A', [{ productId: 'prod-2', sku: 'SKU-2', quantity: 2 }]);
    seedInventory('inv-up', [position({ binCode: 'SEG0101A', productId: 'prod-2', sku: 'SKU-2', systemQty: 2, countedQty: 6 })]);

    const res = await request(app).post('/api/warehouse/inventories/inv-up/complete').send({});

    expect(res.status).toBe(200);
    expect(res.body.bookings[0]).toMatchObject({ status: 'booked', via: 'stock-in', delta: 4 });
    expect(qtyOf('prod-2')).toBe(6);
    expect(binQtyOf('SEG0101A', 'prod-2')).toBe(6);
    expect(eventsOfType('stock_in')).toHaveLength(1);
    expect(stockChangedEvents().length).toBeGreaterThanOrEqual(1);
  });

  it('laesst Positionen ohne Abweichung und ohne Zaehlung unberuehrt', async () => {
    seedProduct('prod-3', 'SKU-3', { quantity: 4, binCode: 'SEG0101A' });
    seedProduct('prod-4', 'SKU-4', { quantity: 1, binCode: 'SEG0101A' });
    seedBin('SEG0101A', [
      { productId: 'prod-3', sku: 'SKU-3', quantity: 4 },
      { productId: 'prod-4', sku: 'SKU-4', quantity: 1 },
    ]);
    seedInventory('inv-noop', [
      position({ binCode: 'SEG0101A', productId: 'prod-3', sku: 'SKU-3', systemQty: 4, countedQty: 4 }),
      position({ binCode: 'SEG0101A', productId: 'prod-4', sku: 'SKU-4', systemQty: 1, countedQty: null }),
    ]);

    const res = await request(app).post('/api/warehouse/inventories/inv-noop/complete').send({});

    expect(res.status).toBe(200);
    expect(res.body.bookings).toEqual([]);
    expect(Object.keys(store.warehouseEvents)).toHaveLength(0);
    expect(qtyOf('prod-3')).toBe(4);
    expect(qtyOf('prod-4')).toBe(1);
  });

  it('bucht bei zweimaligem Abschluss NICHT doppelt', async () => {
    seedProduct('prod-1', 'SKU-1', { quantity: 5, binCode: 'SEG0101A' });
    seedBin('SEG0101A', [{ productId: 'prod-1', sku: 'SKU-1', quantity: 5 }]);
    seedInventory('inv-twice', [position({ binCode: 'SEG0101A', productId: 'prod-1', sku: 'SKU-1', systemQty: 5, countedQty: 3 })]);

    const first = await request(app).post('/api/warehouse/inventories/inv-twice/complete').send({});
    expect(first.status).toBe(200);
    expect(qtyOf('prod-1')).toBe(3);

    const second = await request(app).post('/api/warehouse/inventories/inv-twice/complete').send({});
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('COMPLETED');

    expect(qtyOf('prod-1')).toBe(3);
    expect(eventsOfType('stock_out')).toHaveLength(1);
  });

  it('haelt die Inventur bei Buchungsfehler OFFEN und bucht beim Wiederholen genau einmal', async () => {
    // BIN existiert nicht → Position kann nicht gebucht werden
    seedProduct('prod-1', 'SKU-1', { quantity: 5, binCode: 'SEG0101A' });
    seedInventory('inv-err', [position({ binCode: 'SEG0101A', productId: 'prod-1', sku: 'SKU-1', systemQty: 5, countedQty: 3 })]);

    const failing = await request(app).post('/api/warehouse/inventories/inv-err/complete').send({});
    expect(failing.status).toBe(200);
    expect(failing.body.status).toBe('active');
    expect(failing.body.bookingErrors).toHaveLength(1);
    expect(store.warehouse_inventories['inv-err'].status).toBe('active');
    expect(store.warehouse_inventories['inv-err'].counts[0].bookedAt).toBeUndefined();

    // BIN nachgetragen → Wiederholung bucht
    seedBin('SEG0101A', [{ productId: 'prod-1', sku: 'SKU-1', quantity: 5 }]);
    const retry = await request(app).post('/api/warehouse/inventories/inv-err/complete').send({});
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('completed');
    expect(qtyOf('prod-1')).toBe(3);
    expect(eventsOfType('stock_out')).toHaveLength(1);
  });
});

describe('Inventur-Abschluss — Flag an, Ledger-Produkt (quantitySource=ledger)', () => {
  beforeEach(() => {
    process.env.INVENTORY_COMPLETE_BOOKS = 'on';
    process.env.STOCK_LEDGER = 'true';
  });

  it('korrigiert ueber ein adjust-Event, nicht per direktem inventory.quantity-Write', async () => {
    seedProduct('prod-led', 'SKU-LED', { quantity: 5, quantitySource: 'ledger', binCode: 'SEG0101A' });
    seedBin('SEG0101A', [{ productId: 'prod-led', sku: 'SKU-LED', quantity: 5 }]);
    // Ledger-Historie: +5 (Erstbefuellung)
    store.warehouseEvents['evt-seed'] = { type: 'stock_in', productId: 'prod-led', delta: 5, quantityAfter: 5 };
    seedInventory('inv-led', [position({ binCode: 'SEG0101A', productId: 'prod-led', sku: 'SKU-LED', systemQty: 5, countedQty: 3 })]);

    const res = await request(app).post('/api/warehouse/inventories/inv-led/complete').send({});

    expect(res.status).toBe(200);
    expect(res.body.bookings[0]).toMatchObject({ status: 'booked', via: 'ledger-adjust', delta: -2 });

    // adjust-Event mit deterministischem Idempotenz-Key
    const adjusts = eventsOfType('adjust');
    expect(adjusts).toHaveLength(1);
    expect(adjusts[0].delta).toBe(-2);
    expect(adjusts[0].idempotencyKey).toBe('adjust:inventory:inv-led:SEG0101A:prod-led');

    // Projektion kommt jetzt aus dem Ledger (Σ = 5 − 2 = 3)
    expect(qtyOf('prod-led')).toBe(3);
    expect(store.products_v2['prod-led'].inventory.quantitySource).toBe('ledger');

    // stock:changed + Marktplatz-Push
    expect(stockChangedEvents().length).toBeGreaterThanOrEqual(1);
    expect(syncStockWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'inventory-correction' })
    );
  });

  it('bucht das adjust-Event bei Wiederholung nicht doppelt (deterministischer Key)', async () => {
    seedProduct('prod-led', 'SKU-LED', { quantity: 5, quantitySource: 'ledger', binCode: 'SEG0101A' });
    seedBin('SEG0101A', [{ productId: 'prod-led', sku: 'SKU-LED', quantity: 5 }]);
    store.warehouseEvents['evt-seed'] = { type: 'stock_in', productId: 'prod-led', delta: 5, quantityAfter: 5 };
    seedInventory('inv-led2', [position({ binCode: 'SEG0101A', productId: 'prod-led', sku: 'SKU-LED', systemQty: 5, countedQty: 3 })]);

    await request(app).post('/api/warehouse/inventories/inv-led2/complete').send({});
    // Marker entfernen und erneut abschliessen → simuliert einen Wiederholungslauf
    store.warehouse_inventories['inv-led2'].status = 'active';
    delete store.warehouse_inventories['inv-led2'].counts[0].bookedAt;
    // Die Zaehlvorgabe steht weiter auf 5, der BIN traegt weiter 5 (Ledger-Pfad
    // laesst das Layout unberuehrt) → dieselbe Korrektur wird erneut versucht.
    await request(app).post('/api/warehouse/inventories/inv-led2/complete').send({});

    expect(eventsOfType('adjust')).toHaveLength(1);
    expect(qtyOf('prod-led')).toBe(3);
  });
});
