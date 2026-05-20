'use strict';

/**
 * Unit-tests for lib/gpsr-gemini-lookup.js
 *
 * Mocks lib/gemini3-client.js (Gemini SDK wrapper) and @google-cloud/firestore
 * via require.cache patching — same Vitest-4.x-friendly pattern used elsewhere
 * in this repo.
 *
 * Vitest globals: true — describe/it/expect/vi are global.
 */

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

// ─── Mock lib/gemini3-client ──────────────────────────────────────────────
const gemini3GenerateJSONMock = vi.fn();
installModuleMock('../../lib/gemini3-client', {
  gemini3GenerateJSON: gemini3GenerateJSONMock,
});

// ─── Mock @google-cloud/firestore (in-memory cache) ───────────────────────
class FakeDocRef {
  constructor(store, id) { this._store = store; this._id = id; }
  async get() {
    const data = this._store.get(this._id);
    if (!data) return { exists: false };
    return { exists: true, data: () => data };
  }
  async set(data) { this._store.set(this._id, data); return; }
}
class FakeColRef {
  constructor(store) { this._store = store; }
  doc(id) { return new FakeDocRef(this._store, id); }
}
class FakeFirestore {
  constructor() { this._collections = new Map(); }
  collection(name) {
    if (!this._collections.has(name)) this._collections.set(name, new Map());
    return new FakeColRef(this._collections.get(name));
  }
}
let _fakeFirestoreInstance = null;
installModuleMock('@google-cloud/firestore', {
  Firestore: function FirestoreCtor() {
    if (!_fakeFirestoreInstance) _fakeFirestoreInstance = new FakeFirestore();
    return _fakeFirestoreInstance;
  },
  FieldValue: {},
});

// ─── SUT ───────────────────────────────────────────────────────────────────
const {
  lookupGpsrViaGemini,
  getOrFetchBrandGpsr,
  normalizeResponse,
  brandCacheKey,
  splitNormalized,
  CACHE_COLLECTION,
} = require('../../lib/gpsr-gemini-lookup');

beforeEach(() => {
  gemini3GenerateJSONMock.mockReset();
  if (_fakeFirestoreInstance) _fakeFirestoreInstance._collections.clear();
});

// ─── brandCacheKey ─────────────────────────────────────────────────────────
describe('brandCacheKey', () => {
  it('produces stable kebab-case ids', () => {
    expect(brandCacheKey('GANT')).toBe('gant');
    expect(brandCacheKey('TOMMY JEANS')).toBe('tommy-jeans');
    expect(brandCacheKey('Grana Home / EU')).toBe('grana-home-eu');
    expect(brandCacheKey('  ')).toBe('');
  });
});

// ─── normalizeResponse ─────────────────────────────────────────────────────
describe('normalizeResponse', () => {
  it('returns null on missing input', () => {
    expect(normalizeResponse(null)).toBeNull();
    expect(normalizeResponse({})).toBeNull(); // no useful fields → reject
  });

  it('coerces "null"/"n/a" string sentinels back to null', () => {
    const r = normalizeResponse({
      manufacturer_name: 'ACME GmbH',
      manufacturer_address: 'null',
      country_code: 'n/a',
      email: 'info@acme.de',
      confidence: 0.8,
    });
    expect(r.manufacturer_name).toBe('ACME GmbH');
    expect(r.manufacturer_address).toBeNull();
    expect(r.country_code).toBeNull();
    expect(r.email).toBe('info@acme.de');
  });

  it('uppercases ISO country codes', () => {
    const r = normalizeResponse({
      manufacturer_name: 'X',
      country_code: 'de',
      confidence: 0.9,
    });
    expect(r.country_code).toBe('DE');
  });
});

// ─── lookupGpsrViaGemini ───────────────────────────────────────────────────
describe('lookupGpsrViaGemini', () => {
  it('returns normalized GPSR when Gemini returns a high-confidence match', async () => {
    gemini3GenerateJSONMock.mockResolvedValueOnce({
      manufacturer_name: 'GANT International GmbH',
      manufacturer_address: 'Frankfurter Str. 12',
      manufacturer_city: 'Eschborn',
      manufacturer_postalcode: '65760',
      country_code: 'de',
      entity_country: 'Germany',
      email: 'info-de@gant.com',
      url: 'https://www.gant.de',
      confidence: 0.9,
    });

    const out = await lookupGpsrViaGemini('GANT');
    expect(out).not.toBeNull();
    expect(out.manufacturer_name).toBe('GANT International GmbH');
    expect(out.country_code).toBe('DE');
    expect(out.confidence).toBe(0.9);
    expect(gemini3GenerateJSONMock).toHaveBeenCalledTimes(1);
    const call = gemini3GenerateJSONMock.mock.calls[0][0];
    expect(call.prompt).toMatch(/GANT/);
    expect(call.schema).toEqual(expect.objectContaining({ type: 'object' }));
  });

  it('returns null when Gemini returns nothing useful (no name/address/email/url)', async () => {
    gemini3GenerateJSONMock.mockResolvedValueOnce({ confidence: 0.5 });
    const out = await lookupGpsrViaGemini('UnknownBrand');
    expect(out).toBeNull();
  });

  it('returns null when confidence is below MIN_CACHE_CONFIDENCE (0.3)', async () => {
    gemini3GenerateJSONMock.mockResolvedValueOnce({
      manufacturer_name: 'Maybe Inc.',
      confidence: 0.1,
    });
    const out = await lookupGpsrViaGemini('ObscureBrand');
    expect(out).toBeNull();
  });

  it('swallows Gemini errors and returns null', async () => {
    gemini3GenerateJSONMock.mockRejectedValueOnce(new Error('rate-limited'));
    const out = await lookupGpsrViaGemini('Foo');
    expect(out).toBeNull();
  });

  it('returns null on empty brand input', async () => {
    expect(await lookupGpsrViaGemini('')).toBeNull();
    expect(await lookupGpsrViaGemini(null)).toBeNull();
    expect(gemini3GenerateJSONMock).not.toHaveBeenCalled();
  });
});

// ─── getOrFetchBrandGpsr ───────────────────────────────────────────────────
describe('getOrFetchBrandGpsr', () => {
  it('caches the result so a second call does not hit Gemini', async () => {
    gemini3GenerateJSONMock.mockResolvedValueOnce({
      manufacturer_name: 'Desigual S.L.',
      manufacturer_address: 'Passeig del Mare Nostrum, 15',
      manufacturer_city: 'Barcelona',
      country_code: 'ES',
      email: 'help@desigual.com',
      url: 'https://www.desigual.com',
      confidence: 0.85,
    });

    const first = await getOrFetchBrandGpsr('Desigual');
    expect(first).not.toBeNull();
    expect(first.cached).toBe(false);
    expect(first.gpsr.manufacturer_name).toBe('Desigual S.L.');
    expect(gemini3GenerateJSONMock).toHaveBeenCalledTimes(1);

    // 2nd call → cache hit, no extra Gemini call
    const second = await getOrFetchBrandGpsr('Desigual');
    expect(second).not.toBeNull();
    expect(second.cached).toBe(true);
    expect(second.gpsr.manufacturer_name).toBe('Desigual S.L.');
    expect(gemini3GenerateJSONMock).toHaveBeenCalledTimes(1);
  });

  it('returns null + does NOT cache when Gemini gives no useful data', async () => {
    gemini3GenerateJSONMock.mockResolvedValueOnce({ confidence: 0.4 });
    const out = await getOrFetchBrandGpsr('NoSuchBrand');
    expect(out).toBeNull();

    // Verify nothing landed in the cache
    const cacheStore = _fakeFirestoreInstance._collections.get(CACHE_COLLECTION);
    expect(cacheStore == null || cacheStore.size === 0).toBe(true);
  });
});

// ─── splitNormalized ───────────────────────────────────────────────────────
describe('splitNormalized', () => {
  it('strips nulls and separates confidence', () => {
    const { gpsr, confidence } = splitNormalized({
      manufacturer_name: 'X',
      manufacturer_address: null,
      email: 'x@y.com',
      confidence: 0.7,
    });
    expect(gpsr).toEqual({ manufacturer_name: 'X', email: 'x@y.com' });
    expect(confidence).toBe(0.7);
  });
});
