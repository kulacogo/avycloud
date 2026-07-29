'use strict';

/**
 * saveProduct() haengt die Herstellernummer (MPN) ans Titelende an —
 * NUR auf Automatikpfaden und NUR wenn TITLE_APPEND_MPN='on'.
 *
 * Flag-Matrix:
 *   unset|'off' → exakt heutiges Verhalten (Titel unangetastet)
 *   'shadow'    → rechnet + loggt '[mpn-title-shadow] …', mutiert NICHTS
 *   'on'        → Titel wird ergaenzt
 * Manueller Save (source:'ui' bzw. mode:'manual') bleibt in ALLEN Modi unberuehrt.
 *
 * Mocking: @google-cloud/firestore via require.cache-Patching (CJS-Muster,
 * siehe __tests__/lib/firestore-gpsr-brandname-fallback.test.js). Die
 * Titel-Regel-Engine wird per TITLE_POLICY_DISABLED=true auf minimale
 * Sanitisierung gestellt, damit ausschliesslich der MPN-Append gemessen wird.
 */

// ─── 1. Firestore mock (schreibende Aufrufe werden mitgeschnitten) ──────────

const docStore = new Map(); // `${collection}/${docId}` → data
const writes = []; // { collection, id, data }

function makeDocRef(colName, docId) {
  return {
    id: docId,
    get: async () => {
      const data = docStore.get(`${colName}/${docId}`);
      if (!data) return { exists: false, id: docId, data: () => ({}) };
      return { exists: true, id: docId, data: () => data };
    },
    set: async (data) => {
      writes.push({ collection: colName, id: docId, data });
      docStore.set(`${colName}/${docId}`, data);
    },
    update: async () => {},
    delete: async () => {},
  };
}

function makeQuery(colName) {
  return {
    where: () => makeQuery(colName),
    orderBy: () => makeQuery(colName),
    limit: () => makeQuery(colName),
    select: () => makeQuery(colName),
    get: async () => ({ docs: [], empty: true, size: 0, forEach: () => {} }),
  };
}

function MockFirestore() {
  return {
    collection: (name) => ({
      doc: (id) => makeDocRef(name, id || `auto-${Math.random()}`),
      where: () => makeQuery(name),
      orderBy: () => makeQuery(name),
      limit: () => makeQuery(name),
      select: () => makeQuery(name),
      add: async () => makeDocRef(name, 'auto'),
      get: async () => ({ docs: [], empty: true, size: 0, forEach: () => {} }),
    }),
    batch: () => ({ set() {}, update() {}, delete() {}, commit: async () => [] }),
    runTransaction: async (fn) =>
      fn({
        get: async (refOrQuery) => {
          if (refOrQuery && typeof refOrQuery.get === 'function') return refOrQuery.get();
          return { exists: false, data: () => ({}), docs: [], empty: true };
        },
        set(ref, data) {
          if (ref && typeof ref.set === 'function') ref.set(data);
        },
        update() {},
        delete() {},
      }),
    doc: () => makeDocRef('_root', '_doc'),
  };
}
// FieldValue MUSS eine Funktion/Klasse sein — lib/firestore.js macht
// `value instanceof FieldValue`.
function MockFieldValue() {}
MockFieldValue.serverTimestamp = () => null;
MockFieldValue.increment = (n) => n;
MockFieldValue.delete = () => null;
MockFieldValue.arrayUnion = (...a) => a;
MockFieldValue.arrayRemove = (...a) => a;
MockFirestore.FieldValue = MockFieldValue;
MockFirestore.Timestamp = {
  now: () => ({ seconds: 0, nanoseconds: 0, toDate: () => new Date() }),
  fromDate: (d) => ({ seconds: 0, nanoseconds: 0, toDate: () => d }),
};

function patchCache(moduleName, mockExports) {
  try { require(moduleName); } catch (_) { /* replace anyway */ }
  const cacheKey = require.resolve(moduleName);
  require.cache[cacheKey] = {
    id: cacheKey,
    filename: cacheKey,
    loaded: true,
    exports: mockExports,
    children: [],
    paths: [],
  };
}

patchCache('@google-cloud/firestore', {
  Firestore: MockFirestore,
  FieldValue: MockFirestore.FieldValue,
  Timestamp: MockFirestore.Timestamp,
});

// GPSR-Registry-Lookup stummschalten (kein echter Firestore-Roundtrip).
const realRegistry = require('../../lib/gpsr-manufacturer-registry');
patchCache('../../lib/gpsr-manufacturer-registry', {
  ...realRegistry,
  getManufacturerGpsrByName: async () => null,
  upsertManufacturerGpsr: async () => null,
});

// ─── 2. SUT ─────────────────────────────────────────────────────────────────
const { saveProduct } = require('../../lib/firestore');

const TITLE = 'Bosch Bremsbelagsatz Vorderachse';
const MPN = '0986479058';

function buildProduct(id) {
  return {
    id,
    tenantId: 'default',
    identification: {
      name: TITLE,
      brand: 'Bosch',
      sku: 'SKU-1234567890',
    },
    details: {
      identifiers: {
        mpn: MPN,
        sku: 'SKU-1234567890',
      },
      attributes: {},
    },
  };
}

function savedTitle(id) {
  const hit = [...writes].reverse().find((w) => w.id === id);
  return hit?.data?.identification?.name;
}

beforeEach(() => {
  docStore.clear();
  writes.length = 0;
  delete process.env.TITLE_APPEND_MPN;
  // Titel-Regel-Engine aus: nur der MPN-Append darf den Titel anfassen.
  process.env.TITLE_POLICY_DISABLED = 'true';
});

afterEach(() => {
  delete process.env.TITLE_APPEND_MPN;
  delete process.env.TITLE_POLICY_DISABLED;
});

describe('saveProduct — TITLE_APPEND_MPN Flag-Modi', () => {
  it('unset (== off): Titel bleibt exakt wie heute', async () => {
    await saveProduct(buildProduct('p-mpn-off-unset'), { source: 'job' });
    expect(savedTitle('p-mpn-off-unset')).toBe(TITLE);
  });

  it("'off': Titel bleibt exakt wie heute", async () => {
    process.env.TITLE_APPEND_MPN = 'off';
    await saveProduct(buildProduct('p-mpn-off'), { source: 'job' });
    expect(savedTitle('p-mpn-off')).toBe(TITLE);
  });

  it("'shadow': loggt, mutiert aber NICHTS", async () => {
    process.env.TITLE_APPEND_MPN = 'shadow';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await saveProduct(buildProduct('p-mpn-shadow'), { source: 'job' });
      expect(savedTitle('p-mpn-shadow')).toBe(TITLE);
      const shadowLines = logSpy.mock.calls
        .map((args) => String(args[0] ?? ''))
        .filter((line) => line.includes('[mpn-title-shadow]'));
      expect(shadowLines.length).toBeGreaterThan(0);
      expect(shadowLines[0]).toContain(MPN);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("'on': Herstellernummer landet am Titelende, Marke bleibt vorne", async () => {
    process.env.TITLE_APPEND_MPN = 'on';
    await saveProduct(buildProduct('p-mpn-on'), { source: 'job' });
    const out = savedTitle('p-mpn-on');
    expect(out).toBe(`${TITLE} ${MPN}`);
    expect(out.startsWith('Bosch ')).toBe(true);
    expect(out.slice(0, TITLE.length)).toBe(TITLE);
    expect(out.length).toBeLessThanOrEqual(80);
  });

  it("'on' ist idempotent — ein zweiter Save haengt nichts nochmal an", async () => {
    process.env.TITLE_APPEND_MPN = 'on';
    await saveProduct(buildProduct('p-mpn-idem'), { source: 'job' });
    const first = savedTitle('p-mpn-idem');

    const again = buildProduct('p-mpn-idem');
    again.identification.name = first;
    await saveProduct(again, { source: 'job' });
    expect(savedTitle('p-mpn-idem')).toBe(first);
  });

  it("'on': Muell-MPN (13-stellige EAN-Fehlablage) wird nicht angehaengt", async () => {
    process.env.TITLE_APPEND_MPN = 'on';
    const p = buildProduct('p-mpn-junk');
    p.details.identifiers.mpn = '4047024537231';
    p.details.identifiers.ean = '4047024537231';
    await saveProduct(p, { source: 'job' });
    expect(savedTitle('p-mpn-junk')).toBe(TITLE);
  });

  it("'on': zu langer Titel bleibt unveraendert (nie kuerzen)", async () => {
    process.env.TITLE_APPEND_MPN = 'on';
    const longTitle = `Bosch ${'B'.repeat(70)}`; // 76 Zeichen, + ' 0986479058' > 80
    const p = buildProduct('p-mpn-toolong');
    p.identification.name = longTitle;
    await saveProduct(p, { source: 'job' });
    expect(savedTitle('p-mpn-toolong')).toBe(longTitle);
  });
});

describe('saveProduct — manueller Save bleibt unberuehrt', () => {
  it("source:'ui' laesst den getippten Titel auch bei TITLE_APPEND_MPN='on' in Ruhe", async () => {
    process.env.TITLE_APPEND_MPN = 'on';
    await saveProduct(buildProduct('p-mpn-ui'), { source: 'ui' });
    expect(savedTitle('p-mpn-ui')).toBe(TITLE);
  });

  it("mode:'manual' laesst den getippten Titel in Ruhe", async () => {
    process.env.TITLE_APPEND_MPN = 'on';
    await saveProduct(buildProduct('p-mpn-manual'), { mode: 'manual' });
    expect(savedTitle('p-mpn-manual')).toBe(TITLE);
  });

  it('skipTitlePolicy:true laesst den Titel in Ruhe', async () => {
    process.env.TITLE_APPEND_MPN = 'on';
    await saveProduct(buildProduct('p-mpn-skip'), { source: 'job', skipTitlePolicy: true });
    expect(savedTitle('p-mpn-skip')).toBe(TITLE);
  });
});
