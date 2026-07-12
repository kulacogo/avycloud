'use strict';

/**
 * Unit-tests for lib/hazmat-gemini-lookup.js
 *
 * Mocks lib/gemini3-client.js and @google-cloud/firestore via require.cache
 * patching (Vitest 4.x CJS pattern, siehe __tests__/lib/gpsr-gemini-lookup.test.js).
 * Der SDS-Verifikations-fetch wird per opts.fetchImpl injiziert.
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
  lookupHazmatViaGemini,
  getOrFetchHazmat,
  verifySdsUrl,
  normalizeSignalwort,
  normalizeClpEntry,
  normalizeClpList,
  normalizeResponse,
  eanCacheKey,
  isNegativeResult,
  CACHE_COLLECTION,
} = require('../../lib/hazmat-gemini-lookup');

// ─── fetch-Mock-Helper ─────────────────────────────────────────────────────
function makeFetchResponse({ ok = true, status = 200, contentType = 'application/pdf', body = '%PDF-1.7\nfake-pdf-content' } = {}) {
  const buf = Buffer.from(body, 'latin1');
  return {
    ok,
    status,
    headers: {
      get: (h) => {
        const key = String(h).toLowerCase();
        if (key === 'content-type') return contentType;
        if (key === 'content-length') return String(buf.length);
        return null;
      },
    },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

const pdfFetch = () => vi.fn(async () => makeFetchResponse());
const htmlFetch = () => vi.fn(async () => makeFetchResponse({
  contentType: 'text/html',
  body: '<html><head><title>Downloads</title></head><body>SDS Portal</body></html>',
}));

beforeEach(() => {
  gemini3GenerateJSONMock.mockReset();
  if (_fakeFirestoreInstance) _fakeFirestoreInstance._collections.clear();
});

// ─── eanCacheKey ───────────────────────────────────────────────────────────
describe('eanCacheKey', () => {
  it('reduces to digits-only and rejects invalid lengths', () => {
    expect(eanCacheKey('4064700302006')).toBe('4064700302006');
    expect(eanCacheKey(' 40647-00302006 ')).toBe('4064700302006');
    expect(eanCacheKey('1234567')).toBe(''); // < 8 Stellen
    expect(eanCacheKey('123456789012345')).toBe(''); // > 14 Stellen
    expect(eanCacheKey('')).toBe('');
    expect(eanCacheKey(null)).toBe('');
  });
});

// ─── (b) Signalwort-Normalisierung ─────────────────────────────────────────
describe('normalizeSignalwort', () => {
  it('accepts exactly the 3 Kaufland enum values', () => {
    expect(normalizeSignalwort('Gefahr')).toBe('Gefahr');
    expect(normalizeSignalwort('Achtung')).toBe('Achtung');
    expect(normalizeSignalwort('Kein Signalwort')).toBe('Kein Signalwort');
  });

  it('normalizes casing and english CLP equivalents', () => {
    expect(normalizeSignalwort('gefahr')).toBe('Gefahr');
    expect(normalizeSignalwort('ACHTUNG')).toBe('Achtung');
    expect(normalizeSignalwort('danger')).toBe('Gefahr');
    expect(normalizeSignalwort('Warning')).toBe('Achtung');
    expect(normalizeSignalwort('kein signalwort')).toBe('Kein Signalwort');
    expect(normalizeSignalwort('entfaellt')).toBe('Kein Signalwort');
  });

  it('rejects everything else → null', () => {
    expect(normalizeSignalwort('Vorsicht')).toBeNull();
    expect(normalizeSignalwort('Gefahr!!! Hochexplosiv')).toBeNull();
    expect(normalizeSignalwort('H226')).toBeNull();
    expect(normalizeSignalwort('')).toBeNull();
    expect(normalizeSignalwort(null)).toBeNull();
    expect(normalizeSignalwort('null')).toBeNull();
  });
});

// ─── (c) H/P-Satz-Format-Normalisierung ────────────────────────────────────
describe('normalizeClpEntry / normalizeClpList', () => {
  it('strips the colon after the code: "H226: text" → "H226 text"', () => {
    expect(normalizeClpEntry('H226: Flüssigkeit und Dampf entzündbar.', 'H'))
      .toBe('H226 Flüssigkeit und Dampf entzündbar.');
  });

  it('keeps already-correct entries unchanged', () => {
    expect(normalizeClpEntry('H226 Flüssigkeit und Dampf entzündbar.', 'H'))
      .toBe('H226 Flüssigkeit und Dampf entzündbar.');
  });

  it('normalizes combination codes with spaces: "P403 + P235: …"', () => {
    expect(normalizeClpEntry('P403 + P235: An einem gut belüfteten Ort aufbewahren. Kühl halten.', 'P'))
      .toBe('P403+P235 An einem gut belüfteten Ort aufbewahren. Kühl halten.');
  });

  it('accepts EUH codes in the H family', () => {
    expect(normalizeClpEntry('EUH208: Enthält Isothiazolinone. Kann allergische Reaktionen hervorrufen.', 'H'))
      .toBe('EUH208 Enthält Isothiazolinone. Kann allergische Reaktionen hervorrufen.');
  });

  it('rejects codes without text (never invents CLP text)', () => {
    expect(normalizeClpEntry('H226', 'H')).toBeNull();
    expect(normalizeClpEntry('H226:', 'H')).toBeNull();
  });

  it('rejects wrong-family and garbage entries', () => {
    expect(normalizeClpEntry('P280 Schutzhandschuhe tragen.', 'H')).toBeNull(); // P in H-Liste
    expect(normalizeClpEntry('H315 Verursacht Hautreizungen.', 'P')).toBeNull(); // H in P-Liste
    expect(normalizeClpEntry('Sehr gefährlich, nicht trinken!', 'H')).toBeNull();
    expect(normalizeClpEntry('null', 'H')).toBeNull();
  });

  it('dedupes and filters lists', () => {
    const out = normalizeClpList([
      'H226: Flüssigkeit und Dampf entzündbar.',
      'H226 Flüssigkeit und Dampf entzündbar.', // Duplikat nach Normalisierung
      'P280 Schutzhandschuhe tragen.', // falsche Familie
      'kompletter Unsinn',
    ], 'H');
    expect(out).toEqual(['H226 Flüssigkeit und Dampf entzündbar.']);
    expect(normalizeClpList(null, 'H')).toEqual([]);
    expect(normalizeClpList('H226 foo', 'H')).toEqual([]);
  });
});

// ─── (a) PDF-Verifikations-Guard ───────────────────────────────────────────
describe('verifySdsUrl', () => {
  it('accepts a response starting with %PDF-', async () => {
    const fetchImpl = pdfFetch();
    const res = await verifySdsUrl('https://example.com/sds.pdf', { fetchImpl });
    expect(res.ok).toBe(true);
    expect(res.checked).toBe(true);
    expect(res.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // Browser-artiger User-Agent muss gesetzt sein
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers['User-Agent']).toMatch(/Mozilla/);
  });

  it('rejects an HTML page (no guessing)', async () => {
    const res = await verifySdsUrl('https://example.com/downloads', { fetchImpl: htmlFetch() });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('not-pdf');
  });

  it('rejects non-2xx responses and fetch errors', async () => {
    const notFound = vi.fn(async () => makeFetchResponse({ ok: false, status: 404 }));
    expect((await verifySdsUrl('https://example.com/gone.pdf', { fetchImpl: notFound })).ok).toBe(false);

    const boom = vi.fn(async () => { throw new Error('ECONNRESET'); });
    const res = await verifySdsUrl('https://example.com/sds.pdf', { fetchImpl: boom });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ECONNRESET/);
  });

  it('rejects invalid URLs without fetching', async () => {
    const fetchImpl = pdfFetch();
    const res = await verifySdsUrl('ftp://example.com/sds.pdf', { fetchImpl });
    expect(res.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ─── lookupHazmatViaGemini ─────────────────────────────────────────────────
describe('lookupHazmatViaGemini', () => {
  const FULL_GEMINI_PAYLOAD = {
    sds_url: 'https://tecpo.example.com/sds/unterbodenschutz.pdf',
    signalwort: 'gefahr',
    h_saetze: ['H226: Flüssigkeit und Dampf entzündbar.'],
    p_saetze: ['P403 + P235: An einem gut belüfteten Ort aufbewahren. Kühl halten.'],
    confidence: 0.85,
    sources: ['https://tecpo.example.com/produkt/unterbodenschutz'],
  };

  it('(a) verified=true + verifiedSdsUrl when the SDS fetch returns a real PDF', async () => {
    gemini3GenerateJSONMock.mockResolvedValueOnce({ ...FULL_GEMINI_PAYLOAD });
    const fetchImpl = pdfFetch();

    const out = await lookupHazmatViaGemini({
      ean: '4064700302006', brand: 'TECPO', title: 'TECPO Unterbodenschutz 1L', fetchImpl,
    });

    expect(out).not.toBeNull();
    expect(out.verified).toBe(true);
    expect(out.verifiedSdsUrl).toBe('https://tecpo.example.com/sds/unterbodenschutz.pdf');
    expect(out.signalwort).toBe('Gefahr');
    expect(out.hSaetze).toEqual(['H226 Flüssigkeit und Dampf entzündbar.']);
    expect(out.pSaetze).toEqual(['P403+P235 An einem gut belüfteten Ort aufbewahren. Kühl halten.']);
    expect(out.confidence).toBe(0.85);
    expect(out.sources).toEqual(['https://tecpo.example.com/produkt/unterbodenschutz']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('(a) verified=false + verifiedSdsUrl=null when Gemini delivered an HTML page', async () => {
    gemini3GenerateJSONMock.mockResolvedValueOnce({ ...FULL_GEMINI_PAYLOAD });

    const out = await lookupHazmatViaGemini({
      ean: '4064700302006', brand: 'TECPO', title: 'TECPO Unterbodenschutz 1L', fetchImpl: htmlFetch(),
    });

    expect(out).not.toBeNull();
    expect(out.verified).toBe(false);
    expect(out.verifiedSdsUrl).toBeNull();
    expect(out.sdsUrl).toBe('https://tecpo.example.com/sds/unterbodenschutz.pdf'); // roh, unverifiziert
    expect(out.sdsVerification.error).toBe('not-pdf');
  });

  it('(e) no SDS found → verified=false and NO hSaetze (drops unbelegbare Sätze)', async () => {
    gemini3GenerateJSONMock.mockResolvedValueOnce({
      sds_url: '',
      signalwort: '',
      // Halluzinations-Szenario: Sätze OHNE auffindbares SDS → verwerfen
      h_saetze: ['H900 Frei erfundener Gefahrenhinweis.'],
      p_saetze: ['P101 Frei erfundener Sicherheitshinweis.'],
      confidence: 0.2,
      sources: [],
    });
    const fetchImpl = pdfFetch();

    const out = await lookupHazmatViaGemini({ ean: '4064700302006', title: 'Irgendein Produkt', fetchImpl });

    expect(out).not.toBeNull();
    expect(out.verified).toBe(false);
    expect(out.verifiedSdsUrl).toBeNull();
    expect(out.hSaetze).toEqual([]);
    expect(out.pSaetze).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled(); // nichts zu verifizieren
    expect(isNegativeResult(out)).toBe(true);
  });

  it('kennzeichnungsfrei: "Kein Signalwort" + leere Listen ist ein positives Ergebnis', async () => {
    gemini3GenerateJSONMock.mockResolvedValueOnce({
      sds_url: '',
      signalwort: 'Kein Signalwort',
      h_saetze: [],
      p_saetze: [],
      confidence: 0.7,
      sources: ['https://hersteller.example.com/produkt'],
    });

    const out = await lookupHazmatViaGemini({ ean: '4064700302006', title: 'Nagelpflegestift', fetchImpl: pdfFetch() });
    expect(out.signalwort).toBe('Kein Signalwort');
    expect(out.hSaetze).toEqual([]);
    expect(out.verified).toBe(false);
    expect(isNegativeResult(out)).toBe(false);
  });

  it('swallows Gemini errors → null', async () => {
    gemini3GenerateJSONMock.mockRejectedValueOnce(new Error('rate-limited'));
    const out = await lookupHazmatViaGemini({ ean: '4064700302006', title: 'X', fetchImpl: pdfFetch() });
    expect(out).toBeNull();
  });

  it('returns null on empty input without calling Gemini', async () => {
    expect(await lookupHazmatViaGemini({})).toBeNull();
    expect(await lookupHazmatViaGemini({ ean: '', brand: '', title: '' })).toBeNull();
    expect(gemini3GenerateJSONMock).not.toHaveBeenCalled();
  });

  it('requestedFields=["biozid"] adds the regulatory block — only with sources', async () => {
    gemini3GenerateJSONMock.mockResolvedValueOnce({
      sds_url: '',
      signalwort: '',
      h_saetze: [],
      p_saetze: [],
      confidence: 0.6,
      sources: [],
      biozid: 'Biozidprodukte vorsichtig verwenden. Vor Gebrauch stets Etikett und Produktinformationen lesen.',
      biozid_sources: ['https://www.baua.de/DE/Themen/anwendung.html'],
    });

    const out = await lookupHazmatViaGemini({
      ean: '4012345678901', brand: 'TerraDomi', title: 'TerraDomi Unkrautvernichter',
      requestedFields: ['biozid'], fetchImpl: pdfFetch(),
    });
    expect(out.regulatory).toEqual({
      biozid: 'Biozidprodukte vorsichtig verwenden. Vor Gebrauch stets Etikett und Produktinformationen lesen.',
      sources: ['https://www.baua.de/DE/Themen/anwendung.html'],
    });
    // Prompt + Schema muessen Biozid abdecken
    const call = gemini3GenerateJSONMock.mock.calls[0][0];
    expect(call.prompt).toMatch(/[Bb]iozid/);
    expect(call.schema.properties.biozid).toBeDefined();
    expect(call.model).toBe('gemini-3-flash-preview');
  });

  it('biozid WITHOUT source → biozid null (keine unbelegte Pflicht-Kennzeichnung)', async () => {
    gemini3GenerateJSONMock.mockResolvedValueOnce({
      sds_url: '',
      confidence: 0.6,
      biozid: 'Biozidprodukte vorsichtig verwenden.',
      biozid_sources: [],
    });

    const out = await lookupHazmatViaGemini({
      ean: '4012345678901', title: 'Unkrautvernichter', requestedFields: ['biozid'], fetchImpl: pdfFetch(),
    });
    expect(out.regulatory).toEqual({ biozid: null, sources: [] });
  });

  it('without requestedFields the schema stays biozid-free and regulatory is null', async () => {
    gemini3GenerateJSONMock.mockResolvedValueOnce({ sds_url: '', confidence: 0.5 });
    const out = await lookupHazmatViaGemini({ ean: '4064700302006', title: 'X', fetchImpl: pdfFetch() });
    expect(out.regulatory).toBeNull();
    const call = gemini3GenerateJSONMock.mock.calls[0][0];
    expect(call.schema.properties.biozid).toBeUndefined();
  });
});

// ─── (d) getOrFetchHazmat — Cache ──────────────────────────────────────────
describe('getOrFetchHazmat', () => {
  it('caches the result so a second call does not hit Gemini or fetch', async () => {
    gemini3GenerateJSONMock.mockResolvedValueOnce({
      sds_url: 'https://supplend.example.com/sds.pdf',
      signalwort: 'Achtung',
      h_saetze: ['H319: Verursacht schwere Augenreizung.'],
      p_saetze: ['P305 + P351 + P338: Bei Kontakt mit den Augen einige Minuten lang behutsam mit Wasser ausspülen.'],
      confidence: 0.9,
      sources: ['https://supplend.example.com/produkt'],
    });
    const fetchImpl = pdfFetch();

    const first = await getOrFetchHazmat({ ean: '4260123456789', brand: 'SUPPLEND', title: 'Nagelpflegestift', fetchImpl });
    expect(first).not.toBeNull();
    expect(first.cached).toBe(false);
    expect(first.verified).toBe(true);
    expect(first.hSaetze).toEqual(['H319 Verursacht schwere Augenreizung.']);
    expect(gemini3GenerateJSONMock).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // 2. Call → Cache-Hit, kein weiterer Gemini-/fetch-Call
    const second = await getOrFetchHazmat({ ean: '4260123456789', brand: 'SUPPLEND', title: 'Nagelpflegestift', fetchImpl });
    expect(second).not.toBeNull();
    expect(second.cached).toBe(true);
    expect(second.verified).toBe(true);
    expect(second.verifiedSdsUrl).toBe('https://supplend.example.com/sds.pdf');
    expect(second.hSaetze).toEqual(['H319 Verursacht schwere Augenreizung.']);
    expect(gemini3GenerateJSONMock).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('caches NEGATIVE results too (no SDS found → no retry per sync run)', async () => {
    gemini3GenerateJSONMock.mockResolvedValueOnce({ sds_url: '', confidence: 0.1, sources: [] });

    const first = await getOrFetchHazmat({ ean: '4064700302006', title: 'Nasenspülsalz', fetchImpl: pdfFetch() });
    expect(first.negative).toBe(true);
    expect(first.verified).toBe(false);
    expect(gemini3GenerateJSONMock).toHaveBeenCalledTimes(1);

    const second = await getOrFetchHazmat({ ean: '4064700302006', title: 'Nasenspülsalz', fetchImpl: pdfFetch() });
    expect(second.cached).toBe(true);
    expect(second.negative).toBe(true);
    expect(gemini3GenerateJSONMock).toHaveBeenCalledTimes(1);

    const cacheStore = _fakeFirestoreInstance._collections.get(CACHE_COLLECTION);
    expect(cacheStore.size).toBe(1);
    const doc = cacheStore.get('4064700302006');
    expect(doc.negative).toBe(true);
  });

  it('transient Gemini errors are NOT cached', async () => {
    gemini3GenerateJSONMock.mockRejectedValueOnce(new Error('503'));
    const out = await getOrFetchHazmat({ ean: '4064700302006', title: 'X', fetchImpl: pdfFetch() });
    expect(out).toBeNull();
    const cacheStore = _fakeFirestoreInstance._collections.get(CACHE_COLLECTION);
    expect(cacheStore == null || cacheStore.size === 0).toBe(true);
  });

  it('a cached entry without biozid research is a MISS for requestedFields=["biozid"]', async () => {
    // 1. Lauf ohne biozid
    gemini3GenerateJSONMock.mockResolvedValueOnce({ sds_url: '', confidence: 0.4 });
    await getOrFetchHazmat({ ean: '4012345678901', title: 'Unkrautvernichter', fetchImpl: pdfFetch() });
    expect(gemini3GenerateJSONMock).toHaveBeenCalledTimes(1);

    // 2. Lauf MIT biozid → muss neu recherchieren
    gemini3GenerateJSONMock.mockResolvedValueOnce({
      sds_url: '', confidence: 0.6,
      biozid: 'Biozidprodukte vorsichtig verwenden. Vor Gebrauch stets Etikett und Produktinformationen lesen.',
      biozid_sources: ['https://www.baua.de/foo'],
    });
    const out = await getOrFetchHazmat({
      ean: '4012345678901', title: 'Unkrautvernichter', requestedFields: ['biozid'], fetchImpl: pdfFetch(),
    });
    expect(gemini3GenerateJSONMock).toHaveBeenCalledTimes(2);
    expect(out.regulatory.biozid).toMatch(/Biozidprodukte vorsichtig verwenden/);

    // 3. Lauf MIT biozid → jetzt Cache-Hit
    const third = await getOrFetchHazmat({
      ean: '4012345678901', title: 'Unkrautvernichter', requestedFields: ['biozid'], fetchImpl: pdfFetch(),
    });
    expect(third.cached).toBe(true);
    expect(gemini3GenerateJSONMock).toHaveBeenCalledTimes(2);
  });

  it('without a valid EAN the lookup runs but nothing is cached', async () => {
    gemini3GenerateJSONMock.mockResolvedValue({ sds_url: '', confidence: 0.2 });
    const out = await getOrFetchHazmat({ brand: 'STOOLINK', title: 'Stuhl', fetchImpl: pdfFetch() });
    expect(out).not.toBeNull();
    const cacheStore = _fakeFirestoreInstance._collections.get(CACHE_COLLECTION);
    expect(cacheStore == null || cacheStore.size === 0).toBe(true);
  });
});

// ─── normalizeResponse (Rest-Kanten) ───────────────────────────────────────
describe('normalizeResponse', () => {
  it('returns null on non-object input', () => {
    expect(normalizeResponse(null)).toBeNull();
    expect(normalizeResponse('x')).toBeNull();
  });

  it('clamps confidence into 0..1 and rejects non-http sds urls', () => {
    const r = normalizeResponse({ sds_url: 'javascript:alert(1)', confidence: 7 });
    expect(r.sdsUrl).toBeNull();
    expect(r.confidence).toBe(1);
    const r2 = normalizeResponse({ confidence: -3 });
    expect(r2.confidence).toBe(0);
  });

  it('filters non-URL sources', () => {
    const r = normalizeResponse({
      confidence: 0.5,
      sources: ['https://a.example.com', 'kein-link', 'https://a.example.com'],
    });
    expect(r.sources).toEqual(['https://a.example.com']);
  });
});
