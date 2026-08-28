/**
 * Regression-Test: Ship-Decrement darf sich unter STOCK_LEDGER nicht selbst
 * rueckgaengig machen (Incident 2026-08-28, Oversell eBay 12-15087-51308,
 * SKU-3190474725 — und still seit 21.07. SKU-1233168508).
 *
 * Hergang: `decrementProductByIdOrSku` (Pfad B, Versand ohne gebuchten Pick)
 * schrieb sein `order_decrement`-warehouseEvent OHNE `delta`. Der Ledger
 * (Σ warehouseEvents.delta) war damit blind fuer den Abgang. Direkt nach der
 * eigenen Tx ruft die Funktion `refreshProductInventory` — das projizierte
 * Σ Ledger (unveraendert +1) zurueck in `inventory.quantity` und erweckte die
 * verschickte Einheit Millisekunden nach dem Decrement wieder. Der
 * zeroStockEnd-Marker-Relist stellte das beendete Listing daraufhin als neue
 * ItemID wieder online → Kaeufer kaufte die Phantom-Einheit.
 *
 * Gleiche Klasse: `removeProductFromBin` (Operator entfernt Einheit aus dem
 * Platz) dekrementierte ebenfalls ohne Ledger-Event → Refresh machte auch das
 * rueckgaengig.
 *
 * Abgedeckt:
 *   - order_decrement traegt delta = −(angewandte Menge) + sku + meta.orderId
 *   - STOCK_LEDGER=true: quantity bleibt nach Decrement 0 (keine Resurrektion)
 *   - Clamp: requested > Bestand → delta nur ueber die angewandte Menge
 *   - bin_remove_product traegt delta, Refresh resurrektiert nicht
 *   - skipProductUpdate (Layout-only) schreibt KEIN delta
 *   - STOCK_LEDGER aus: Verhalten wie bisher (bins-Projektion, quantity 0)
 *
 * Setup: In-Memory-Firestore via require.cache-Patching (CJS, kein vi.mock) —
 * gleiche Mechanik wie warehouse-stock-in-idempotency.test.js.
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
  inventory_ledger: {},
};

let nowMs = Date.UTC(2026, 7, 27, 13, 33, 30);

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

const { decrementProductByIdOrSku, removeProductFromBin, bookStockOut, refreshProductInventory } = require('../lib/warehouse');

// ─── Fixtures ───────────────────────────────────────────────────────────────

const PRODUCT_ID = 'prod-dreame-r20';
const SKU = 'SKU-3190474725';
const BIN = 'LEG0202E';

function seedProductWithStock(quantity = 1) {
  store.products_v2[PRODUCT_ID] = {
    id: PRODUCT_ID,
    tenantId: 'default',
    identification: { sku: SKU, name: 'Dreame R20' },
    details: { identifiers: { sku: SKU }, images: [] },
    inventory: { quantity, quantitySource: 'ledger' },
    storageBins: [{ code: BIN, quantity }],
    storage: { binCode: BIN, quantity },
  };
  store.warehouseBins[BIN] = {
    code: BIN,
    products: [{ productId: PRODUCT_ID, sku: SKU, name: 'Dreame R20', quantity }],
    productCount: quantity,
  };
  store.warehouseEvents['seed-stock-in'] = {
    type: 'stock_in',
    binCode: BIN,
    productId: PRODUCT_ID,
    sku: SKU,
    delta: quantity,
    quantityAfter: quantity,
    createdAt: FakeTimestamp.now(),
  };
}

function ledgerSum() {
  return Object.values(store.warehouseEvents).reduce((sum, e) => {
    const d = Number(e && e.delta);
    return Number.isFinite(d) ? sum + d : sum;
  }, 0);
}

function orderDecrementEvents() {
  return Object.values(store.warehouseEvents).filter((e) => e.type === 'order_decrement');
}

beforeEach(() => {
  for (const coll of Object.keys(store)) store[coll] = {};
  emitSyncEvent.mockClear();
  delete process.env.STOCK_LEDGER;
});

afterEach(() => {
  delete process.env.STOCK_LEDGER;
});

// ─── Incident-Replay: Pfad B (ship-decrement) ───────────────────────────────

describe('decrementProductByIdOrSku unter STOCK_LEDGER (Incident 2026-08-28)', () => {
  it('resurrektiert NICHT: quantity bleibt nach Decrement 0, Ledger-Summe 0', async () => {
    process.env.STOCK_LEDGER = 'true';
    seedProductWithStock(1);

    await decrementProductByIdOrSku(SKU, 1);

    // Das war der Vorfall: refreshProductInventory setzte 0 → 1 zurueck.
    expect(store.products_v2[PRODUCT_ID].inventory.quantity).toBe(0);
    expect(ledgerSum()).toBe(0);
  });

  it('schreibt order_decrement MIT delta = −(angewandte Menge) und sku', async () => {
    process.env.STOCK_LEDGER = 'true';
    seedProductWithStock(1);

    await decrementProductByIdOrSku(SKU, 1);

    const events = orderDecrementEvents();
    expect(events).toHaveLength(1);
    expect(events[0].delta).toBe(-1);
    expect(events[0].sku).toBe(SKU);
  });

  it('clampt delta auf die angewandte Menge (requested 2, Bestand 1 → delta −1)', async () => {
    process.env.STOCK_LEDGER = 'true';
    seedProductWithStock(1);

    await decrementProductByIdOrSku(SKU, 2);

    const events = orderDecrementEvents();
    expect(events).toHaveLength(1);
    expect(events[0].delta).toBe(-1);
    // Ledger darf nie unter 0 getrieben werden.
    expect(ledgerSum()).toBe(0);
    expect(store.products_v2[PRODUCT_ID].inventory.quantity).toBe(0);
  });

  it('reicht meta (orderId) in das Event durch', async () => {
    process.env.STOCK_LEDGER = 'true';
    seedProductWithStock(1);

    await decrementProductByIdOrSku(SKU, 1, { orderId: 'ebay__12-15087-51308' });

    const events = orderDecrementEvents();
    expect(events[0].meta).toEqual({ orderId: 'ebay__12-15087-51308' });
  });

  it('verhaelt sich ohne STOCK_LEDGER wie bisher (bins-Projektion, quantity 0)', async () => {
    seedProductWithStock(1);

    await decrementProductByIdOrSku(SKU, 1);

    expect(store.products_v2[PRODUCT_ID].inventory.quantity).toBe(0);
    const events = orderDecrementEvents();
    expect(events).toHaveLength(1);
    expect(events[0].delta).toBe(-1);
  });
});

// ─── Gleiche Klasse: removeProductFromBin ───────────────────────────────────

describe('removeProductFromBin unter STOCK_LEDGER', () => {
  it('resurrektiert NICHT: quantity 0 nach Entfernen, bin_remove_product traegt delta', async () => {
    process.env.STOCK_LEDGER = 'true';
    seedProductWithStock(1);

    await removeProductFromBin(BIN, PRODUCT_ID);

    expect(store.products_v2[PRODUCT_ID].inventory.quantity).toBe(0);
    expect(ledgerSum()).toBe(0);
    const events = Object.values(store.warehouseEvents).filter((e) => e.type === 'bin_remove_product');
    expect(events).toHaveLength(1);
    expect(events[0].delta).toBe(-1);
  });

  it('skipProductUpdate (Layout-only) schreibt KEIN delta — Ledger unveraendert', async () => {
    process.env.STOCK_LEDGER = 'true';
    seedProductWithStock(1);

    await removeProductFromBin(BIN, PRODUCT_ID, { skipProductUpdate: true });

    const events = Object.values(store.warehouseEvents).filter((e) => e.type === 'bin_remove_product');
    expect(events).toHaveLength(1);
    expect(events[0].delta).toBeUndefined();
    expect(ledgerSum()).toBe(1);
  });

  it('clampt delta auf den Bestand: Bin-Eintrag 2, quantity 1 → delta −1, Σ nie unter 0', async () => {
    process.env.STOCK_LEDGER = 'true';
    seedProductWithStock(1);
    // Drift-Zustand: Bin-Eintrag traegt mehr als der Bestand kennt.
    store.warehouseBins[BIN].products[0].quantity = 2;
    store.warehouseBins[BIN].productCount = 2;

    await removeProductFromBin(BIN, PRODUCT_ID);

    const events = Object.values(store.warehouseEvents).filter((e) => e.type === 'bin_remove_product');
    expect(events).toHaveLength(1);
    expect(events[0].delta).toBe(-1);
    expect(ledgerSum()).toBe(0);
  });
});

// ─── Chronologie + Sync-Emit (Review 2026-08-28) ────────────────────────────

describe('decrementProductByIdOrSku — Ledger-Chronologie und stock:changed', () => {
  it('schreibt GENAU EINEN ship-decrement-Eintrag, KEINEN warehouse-refresh-Eintrag, und emittiert stock:changed mit after=0', async () => {
    process.env.STOCK_LEDGER = 'true';
    seedProductWithStock(1);

    await decrementProductByIdOrSku(SKU, 1);

    const ledger = Object.values(store.inventory_ledger);
    expect(ledger.map((e) => e.reason)).toEqual(['ship-decrement']);
    expect(ledger[0].before).toBe(1);
    expect(ledger[0].after).toBe(0);
    // Der Refresh darf die Menge nicht mehr aendern → kein zweiter Eintrag,
    // der die Chronologie verdreht (Ermittlungs-Hindernis des Incidents).
    const emitted = emitSyncEvent.mock.calls.filter(([name]) => name === 'stock:changed');
    expect(emitted.length).toBeGreaterThanOrEqual(1);
    expect(emitted[0][1].after).toBe(0);
  });

  it('Menge 2 ueber zwei Bins: delta −2, Σ Ledger und quantity konsistent', async () => {
    process.env.STOCK_LEDGER = 'true';
    seedProductWithStock(3);
    // Bestand auf zwei Plaetze verteilt (2 + 1).
    store.products_v2[PRODUCT_ID].storageBins = [
      { code: BIN, quantity: 2 },
      { code: 'LEG0303A', quantity: 1 },
    ];
    store.warehouseBins[BIN].products[0].quantity = 2;
    store.warehouseBins[BIN].productCount = 2;
    store.warehouseBins.LEG0303A = {
      code: 'LEG0303A',
      products: [{ productId: PRODUCT_ID, sku: SKU, name: 'Dreame R20', quantity: 1 }],
      productCount: 1,
    };

    await decrementProductByIdOrSku(SKU, 2);

    const events = orderDecrementEvents();
    expect(events).toHaveLength(1);
    expect(events[0].delta).toBe(-2);
    expect(ledgerSum()).toBe(1);
    expect(store.products_v2[PRODUCT_ID].inventory.quantity).toBe(1);
  });

  it('funktioniert auch via Produkt-Doc-ID statt SKU', async () => {
    process.env.STOCK_LEDGER = 'true';
    seedProductWithStock(1);

    await decrementProductByIdOrSku(PRODUCT_ID, 1);

    expect(store.products_v2[PRODUCT_ID].inventory.quantity).toBe(0);
    expect(orderDecrementEvents()[0].delta).toBe(-1);
  });
});

// ─── Repair-Invariante: Altdaten + adjust bleiben stabil ────────────────────

describe('refreshProductInventory nach Repair (Altdaten ohne delta + adjust)', () => {
  it('resurrektiert reparierte Produkte NICHT: stock_in(+1) + delta-loses order_decrement + adjust(−1) → quantity bleibt 0', async () => {
    process.env.STOCK_LEDGER = 'true';
    store.products_v2[PRODUCT_ID] = {
      id: PRODUCT_ID,
      tenantId: 'default',
      identification: { sku: SKU, name: 'Dreame R20' },
      details: { identifiers: { sku: SKU }, images: [] },
      inventory: { quantity: 0, quantitySource: 'ledger' },
      storageBins: [],
      storage: null,
    };
    store.warehouseEvents['alt-stock-in'] = { type: 'stock_in', productId: PRODUCT_ID, sku: SKU, delta: 1 };
    // Altdaten-Event der Incident-Klasse: order_decrement OHNE delta.
    store.warehouseEvents['alt-order-decrement'] = { type: 'order_decrement', productId: PRODUCT_ID, requestedQty: 1 };
    // Repair-Buchung des Scripts (applyMovement type 'adjust').
    store.warehouseEvents['repair-adjust'] = { type: 'adjust', productId: PRODUCT_ID, delta: -1 };

    await refreshProductInventory(PRODUCT_ID);

    expect(store.products_v2[PRODUCT_ID].inventory.quantity).toBe(0);
  });
});

// ─── Ship-dann-Pick: Mutual Exclusivity (Review 2026-08-28) ─────────────────

describe('bookStockOut nach Ship-Claim (by=ship)', () => {
  it('skippt KOMPLETT: kein stock_out-Event, kein Bin-Write, quantity unveraendert', async () => {
    process.env.STOCK_LEDGER = 'true';
    seedProductWithStock(2);
    store.warehouseBins[BIN].products[0].quantity = 2;
    store.warehouseBins[BIN].productCount = 2;
    store.warehouseEvents['seed-stock-in'].delta = 2;
    store.orders = {
      'ebay__12-15087-51308': {
        tenantId: 'default',
        stockDecrementedAt: '2026-08-27T13:33:30.001Z',
        stockDecrementedBy: 'ship',
        stockDecrementedSkus: [SKU],
      },
    };

    const result = await bookStockOut({
      productId: PRODUCT_ID,
      binCode: BIN,
      quantity: 1,
      meta: { orderId: 'ebay__12-15087-51308', flow: 'pick' },
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('already-decremented-by-ship');
    const stockOuts = Object.values(store.warehouseEvents).filter((e) => e.type === 'stock_out');
    expect(stockOuts).toHaveLength(0);
    expect(store.products_v2[PRODUCT_ID].inventory.quantity).toBe(2);
    expect(store.warehouseBins[BIN].products[0].quantity).toBe(2);
    expect(ledgerSum()).toBe(2);
  });

  it('bucht normal, wenn KEIN Ship-Claim existiert (Pick-Claim wird gesetzt)', async () => {
    process.env.STOCK_LEDGER = 'true';
    seedProductWithStock(2);
    store.warehouseBins[BIN].products[0].quantity = 2;
    store.warehouseBins[BIN].productCount = 2;
    store.warehouseEvents['seed-stock-in'].delta = 2;
    store.orders = { 'order-frisch': { tenantId: 'default', items: [{ sku: SKU, quantity: 1 }] } };

    const result = await bookStockOut({
      productId: PRODUCT_ID,
      binCode: BIN,
      quantity: 1,
      meta: { orderId: 'order-frisch', flow: 'pick' },
    });

    expect(result.skipped).toBeUndefined();
    const stockOuts = Object.values(store.warehouseEvents).filter((e) => e.type === 'stock_out');
    expect(stockOuts).toHaveLength(1);
    expect(stockOuts[0].delta).toBe(-1);
    expect(store.orders['order-frisch'].stockDecrementedBy).toBe('pick');
    expect(ledgerSum()).toBe(1);
    expect(store.products_v2[PRODUCT_ID].inventory.quantity).toBe(1);
  });
});
