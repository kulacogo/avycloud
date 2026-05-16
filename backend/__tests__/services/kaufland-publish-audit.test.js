'use strict';

/**
 * Service-level tests for services/kaufland-publish-audit.js.
 *
 * Uses require.cache patching (Vitest 4.x cannot mock CJS modules via
 * vi.mock(). See __tests__/services/kaufland-listings-sync.test.js for the
 * established pattern.)
 *
 * The audit service writes to Firestore collection `kaufland_publish_runs`.
 * We stub firestore.collection().doc() returning helpers that record into a
 * shared in-memory store so we can assert on full payloads.
 */

// vitest globals: true — describe/it/expect/vi are global.

// ─── Module-mock helper (require.cache patch) ─────────────────────────────
function installModuleMock(modulePath, mockExports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: mockExports,
    children: [],
    paths: [],
  };
  return resolved;
}

// ─── In-memory Firestore stand-in ─────────────────────────────────────────
const store = new Map(); // docId -> data
let autoIdCounter = 0;

function makeDocRef(docId) {
  return {
    id: docId,
    async set(payload) {
      store.set(docId, JSON.parse(JSON.stringify(payload)));
    },
    async get() {
      const exists = store.has(docId);
      const data = exists ? store.get(docId) : null;
      return { exists, data: () => data };
    },
    async update(patch) {
      const current = store.get(docId) || {};
      // Crudely emulate arrayUnion: detect our sentinel object and append.
      const next = { ...current };
      for (const [k, v] of Object.entries(patch)) {
        if (v && typeof v === 'object' && v.__op === 'arrayUnion') {
          const arr = Array.isArray(current[k]) ? [...current[k]] : [];
          for (const item of v.elements) arr.push(item);
          next[k] = arr;
        } else {
          next[k] = v;
        }
      }
      store.set(docId, next);
    },
  };
}

const mockFirestore = {
  collection: vi.fn((name) => {
    if (name !== 'kaufland_publish_runs') {
      // tests only exercise this single collection — guard against drift.
      throw new Error(`unexpected collection: ${name}`);
    }
    return {
      doc: (id) => {
        const docId = id || `run-${++autoIdCounter}`;
        return makeDocRef(docId);
      },
    };
  }),
};

installModuleMock('../../lib/firestore', { firestore: mockFirestore });

// Patch @google-cloud/firestore Timestamp + FieldValue sentinel
try {
  const gcpResolved = require.resolve('@google-cloud/firestore');
  const existing = require.cache[gcpResolved]?.exports || {};
  require.cache[gcpResolved] = {
    id: gcpResolved,
    filename: gcpResolved,
    loaded: true,
    exports: Object.assign({}, existing, {
      Timestamp: {
        now: () => ({ __mock: true, _seconds: 1700000000, _nanoseconds: 0, toMillis: () => 1700000000000 }),
        fromDate: (d) => ({ __mock: true, _seconds: Math.floor((d?.getTime?.() || 0) / 1000) }),
      },
      FieldValue: {
        arrayUnion: (...elements) => ({ __op: 'arrayUnion', elements }),
        arrayRemove: (...elements) => ({ __op: 'arrayRemove', elements }),
      },
    }),
    children: [],
    paths: [],
  };
} catch (_) {
  /* package not installed in test env — ignore */
}

// ─── SUT ──────────────────────────────────────────────────────────────────
const audit = require('../../services/kaufland-publish-audit');

beforeEach(() => {
  store.clear();
  autoIdCounter = 0;
  mockFirestore.collection.mockClear();
});

describe('kaufland-publish-audit.startRun', () => {
  it('persists tenantId, storefront, source, requestedCount, requestedProductIds and status=running', async () => {
    const runId = await audit.startRun({
      tenantId: 'trendocean',
      storefront: 'de',
      source: 'ui-bulk',
      requestedProductIds: ['p1', 'p2', 'p3'],
    });
    expect(typeof runId).toBe('string');
    expect(runId).toMatch(/^run-/);

    const doc = store.get(runId);
    expect(doc).toBeTruthy();
    expect(doc.tenantId).toBe('trendocean');
    expect(doc.storefront).toBe('de');
    expect(doc.source).toBe('ui-bulk');
    expect(doc.requestedCount).toBe(3);
    expect(doc.requestedProductIds).toEqual(['p1', 'p2', 'p3']);
    expect(doc.requestedProductIdsTruncated).toBe(false);
    expect(doc.status).toBe('running');
    expect(Array.isArray(doc.results)).toBe(true);
    expect(doc.results.length).toBe(0);
    expect(doc.startedAt).toBeTruthy();
    expect(doc.startedAtIso).toMatch(/T/);
  });

  it('caps requestedProductIds at 500 and flags truncated', async () => {
    const ids = Array.from({ length: 600 }, (_, i) => `prod-${i}`);
    const runId = await audit.startRun({
      tenantId: 't1',
      storefront: 'de',
      requestedProductIds: ids,
    });
    const doc = store.get(runId);
    expect(doc.requestedCount).toBe(600); // count stays correct
    expect(doc.requestedProductIds.length).toBe(500); // doc-stored list is capped
    expect(doc.requestedProductIdsTruncated).toBe(true);
  });

  it('throws when tenantId is missing', async () => {
    await expect(audit.startRun({ storefront: 'de', requestedProductIds: [] })).rejects.toThrow(/tenantId/);
  });

  it('defaults source to ui-bulk when omitted', async () => {
    const runId = await audit.startRun({ tenantId: 't1', storefront: 'de', requestedProductIds: [] });
    expect(store.get(runId).source).toBe('ui-bulk');
  });
});

describe('kaufland-publish-audit.appendResult', () => {
  it('arrayUnion-appends a result onto the run', async () => {
    const runId = await audit.startRun({
      tenantId: 't1',
      storefront: 'de',
      requestedProductIds: ['p1'],
    });
    await audit.appendResult({
      runId,
      productId: 'p1',
      sku: 'SKU-1',
      ok: true,
      status: 'created',
      reason: '',
      fixes: ['retitle'],
      idUnit: 4242,
      durationMs: 120,
      repaired: false,
    });

    const doc = store.get(runId);
    expect(doc.results).toHaveLength(1);
    const r = doc.results[0];
    expect(r.productId).toBe('p1');
    expect(r.sku).toBe('SKU-1');
    expect(r.ok).toBe(true);
    expect(r.status).toBe('created');
    expect(r.fixes).toEqual(['retitle']);
    expect(r.idUnit).toBe('4242'); // coerced to string
    expect(r.durationMs).toBe(120);
    expect(r.repaired).toBe(false);
    expect(r.at).toBeTruthy();
  });

  it('throws when the run does not exist', async () => {
    await expect(
      audit.appendResult({ runId: 'nonexistent', productId: 'p1', ok: false })
    ).rejects.toThrow(/not found/);
  });

  it('throws when runId is missing', async () => {
    await expect(audit.appendResult({ productId: 'p1', ok: false })).rejects.toThrow(/runId/);
  });
});

describe('kaufland-publish-audit.finalizeRun', () => {
  it('writes summary, status=completed, completedAt and durationMs', async () => {
    const runId = await audit.startRun({
      tenantId: 't1',
      storefront: 'de',
      requestedProductIds: ['p1', 'p2'],
    });
    await audit.appendResult({ runId, productId: 'p1', ok: true, status: 'created' });
    await audit.appendResult({ runId, productId: 'p2', ok: false, status: 'failed', reason: 'KAUFLAND_BLAH' });

    await audit.finalizeRun({
      runId,
      summary: { total: 2, success: 1, failed: 1, fixed: 0, pending: 0, skipped: 0, repaired: 0 },
    });

    const doc = store.get(runId);
    expect(doc.status).toBe('completed');
    expect(doc.summary).toEqual({
      total: 2,
      success: 1,
      failed: 1,
      fixed: 0,
      pending: 0,
      skipped: 0,
      repaired: 0,
    });
    expect(doc.completedAt).toBeTruthy();
    expect(doc.completedAtIso).toMatch(/T/);
    expect(typeof doc.durationMs).toBe('number');
    expect(doc.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('coerces missing summary fields to 0 rather than NaN', async () => {
    const runId = await audit.startRun({
      tenantId: 't1',
      storefront: 'de',
      requestedProductIds: [],
    });
    await audit.finalizeRun({ runId, summary: { success: 5 } });
    const doc = store.get(runId);
    expect(doc.summary.success).toBe(5);
    expect(doc.summary.total).toBe(0);
    expect(doc.summary.failed).toBe(0);
  });

  it('throws when the run does not exist', async () => {
    await expect(audit.finalizeRun({ runId: 'missing', summary: {} })).rejects.toThrow(/not found/);
  });
});
