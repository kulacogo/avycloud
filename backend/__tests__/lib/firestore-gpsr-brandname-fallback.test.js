'use strict';

/**
 * AUDIT 2026-07-16: Der Registry-Enforce in lib/firestore.js ERFAND
 * manufacturer_name aus der Marke (Brand != juristischer Hersteller) —
 * ein Halluzinations-Amplifikator. Der Fallback liegt jetzt hinter dem
 * Runtime-Flag gpsrBrandNameFallback (default FALSE, ENV-Override
 * RUNTIME_FLAG_GPSRBRANDNAMEFALLBACK). Zusaetzlich kopiert der Enforce
 * Beleg-Metadaten aus dem Registry-Eintrag mit (evidence, falls vorhanden;
 * sonst provenance aus sources/confidence).
 *
 * Getestet am Read-Path (getProduct) — derselbe Enforce-Spiegel wie am
 * Save-Boundary. Mocking: @google-cloud/firestore + getManufacturerGpsrByName
 * via require.cache patching (CJS-Muster, siehe
 * __tests__/lib/firestore-getAllProductsForTenant.test.js).
 */

// ─── 1. Firestore mock (collection-name-aware) ──────────────────────────────

const docStore = new Map(); // `${collection}/${docId}` → data

function makeDocRef(colName, docId) {
  return {
    get: async () => {
      const data = docStore.get(`${colName}/${docId}`);
      if (!data) return { exists: false, data: () => ({}) };
      return { exists: true, id: docId, data: () => data };
    },
    set: async () => {},
    update: async () => {},
    delete: async () => {},
  };
}

function makeQuery() {
  return {
    where: () => makeQuery(),
    orderBy: () => makeQuery(),
    limit: () => makeQuery(),
    get: async () => ({ docs: [], empty: true, size: 0, forEach: () => {} }),
  };
}

function MockFirestore() {
  return {
    collection: (name) => ({
      doc: (id) => makeDocRef(name, id),
      where: () => makeQuery(),
      orderBy: () => makeQuery(),
      limit: () => makeQuery(),
      get: async () => ({ docs: [], empty: true, size: 0, forEach: () => {} }),
    }),
    batch: () => ({ set() {}, update() {}, delete() {}, commit: async () => [] }),
    runTransaction: async (fn) => fn({
      get: async () => ({ exists: false, data: () => ({}) }),
      set() {}, update() {}, delete() {},
    }),
    doc: () => makeDocRef('_root', '_doc'),
  };
}
MockFirestore.FieldValue = {
  serverTimestamp: () => null,
  increment: (n) => n,
  delete: () => null,
  arrayUnion: (...a) => a,
  arrayRemove: (...a) => a,
};
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

// ─── 2. Registry mock: echte Pure-Functions, gestubbter Lookup ──────────────
// (Das echte Modul laedt sicher, weil @google-cloud/firestore bereits
// gemockt ist.)
const realRegistry = require('../../lib/gpsr-manufacturer-registry');
const getManufacturerGpsrByNameStub = vi.fn();
patchCache('../../lib/gpsr-manufacturer-registry', {
  ...realRegistry,
  getManufacturerGpsrByName: getManufacturerGpsrByNameStub,
});
// patchCache loest relative Pfade gegen DIESES File auf — require.resolve
// oben zeigt auf lib/gpsr-manufacturer-registry.js, exakt was firestore.js lädt.

// ─── 3. SUT ──────────────────────────────────────────────────────────────────
const { getProduct } = require('../../lib/firestore');

const REGISTRY_ENTRY_WITHOUT_NAME = {
  key: 'acme',
  manufacturer_name: '',
  gpsr: {
    manufacturer_address: 'Hauptstr. 1',
    manufacturer_city: 'Berlin',
    manufacturer_postalcode: '10115',
    email: 'info@acme-example.de',
  },
  confidence: 0.9,
  sources: ['https://acme-example.de/impressum'],
  updated_at_iso: '2026-07-01T00:00:00.000Z',
};

function seedProduct(id) {
  // getProduct probiert products_v2 ODER products (USE_PRODUCTS_V2-abhängig) —
  // beide Collections mit demselben Doc befüllen.
  const product = {
    id,
    tenantId: 'default',
    identification: { name: 'ACME Messgerät', brand: 'ACME', sku: id },
    details: { gpsr: {} },
  };
  docStore.set(`products_v2/${id}`, product);
  docStore.set(`products/${id}`, product);
}

beforeEach(() => {
  docStore.clear();
  getManufacturerGpsrByNameStub.mockReset();
  delete process.env.RUNTIME_FLAG_GPSRBRANDNAMEFALLBACK;
});

afterEach(() => {
  delete process.env.RUNTIME_FLAG_GPSRBRANDNAMEFALLBACK;
});

describe('getProduct — Registry-Enforce ohne Brand-Erfindungs-Fallback', () => {
  it('erfindet manufacturer_name NICHT mehr aus der Marke (Flag default false)', async () => {
    seedProduct('p-gate-1');
    getManufacturerGpsrByNameStub.mockResolvedValue({ ...REGISTRY_ENTRY_WITHOUT_NAME });

    const out = await getProduct('p-gate-1');
    expect(out).toBeTruthy();
    // Registry-Felder wurden enforced …
    expect(out.details.gpsr.manufacturer_address).toBe('Hauptstr. 1');
    // … aber der Name wird NICHT aus der Marke erfunden.
    expect(out.details.gpsr.manufacturer_name).toBeUndefined();
  });

  it('kopiert Beleg-Metadaten (provenance) aus dem Registry-Eintrag mit', async () => {
    seedProduct('p-gate-2');
    getManufacturerGpsrByNameStub.mockResolvedValue({ ...REGISTRY_ENTRY_WITHOUT_NAME });

    const out = await getProduct('p-gate-2');
    expect(out.details.gpsr.evidence).toEqual(expect.objectContaining({
      status: 'registry',
      registry_key: 'acme',
      sources: ['https://acme-example.de/impressum'],
    }));
  });

  it('ENV-Override RUNTIME_FLAG_GPSRBRANDNAMEFALLBACK=true stellt das alte Verhalten wieder her', async () => {
    process.env.RUNTIME_FLAG_GPSRBRANDNAMEFALLBACK = 'true';
    seedProduct('p-gate-3');
    getManufacturerGpsrByNameStub.mockResolvedValue({ ...REGISTRY_ENTRY_WITHOUT_NAME });

    const out = await getProduct('p-gate-3');
    expect(out.details.gpsr.manufacturer_name).toBe('ACME');
  });

  it('ein Registry-Eintrag MIT manufacturer_name bleibt unangetastet enforced', async () => {
    seedProduct('p-gate-4');
    getManufacturerGpsrByNameStub.mockResolvedValue({
      ...REGISTRY_ENTRY_WITHOUT_NAME,
      gpsr: { ...REGISTRY_ENTRY_WITHOUT_NAME.gpsr, manufacturer_name: 'ACME Instruments GmbH' },
    });

    const out = await getProduct('p-gate-4');
    expect(out.details.gpsr.manufacturer_name).toBe('ACME Instruments GmbH');
  });
});
