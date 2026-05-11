'use strict';

/**
 * Tests for attachUserContext middleware — Phase D.0.
 *
 * Mocking strategy follows the repo convention (workflow.md): patch
 * `@google-cloud/firestore` in require.cache BEFORE loading the SUT, so the
 * `new Firestore(...)` call inside `lib/firestore.js` returns our controllable
 * stub. Vitest `vi.mock()` is NOT used (forbidden for CJS modules).
 *
 * @see backend/__tests__/lib/firestore-getAllProductsForTenant.test.js (same pattern)
 */

// ─── 1. Build a minimal, controllable Firestore mock ────────────────────────

const firestoreState = {
  // uid -> { exists, data }
  docs: new Map(),
  // call-counters for cache assertions
  getCalls: 0,
  // optional forced error for next get()
  nextError: null,
};

function makeDocSnapshot(payload) {
  if (!payload || payload.exists === false) {
    return { exists: false, data: () => undefined };
  }
  return { exists: true, data: () => payload.data || {} };
}

function makeFirestoreStub() {
  return {
    collection(name) {
      return {
        doc(uid) {
          return {
            async get() {
              firestoreState.getCalls += 1;
              if (firestoreState.nextError) {
                const err = firestoreState.nextError;
                firestoreState.nextError = null;
                throw err;
              }
              if (name !== 'users') {
                return makeDocSnapshot({ exists: false });
              }
              const payload = firestoreState.docs.get(uid);
              return makeDocSnapshot(payload);
            },
          };
        },
        where() { return this; },
        get: async () => ({ docs: [], empty: true, size: 0, forEach: () => {} }),
      };
    },
    batch: () => ({ set() {}, update() {}, delete() {}, commit: () => Promise.resolve([]) }),
    runTransaction: async (fn) => fn({
      get: async () => ({ exists: false, data: () => ({}) }),
      set() {}, update() {}, delete() {},
    }),
    doc: () => ({}),
  };
}

function MockFirestore() { return makeFirestoreStub(); }
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
const {
  attachUserContext,
  DEFAULT_TENANT_ID,
  _clearTenantCache,
} = require('../../lib/attach-user-context');

// ─── 2. Helpers ─────────────────────────────────────────────────────────────

function makeReq({ user } = {}) {
  return { user };
}

function makeRes() {
  return {};
}

function runMiddleware(req) {
  return new Promise((resolve, reject) => {
    try {
      attachUserContext(req, makeRes(), (err) => {
        if (err) return reject(err);
        resolve();
      });
    } catch (e) {
      reject(e);
    }
  });
}

beforeEach(() => {
  firestoreState.docs.clear();
  firestoreState.getCalls = 0;
  firestoreState.nextError = null;
  _clearTenantCache();
});

// ─── 3. Tests ───────────────────────────────────────────────────────────────

describe('attachUserContext — middleware behaviour', () => {
  it('sets tenantId from claims when present (no Firestore read)', async () => {
    const req = makeReq({
      user: { uid: 'u-1', claims: { tenantId: 'tenant-A' } },
    });

    await runMiddleware(req);

    expect(req.user.tenantId).toBe('tenant-A');
    expect(firestoreState.getCalls).toBe(0);
  });

  it('loads tenantId from users-Doc when claims absent', async () => {
    firestoreState.docs.set('u-2', { exists: true, data: { tenantId: 'tenant-B' } });
    const req = makeReq({ user: { uid: 'u-2', claims: {} } });

    await runMiddleware(req);

    expect(req.user.tenantId).toBe('tenant-B');
    expect(firestoreState.getCalls).toBe(1);
  });

  it("falls back to 'default' on Firestore-error", async () => {
    firestoreState.nextError = new Error('Firestore unavailable');
    const req = makeReq({ user: { uid: 'u-3', claims: {} } });

    await runMiddleware(req);

    expect(req.user.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(req.user.tenantId).toBe('default');
  });

  it("falls back to 'default' when user-doc has no tenantId", async () => {
    firestoreState.docs.set('u-4', { exists: true, data: { email: 'x@y.de' } });
    const req = makeReq({ user: { uid: 'u-4', claims: {} } });

    await runMiddleware(req);

    expect(req.user.tenantId).toBe('default');
  });

  it("falls back to 'default' when user-doc does not exist", async () => {
    // no firestoreState.docs.set — snapshot.exists === false
    const req = makeReq({ user: { uid: 'u-missing', claims: {} } });

    await runMiddleware(req);

    expect(req.user.tenantId).toBe('default');
    expect(firestoreState.getCalls).toBe(1);
  });

  it('caches lookups for 30s (second call hits cache, not Firestore)', async () => {
    firestoreState.docs.set('u-5', { exists: true, data: { tenantId: 'tenant-C' } });

    const req1 = makeReq({ user: { uid: 'u-5', claims: {} } });
    await runMiddleware(req1);
    expect(req1.user.tenantId).toBe('tenant-C');
    expect(firestoreState.getCalls).toBe(1);

    // Second request for same uid → cache hit, no extra Firestore call.
    const req2 = makeReq({ user: { uid: 'u-5', claims: {} } });
    await runMiddleware(req2);
    expect(req2.user.tenantId).toBe('tenant-C');
    expect(firestoreState.getCalls).toBe(1);

    // Third request for different uid → must hit Firestore.
    firestoreState.docs.set('u-5b', { exists: true, data: { tenantId: 'tenant-D' } });
    const req3 = makeReq({ user: { uid: 'u-5b', claims: {} } });
    await runMiddleware(req3);
    expect(req3.user.tenantId).toBe('tenant-D');
    expect(firestoreState.getCalls).toBe(2);
  });

  it('passes-through when req.user is missing', async () => {
    const req = makeReq({ user: undefined });
    await runMiddleware(req);

    // No throw, no decoration, no Firestore call.
    expect(req.user).toBeUndefined();
    expect(firestoreState.getCalls).toBe(0);
  });

  it('passes-through when req.user is null', async () => {
    const req = makeReq({ user: null });
    await runMiddleware(req);

    expect(req.user).toBeNull();
    expect(firestoreState.getCalls).toBe(0);
  });

  it('prefers claim over Firestore even if user-doc has a different tenantId', async () => {
    firestoreState.docs.set('u-6', { exists: true, data: { tenantId: 'from-firestore' } });
    const req = makeReq({
      user: { uid: 'u-6', claims: { tenantId: 'from-claim' } },
    });

    await runMiddleware(req);

    expect(req.user.tenantId).toBe('from-claim');
    expect(firestoreState.getCalls).toBe(0);
  });

  it("treats whitespace-only claim tenantId as absent and falls back", async () => {
    firestoreState.docs.set('u-7', { exists: true, data: { tenantId: 'tenant-E' } });
    const req = makeReq({
      user: { uid: 'u-7', claims: { tenantId: '   ' } },
    });

    await runMiddleware(req);

    expect(req.user.tenantId).toBe('tenant-E');
    expect(firestoreState.getCalls).toBe(1);
  });

  it('preserves existing req.user fields (additive only)', async () => {
    firestoreState.docs.set('u-8', { exists: true, data: { tenantId: 'tenant-F' } });
    const req = makeReq({
      user: {
        uid: 'u-8',
        email: 'admin@trendocean.de',
        isAdmin: true,
        emailVerified: true,
        claims: {},
      },
    });

    await runMiddleware(req);

    expect(req.user.uid).toBe('u-8');
    expect(req.user.email).toBe('admin@trendocean.de');
    expect(req.user.isAdmin).toBe(true);
    expect(req.user.emailVerified).toBe(true);
    expect(req.user.tenantId).toBe('tenant-F');
  });
});
