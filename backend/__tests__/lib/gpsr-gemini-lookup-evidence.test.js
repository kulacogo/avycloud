'use strict';

/**
 * Beleg-Pflicht im Gemini-GPSR-Lookup (AUDIT 2026-07-16):
 * lib/gpsr-gemini-lookup.js getOrFetchBrandGpsr muss VOR dem 30d-Cache-Write
 * lib/gpsr-evidence.js verifyGpsrRecord laufen lassen:
 *   - verified/partial → cachen MIT evidence-Feld
 *   - unverifiable     → cachen mit confidence<=0.3 UND unverified:true
 *   - infra_blocked    → NICHT cachen (transient)
 * Der Seiten-Abruf wird via opts.verifyFetchImpl injiziert (kein Netz in
 * Tests); ohne Injection bleibt unter Vitest das Legacy-Verhalten (eigener
 * Guard, Muster INTEGRATION_CREDENTIALS_STORE=off).
 *
 * Mocks: lib/gemini3-client + @google-cloud/firestore via require.cache
 * patching (CJS-Muster, kein vi.mock).
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
  getOrFetchBrandGpsr,
  CACHE_COLLECTION,
} = require('../../lib/gpsr-gemini-lookup');

// ─── Fixtures ──────────────────────────────────────────────────────────────

const GEMINI_RECORD = {
  manufacturer_name: 'ACME Instruments GmbH',
  manufacturer_address: 'Hauptstr. 12',
  manufacturer_city: 'Berlin',
  manufacturer_postalcode: '10115',
  country_code: 'DE',
  entity_country: 'Germany',
  email: 'info@acme-example.de',
  url: 'https://www.acme-example.de',
  confidence: 0.9,
};

// Impressum-Seite, die Name + Adress-Kern wirklich enthaelt (>=200 Zeichen).
const VERIFIED_PAGE_TEXT = [
  'Impressum',
  'ACME Instruments GmbH',
  'Hauptstraße 12',
  '10115 Berlin',
  'Deutschland',
  'Vertreten durch die Geschäftsführung. Registergericht Berlin-Charlottenburg, HRB 123456.',
  'Umsatzsteuer-Identifikationsnummer gemäß §27a UStG: DE123456789.',
  'Verantwortlich für den Inhalt nach § 55 Abs. 2 RStV: Max Beispiel.',
].join('\n');

// Seite ohne jeden Bezug zum Hersteller (>=200 Zeichen).
const UNRELATED_PAGE_TEXT = (
  'Lorem ipsum dolor sit amet, consetetur sadipscing elitr, sed diam nonumy ' +
  'eirmod tempor invidunt ut labore et dolore magna aliquyam erat, sed diam voluptua. '
).repeat(3);

function cacheStore() {
  return _fakeFirestoreInstance
    ? _fakeFirestoreInstance._collections.get(CACHE_COLLECTION)
    : null;
}

beforeEach(() => {
  gemini3GenerateJSONMock.mockReset();
  if (_fakeFirestoreInstance) _fakeFirestoreInstance._collections.clear();
});

describe('getOrFetchBrandGpsr — Beleg-Verifikation vor dem Cache-Write', () => {
  it('verified: cached MIT evidence-Feld, 2. Call kommt aus dem Cache inkl. evidence', async () => {
    gemini3GenerateJSONMock.mockResolvedValueOnce({ ...GEMINI_RECORD });
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200, text: VERIFIED_PAGE_TEXT, html: '', via: 'test',
    }));

    const first = await getOrFetchBrandGpsr('ACME Instruments', { verifyFetchImpl: fetchImpl });
    expect(first).not.toBeNull();
    expect(first.cached).toBe(false);
    expect(first.unverified).toBeUndefined();
    expect(first.evidence).toBeTruthy();
    expect(first.evidence.status).toBe('verified');
    expect(first.evidence.url).toBe('https://www.acme-example.de/');
    expect(first.gpsr.manufacturer_name).toBe('ACME Instruments GmbH');
    expect(fetchImpl).toHaveBeenCalled();

    const doc = cacheStore().get('acme-instruments');
    expect(doc).toBeTruthy();
    expect(doc.evidence.status).toBe('verified');
    expect(doc.unverified).toBeUndefined();
    expect(doc.confidence).toBe(0.9);

    const second = await getOrFetchBrandGpsr('ACME Instruments', { verifyFetchImpl: fetchImpl });
    expect(second.cached).toBe(true);
    expect(second.evidence.status).toBe('verified');
    expect(gemini3GenerateJSONMock).toHaveBeenCalledTimes(1);
  });

  it('unverifiable: cached NUR mit confidence<=0.3 und unverified:true (Negativ-Semantik)', async () => {
    gemini3GenerateJSONMock.mockResolvedValueOnce({ ...GEMINI_RECORD });
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200, text: UNRELATED_PAGE_TEXT, html: '', via: 'test',
    }));

    const out = await getOrFetchBrandGpsr('ACME Instruments', { verifyFetchImpl: fetchImpl });
    expect(out).not.toBeNull();
    expect(out.unverified).toBe(true);
    expect(out.confidence).toBeLessThanOrEqual(0.3);
    expect(out.evidence.status).toBe('unverifiable');

    const doc = cacheStore().get('acme-instruments');
    expect(doc).toBeTruthy();
    expect(doc.unverified).toBe(true);
    expect(doc.confidence).toBeLessThanOrEqual(0.3);
    expect(doc.evidence.status).toBe('unverifiable');

    // Negativ-Cache: 2. Call trifft den Cache (kein 2. Gemini-Call), traegt
    // aber weiterhin unverified:true → Konsumenten-Gates lehnen ab.
    const second = await getOrFetchBrandGpsr('ACME Instruments', { verifyFetchImpl: fetchImpl });
    expect(second.cached).toBe(true);
    expect(second.unverified).toBe(true);
    expect(gemini3GenerateJSONMock).toHaveBeenCalledTimes(1);
  });

  it('infra_blocked: wird NICHT gecacht — naechster Call fragt Gemini erneut', async () => {
    gemini3GenerateJSONMock.mockResolvedValue({ ...GEMINI_RECORD });
    const fetchImpl = vi.fn(async () => ({
      ok: false, status: 503, text: '', html: '', via: 'test',
    }));

    const out = await getOrFetchBrandGpsr('ACME Instruments', { verifyFetchImpl: fetchImpl });
    expect(out).not.toBeNull();
    expect(out.evidence.status).toBe('infra_blocked');
    expect(out.cached).toBe(false);

    const store = cacheStore();
    expect(store == null || store.size === 0).toBe(true);

    const second = await getOrFetchBrandGpsr('ACME Instruments', { verifyFetchImpl: fetchImpl });
    expect(second).not.toBeNull();
    expect(gemini3GenerateJSONMock).toHaveBeenCalledTimes(2);
  });

  it('Fake-Gate: suspekte persoenliche Freemail wird vor dem Cachen genullt', async () => {
    gemini3GenerateJSONMock.mockResolvedValueOnce({
      ...GEMINI_RECORD,
      email: 'okopp@gmail.com', // persoenliche Freemail als "Hersteller"-Kontakt
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200, text: VERIFIED_PAGE_TEXT, html: '', via: 'test',
    }));

    const out = await getOrFetchBrandGpsr('ACME Instruments', { verifyFetchImpl: fetchImpl });
    expect(out).not.toBeNull();
    expect(out.evidence.status).toBe('verified');
    expect(out.gpsr.email).toBeUndefined();
    expect(out.evidence.issues).toEqual(
      expect.arrayContaining([expect.stringMatching(/^suspect_email:/)])
    );

    const doc = cacheStore().get('acme-instruments');
    expect(doc.gpsr.email).toBeUndefined();
    expect(doc.gpsr.manufacturer_name).toBe('ACME Instruments GmbH');
  });

  it('ohne injizierten fetch bleibt unter Vitest das Legacy-Verhalten (kein evidence, kein Netz)', async () => {
    gemini3GenerateJSONMock.mockResolvedValueOnce({ ...GEMINI_RECORD });

    const out = await getOrFetchBrandGpsr('ACME Instruments');
    expect(out).not.toBeNull();
    expect(out.evidence).toBeUndefined();
    expect(out.unverified).toBeUndefined();

    // Legacy-Cache-Write ohne evidence-Feld (altes Verhalten byte-kompatibel).
    const doc = cacheStore().get('acme-instruments');
    expect(doc).toBeTruthy();
    expect(doc.evidence).toBeUndefined();
    expect(doc.unverified).toBeUndefined();
  });
});
