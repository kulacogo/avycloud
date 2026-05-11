'use strict';

/**
 * Tests for getAllProductsV2ForTenant() — D.0c (V2-Collection Tenant Helper)
 *
 * Mirrors __tests__/lib/firestore-getAllProductsForTenant.test.js but exercises
 * the products_v2 path provided by lib/product-store.js. The helper is
 * additive — getAllProductsV2() must remain available unchanged.
 *
 * Contract under test:
 *   1. tenantId is mandatory (throws on missing/empty/non-string)
 *   2. issues a where('tenantId','==',tenantId) Firestore query on the
 *      products_v2 collection
 *   3. returns an array of product docs (empty array on no match)
 *   4. wraps Firestore-side errors (i.e. propagates them so callers can react)
 *   5. honors options.queryFn passthrough for further refinement
 *
 * Mocking strategy: require.cache patching for lib/firestore.js (the only
 * dependency `product-store.js` reads for Firestore access). No vi.mock —
 * see .claude/rules/workflow.md "vi.mock() für CJS Module ist verboten".
 */

const path = require('path');

// ─── 1. Build a controllable Firestore stub ─────────────────────────────────

const state = {
  whereCalls: [],
  collectionRequested: null,
  getResponse: { docs: [] },
  shouldThrowOnGet: false,
};

function makeQuery() {
  return {
    where(field, op, value) {
      state.whereCalls.push({ field, op, value });
      return makeQuery();
    },
    orderBy() { return makeQuery(); },
    limit() { return makeQuery(); },
    get() {
      if (state.shouldThrowOnGet) {
        return Promise.reject(new Error('firestore boom'));
      }
      const docs = (state.getResponse.docs || []).map((doc) => ({
        id: doc.id,
        data: () => doc.data,
      }));
      return Promise.resolve({
        docs,
        empty: docs.length === 0,
        size: docs.length,
        forEach: (cb) => docs.forEach(cb),
      });
    },
  };
}

const fakeFirestore = {
  collection(name) {
    state.collectionRequested = name;
    return {
      doc: () => ({ get: () => Promise.resolve({ exists: false, data: () => ({}) }) }),
      where(field, op, value) {
        state.whereCalls.push({ field, op, value });
        return makeQuery();
      },
      orderBy: () => makeQuery(),
      limit: () => makeQuery(),
      get: () => makeQuery().get(),
    };
  },
};

// Patch lib/firestore.js BEFORE product-store loads, so its `require('./firestore')`
// resolves to our stub.
const firestoreModulePath = path.resolve(__dirname, '..', '..', 'lib', 'firestore.js');
require.cache[firestoreModulePath] = {
  id: firestoreModulePath,
  filename: firestoreModulePath,
  loaded: true,
  exports: {
    firestore: fakeFirestore,
    saveProduct: async (p) => p,
    PRODUCTS_COLLECTION: 'products',
  },
  children: [],
  paths: [],
};

// Also patch product-canonical (transitively required by product-store) so the
// module loads cleanly even though we don't exercise saveProductV2 here.
const canonicalModulePath = path.resolve(__dirname, '..', '..', 'lib', 'product-canonical.js');
try {
  require.cache[canonicalModulePath] = {
    id: canonicalModulePath,
    filename: canonicalModulePath,
    loaded: true,
    exports: {
      normalizeProduct: (p) => p,
      validateCanonical: () => ({ valid: true, errors: [] }),
    },
    children: [],
    paths: [],
  };
} catch (_) { /* non-fatal */ }

const { getAllProductsV2ForTenant, getAllProductsV2 } = require('../../lib/product-store');

// ─── 2. Helpers ─────────────────────────────────────────────────────────────

function setDocs(docs) {
  state.getResponse = { docs };
}

beforeEach(() => {
  state.whereCalls = [];
  state.collectionRequested = null;
  state.getResponse = { docs: [] };
  state.shouldThrowOnGet = false;
});

// ─── 3. Tests ───────────────────────────────────────────────────────────────

describe('getAllProductsV2ForTenant — input validation', () => {
  it('throws when tenantId is missing (undefined)', async () => {
    await expect(getAllProductsV2ForTenant()).rejects.toThrow(/tenantId is required/);
  });

  it('throws when tenantId is null', async () => {
    await expect(getAllProductsV2ForTenant(null)).rejects.toThrow(/tenantId is required/);
  });

  it('throws when tenantId is an empty string', async () => {
    await expect(getAllProductsV2ForTenant('')).rejects.toThrow(/tenantId is required/);
  });

  it('throws when tenantId is whitespace-only', async () => {
    await expect(getAllProductsV2ForTenant('   ')).rejects.toThrow(/tenantId is required/);
  });

  it('throws when tenantId is not a string (number)', async () => {
    await expect(getAllProductsV2ForTenant(42)).rejects.toThrow(/non-empty string/);
  });
});

describe('getAllProductsV2ForTenant — query behaviour', () => {
  it('issues a where("tenantId","==",tenantId) query against products_v2', async () => {
    setDocs([]);
    await getAllProductsV2ForTenant('tenant-A');

    const tenantWhere = state.whereCalls.find((c) => c.field === 'tenantId');
    expect(tenantWhere).toBeDefined();
    expect(tenantWhere.op).toBe('==');
    expect(tenantWhere.value).toBe('tenant-A');
  });

  it('returns array of products when snapshot has docs', async () => {
    setDocs([
      { id: 'p1', data: { tenantId: 'tenant-A', name: 'Apple' } },
      { id: 'p2', data: { tenantId: 'tenant-A', name: 'Banana' } },
    ]);

    const result = await getAllProductsV2ForTenant('tenant-A');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
    expect(result.find((p) => p.id === 'p1').name).toBe('Apple');
  });

  it('returns empty array when no products match tenantId', async () => {
    setDocs([]);

    const result = await getAllProductsV2ForTenant('tenant-without-products');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('propagates Firestore-side errors so callers can react', async () => {
    state.shouldThrowOnGet = true;
    await expect(getAllProductsV2ForTenant('tenant-A')).rejects.toThrow(/firestore boom/);
  });

  it('honors options.queryFn passthrough for further refinement', async () => {
    setDocs([]);
    let received = null;
    await getAllProductsV2ForTenant('tenant-A', {
      queryFn: (q) => {
        received = q;
        // chain another where to confirm refinement is wired through
        return q.where('inventory.quantity', '>', 0);
      },
    });

    expect(received).not.toBeNull();
    // queryFn was called AFTER the tenantId where-clause → there should be
    // at least one tenantId entry plus our chained where.
    const fields = state.whereCalls.map((c) => c.field);
    expect(fields).toContain('tenantId');
    expect(fields).toContain('inventory.quantity');
  });
});

describe('getAllProductsV2ForTenant — additive contract', () => {
  it('does not replace getAllProductsV2 (both exports remain callable)', () => {
    expect(typeof getAllProductsV2).toBe('function');
    expect(typeof getAllProductsV2ForTenant).toBe('function');
  });
});
