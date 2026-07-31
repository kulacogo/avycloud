/**
 * Los-Verwaltung — Firestore-Pfade (In-Memory-Fake via require.cache, kein vi.mock).
 *
 * Regression (Review 2026-07-31): deleteLot MUSS fail-closed sein — ein
 * Fehler der count()-Aggregation darf NIE als "0 Produkte" gelesen werden,
 * sonst löscht eine transiente Firestore-Störung ein Los samt ekBrutto.
 */
process.env.USE_PRODUCTS_V2 = 'true';
process.env.GOOGLE_CLOUD_PROJECT = 'avycloud-test';

const store = {
  warehouse_lots: {},
  products_v2: {},
};

// 'ok' → zählt echt; 'throw' → simuliert DEADLINE_EXCEEDED der Aggregation
let countBehavior = 'ok';

function getPath(obj, dotted) {
  return String(dotted)
    .split('.')
    .reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

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
    if (opts && opts.merge && coll[this.id]) coll[this.id] = { ...coll[this.id], ...data };
    else coll[this.id] = { ...data };
  }

  async update(data) {
    const coll = ensureColl(this.collName);
    if (coll[this.id] === undefined) throw new Error(`NOT_FOUND: ${this.path}`);
    coll[this.id] = { ...coll[this.id], ...data };
  }

  async delete() { delete ensureColl(this.collName)[this.id]; }
}

class FakeQuery {
  constructor(collName, filters = []) {
    this.collName = collName;
    this.filters = filters;
  }

  where(field, op, value) {
    return new FakeQuery(this.collName, [...this.filters, { field, value }]);
  }

  matchingDocs() {
    const coll = ensureColl(this.collName);
    let docs = Object.keys(coll).map((id) => new FakeDocRef(this.collName, id).snapshot());
    for (const f of this.filters) {
      docs = docs.filter((d) => getPath(d.data(), f.field) === f.value);
    }
    return docs;
  }

  async get() {
    const docs = this.matchingDocs();
    return { docs, empty: docs.length === 0, size: docs.length };
  }

  count() {
    return {
      get: async () => {
        if (countBehavior === 'throw') throw new Error('DEADLINE_EXCEEDED (simuliert)');
        const n = this.matchingDocs().length;
        return { data: () => ({ count: n }) };
      },
    };
  }
}

class FakeCollection extends FakeQuery {
  doc(id) { return new FakeDocRef(this.collName, id); }
}

const fakeDb = {
  collection: (name) => new FakeCollection(name),
  getAll: async (...refs) => refs.map((r) => r.snapshot()),
  batch: () => {
    const ops = [];
    return {
      set: (ref, data, opts) => ops.push(() => ref.set(data, opts)),
      update: (ref, data) => ops.push(() => ref.update(data)),
      delete: (ref) => ops.push(() => ref.delete()),
      commit: async () => { for (const op of ops) await op(); },
    };
  },
};

const FakeTimestamp = {
  now: () => ({ toDate: () => new Date('2026-07-31T04:00:00Z') }),
};

function FakeFirestore() { return fakeDb; }

function patchCache(moduleName, exports) {
  const key = require.resolve(moduleName);
  require.cache[key] = { id: key, filename: key, loaded: true, exports, children: [], paths: [] };
}

patchCache('@google-cloud/firestore', { Firestore: FakeFirestore, Timestamp: FakeTimestamp });

// Frisch laden, damit die Lib den Fake bekommt
const libPath = require.resolve('../lib/warehouse-lots.js');
delete require.cache[libPath];
const { createLots, listLots, deleteLot, updateLot, lotExists } = require('../lib/warehouse-lots');

beforeEach(() => {
  store.warehouse_lots = {};
  store.products_v2 = {};
  countBehavior = 'ok';
});

describe('createLots', () => {
  it('legt L-Bereich an und überspringt existierende (idempotent)', async () => {
    store.warehouse_lots['L-072602'] = { code: 'L-072602', tenantId: 'default' };
    const result = await createLots({ type: 'L', month: 7, year: 2026, numbers: '1-3' });
    expect(result.created).toEqual(['L-072601', 'L-072603']);
    expect(result.skipped).toEqual(['L-072602']);
    expect(store.warehouse_lots['L-072601'].type).toBe('L');
    expect(store.warehouse_lots['L-072601'].tenantId).toBe('default');
    expect(store.warehouse_lots['L-072601'].number).toBe(1);
  });

  it('NL: genau ein Los pro Monat', async () => {
    const first = await createLots({ type: 'NL', month: 6, year: 2026 });
    const second = await createLots({ type: 'NL', month: 6, year: 2026 });
    expect(first.created).toEqual(['NL-0626']);
    expect(second.created).toEqual([]);
    expect(second.skipped).toEqual(['NL-0626']);
  });
});

describe('deleteLot — fail-closed', () => {
  beforeEach(async () => {
    await createLots({ type: 'NL', month: 6, year: 2026 });
  });

  it('löscht ein Los ohne zugeordnete Produkte', async () => {
    const result = await deleteLot('NL-0626');
    expect(result.deleted).toBe('NL-0626');
    expect(store.warehouse_lots['NL-0626']).toBeUndefined();
  });

  it('blockt, wenn Produkte zugeordnet sind', async () => {
    store.products_v2['p1'] = { ops: { sourceLot: 'NL-0626' } };
    await expect(deleteLot('NL-0626')).rejects.toThrow(/zugeordnete Produkte/);
    expect(store.warehouse_lots['NL-0626']).toBeDefined();
  });

  it('REGRESSION: count()-Fehler löscht NICHT (wirft statt 0 zu melden)', async () => {
    store.products_v2['p1'] = { ops: { sourceLot: 'NL-0626' } };
    countBehavior = 'throw';
    await expect(deleteLot('NL-0626')).rejects.toThrow(/Produktzählung/);
    expect(store.warehouse_lots['NL-0626']).toBeDefined();
  });
});

describe('listLots', () => {
  it('withCounts=false macht KEINE Aggregation (robust im Störfall)', async () => {
    await createLots({ type: 'NL', month: 6, year: 2026 });
    countBehavior = 'throw';
    const lots = await listLots({ withCounts: false });
    expect(lots).toHaveLength(1);
    expect(lots[0].productCount).toBeUndefined();
  });

  it('withCounts=true liefert null (unbekannt) statt 0 bei Count-Fehler', async () => {
    await createLots({ type: 'NL', month: 6, year: 2026 });
    countBehavior = 'throw';
    const lots = await listLots({ withCounts: true });
    expect(lots[0].productCount).toBeNull();
  });

  it('sortiert neueste zuerst, L vor NL, Nummern aufsteigend', async () => {
    await createLots({ type: 'NL', month: 6, year: 2026 });
    await createLots({ type: 'NL', month: 7, year: 2026 });
    await createLots({ type: 'L', month: 7, year: 2026, numbers: '2' });
    await createLots({ type: 'L', month: 7, year: 2026, numbers: '1' });
    const lots = await listLots({ withCounts: false });
    expect(lots.map((l) => l.code)).toEqual(['L-072601', 'L-072602', 'NL-0726', 'NL-0626']);
  });
});

describe('updateLot / lotExists', () => {
  it('pflegt ekBrutto und lehnt Negatives ab', async () => {
    await createLots({ type: 'NL', month: 6, year: 2026 });
    const lot = await updateLot('NL-0626', { ekBrutto: 14000 });
    expect(lot.ekBrutto).toBe(14000);
    await expect(updateLot('NL-0626', { ekBrutto: -5 })).rejects.toThrow(/≥ 0/);
  });

  it('lotExists: false für Fremdformate ohne Firestore-Zugriff', async () => {
    expect(await lotExists('PEG001')).toBe(false);
    expect(await lotExists('NL-0626')).toBe(false);
    await createLots({ type: 'NL', month: 6, year: 2026 });
    expect(await lotExists('nl-0626')).toBe(true);
  });
});
