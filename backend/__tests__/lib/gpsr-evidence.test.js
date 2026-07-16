'use strict';

/**
 * Unit-Tests fuer lib/gpsr-evidence.js — Beleg-Validierung fuer GPSR-Daten.
 *
 * Mockt @google-cloud/firestore via require.cache-Patching (Vitest 4.x CJS,
 * Vorbild: __tests__/lib/hazmat-gemini-lookup.test.js). Der Seiten-Abruf wird
 * per fetchImpl injiziert — kein Netz in Tests.
 *
 * Vitest globals: true — describe/it/expect/vi sind global.
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
  looksLikeFakePhone,
  looksLikeSuspectEmail,
  classifyImpressumUrl,
  buildCandidateUrls,
  evaluateGpsrPageEvidence,
  verifyGpsrRecord,
  getOrVerifyBrandGpsr,
  brandCacheKey,
  gpsrFingerprint,
  CACHE_COLLECTION,
} = require('../../lib/gpsr-evidence');

// ─── fetch-Fake-Helper ─────────────────────────────────────────────────────
// Signatur wie fetchPageForVerification: (url, { timeoutMs }) → { ok, status, text, html, via }
function fetchFake(handler) {
  return vi.fn(async (url) => {
    const res = typeof handler === 'function' ? handler(url) : handler;
    return { via: 'direct', text: '', html: '', ...res };
  });
}
const okPage = (html) => ({ ok: true, status: 200, html, text: html.replace(/<[^>]+>/g, ' ') });

const GPSR_FULL = {
  manufacturer_name: 'TECPO GmbH',
  manufacturer_address: 'Carl-Wery-Str. 34, 81739 München',
  email: 'info@tecpo.de',
  manufacturer_phone: '+49 89 80094450',
  url: 'https://www.tecpo.de',
};

const PAGE_FULL = [
  '<html><body><h1>Impressum</h1>',
  '<p>TECPO GmbH<br>Carl-Wery-Straße 34<br>81739 München<br>Deutschland</p>',
  '<p>E-Mail: info@tecpo.de — Telefon: +49 89 80094450</p>',
  '<p>Vertreten durch die Geschäftsführung. USt-IdNr. gemäß §27a UStG.</p>',
  '<p>Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV. Plattform der EU-Kommission zur Online-Streitbeilegung.</p>',
  '</body></html>',
].join('\n');

const PAGE_NAME_ONLY = [
  '<html><body><h1>Über uns</h1>',
  '<p>TECPO GmbH ist ein Anbieter von Werkstattbedarf und Additiven.</p>',
  '<p>Qualität und Service stehen im Mittelpunkt unseres Handelns, seit vielen Jahren beliefern wir Werkstätten in ganz Europa mit Produkten für Wartung und Pflege.</p>',
  '</body></html>',
].join('\n');

beforeEach(() => {
  if (_fakeFirestoreInstance) _fakeFirestoreInstance._collections.clear();
});

// ─── 1a. looksLikeFakePhone ────────────────────────────────────────────────
describe('looksLikeFakePhone', () => {
  it('flaggt aufsteigende/absteigende Sequenzen', () => {
    expect(looksLikeFakePhone('456789')).toBe(true);
    expect(looksLikeFakePhone('123456')).toBe(true);
    expect(looksLikeFakePhone('654321')).toBe(true);
    // Audit-Muster: "+496105456789" — 456789-Kern
    expect(looksLikeFakePhone('+496105456789')).toBe(true);
    expect(looksLikeFakePhone('+49 6105 456789')).toBe(true);
  });

  it('flaggt Wiederholungs-Platzhalter', () => {
    expect(looksLikeFakePhone('000000000')).toBe(true);
    expect(looksLikeFakePhone('+49 111 111 111')).toBe(true);
  });

  it('flaggt eindeutig zu kurze Nummern', () => {
    expect(looksLikeFakePhone('12345')).toBe(true);
    expect(looksLikeFakePhone('+49 61')).toBe(true);
  });

  it('laesst echte Nummern durch (konservativ)', () => {
    expect(looksLikeFakePhone('+49 89 80094450')).toBe(false);
    expect(looksLikeFakePhone('+498980094450')).toBe(false);
    expect(looksLikeFakePhone('089 12345')).toBe(false); // 5er-Sequenz reicht NICHT
    expect(looksLikeFakePhone('+1 408 996 1010')).toBe(false);
    expect(looksLikeFakePhone('0049 30 901820')).toBe(false);
  });

  it('leerer/ziffernloser Input ist kein Fake-Urteil', () => {
    expect(looksLikeFakePhone('')).toBe(false);
    expect(looksLikeFakePhone(null)).toBe(false);
    expect(looksLikeFakePhone(undefined)).toBe(false);
    expect(looksLikeFakePhone('kein telefon')).toBe(false);
  });
});

// ─── 1b. looksLikeSuspectEmail ─────────────────────────────────────────────
describe('looksLikeSuspectEmail', () => {
  it('Domain-Match + persoenliches Prefix = ok mit Hinweis personal_mailbox', () => {
    const byUrl = looksLikeSuspectEmail('okopp@apple.com', { manufacturerUrl: 'https://www.apple.com/de' });
    expect(byUrl.suspect).toBe(false);
    expect(byUrl.issues).toContain('personal_mailbox');

    const byBrand = looksLikeSuspectEmail('okopp@apple.com', { brand: 'Apple' });
    expect(byBrand.suspect).toBe(false);
    expect(byBrand.issues).toContain('personal_mailbox');
  });

  it('persoenliche Freemail-Adresse als Hersteller-Kontakt → suspect', () => {
    const r = looksLikeSuspectEmail('foo@gmail.com', { brand: 'Bosch' });
    expect(r.suspect).toBe(true);
    expect(r.reason).toBe('personal_freemail');
  });

  it('Business-Prefix auf Freemail → ok, nur Hinweis generic_provider', () => {
    const r = looksLikeSuspectEmail('info@gmail.com', { brand: 'Bosch' });
    expect(r.suspect).toBe(false);
    expect(r.issues).toContain('generic_provider');
  });

  it('fremde Firmen-Domain → suspect (auch mit info@/service@)', () => {
    const service = looksLikeSuspectEmail('service@apple.com', {
      brand: 'Bosch', manufacturerUrl: 'https://www.bosch.de',
    });
    expect(service.suspect).toBe(true);
    expect(service.reason).toBe('foreign_domain');

    const personal = looksLikeSuspectEmail('okopp@apple.com', { brand: 'Bosch' });
    expect(personal.suspect).toBe(true);
    expect(personal.reason).toBe('foreign_domain_personal');
  });

  it('brand-aehnliche Domains gelten als Match (bosch-home.com fuer Bosch GmbH)', () => {
    const r = looksLikeSuspectEmail('info@bosch-home.com', { brand: 'Bosch GmbH' });
    expect(r.suspect).toBe(false);
    expect(r.reason).toBe('domain_match');
  });

  it('ohne jede Referenz kein Urteil (konservativ)', () => {
    const r = looksLikeSuspectEmail('okopp@apple.com', {});
    expect(r.suspect).toBe(false);
    expect(r.reason).toBe('no_reference');
  });

  it('ungueltige/leere E-Mails werden nicht als suspect geflaggt', () => {
    expect(looksLikeSuspectEmail('', { brand: 'X' }).suspect).toBe(false);
    expect(looksLikeSuspectEmail(null, { brand: 'X' }).suspect).toBe(false);
    const invalid = looksLikeSuspectEmail('not-an-email', { brand: 'X' });
    expect(invalid.suspect).toBe(false);
    expect(invalid.issues).toContain('invalid_email_format');
  });
});

// ─── 1c. classifyImpressumUrl ──────────────────────────────────────────────
describe('classifyImpressumUrl', () => {
  it('Hersteller-Domains + Impressum-/Kontakt-/Legal-/About-Pfade sind tauglich', () => {
    expect(classifyImpressumUrl('https://www.tecpo.de/impressum').kind).toBe('candidate');
    expect(classifyImpressumUrl('https://www.tecpo.de/impressum').reason).toBe('impressum_path');
    expect(classifyImpressumUrl('https://tecpo.de/kontakt').kind).toBe('candidate');
    expect(classifyImpressumUrl('https://tecpo.de/legal-notice').kind).toBe('candidate');
    expect(classifyImpressumUrl('https://tecpo.de/about').kind).toBe('candidate');
    expect(classifyImpressumUrl('https://www.tecpo.de/').kind).toBe('candidate');
  });

  it('Such-/Kategorie-URLs sind untauglich', () => {
    expect(classifyImpressumUrl('https://www.google.com/search?q=tecpo+impressum').kind).toBe('search');
    expect(classifyImpressumUrl('https://www.tecpo.de/products?search=oil').kind).toBe('search');
    expect(classifyImpressumUrl('https://shop.example.com/category/oil/').kind).toBe('search');
  });

  it('Social- und Marktplatz-URLs sind untauglich', () => {
    expect(classifyImpressumUrl('https://www.facebook.com/tecpo').kind).toBe('social');
    expect(classifyImpressumUrl('https://www.instagram.com/tecpo/').kind).toBe('social');
    expect(classifyImpressumUrl('https://www.ebay.de/itm/1234567890').kind).toBe('marketplace');
    expect(classifyImpressumUrl('https://www.amazon.de/dp/B0ABCDEF').kind).toBe('marketplace');
    expect(classifyImpressumUrl('https://www.kaufland.de/product/12345/').kind).toBe('marketplace');
  });

  it('Bilder und Nicht-URLs sind invalid/image', () => {
    expect(classifyImpressumUrl('https://cdn.gstatic.com/logo').kind).toBe('image');
    expect(classifyImpressumUrl('https://tecpo.de/logo.png').kind).toBe('image');
    expect(classifyImpressumUrl('').kind).toBe('invalid');
    expect(classifyImpressumUrl('kein link').kind).toBe('invalid');
    expect(classifyImpressumUrl('ftp://tecpo.de/impressum').kind).toBe('invalid');
  });
});

// ─── buildCandidateUrls ────────────────────────────────────────────────────
describe('buildCandidateUrls', () => {
  it('liefert Original-URL + https-Impressum-Varianten, dedupliziert', () => {
    const urls = buildCandidateUrls('https://www.tecpo.de');
    expect(urls[0]).toBe('https://www.tecpo.de/');
    expect(urls).toContain('https://www.tecpo.de/impressum');
    expect(urls).toContain('https://www.tecpo.de/imprint');
    expect(urls).toContain('https://www.tecpo.de/kontakt');
    expect(urls).toContain('https://www.tecpo.de/about');
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('akzeptiert URLs ohne Protokoll', () => {
    const urls = buildCandidateUrls('tecpo.de/impressum');
    expect(urls.length).toBeGreaterThan(0);
    expect(urls[0]).toBe('https://tecpo.de/impressum');
  });

  it('untaugliche Domains (Social/Marktplatz) ergeben KEINE Kandidaten', () => {
    expect(buildCandidateUrls('https://www.facebook.com/tecpo')).toEqual([]);
    expect(buildCandidateUrls('https://www.ebay.de/usr/tecpo')).toEqual([]);
    expect(buildCandidateUrls('')).toEqual([]);
    expect(buildCandidateUrls('kein link')).toEqual([]);
  });
});

// ─── evaluateGpsrPageEvidence ──────────────────────────────────────────────
describe('evaluateGpsrPageEvidence', () => {
  it('matcht Name + Adresse diakritik-tolerant (Str. ↔ Straße, München ↔ Muenchen-Normalisierung)', () => {
    const page = okPage(PAGE_FULL);
    const ev = evaluateGpsrPageEvidence({ text: page.text, html: page.html, gpsr: GPSR_FULL });
    expect(ev.ok).toBe(true);
    expect(ev.nameMatch).toBe(true);
    expect(ev.addressMatch).toBe(true);
    expect(ev.emailMatch).toBe('confirmed');
    expect(ev.phoneMatch).toBe('confirmed');
  });

  it('leere/zu kurze Seiten sind kein Beleg', () => {
    const ev = evaluateGpsrPageEvidence({ text: 'TECPO', html: '', gpsr: GPSR_FULL });
    expect(ev.ok).toBe(false);
    expect(ev.reason).toBe('page_empty');
  });
});

// ─── 2. verifyGpsrRecord ───────────────────────────────────────────────────
describe('verifyGpsrRecord', () => {
  it('Seite enthaelt Name+Adresse → verified mit evidence-Metadaten', async () => {
    const fetchImpl = fetchFake(() => okPage(PAGE_FULL));
    const out = await verifyGpsrRecord({ brand: 'TECPO', gpsr: GPSR_FULL, fetchImpl });

    expect(out.status).toBe('verified');
    expect(out.matchedFields.name).toBe(true);
    expect(out.matchedFields.address).toBe(true);
    expect(out.matchedFields.email).toBe('confirmed');
    expect(out.matchedFields.phone).toBe('confirmed');
    expect(out.evidence.url).toMatch(/tecpo\.de/);
    expect(out.evidence.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.evidence.method).toBe('direct');
    expect(out.issues).toEqual([]);
    // Erster Kandidat belegt bereits → frueher Ausstieg, genau 1 Abruf
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Timeout wird an den Fetcher durchgereicht
    expect(fetchImpl.mock.calls[0][1].timeoutMs).toBe(15000);
  });

  it('nur Name belegt → partial (alle Kandidaten werden probiert)', async () => {
    const fetchImpl = fetchFake(() => okPage(PAGE_NAME_ONLY));
    const out = await verifyGpsrRecord({ brand: 'TECPO', gpsr: GPSR_FULL, fetchImpl });

    expect(out.status).toBe('partial');
    expect(out.matchedFields.name).toBe(true);
    expect(out.matchedFields.address).toBe(false);
    expect(out.evidence.url).toMatch(/tecpo\.de/);
    expect(fetchImpl).toHaveBeenCalledTimes(4); // default maxPages
  });

  it('404 ist Evidenz GEGEN die Quelle → unverifiable', async () => {
    const fetchImpl = fetchFake({ ok: false, status: 404 });
    const out = await verifyGpsrRecord({ brand: 'TECPO', gpsr: GPSR_FULL, fetchImpl });
    expect(out.status).toBe('unverifiable');
    expect(out.evidence).toBeNull();
  });

  it('403/Infra auf ALLEN Kandidaten → infra_blocked (NIE unverifiable)', async () => {
    const fetchImpl = fetchFake({ ok: false, status: 403 });
    const out = await verifyGpsrRecord({ brand: 'TECPO', gpsr: GPSR_FULL, fetchImpl });
    expect(out.status).toBe('infra_blocked');
    expect(out.issues).toContain('fetch_infrastructure_failure');
    expect(out.evidence).toBeNull();
  });

  it('Infra auf einem Kandidaten blockt nicht: /impressum liefert den Beleg', async () => {
    const fetchImpl = fetchFake((url) => (
      url.endsWith('/impressum') ? okPage(PAGE_FULL) : { ok: false, status: 403 }
    ));
    const out = await verifyGpsrRecord({ brand: 'TECPO', gpsr: GPSR_FULL, fetchImpl });
    expect(out.status).toBe('verified');
    expect(out.evidence.url).toBe('https://www.tecpo.de/impressum');
  });

  it('Fake-Phone wird IMMER genullt — auch bei infra_blocked; Input bleibt unveraendert', async () => {
    const gpsr = { ...GPSR_FULL, manufacturer_phone: '+496105456789' };
    const fetchImpl = fetchFake({ ok: false, status: 403 });
    const out = await verifyGpsrRecord({ brand: 'TECPO', gpsr, fetchImpl });

    expect(out.status).toBe('infra_blocked');
    expect(out.issues).toContain('fake_phone_pattern');
    expect(out.gpsr.manufacturer_phone).toBeNull();
    // Feld-Bereinigung ist Vorschlag am RUECKGABE-Objekt, kein Input-Mutieren
    expect(gpsr.manufacturer_phone).toBe('+496105456789');
  });

  it('suspecte E-Mail wird genullt (okopp@gmail.com als Hersteller-Kontakt)', async () => {
    const gpsr = { ...GPSR_FULL, email: 'okopp@gmail.com' };
    const fetchImpl = fetchFake(() => okPage(PAGE_FULL));
    const out = await verifyGpsrRecord({ brand: 'TECPO', gpsr, fetchImpl });

    expect(out.status).toBe('verified');
    expect(out.gpsr.email).toBeNull();
    expect(out.issues).toContain('suspect_email:personal_freemail');
  });

  it('ohne url → unverifiable, Fake-Gates laufen trotzdem', async () => {
    const gpsr = {
      manufacturer_name: 'TECPO GmbH',
      manufacturer_address: 'Carl-Wery-Str. 34, 81739 München',
      manufacturer_phone: '123456',
    };
    const fetchImpl = fetchFake(() => okPage(PAGE_FULL));
    const out = await verifyGpsrRecord({ brand: 'TECPO', gpsr, fetchImpl });

    expect(out.status).toBe('unverifiable');
    expect(out.issues).toContain('no_candidate_urls');
    expect(out.issues).toContain('fake_phone_pattern');
    expect(out.gpsr.manufacturer_phone).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ohne manufacturer_name kein Verifikationsversuch → unverifiable', async () => {
    const fetchImpl = fetchFake(() => okPage(PAGE_FULL));
    const out = await verifyGpsrRecord({
      brand: 'TECPO',
      gpsr: { manufacturer_address: 'Carl-Wery-Str. 34', url: 'https://www.tecpo.de' },
      fetchImpl,
    });
    expect(out.status).toBe('unverifiable');
    expect(out.issues).toContain('no_manufacturer_name');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('geworfene fetch-Fehler zaehlen als Infra', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNRESET'); });
    const out = await verifyGpsrRecord({ brand: 'TECPO', gpsr: GPSR_FULL, fetchImpl });
    expect(out.status).toBe('infra_blocked');
    expect(out.attempts.every((a) => a.infra)).toBe(true);
  });
});

// ─── 3. getOrVerifyBrandGpsr — Cache ───────────────────────────────────────
describe('getOrVerifyBrandGpsr', () => {
  it('cached verified-Ergebnisse: zweiter Call laeuft ohne Netz', async () => {
    const fetch1 = fetchFake(() => okPage(PAGE_FULL));
    const first = await getOrVerifyBrandGpsr({ brand: 'TECPO', gpsr: GPSR_FULL, fetchImpl: fetch1 });
    expect(first.status).toBe('verified');
    expect(first.cached).toBe(false);
    expect(first.negative).toBe(false);
    expect(fetch1).toHaveBeenCalledTimes(1);

    const store = _fakeFirestoreInstance._collections.get(CACHE_COLLECTION);
    expect(store.size).toBe(1);
    const doc = store.get(brandCacheKey('TECPO'));
    expect(doc.status).toBe('verified');
    expect(doc.negative).toBe(false);
    expect(doc.fingerprint).toBe(gpsrFingerprint(GPSR_FULL));

    const fetch2 = fetchFake(() => okPage(PAGE_FULL));
    const second = await getOrVerifyBrandGpsr({ brand: 'TECPO', gpsr: GPSR_FULL, fetchImpl: fetch2 });
    expect(second.cached).toBe(true);
    expect(second.status).toBe('verified');
    expect(second.evidence.url).toMatch(/tecpo\.de/);
    expect(fetch2).not.toHaveBeenCalled();
  });

  it('cached NEGATIVE Ergebnisse (unverifiable) — kein Dauer-Retry pro Lauf', async () => {
    const fetch1 = fetchFake({ ok: false, status: 404 });
    const first = await getOrVerifyBrandGpsr({ brand: 'NOBRAND', gpsr: GPSR_FULL, fetchImpl: fetch1 });
    expect(first.status).toBe('unverifiable');
    expect(first.negative).toBe(true);

    const fetch2 = fetchFake({ ok: false, status: 404 });
    const second = await getOrVerifyBrandGpsr({ brand: 'NOBRAND', gpsr: GPSR_FULL, fetchImpl: fetch2 });
    expect(second.cached).toBe(true);
    expect(second.negative).toBe(true);
    expect(fetch2).not.toHaveBeenCalled();
  });

  it('cached infra_blocked NIE (transient) — naechster Call prueft erneut', async () => {
    const fetch1 = fetchFake({ ok: false, status: 403 });
    const first = await getOrVerifyBrandGpsr({ brand: 'TECPO', gpsr: GPSR_FULL, fetchImpl: fetch1 });
    expect(first.status).toBe('infra_blocked');

    const store = _fakeFirestoreInstance._collections.get(CACHE_COLLECTION);
    expect(store == null || store.size === 0).toBe(true);

    // Infrastruktur wieder gesund → jetzt echtes Urteil + Cache-Write
    const fetch2 = fetchFake(() => okPage(PAGE_FULL));
    const second = await getOrVerifyBrandGpsr({ brand: 'TECPO', gpsr: GPSR_FULL, fetchImpl: fetch2 });
    expect(second.status).toBe('verified');
    expect(fetch2).toHaveBeenCalled();
  });

  it('anderer GPSR-Inhalt = Cache-Miss (Fingerprint schuetzt vor Fremd-Belegen)', async () => {
    const fetch1 = fetchFake(() => okPage(PAGE_FULL));
    await getOrVerifyBrandGpsr({ brand: 'TECPO', gpsr: GPSR_FULL, fetchImpl: fetch1 });

    const other = { ...GPSR_FULL, manufacturer_name: 'Andere Firma GmbH' };
    const fetch2 = fetchFake(() => okPage(PAGE_FULL));
    const out = await getOrVerifyBrandGpsr({ brand: 'TECPO', gpsr: other, fetchImpl: fetch2 });
    expect(fetch2).toHaveBeenCalled();
    expect(out.cached).toBe(false);
    expect(out.status).toBe('unverifiable'); // "Andere Firma" steht nicht auf der Seite
  });

  it('ohne brand laeuft die Verifikation, aber nichts wird gecacht', async () => {
    const fetchImpl = fetchFake(() => okPage(PAGE_FULL));
    const out = await getOrVerifyBrandGpsr({ gpsr: GPSR_FULL, fetchImpl });
    expect(out.status).toBe('verified');
    const store = _fakeFirestoreInstance._collections.get(CACHE_COLLECTION);
    expect(store == null || store.size === 0).toBe(true);
  });

  it('ohne gpsr → null', async () => {
    expect(await getOrVerifyBrandGpsr({ brand: 'TECPO' })).toBeNull();
    expect(await getOrVerifyBrandGpsr({})).toBeNull();
  });
});

// ─── brandCacheKey ─────────────────────────────────────────────────────────
describe('brandCacheKey', () => {
  it('normalisiert Marken zu stabilen Doc-Keys', () => {
    expect(brandCacheKey('TOMMY JEANS')).toBe('tommy-jeans');
    expect(brandCacheKey('Grana Home / EU')).toBe('grana-home-eu');
    expect(brandCacheKey('')).toBe('');
    expect(brandCacheKey(null)).toBe('');
  });
});
