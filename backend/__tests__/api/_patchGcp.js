/**
 * Patches GCP npm packages in Node's require.cache BEFORE any lib/route
 * modules are loaded.  This works around Vitest 4.x's broken vi.mock() for
 * CJS modules by operating directly on Node's module system.
 *
 * HOW IT WORKS:
 *   require.cache is the single source of truth for CJS modules.
 *   When we preload a package and then replace its cache entry with a mock,
 *   every subsequent require() of that package returns our mock.
 *
 * USAGE (in test file, BEFORE requiring any app code):
 *   require('./_patchGcp');
 */

// ─── 1. Force-load the packages so they enter require.cache ──────────────────
// (If they fail to load due to missing credentials, that's fine — we'll
//  replace the cache entry anyway.)
try { require('@google-cloud/firestore'); } catch (_) {}
try { require('@google-cloud/storage'); } catch (_) {}
try { require('firebase-admin'); } catch (_) {}
try { require('google-auth-library'); } catch (_) {}

// ─── 2. Build mock implementations ──────────────────────────────────────────

function noop() {}
function noopAsync() { return Promise.resolve(); }

// -- Firestore mock --
const mockDoc = {
  get: vi.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
  set: vi.fn().mockResolvedValue({}),
  update: vi.fn().mockResolvedValue({}),
  delete: vi.fn().mockResolvedValue({}),
  collection: vi.fn(),
  onSnapshot: vi.fn((cb) => noop), // returns unsubscribe fn
};

const mockQuery = {
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  offset: vi.fn().mockReturnThis(),
  startAfter: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  get: vi.fn().mockResolvedValue({ docs: [], empty: true, size: 0, forEach: noop }),
};

const mockCol = {
  doc: vi.fn(() => ({ ...mockDoc })),
  add: vi.fn().mockResolvedValue({ id: 'mock-auto-id' }),
  where: vi.fn(() => ({ ...mockQuery })),
  orderBy: vi.fn(() => ({ ...mockQuery })),
  limit: vi.fn(() => ({ ...mockQuery })),
  get: vi.fn().mockResolvedValue({ docs: [], empty: true, size: 0, forEach: noop }),
};

function MockFirestore() {
  return {
    collection: vi.fn(() => ({ ...mockCol })),
    batch: vi.fn(() => ({
      set: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      commit: vi.fn().mockResolvedValue([]),
    })),
    runTransaction: vi.fn(async (fn) => {
      const tx = {
        get: vi.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
        set: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      };
      return fn(tx);
    }),
    doc: vi.fn(() => ({ ...mockDoc })),
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
  now: () => ({ seconds: Math.floor(Date.now() / 1000), nanoseconds: 0, toDate: () => new Date() }),
  fromDate: (d) => ({ seconds: Math.floor((d?.getTime?.() || Date.now()) / 1000), nanoseconds: 0, toDate: () => d || new Date() }),
};

const firestoreMockExports = {
  Firestore: MockFirestore,
  FieldValue: MockFirestore.FieldValue,
  Timestamp: MockFirestore.Timestamp,
};

// -- Storage mock --
const mockStream = { on: vi.fn().mockReturnThis(), end: vi.fn(), write: vi.fn() };
const mockFile = {
  save: vi.fn().mockResolvedValue(),
  delete: vi.fn().mockResolvedValue(),
  exists: vi.fn().mockResolvedValue([false]),
  getSignedUrl: vi.fn().mockResolvedValue(['https://mock-signed-url']),
  createWriteStream: vi.fn(() => mockStream),
  createReadStream: vi.fn(() => mockStream),
};
const mockBucket = {
  file: vi.fn(() => ({ ...mockFile })),
  upload: vi.fn().mockResolvedValue(),
  getFiles: vi.fn().mockResolvedValue([[]]),
  exists: vi.fn().mockResolvedValue([true]),
  makePublic: vi.fn().mockResolvedValue(),
  create: vi.fn().mockResolvedValue(),
  iam: { getPolicy: vi.fn().mockResolvedValue([{ bindings: [] }]), setPolicy: vi.fn().mockResolvedValue() },
};

function MockStorage() {
  return { bucket: vi.fn(() => ({ ...mockBucket })) };
}

const storageMockExports = { Storage: MockStorage };

// -- Firebase Admin mock --
const adminMockExports = {
  apps: [],
  initializeApp: vi.fn(),
  credential: {
    applicationDefault: vi.fn(),
    cert: vi.fn(),
  },
  auth: vi.fn(() => ({
    verifyIdToken: vi.fn().mockResolvedValue({ uid: 'test-uid' }),
    getUser: vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@test.com' }),
  })),
  firestore: vi.fn(() => new MockFirestore()),
};

// -- Google Auth Library mock --
const authMockExports = {
  GoogleAuth: vi.fn().mockImplementation(() => ({
    getClient: vi.fn().mockResolvedValue({}),
    getApplicationDefault: vi.fn().mockResolvedValue({}),
  })),
  OAuth2Client: vi.fn(),
};

// ─── 3. Replace require.cache entries ────────────────────────────────────────

function patchCache(moduleName, mockExports) {
  let cacheKey;
  try {
    cacheKey = require.resolve(moduleName);
  } catch (_) {
    // Module not installed — nothing to patch
    return;
  }
  require.cache[cacheKey] = {
    id: cacheKey,
    filename: cacheKey,
    loaded: true,
    exports: mockExports,
    children: [],
    paths: [],
  };
}

patchCache('@google-cloud/firestore', firestoreMockExports);
patchCache('@google-cloud/storage', storageMockExports);
patchCache('firebase-admin', adminMockExports);
patchCache('google-auth-library', authMockExports);

module.exports = {
  MockFirestore,
  MockStorage,
  mockDoc,
  mockCol,
  mockQuery,
  mockBucket,
  mockFile,
};
