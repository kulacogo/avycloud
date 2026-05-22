'use strict';

/**
 * Tests for lib/kaufland-manufacturer-whitelist.js
 *
 * Mocks `lib/kaufland-api` (kauflandRequest) and `lib/firestore` (collection.doc)
 * via require.cache patching (Vitest 4.x CJS-friendly pattern, mirrors other
 * service tests in this repo).
 *
 * Coverage:
 *   1. exact case-insensitive match → returns Kauflands EXACT label
 *   2. no match (zero hits) → found:false, source:'api'
 *   3. cache-hit → no second API call
 *   4. cache stale (>30d) → re-fetches via API
 *   5. API-error → graceful return with source:'error', no throw
 */

// vitest globals: true — describe/it/expect/vi are global.

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

// ─── Mock kaufland-api.kauflandRequest ────────────────────────────────────
const kauflandRequestMock = vi.fn();
installModuleMock('../../lib/kaufland-api', {
  kauflandRequest: kauflandRequestMock,
});

// ─── Mock lib/firestore with an in-memory doc store ───────────────────────
// We use a simple Map<docId, data> so we can simulate cache hits/misses/stale.
const docStore = new Map();
const docGetMock = vi.fn();
const docSetMock = vi.fn();

function makeDocRef(docId) {
  return {
    id: docId,
    get: () => docGetMock(docId),
    set: (payload, opts) => docSetMock(docId, payload, opts),
  };
}

const collectionDocMock = vi.fn((docId) => makeDocRef(docId));
const collectionMock = vi.fn(() => ({ doc: collectionDocMock }));

installModuleMock('../../lib/firestore', {
  firestore: { collection: collectionMock },
});

// Default behaviours.
docGetMock.mockImplementation(async (docId) => {
  if (docStore.has(docId)) {
    return { exists: true, data: () => docStore.get(docId) };
  }
  return { exists: false, data: () => null };
});
docSetMock.mockImplementation(async (docId, payload, _opts) => {
  docStore.set(docId, { ...payload });
});

// ─── SUT ──────────────────────────────────────────────────────────────────
const whitelist = require('../../lib/kaufland-manufacturer-whitelist');

beforeEach(() => {
  kauflandRequestMock.mockReset();
  docGetMock.mockClear();
  docSetMock.mockClear();
  collectionMock.mockClear();
  collectionDocMock.mockClear();
  docStore.clear();
  whitelist.__resetForTests();
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe('findManufacturerInWhitelist', () => {
  it('returns Kauflands EXACT label when whitelist contains a case-insensitive match', async () => {
    // /attributes lookup returns a list with manufacturer entry id=21
    kauflandRequestMock.mockImplementation(async (method, path) => {
      if (path === '/attributes') {
        return { data: { data: [{ id_attribute: 21, name: 'manufacturer' }] } };
      }
      if (String(path).includes('/attributes/21/shared-set')) {
        return {
          data: {
            data: [
              { label: 'Brax', value: 'brax-id' },
              { label: 'Brax Sport', value: 'brax-sport-id' },
            ],
            pagination: { total: 16 },
          },
        };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await whitelist.findManufacturerInWhitelist('BRAX');

    expect(result.found).toBe(true);
    expect(result.exactMatch).toBe(true);
    expect(result.label).toBe('Brax'); // Kauflands EXAKTE Schreibweise, nicht "BRAX"
    expect(result.total).toBe(16);
    expect(result.source).toBe('api');
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it('returns found:false when whitelist returns zero matches', async () => {
    kauflandRequestMock.mockImplementation(async (method, path) => {
      if (path === '/attributes') {
        return { data: { data: [{ id_attribute: 21, name: 'manufacturer' }] } };
      }
      return { data: { data: [], pagination: { total: 0 } } };
    });

    const result = await whitelist.findManufacturerInWhitelist('namuk');

    expect(result.found).toBe(false);
    expect(result.exactMatch).toBe(false);
    expect(result.label).toBeNull();
    expect(result.total).toBe(0);
    expect(result.source).toBe('api');
  });

  it('returns cached result without re-calling the API when cache is fresh', async () => {
    // Pre-seed the cache with a fresh entry.
    const slug = 'brax';
    docStore.set(slug, {
      brand: 'BRAX',
      brand_lc: 'brax',
      found: true,
      label: 'Brax',
      exactMatch: true,
      total: 16,
      suggestions: [{ label: 'Brax', value: 'brax-id' }],
      storefront: 'de',
      locale: 'de-DE',
      lookedUpAt: { toMillis: () => Date.now() - 1000 }, // 1s old
    });

    const result = await whitelist.findManufacturerInWhitelist('BRAX');

    expect(result.found).toBe(true);
    expect(result.label).toBe('Brax');
    expect(result.source).toBe('cache');
    expect(kauflandRequestMock).not.toHaveBeenCalled();
  });

  it('re-fetches when cache is older than the TTL (30d)', async () => {
    const slug = 'brax';
    const thirtyOneDaysMs = 31 * 24 * 60 * 60 * 1000;
    docStore.set(slug, {
      brand: 'BRAX',
      brand_lc: 'brax',
      found: true,
      label: 'Brax-Old',
      exactMatch: true,
      total: 1,
      suggestions: [],
      storefront: 'de',
      locale: 'de-DE',
      lookedUpAt: { toMillis: () => Date.now() - thirtyOneDaysMs },
    });

    kauflandRequestMock.mockImplementation(async (method, path) => {
      if (path === '/attributes') {
        return { data: { data: [{ id_attribute: 21, name: 'manufacturer' }] } };
      }
      return {
        data: {
          data: [{ label: 'Brax', value: 'brax-id' }],
          pagination: { total: 16 },
        },
      };
    });

    const result = await whitelist.findManufacturerInWhitelist('BRAX');

    expect(result.source).toBe('api');
    expect(result.label).toBe('Brax');
    expect(kauflandRequestMock).toHaveBeenCalled();
  });

  it('returns gracefully with source:"error" when the whitelist API call throws', async () => {
    kauflandRequestMock.mockImplementation(async (method, path) => {
      if (path === '/attributes') {
        // Fallback to id=21 will be used.
        throw new Error('attribute discovery boom');
      }
      throw new Error('whitelist API exploded');
    });

    const result = await whitelist.findManufacturerInWhitelist('NewBrand');

    expect(result.found).toBe(false);
    expect(result.label).toBeNull();
    expect(result.source).toBe('error');
    expect(result.total).toBe(0);
    // Production safety: error never propagates.
  });
});

describe('getManufacturerAttributeId', () => {
  it('returns the id from /attributes when present', async () => {
    kauflandRequestMock.mockResolvedValueOnce({
      data: { data: [{ id_attribute: 42, name: 'Manufacturer' }] },
    });
    const id = await whitelist.getManufacturerAttributeId();
    expect(id).toBe(42);
  });

  it('falls back to 21 when /attributes call fails', async () => {
    kauflandRequestMock.mockRejectedValueOnce(new Error('attributes endpoint down'));
    const id = await whitelist.getManufacturerAttributeId();
    expect(id).toBe(21);
  });
});
