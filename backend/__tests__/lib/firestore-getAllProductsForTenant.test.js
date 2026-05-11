'use strict';

/**
 * Tests for getAllProductsForTenant() — Phase D.0a
 * (see /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md)
 *
 * The helper is additive: existing getAllProducts() must remain untouched.
 * We focus on the contract:
 *   1. tenantId is mandatory (throws on missing/empty/non-string)
 *   2. delegates to a Firestore where('tenantId','==',tenantId).get() query
 *   3. returns an array of product docs (empty array when no matches)
 *
 * Mocking strategy: install a Firestore stub in require.cache BEFORE loading
 * lib/firestore.js, so the module's `new Firestore(...)` call returns OUR
 * controllable client. This follows the repo convention (require.cache
 * patching, see __tests__/api/_patchGcp.js + workflow.md "vi.mock() für CJS
 * Module ist verboten").
 */

// ─── 1. Build a minimal, controllable Firestore mock ────────────────────────

const queryState = {
  // last where() args captured for assertion
  whereCalls: [],
  // controlled response for .get()
  getResponse: { docs: [], empty: true, size: 0, forEach: () => {} },
};

function makeQuery() {
  return {
    where(field, op, value) {
      queryState.whereCalls.push({ field, op, value });
      return makeQuery();
    },
    orderBy() { return makeQuery(); },
    limit() { return makeQuery(); },
    get() {
      const resp = queryState.getResponse;
      // Provide forEach over docs[] when the test set docs directly
      if (resp.docs && !resp.forEach) {
        resp.forEach = (cb) => resp.docs.forEach(cb);
        resp.size = resp.docs.length;
        resp.empty = resp.docs.length === 0;
      }
      return Promise.resolve(resp);
    },
  };
}

function makeCollection() {
  return {
    doc: () => ({}),
    where(field, op, value) {
      queryState.whereCalls.push({ field, op, value });
      return makeQuery();
    },
    orderBy: () => makeQuery(),
    limit: () => makeQuery(),
    get: () => Promise.resolve(queryState.getResponse),
  };
}

function MockFirestore() {
  return {
    collection: () => makeCollection(),
    batch: () => ({ set() {}, update() {}, delete() {}, commit: () => Promise.resolve([]) }),
    runTransaction: async (fn) => fn({ get: async () => ({ exists: false, data: () => ({}) }), set() {}, update() {}, delete() {} }),
    doc: () => ({}),
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

// Install the mock in require.cache BEFORE lib/firestore is loaded.
try { require('@google-cloud/firestore'); } catch (_) {}
const fsCacheKey = require.resolve('@google-cloud/firestore');
require.cache[fsCacheKey] = {
  id: fsCacheKey,
  filename: fsCacheKey,
  loaded: true,
  exports: {
    Firestore: MockFirestore,
    FieldValue: MockFirestore.FieldValue,
    Timestamp: MockFirestore.Timestamp,
  },
  children: [],
  paths: [],
};

// Now safe to load the SUT.
const { getAllProductsForTenant } = require('../../lib/firestore');

// ─── 2. Helpers ─────────────────────────────────────────────────────────────

function setSnapshotDocs(docs) {
  queryState.getResponse = {
    docs,
    empty: docs.length === 0,
    size: docs.length,
    forEach: (cb) => docs.forEach(cb),
  };
}

function makeDoc(id, data) {
  return { id, data: () => data };
}

beforeEach(() => {
  queryState.whereCalls = [];
  setSnapshotDocs([]);
});

// ─── 3. Tests ───────────────────────────────────────────────────────────────

describe('getAllProductsForTenant — input validation', () => {
  it('throws when tenantId is missing (undefined)', async () => {
    await expect(getAllProductsForTenant()).rejects.toThrow(/tenantId is required/);
  });

  it('throws when tenantId is null', async () => {
    await expect(getAllProductsForTenant(null)).rejects.toThrow(/tenantId is required/);
  });

  it('throws when tenantId is an empty string', async () => {
    await expect(getAllProductsForTenant('')).rejects.toThrow(/tenantId is required/);
  });

  it('throws when tenantId is whitespace-only', async () => {
    await expect(getAllProductsForTenant('   ')).rejects.toThrow(/tenantId is required/);
  });

  it('throws when tenantId is not a string (number)', async () => {
    await expect(getAllProductsForTenant(123)).rejects.toThrow(/non-empty string/);
  });

  it('throws when tenantId is not a string (object)', async () => {
    await expect(getAllProductsForTenant({ id: 'tenant-1' })).rejects.toThrow(/non-empty string/);
  });
});

describe('getAllProductsForTenant — query behaviour', () => {
  it('issues a where("tenantId","==",tenantId) Firestore query', async () => {
    setSnapshotDocs([]);
    await getAllProductsForTenant('tenant-A');

    const tenantWhere = queryState.whereCalls.find((c) => c.field === 'tenantId');
    expect(tenantWhere).toBeDefined();
    expect(tenantWhere.op).toBe('==');
    expect(tenantWhere.value).toBe('tenant-A');
  });

  it('returns array of products when snapshot has docs', async () => {
    // Firestore-side filter already restricts to tenant-A, so the snapshot
    // only contains the matching docs. We assert correct mapping (id + data).
    setSnapshotDocs([
      makeDoc('p1', { id: 'p1', tenantId: 'tenant-A', name: 'Apple' }),
      makeDoc('p2', { id: 'p2', tenantId: 'tenant-A', name: 'Banana' }),
    ]);

    const result = await getAllProductsForTenant('tenant-A');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
    expect(result.find((p) => p.id === 'p1').name).toBe('Apple');
  });

  it('uses doc.id as fallback when data has no id field', async () => {
    setSnapshotDocs([
      makeDoc('doc-id-fallback', { tenantId: 'tenant-A', name: 'NoIdInData' }),
    ]);

    const result = await getAllProductsForTenant('tenant-A');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('doc-id-fallback');
  });

  it('returns empty array when no products match tenantId (no throw)', async () => {
    setSnapshotDocs([]);

    const result = await getAllProductsForTenant('tenant-without-products');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('wraps Firestore errors into a descriptive Error', async () => {
    // Force the .get() call to reject by replacing getResponse with a thenable
    // that rejects.
    const original = queryState.getResponse;
    queryState.getResponse = {
      // Will be returned by query.get() — but our makeQuery().get() resolves
      // unconditionally. So instead, monkey-patch makeQuery.get for this test
      // by swapping getResponse to a Promise.reject via a custom forEach that
      // throws synchronously when Firestore tries to iterate.
      docs: [],
      empty: false,
      size: 1,
      forEach: () => { throw new Error('boom'); },
    };

    await expect(getAllProductsForTenant('tenant-A')).rejects.toThrow(/Failed to get products for tenant tenant-A/);

    queryState.getResponse = original;
  });
});
