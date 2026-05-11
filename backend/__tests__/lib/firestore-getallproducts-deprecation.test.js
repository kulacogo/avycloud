'use strict';

/**
 * Tests for getAllProducts() deprecation wrapper — Phase D.0c (Schritt 1)
 * Plan: /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md
 * Runbook: docs/runbooks/d0c-throw-flip.md
 *
 * Scope (Schritt-1 wrapper — NOT the throw-flip):
 *   1. getAllProducts() emits a [DEPRECATED] console.warn line containing a
 *      stack trace, on every call.
 *   2. Backward-compat: the wrapper still resolves with the array of products
 *      (existing implementation behind the warning is untouched).
 *   3. The pre-D.0c audit-script (scripts/audit-getAllProducts-callers.js)
 *      still reports zero production + script callers (exit 0).
 *
 * Mocking strategy mirrors __tests__/lib/firestore-getAllProductsForTenant.test.js:
 * install a Firestore stub in require.cache BEFORE loading lib/firestore.js.
 * No vi.mock() (forbidden for CJS modules — see .claude/rules/workflow.md).
 */

const path = require('path');
const { execSync } = require('child_process');

// ─── 1. Controllable Firestore mock ────────────────────────────────────────

const queryState = {
  getResponse: { docs: [], empty: true, size: 0, forEach: () => {} },
};

function makeQuery() {
  return {
    where() { return makeQuery(); },
    orderBy() { return makeQuery(); },
    limit() { return makeQuery(); },
    get: () => Promise.resolve(queryState.getResponse),
  };
}

function makeCollection() {
  return {
    doc: () => ({}),
    where: () => makeQuery(),
    orderBy: () => makeQuery(),
    limit: () => makeQuery(),
    get: () => Promise.resolve(queryState.getResponse),
  };
}

function MockFirestore() {
  return {
    collection: () => makeCollection(),
    batch: () => ({ set() {}, update() {}, delete() {}, commit: () => Promise.resolve([]) }),
    runTransaction: async (fn) => fn({
      get: async () => ({ exists: false, data: () => ({}) }),
      set() {},
      update() {},
      delete() {},
    }),
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

try { require('@google-cloud/firestore'); } catch (_) { /* ok if not cached yet */ }
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

// Safe to load SUT now.
const { getAllProducts } = require('../../lib/firestore');

// ─── 2. Helpers ────────────────────────────────────────────────────────────

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

let warnSpy;

beforeEach(() => {
  setSnapshotDocs([]);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  if (warnSpy) warnSpy.mockRestore();
});

// ─── 3. Tests ──────────────────────────────────────────────────────────────

describe('getAllProducts() — deprecation wrapper (D.0c Schritt 1)', () => {
  it('emits a [DEPRECATED] console.warn with a stack trace on call', async () => {
    await getAllProducts();

    // Find at least one warn call carrying the [DEPRECATED] marker.
    const deprecatedCalls = warnSpy.mock.calls.filter((args) =>
      args.some((a) => typeof a === 'string' && a.includes('[DEPRECATED] getAllProducts()'))
    );
    expect(deprecatedCalls.length).toBeGreaterThanOrEqual(1);

    // The combined message MUST mention the migration target.
    const joined = deprecatedCalls.flat().join(' ');
    expect(joined).toMatch(/getAllProductsForTenant\(tenantId\)/);
    // ...and MUST include a stack trace (so silent callers are identifiable).
    expect(joined).toMatch(/getAllProducts deprecation|at [^\s]+/);
  });

  it('still returns the array of products for backward-compat (no throw)', async () => {
    setSnapshotDocs([
      makeDoc('p1', { id: 'p1', tenantId: 'tenant-A', name: 'Apple' }),
      makeDoc('p2', { id: 'p2', name: 'Banana' }),
    ]);

    const result = await getAllProducts();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
    // doc.id fallback applies when data lacks an id field.
    expect(result.find((p) => p.id === 'p2').name).toBe('Banana');
  });

  it('audit-script reports zero production + script callers (exit 0)', () => {
    const script = path.resolve(__dirname, '..', '..', 'scripts', 'audit-getAllProducts-callers.js');
    // Will throw if exit code != 0.
    const stdout = execSync(`node ${script}`, { encoding: 'utf8' });
    const report = JSON.parse(stdout);
    expect(report.production_caller_count).toBe(0);
    expect(report.script_caller_count).toBe(0);
  });
});
