'use strict';

/**
 * Kaufland-Enricher: hazmat/biozid-Bucket (GHS/CLP-Kennzeichnung).
 *
 * Hintergrund (Live, 2026-07-12): Kaufland lehnt Chemie-/Pflegeprodukte ohne
 * CLP-Attribute ab — "Fehlend: Inhalt, Sicherheitsdatenblatt, Signalwort,
 * Gefahrenhinweise, Sicherheitsinfo (P-Sätze)" (SUPPLEND Nagelpflegestift,
 * TECPO Unterbodenschutz) bzw. "Fehlend: Biozid" (TerraDomi Unkrautvernichter).
 *
 * Diese Tests decken die Verdrahtung von lib/hazmat-gemini-lookup.js in
 * services/kaufland-attribute-enricher.js:
 *   (a) verified-Ergebnis → alle 4 Attribute gesetzt, SDS = GCS-Mirror-URL
 *   (b) unverified → NICHTS geschrieben + errors enthält Hinweis
 *   (c) belegtes 'Kein Signalwort' (confidence 0.9 + Quelle, kein SDS)
 *       → NUR Signalwort gesetzt
 *   (d) bestehender non-empty Wert wird NIE überschrieben
 *   + Biozid nur mit Quelle, Kostenkontrolle (kein Lookup ohne missing),
 *     Mirror-Fehler → Original-URL, geteilter Lookup-Call.
 *
 * Vitest 4.x CJS-Pattern: require.cache-Patching statt vi.mock() (Vorbilder:
 * __tests__/kaufland-enricher-content-weight.test.js,
 * __tests__/kaufland-pending-publish-heal.test.js).
 */

// vitest globals: true — describe/it/expect/vi sind global.

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

// ─── Mocks (VOR dem SUT-Require installieren) ─────────────────────────────
const callGeminiVisionMock = vi.fn();
installModuleMock('../lib/gemini-client', {
  callGeminiVision: callGeminiVisionMock,
  getGeminiClient: vi.fn(),
  getGeminiApiKey: vi.fn(),
});

const lookupGpsrFromWebMock = vi.fn();
installModuleMock('../lib/gpsr-web-fallback', {
  lookupGpsrFromWeb: lookupGpsrFromWebMock,
});

const getOrFetchBrandGpsrMock = vi.fn();
installModuleMock('../lib/gpsr-gemini-lookup', {
  getOrFetchBrandGpsr: getOrFetchBrandGpsrMock,
  lookupGpsrViaGemini: vi.fn(async () => null),
  readBrandGpsrCache: vi.fn(async () => null),
  writeBrandGpsrCache: vi.fn(async () => {}),
});

const lookupWeightFromWebMock = vi.fn();
installModuleMock('../lib/weight-web-lookup', {
  lookupWeightFromWeb: lookupWeightFromWebMock,
  brandDomainGuess: vi.fn(() => null),
});

// Der hazmat/biozid-Bucket lazy-requiret beide Module — Mock verhindert echte
// Gemini-/Firestore-/GCS-Clients im Testprozess.
const getOrFetchHazmatMock = vi.fn();
const verifySdsUrlMock = vi.fn();
installModuleMock('../lib/hazmat-gemini-lookup', {
  getOrFetchHazmat: getOrFetchHazmatMock,
  verifySdsUrl: verifySdsUrlMock,
  lookupHazmatViaGemini: vi.fn(async () => null),
  readHazmatCache: vi.fn(async () => null),
  writeHazmatCache: vi.fn(async () => {}),
});

const uploadDocumentBufferMock = vi.fn();
installModuleMock('../lib/storage', {
  uploadDocumentBuffer: uploadDocumentBufferMock,
  uploadImage: vi.fn(),
  uploadBase64Image: vi.fn(),
  uploadLogoImage: vi.fn(),
  deleteProductImages: vi.fn(),
  uploadJobFile: vi.fn(),
  downloadFile: vi.fn(),
});

// ─── SUT ──────────────────────────────────────────────────────────────────
const {
  enrichProductForKaufland,
  classifyMissingAttribute,
  classifyHazmatToken,
} = require('../services/kaufland-attribute-enricher');

const SDS_URL = 'https://tecpo.example.com/sds/unterbodenschutz.pdf';
const GCS_URL = 'https://storage.googleapis.com/avycloud-product-images/products/hz1/sicherheitsdatenblatt_abc123.pdf';
const PDF_BUFFER = Buffer.from('%PDF-1.7\nfake-sds-content', 'latin1');

function verifiedResult(overrides = {}) {
  return {
    sdsUrl: SDS_URL,
    verifiedSdsUrl: SDS_URL,
    verified: true,
    signalwort: 'Gefahr',
    hSaetze: ['H226 Flüssigkeit und Dampf entzündbar.'],
    pSaetze: ['P403+P235 An einem gut belüfteten Ort aufbewahren. Kühl halten.'],
    confidence: 0.9,
    sources: ['https://tecpo.example.com/produkt'],
    regulatory: null,
    sdsVerification: { checked: true, ok: true, status: 200, contentType: 'application/pdf', size: PDF_BUFFER.length },
    cached: false,
    negative: false,
    source: 'gemini-googleSearch',
    ...overrides,
  };
}

function buildProduct(overrides = {}) {
  return {
    id: 'hz1',
    identification: { name: 'TECPO Unterbodenschutz 500ml Spray', brand: 'TECPO' },
    details: { identifiers: { ean: '4004764912345' } },
    ...overrides,
  };
}

const HAZMAT_MISSING = ['Sicherheitsdatenblatt', 'Signalwort', 'Gefahrenhinweise', 'Sicherheitsinfo (P-Sätze)'];

beforeEach(() => {
  callGeminiVisionMock.mockReset();
  lookupGpsrFromWebMock.mockReset();
  getOrFetchBrandGpsrMock.mockReset();
  getOrFetchBrandGpsrMock.mockResolvedValue(null);
  lookupWeightFromWebMock.mockReset();
  getOrFetchHazmatMock.mockReset();
  verifySdsUrlMock.mockReset();
  verifySdsUrlMock.mockResolvedValue({
    checked: true, ok: true, status: 200, contentType: 'application/pdf', size: PDF_BUFFER.length, buffer: PDF_BUFFER,
  });
  uploadDocumentBufferMock.mockReset();
  uploadDocumentBufferMock.mockResolvedValue({ url: GCS_URL, mimeType: 'application/pdf', size: PDF_BUFFER.length });
});

// ─── classifyMissingAttribute: neue Buckets ────────────────────────────────
describe('classifyMissingAttribute — hazmat/biozid', () => {
  it('mappt die 4 Live-CLP-Labels auf "hazmat"', () => {
    expect(classifyMissingAttribute('Signalwort')).toBe('hazmat');
    expect(classifyMissingAttribute('Gefahrenhinweise')).toBe('hazmat');
    expect(classifyMissingAttribute('Sicherheitsinfo (P-Sätze)')).toBe('hazmat');
    expect(classifyMissingAttribute('Sicherheitsdatenblatt')).toBe('hazmat');
    expect(classifyMissingAttribute('H-Sätze')).toBe('hazmat');
    expect(classifyMissingAttribute('P-Sätze')).toBe('hazmat');
  });

  it('mappt Biozid auf "biozid"', () => {
    expect(classifyMissingAttribute('Biozid')).toBe('biozid');
  });

  it('matcht NICHT auf verwandte, aber andere Labels', () => {
    expect(classifyMissingAttribute('Sicherheitshinweise')).toBeNull();
    expect(classifyMissingAttribute('Signalfarbe')).toBeNull();
  });

  it('classifyHazmatToken liefert das Sub-Feld (für Nie-Überschreiben-Check)', () => {
    expect(classifyHazmatToken('signalwort')).toBe('signalwort');
    expect(classifyHazmatToken('gefahrenhinweise')).toBe('hSaetze');
    expect(classifyHazmatToken('sicherheitsinfopsätze')).toBe('pSaetze');
    expect(classifyHazmatToken('sicherheitsdatenblatt')).toBe('sds');
    expect(classifyHazmatToken('biozid')).toBeNull();
  });
});

// ─── (a) verified-Ergebnis ─────────────────────────────────────────────────
describe('enrichProductForKaufland — hazmat bucket (verified)', () => {
  it('(a) verified → alle 4 Attribute gesetzt, SDS = GCS-Mirror-URL', async () => {
    getOrFetchHazmatMock.mockResolvedValueOnce(verifiedResult());
    const out = await enrichProductForKaufland(buildProduct(), HAZMAT_MISSING);

    expect(getOrFetchHazmatMock).toHaveBeenCalledTimes(1);
    expect(getOrFetchHazmatMock).toHaveBeenCalledWith(expect.objectContaining({
      ean: '4004764912345',
      brand: 'TECPO',
      title: 'TECPO Unterbodenschutz 500ml Spray',
      requestedFields: [],
    }));

    expect(out.enrichedFields).toContain('hazmat');
    const attrs = out.enriched.details.attributes;
    expect(attrs.Signalwort).toBe('Gefahr');
    expect(attrs.Gefahrenhinweise).toEqual(['H226 Flüssigkeit und Dampf entzündbar.']);
    expect(attrs['Sicherheitsinfo (P-Sätze)']).toEqual(['P403+P235 An einem gut belüfteten Ort aufbewahren. Kühl halten.']);
    expect(attrs.Sicherheitsdatenblatt).toBe(GCS_URL);

    // GCS-Mirror: PDF erneut geladen (Lookup reicht den Buffer nicht durch)
    // und byte-identisch via uploadDocumentBuffer gespiegelt.
    expect(verifySdsUrlMock).toHaveBeenCalledWith(SDS_URL);
    expect(uploadDocumentBufferMock).toHaveBeenCalledTimes(1);
    expect(uploadDocumentBufferMock).toHaveBeenCalledWith(
      PDF_BUFFER, 'application/pdf', 'hz1', 'sicherheitsdatenblatt'
    );
    expect(out.errors).toEqual([]);
  });

  it('Mirror-Fehler → verifizierte Original-URL wird geschrieben (besser als nichts)', async () => {
    getOrFetchHazmatMock.mockResolvedValueOnce(verifiedResult());
    uploadDocumentBufferMock.mockRejectedValueOnce(new Error('gcs boom'));

    const out = await enrichProductForKaufland(buildProduct(), HAZMAT_MISSING);
    expect(out.enrichedFields).toContain('hazmat');
    expect(out.enriched.details.attributes.Sicherheitsdatenblatt).toBe(SDS_URL);
  });

  it('Re-Fetch liefert kein PDF mehr (transient) → Original-URL wird geschrieben', async () => {
    getOrFetchHazmatMock.mockResolvedValueOnce(verifiedResult());
    verifySdsUrlMock.mockResolvedValueOnce({ checked: true, ok: false, error: 'not-pdf' });

    const out = await enrichProductForKaufland(buildProduct(), HAZMAT_MISSING);
    expect(out.enriched.details.attributes.Sicherheitsdatenblatt).toBe(SDS_URL);
    expect(uploadDocumentBufferMock).not.toHaveBeenCalled();
  });
});

// ─── (b) unverified ────────────────────────────────────────────────────────
describe('enrichProductForKaufland — hazmat bucket (unverified)', () => {
  it('(b) unverified (SDS-URL war HTML) → NICHTS geschrieben + errors enthält Hinweis', async () => {
    getOrFetchHazmatMock.mockResolvedValueOnce(verifiedResult({
      verified: false,
      verifiedSdsUrl: null,
      sdsVerification: { checked: true, ok: false, status: 200, contentType: 'text/html', error: 'not-pdf' },
    }));

    const out = await enrichProductForKaufland(buildProduct(), HAZMAT_MISSING);
    expect(out.enrichedFields).toEqual([]);
    const attrs = out.enriched.details.attributes || {};
    expect(attrs.Signalwort).toBeUndefined();
    expect(attrs.Gefahrenhinweise).toBeUndefined();
    expect(attrs['Sicherheitsinfo (P-Sätze)']).toBeUndefined();
    expect(attrs.Sicherheitsdatenblatt).toBeUndefined();
    expect(out.errors.some((e) => /hazmat.*NICHT geschrieben/i.test(e))).toBe(true);
    expect(uploadDocumentBufferMock).not.toHaveBeenCalled();
  });

  it('transienter Lookup-Fehler (null) → nichts geschrieben, klarer error, kein Crash', async () => {
    getOrFetchHazmatMock.mockResolvedValueOnce(null);
    const out = await enrichProductForKaufland(buildProduct(), HAZMAT_MISSING);
    expect(out.enrichedFields).toEqual([]);
    expect(out.enriched.details.attributes?.Signalwort).toBeUndefined();
    expect(out.errors.some((e) => /hazmat.*transient/i.test(e))).toBe(true);
  });
});

// ─── (c) belegtes 'Kein Signalwort' ────────────────────────────────────────
describe('enrichProductForKaufland — hazmat bucket (Kein Signalwort)', () => {
  it('(c) confidence 0.9 + Quelle, aber kein SDS → NUR Signalwort gesetzt', async () => {
    getOrFetchHazmatMock.mockResolvedValueOnce(verifiedResult({
      sdsUrl: null,
      verifiedSdsUrl: null,
      verified: false,
      signalwort: 'Kein Signalwort',
      hSaetze: [],
      pSaetze: [],
      confidence: 0.9,
      sources: ['https://supplend.example.com/nagelpflegestift'],
      sdsVerification: { checked: false, ok: false },
    }));

    const product = buildProduct({
      identification: { name: 'SUPPLEND Nagelpflegestift', brand: 'SUPPLEND' },
    });
    const out = await enrichProductForKaufland(product, HAZMAT_MISSING);

    expect(out.enrichedFields).toContain('hazmat');
    const attrs = out.enriched.details.attributes;
    expect(attrs.Signalwort).toBe('Kein Signalwort');
    expect(attrs.Gefahrenhinweise).toBeUndefined();
    expect(attrs['Sicherheitsinfo (P-Sätze)']).toBeUndefined();
    expect(attrs.Sicherheitsdatenblatt).toBeUndefined();
    expect(uploadDocumentBufferMock).not.toHaveBeenCalled();
  });

  it('"Kein Signalwort" OHNE Quelle bzw. mit niedriger Confidence → NICHT geschrieben', async () => {
    // Ohne Quelle
    getOrFetchHazmatMock.mockResolvedValueOnce(verifiedResult({
      sdsUrl: null, verifiedSdsUrl: null, verified: false,
      signalwort: 'Kein Signalwort', hSaetze: [], pSaetze: [],
      confidence: 0.9, sources: [],
      sdsVerification: { checked: false, ok: false },
    }));
    const out1 = await enrichProductForKaufland(buildProduct(), HAZMAT_MISSING);
    expect(out1.enrichedFields).toEqual([]);
    expect(out1.enriched.details.attributes?.Signalwort).toBeUndefined();

    // Confidence < 0.8
    getOrFetchHazmatMock.mockResolvedValueOnce(verifiedResult({
      sdsUrl: null, verifiedSdsUrl: null, verified: false,
      signalwort: 'Kein Signalwort', hSaetze: [], pSaetze: [],
      confidence: 0.5, sources: ['https://x.example.com'],
      sdsVerification: { checked: false, ok: false },
    }));
    const out2 = await enrichProductForKaufland(buildProduct(), HAZMAT_MISSING);
    expect(out2.enrichedFields).toEqual([]);
    expect(out2.enriched.details.attributes?.Signalwort).toBeUndefined();
  });

  it('unverifiziertes "Gefahr"/"Achtung" wird NIE über den Kein-Signalwort-Pfad geschrieben', async () => {
    getOrFetchHazmatMock.mockResolvedValueOnce(verifiedResult({
      sdsUrl: null, verifiedSdsUrl: null, verified: false,
      signalwort: 'Gefahr', hSaetze: [], pSaetze: [],
      confidence: 0.95, sources: ['https://x.example.com'],
      sdsVerification: { checked: false, ok: false },
    }));
    const out = await enrichProductForKaufland(buildProduct(), HAZMAT_MISSING);
    expect(out.enrichedFields).toEqual([]);
    expect(out.enriched.details.attributes?.Signalwort).toBeUndefined();
  });
});

// ─── (d) bestehende Werte nie überschreiben ────────────────────────────────
describe('enrichProductForKaufland — hazmat bucket (nie überschreiben)', () => {
  it('(d) bestehender non-empty Wert bleibt, fehlende werden ergänzt', async () => {
    getOrFetchHazmatMock.mockResolvedValueOnce(verifiedResult());
    const product = buildProduct({
      details: {
        identifiers: { ean: '4004764912345' },
        attributes: { Signalwort: 'Achtung' },
      },
    });
    const out = await enrichProductForKaufland(product, HAZMAT_MISSING);

    const attrs = out.enriched.details.attributes;
    expect(attrs.Signalwort).toBe('Achtung'); // NICHT überschrieben
    expect(attrs.Gefahrenhinweise).toEqual(['H226 Flüssigkeit und Dampf entzündbar.']);
    expect(attrs['Sicherheitsinfo (P-Sätze)']).toEqual(['P403+P235 An einem gut belüfteten Ort aufbewahren. Kühl halten.']);
    expect(attrs.Sicherheitsdatenblatt).toBe(GCS_URL);
    expect(out.enrichedFields).toContain('hazmat');
  });

  it('alle 4 Attribute lokal non-empty → Lookup wird GAR NICHT gerufen (Kostenkontrolle)', async () => {
    const product = buildProduct({
      details: {
        identifiers: { ean: '4004764912345' },
        attributes: {
          Signalwort: 'Gefahr',
          Gefahrenhinweise: ['H226 Flüssigkeit und Dampf entzündbar.'],
          'Sicherheitsinfo (P-Sätze)': ['P210 Von Hitze fernhalten.'],
          Sicherheitsdatenblatt: 'https://example.com/sds.pdf',
        },
      },
    });
    const out = await enrichProductForKaufland(product, HAZMAT_MISSING);
    expect(getOrFetchHazmatMock).not.toHaveBeenCalled();
    expect(out.enrichedFields).toEqual([]);
    expect(out.errors).toEqual([]);
  });
});

// ─── Biozid-Bucket ─────────────────────────────────────────────────────────
describe('enrichProductForKaufland — biozid bucket', () => {
  it('Biozid mit belegter Quelle → details.attributes.Biozid gesetzt', async () => {
    getOrFetchHazmatMock.mockResolvedValueOnce(verifiedResult({
      sdsUrl: null, verifiedSdsUrl: null, verified: false,
      signalwort: null, hSaetze: [], pSaetze: [],
      confidence: 0.85, sources: [],
      sdsVerification: { checked: false, ok: false },
      regulatory: {
        biozid: 'Biozidprodukte vorsichtig verwenden. Vor Gebrauch stets Etikett und Produktinformationen lesen.',
        sources: ['https://terradomi.example.com/unkrautvernichter'],
      },
    }));

    const product = buildProduct({
      identification: { name: 'TerraDomi Unkrautvernichter 5l', brand: 'TerraDomi' },
    });
    const out = await enrichProductForKaufland(product, ['Biozid']);

    expect(getOrFetchHazmatMock).toHaveBeenCalledTimes(1);
    expect(getOrFetchHazmatMock).toHaveBeenCalledWith(expect.objectContaining({
      requestedFields: ['biozid'],
    }));
    expect(out.enrichedFields).toContain('biozid');
    expect(out.enriched.details.attributes.Biozid)
      .toBe('Biozidprodukte vorsichtig verwenden. Vor Gebrauch stets Etikett und Produktinformationen lesen.');
    // Biozid-only: hazmat-Attribute werden NICHT angefasst
    expect(out.enriched.details.attributes.Signalwort).toBeUndefined();
  });

  it('Biozid ohne Quelle (regulatory.biozid=null) → nichts geschrieben + errors', async () => {
    getOrFetchHazmatMock.mockResolvedValueOnce(verifiedResult({
      sdsUrl: null, verifiedSdsUrl: null, verified: false,
      signalwort: null, hSaetze: [], pSaetze: [],
      confidence: 0.3, sources: [],
      sdsVerification: { checked: false, ok: false },
      regulatory: { biozid: null, sources: [] },
    }));

    const out = await enrichProductForKaufland(buildProduct(), ['Biozid']);
    expect(out.enrichedFields).toEqual([]);
    expect(out.enriched.details.attributes?.Biozid).toBeUndefined();
    expect(out.errors.some((e) => /biozid.*NICHT geschrieben/i.test(e))).toBe(true);
  });

  it('hazmat + biozid gleichzeitig missing → EIN geteilter Lookup-Call mit requestedFields=[biozid]', async () => {
    getOrFetchHazmatMock.mockResolvedValueOnce(verifiedResult({
      regulatory: {
        biozid: 'Biozidprodukte vorsichtig verwenden. Vor Gebrauch stets Etikett und Produktinformationen lesen.',
        sources: ['https://terradomi.example.com/produkt'],
      },
    }));

    const out = await enrichProductForKaufland(buildProduct(), [...HAZMAT_MISSING, 'Biozid']);
    expect(getOrFetchHazmatMock).toHaveBeenCalledTimes(1);
    expect(getOrFetchHazmatMock).toHaveBeenCalledWith(expect.objectContaining({
      requestedFields: ['biozid'],
    }));
    expect(out.enrichedFields).toEqual(expect.arrayContaining(['hazmat', 'biozid']));
    expect(out.enriched.details.attributes.Signalwort).toBe('Gefahr');
    expect(out.enriched.details.attributes.Biozid).toMatch(/Biozidprodukte/);
  });

  it('bestehender Biozid-Wert → Lookup wird nicht gerufen (Kostenkontrolle)', async () => {
    const product = buildProduct({
      details: {
        identifiers: { ean: '4004764912345' },
        attributes: { Biozid: 'Biozidprodukte vorsichtig verwenden.' },
      },
    });
    const out = await enrichProductForKaufland(product, ['Biozid']);
    expect(getOrFetchHazmatMock).not.toHaveBeenCalled();
    expect(out.enrichedFields).toEqual([]);
  });
});

// ─── Kostenkontrolle: kein Lookup ohne missing/declined hazmat-Attribut ────
describe('enrichProductForKaufland — Kostenkontrolle', () => {
  it('andere missing-Attribute (Inhalt/Gewicht/Material) triggern den Hazmat-Lookup NICHT', async () => {
    callGeminiVisionMock.mockResolvedValue('100% Kunststoff');
    lookupWeightFromWebMock.mockResolvedValue({ weight_grams: null, confidence: 0, sources: [] });

    const out = await enrichProductForKaufland(buildProduct(), ['Inhalt', 'Gewicht', 'Materialzusammensetzung']);
    expect(getOrFetchHazmatMock).not.toHaveBeenCalled();
    expect(verifySdsUrlMock).not.toHaveBeenCalled();
    expect(uploadDocumentBufferMock).not.toHaveBeenCalled();
    expect(out.enrichedFields).not.toContain('hazmat');
    expect(out.enrichedFields).not.toContain('biozid');
  });

  it('leere missing-Liste → kein Lookup', async () => {
    await enrichProductForKaufland(buildProduct(), []);
    expect(getOrFetchHazmatMock).not.toHaveBeenCalled();
  });

  it('DECLINED-Hint auf Signalwort (ohne missing) triggert den hazmat-Bucket', async () => {
    getOrFetchHazmatMock.mockResolvedValueOnce(verifiedResult());
    const out = await enrichProductForKaufland(buildProduct(), [], {
      declined: [{ attribute: 'Signalwort', message: 'invalid_text_format' }],
    });
    expect(getOrFetchHazmatMock).toHaveBeenCalledTimes(1);
    expect(out.enrichedFields).toContain('hazmat');
    expect(out.enriched.details.attributes.Gefahrenhinweise).toEqual(['H226 Flüssigkeit und Dampf entzündbar.']);
  });
});
