/**
 * Regression-Test: Bestandseingang (`bookStockIn`) ist idempotent.
 *
 * Incident 05.06.2026: derselbe Einlager-Vorgang wurde zweimal gebucht
 * (14:23:17 +3→3, 14:24:13 +3→6). Reichweite 16 SKUs / 18 Doppel-Paare /
 * 30 Phantom-Einheiten; SKU-3280641599 sogar DREIFACH innerhalb von 10 s.
 * `bookStockIn` hatte keinerlei Idempotenz — die Firestore-Tx schuetzte nur
 * gegen Nebenlaeufigkeit, nicht gegen Doppel-Absendung.
 *
 * Abgedeckt:
 *   - gleiche Request-Id zweimal        → nur EINE Buchung
 *   - ohne Request-Id im Dedup-Fenster  → nur EINE Buchung
 *   - Dreifach-Absendung in 10 s        → nur EINE Buchung
 *   - legitime 2. Buchung NACH Fenster  → wird gebucht
 *   - Paletten-Takt verschiedener SKUs  → wird NICHT geblockt
 *   - Notbremse STOCK_IN_DEDUP=off      → altes Verhalten (bucht doppelt)
 *   - verschiedene Request-Ids          → beide Buchungen laufen
 *
 * Setup: eigene In-Memory-Firestore (require.cache-Patching, kein vi.mock —
 * CJS). Die Tx puffert Writes und committet erst nach dem Callback, damit ein
 * Early-Return im Dedup-Fall beweisbar NICHTS schreibt.
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

const { bookStockIn, buildStockInClaimIds, stockInDedupWindowMs, normalizeStockInActorKey } = require('../lib/warehouse');

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
  delete process.env.STOCK_IN_DEDUP;
  delete process.env.STOCK_IN_DEDUP_WINDOW_SECONDS;
  seedProduct('prod-1', 'SKU-1');
  seedBin('SEG0101A');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('bookStockIn Idempotenz — Request-Id', () => {
  it('bucht dieselbe Request-Id nur EINMAL (Doppelklick)', async () => {
    const first = await stow({ requestId: 'req-abc' });
    expect(first.deduped).toBe(false);
    expect(qtyOf('prod-1')).toBe(3);

    nowMs += 56 * 1000; // 56 s spaeter — Fenster laengst zu, Request-Id greift trotzdem
    const second = await stow({ requestId: 'req-abc' });

    expect(second.deduped).toBe(true);
    expect(second.dedupReason).toBe('request-id');
    expect(second.product).toBeTruthy();
    expect(qtyOf('prod-1')).toBe(3);
    expect(binQtyOf('SEG0101A', 'prod-1')).toBe(3);
    expect(stockInEvents()).toHaveLength(1);
  });

  it('bucht verschiedene Request-Ids beide (legitime Mehrfach-Einlagerung)', async () => {
    await stow({ requestId: 'req-1' });
    nowMs += 4000;
    const second = await stow({ requestId: 'req-2' });

    expect(second.deduped).toBe(false);
    expect(qtyOf('prod-1')).toBe(6);
    expect(stockInEvents()).toHaveLength(2);
  });
});

describe('bookStockIn Idempotenz — Dedup-Fenster (Alt-Clients ohne Request-Id)', () => {
  it('bucht die Wiederholung 1 s spaeter NICHT', async () => {
    await stow();
    nowMs += 1000;
    const second = await stow();

    expect(second.deduped).toBe(true);
    expect(second.dedupReason).toBe('window');
    expect(qtyOf('prod-1')).toBe(3);
    expect(stockInEvents()).toHaveLength(1);
  });

  it('bucht die DREIFACH-Absendung in 10 s nur einmal — mit derselben Request-Id (echter Client)', async () => {
    // Seit die Oberflaeche eine Kennung PRO ABSICHT mitsendet, ist das der reale Fall:
    // Doppel-/Dreifachfeuer von Scanner oder Enter schickt DIESELBE Kennung. Das wirkt
    // unabhaengig vom Zeitfenster und ist die scharfe Absicherung.
    const id = 'stow:abs-1';
    const r1 = await stow({ quantity: 2, requestId: id });
    nowMs += 5000;
    const r2 = await stow({ quantity: 2, requestId: id });
    nowMs += 5000;
    const r3 = await stow({ quantity: 2, requestId: id });
    expect([r1.deduped === true, r2.deduped === true, r3.deduped === true]).toEqual([false, true, true]);
    expect(qtyOf('prod-1')).toBe(2);
    expect(stockInEvents()).toHaveLength(1);
  });

  it('faengt Doppelfeuer ohne Request-Id nur innerhalb des kurzen Fensters (Alt-Client)', async () => {
    // Das Fenster ist bewusst KURZ (Default 5 s). Es ist der unscharfe Mechanismus und
    // darf keine legitime zweite Einlagerung verschlucken — zwei gleiche Kartons in
    // denselben Platz sind ein normaler Vorgang. Technisches Doppelfeuer lag gemessen
    // bei 1-2 s; alles darueber faengt heute die Request-Id bzw. die sichtbare Quittung.
    const r1 = await stow({ quantity: 2 });
    nowMs += 2000; // innerhalb 5 s -> Doppelfeuer, wird verworfen
    const r2 = await stow({ quantity: 2 });
    nowMs += 10000; // ausserhalb -> zweiter echter Karton, MUSS gebucht werden
    const r3 = await stow({ quantity: 2 });

    expect([r1.deduped === true, r2.deduped === true, r3.deduped === true]).toEqual([false, true, false]);
    expect(qtyOf('prod-1')).toBe(4);
    expect(stockInEvents()).toHaveLength(2);
  });

  it('bucht die zweite Buchung NACH dem Fenster (31 s) regulaer', async () => {
    await stow();
    nowMs += 31 * 1000;
    const second = await stow();

    expect(second.deduped).toBe(false);
    expect(qtyOf('prod-1')).toBe(6);
    expect(binQtyOf('SEG0101A', 'prod-1')).toBe(6);
    expect(stockInEvents()).toHaveLength(2);
  });

  it('blockt den Paletten-Takt verschiedener SKUs NICHT (8-10 s pro SKU)', async () => {
    seedProduct('prod-2', 'SKU-2');
    seedProduct('prod-3', 'SKU-3');

    const r1 = await stow({ sku: 'SKU-1', quantity: 1 });
    nowMs += 9000;
    const r2 = await stow({ sku: 'SKU-2', quantity: 1 });
    nowMs += 8000;
    const r3 = await stow({ sku: 'SKU-3', quantity: 1 });

    expect([r1.deduped, r2.deduped, r3.deduped]).toEqual([false, false, false]);
    expect(qtyOf('prod-1')).toBe(1);
    expect(qtyOf('prod-2')).toBe(1);
    expect(qtyOf('prod-3')).toBe(1);
    expect(stockInEvents()).toHaveLength(3);
  });

  it('unterscheidet Menge, BIN und Mitarbeiter (kein Kollateral-Block)', async () => {
    seedBin('SEG0102A');
    await stow({ quantity: 3 });

    const otherQty = await stow({ quantity: 4 });
    const otherBin = await stow({ quantity: 3, binCode: 'SEG0102A' });
    const otherActor = await stow({ quantity: 3, actor: { uid: 'user-2', email: 'kollege@trendocean.de' } });

    expect(otherQty.deduped).toBe(false);
    expect(otherBin.deduped).toBe(false);
    expect(otherActor.deduped).toBe(false);
    expect(qtyOf('prod-1')).toBe(13);
  });

  it('respektiert STOCK_IN_DEDUP_WINDOW_SECONDS=0 (Fenster aus, Request-Id bleibt)', async () => {
    process.env.STOCK_IN_DEDUP_WINDOW_SECONDS = '0';
    expect(stockInDedupWindowMs()).toBe(0);

    await stow();
    nowMs += 1000;
    const second = await stow();
    expect(second.deduped).toBe(false);
    expect(qtyOf('prod-1')).toBe(6);

    const third = await stow({ requestId: 'req-x' });
    const fourth = await stow({ requestId: 'req-x' });
    expect(third.deduped).toBe(false);
    expect(fourth.deduped).toBe(true);
  });
});

describe('bookStockIn Idempotenz — Order-/Retouren-Kontext bleibt ungebremst', () => {
  it('blockt zwei Re-Credits verschiedener Orders NICHT (kein Bestandsverlust)', async () => {
    // WP4-Re-Credit / returns-restock: gleiche SKU, gleicher BIN, gleiche Menge,
    // kein Actor — zwei Stornos in Folge muessen BEIDE gutschreiben.
    const first = await bookStockIn({
      sku: 'SKU-1', binCode: 'SEG0101A', quantity: 1,
      meta: { source: 'cancel-recredit', orderId: 'order-A' },
    });
    nowMs += 2000;
    const second = await bookStockIn({
      sku: 'SKU-1', binCode: 'SEG0101A', quantity: 1,
      meta: { source: 'cancel-recredit', orderId: 'order-B' },
    });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(false);
    expect(qtyOf('prod-1')).toBe(2);
    expect(stockInEvents()).toHaveLength(2);
    // Kein Fenster-Claim fuer Order-Buchungen
    expect(Object.values(store.stock_in_claims).filter((c) => c.kind === 'window')).toHaveLength(0);
  });

  it('respektiert bei Order-Kontext dennoch eine mitgesendete Request-Id', async () => {
    const first = await bookStockIn({
      sku: 'SKU-1', binCode: 'SEG0101A', quantity: 1,
      meta: { source: 'returns-restock', orderId: 'order-A', returnId: 'ret-1', requestId: 'ret-1:SKU-1' },
    });
    const second = await bookStockIn({
      sku: 'SKU-1', binCode: 'SEG0101A', quantity: 1,
      meta: { source: 'returns-restock', orderId: 'order-A', returnId: 'ret-1', requestId: 'ret-1:SKU-1' },
    });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(qtyOf('prod-1')).toBe(1);
  });
});

describe('bookStockIn Idempotenz — Notbremse STOCK_IN_DEDUP=off', () => {
  it('bucht mit abgeschalteter Dedup wieder doppelt (Alt-Verhalten)', async () => {
    process.env.STOCK_IN_DEDUP = 'off';

    const first = await stow({ requestId: 'req-same' });
    nowMs += 1000;
    const second = await stow({ requestId: 'req-same' });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(false);
    expect(qtyOf('prod-1')).toBe(6);
    expect(stockInEvents()).toHaveLength(2);
    expect(Object.keys(store.stock_in_claims)).toHaveLength(0);
  });
});

describe('bookStockIn Idempotenz — Claim-Persistenz', () => {
  it('schreibt Claims nach Firestore (mehrere Cloud-Run-Instanzen, kein In-Memory)', async () => {
    await stow({ requestId: 'req-persist' });

    const claims = Object.values(store.stock_in_claims);
    expect(claims).toHaveLength(2); // request + window
    expect(claims.map((c) => c.kind).sort()).toEqual(['request', 'window']);
    for (const claim of claims) {
      expect(claim.tenantId).toBe('default');
      expect(claim.binCode).toBe('SEG0101A');
      expect(claim.quantity).toBe(3);
      expect(typeof claim.lastAtMs).toBe('number');
    }
  });

  it('schreibt im Dedup-Fall KEINEN weiteren Claim und kein Event', async () => {
    await stow();
    const claimsAfterFirst = JSON.stringify(store.stock_in_claims);
    const eventsAfterFirst = Object.keys(store.warehouseEvents).length;

    nowMs += 2000;
    await stow();

    expect(Object.keys(store.warehouseEvents)).toHaveLength(eventsAfterFirst);
    expect(JSON.stringify(store.stock_in_claims)).toBe(claimsAfterFirst);
  });

  it('buildStockInClaimIds ist deterministisch und trennt Tenants', () => {
    const base = { tenantId: 'default', requestId: 'r1', productKey: 'prod-1', binCode: 'SEG0101A', quantity: 3, actorKey: 'user-1' };
    const a = buildStockInClaimIds(base);
    const b = buildStockInClaimIds(base);
    const other = buildStockInClaimIds({ ...base, tenantId: 'other' });

    expect(a).toEqual(b);
    expect(a.requestClaimId).toHaveLength(40);
    expect(a.windowClaimId).toHaveLength(40);
    expect(a.requestClaimId).not.toBe(a.windowClaimId);
    expect(other.windowClaimId).not.toBe(a.windowClaimId);
    expect(buildStockInClaimIds({ ...base, requestId: null }).requestClaimId).toBeNull();
  });

  it('normalizeStockInActorKey faellt auf "anon" zurueck', () => {
    expect(normalizeStockInActorKey(null)).toBe('anon');
    expect(normalizeStockInActorKey({})).toBe('anon');
    expect(normalizeStockInActorKey({ actor: { uid: 'User-9' } })).toBe('user-9');
    expect(normalizeStockInActorKey({ actor: 'Scanner-A' })).toBe('scanner-a');
  });
});
