'use strict';

/**
 * Kaufland-Enricher: content/weight-Buckets + Material-%-Gate + Declined-Hints.
 *
 * Hintergrund (Live, 2026-07-12): Kaufland lehnt Produktdaten mit konkreten
 * Gründen ab — "Fehlend: Inhalt, Gewicht" (Tampen Nasenspülsalz), "Abgelehnt:
 * material_composition — hint: material_composition_must_contain_%, reason:
 * invalid_text_format" (STOOLINK/Stradivarius). Diese Tests decken:
 *   - classifyMissingAttribute: neue Buckets 'content' + 'weight'
 *   - deterministische Inhalt-Extraktion (Regex, Kaufland-Format "300 g"/"5 l")
 *     mit Gemini-Flash-Fallback (regex-validiert)
 *   - Gewichts-Quellen-Kaskade (logistics/details/Attribute → Web-Lookup)
 *   - Material-%-Gate in buildKauflandProductDataAttributes (CORE + Backfill)
 *   - Declined-Hints-Durchreichung (opts.declined) inkl. Force-Re-Format
 *
 * Vitest 4.x CJS-Pattern: require.cache-Patching statt vi.mock() (Vorbilder:
 * __tests__/services/kaufland-attribute-enricher.test.js,
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

// buildKauflandProductDataAttributes lazy-requiret die Manufacturer-Whitelist
// (Firestore-backed) — ohne Mock zieht der Lookup einen echten Client hoch.
installModuleMock('../lib/kaufland-manufacturer-whitelist', {
  findManufacturerInWhitelist: vi.fn(async () => ({
    found: false, label: null, exactMatch: false, total: 0, suggestions: [], source: 'api',
  })),
  getManufacturerAttributeId: vi.fn(async () => 21),
});

// kaufland-product-data-repair requiret kaufland-api top-level — mocken damit
// keine echten HTTP-Clients im Testprozess landen.
installModuleMock('../lib/kaufland-api', {
  getProductData: vi.fn(),
  getProductDataStatus: vi.fn(),
  putProductData: vi.fn(),
  patchProductData: vi.fn(),
});

// ─── SUT ──────────────────────────────────────────────────────────────────
const {
  enrichProductForKaufland,
  classifyMissingAttribute,
  extractContentFromText,
  parseWeightToGramsLoose,
  formatWeightForKaufland,
} = require('../services/kaufland-attribute-enricher');
const repair = require('../services/kaufland-product-data-repair');
const { healPendingKauflandPublishes } = require('../services/kaufland-listings-sync');

beforeEach(() => {
  callGeminiVisionMock.mockReset();
  lookupGpsrFromWebMock.mockReset();
  getOrFetchBrandGpsrMock.mockReset();
  getOrFetchBrandGpsrMock.mockResolvedValue(null);
  lookupWeightFromWebMock.mockReset();
});

// ─── classifyMissingAttribute: neue Buckets ────────────────────────────────
describe('classifyMissingAttribute — content/weight', () => {
  it('mappt Inhalt/content_volume/Füllmenge auf "content"', () => {
    expect(classifyMissingAttribute('Inhalt')).toBe('content');
    expect(classifyMissingAttribute('content_volume')).toBe('content');
    expect(classifyMissingAttribute('Füllmenge')).toBe('content');
  });

  it('mappt Gewicht/weight auf "weight"', () => {
    expect(classifyMissingAttribute('Gewicht')).toBe('weight');
    expect(classifyMissingAttribute('weight')).toBe('weight');
  });

  it('matcht NICHT auf verwandte, aber andere Labels (Inhaltsstoffe, Maximalgewicht)', () => {
    expect(classifyMissingAttribute('Inhaltsstoffe')).toBeNull();
    expect(classifyMissingAttribute('Maximalgewicht')).toBeNull();
  });
});

// ─── extractContentFromText: Regex-Fälle ──────────────────────────────────
describe('extractContentFromText', () => {
  it('normalisiert ins Kaufland-Format (Zahl, Leerzeichen, Einheit klein)', () => {
    expect(extractContentFromText('300g')).toBe('300 g');
    expect(extractContentFromText('SONAX Politur 300 g Dose')).toBe('300 g');
    expect(extractContentFromText('Kanister 5L')).toBe('5 l');
    expect(extractContentFromText('50ml')).toBe('50 ml');
    expect(extractContentFromText('0,5 l Flasche')).toBe('0,5 l');
    expect(extractContentFromText('1 kg Beutel')).toBe('1 kg');
  });

  it('Multipack: nimmt konservativ die Einzelgebinde-Menge', () => {
    expect(extractContentFromText('2x250 ml Set')).toBe('250 ml');
    expect(extractContentFromText('Nasenspülsalz 20 x 2,5g')).toBe('2,5 g');
  });

  it('liefert null wenn keine Mengenangabe vorhanden', () => {
    expect(extractContentFromText('STOOLINK Stühle 2er Set grau')).toBeNull();
    expect(extractContentFromText('Hose Gr. 38 Länge 32')).toBeNull();
    expect(extractContentFromText('')).toBeNull();
    expect(extractContentFromText(null)).toBeNull();
  });
});

// ─── Content-Bucket im Enricher ────────────────────────────────────────────
describe('enrichProductForKaufland — content bucket', () => {
  it('extrahiert Inhalt deterministisch aus dem Titel (kein Gemini-Call)', async () => {
    const product = {
      id: 'p1',
      identification: { name: 'TECPO Unterbodenschutz 500ml Spray', brand: 'TECPO' },
      details: {},
    };
    const out = await enrichProductForKaufland(product, ['Inhalt']);
    expect(out.enrichedFields).toContain('content');
    expect(out.enriched.details.attributes.Inhalt).toBe('500 ml');
    expect(callGeminiVisionMock).not.toHaveBeenCalled();
  });

  it('extrahiert Inhalt aus Attribut-Werten (Füllmenge) bevor der Titel drankommt', async () => {
    const product = {
      id: 'p2',
      identification: { name: 'Tampen Nasenspülsalz Beutel', brand: 'Tampen' },
      details: { attributes: { 'Füllmenge': '20x2,5 g' } },
    };
    const out = await enrichProductForKaufland(product, ['Inhalt']);
    expect(out.enrichedFields).toContain('content');
    expect(out.enriched.details.attributes.Inhalt).toBe('2,5 g');
    expect(callGeminiVisionMock).not.toHaveBeenCalled();
  });

  it('fällt auf Gemini-Flash zurück wenn Regex nichts findet — Antwort regex-validiert', async () => {
    callGeminiVisionMock.mockResolvedValueOnce('10 ml');
    const product = {
      id: 'p3',
      identification: { name: 'SUPPLEND Nagelpflegestift', brand: 'SUPPLEND' },
      details: {},
    };
    const out = await enrichProductForKaufland(product, ['Inhalt']);
    expect(callGeminiVisionMock).toHaveBeenCalledTimes(1);
    expect(out.enrichedFields).toContain('content');
    expect(out.enriched.details.attributes.Inhalt).toBe('10 ml');
  });

  it('verwirft Gemini-Antworten die dem Format nicht entsprechen ("unbekannt", Freitext)', async () => {
    callGeminiVisionMock.mockResolvedValueOnce('unbekannt');
    const product = {
      id: 'p4',
      identification: { name: 'SUPPLEND Nagelpflegestift', brand: 'SUPPLEND' },
      details: {},
    };
    const out = await enrichProductForKaufland(product, ['Inhalt']);
    expect(out.enrichedFields).toEqual([]);
    expect(out.enriched.details.attributes?.Inhalt).toBeUndefined();
  });
});

// ─── Weight-Bucket im Enricher: Quellen-Kaskade ────────────────────────────
describe('enrichProductForKaufland — weight bucket', () => {
  it('(a) nimmt details.weight (numerisch = kg) ohne Web-Lookup', async () => {
    const product = {
      id: 'w1',
      identification: { name: 'Thule Bodenmatte', brand: 'Thule' },
      details: { weight: 1.5 },
    };
    const out = await enrichProductForKaufland(product, ['Gewicht']);
    expect(out.enrichedFields).toContain('weight');
    expect(out.enriched.details.attributes.Gewicht).toBe('1,5 kg');
    expect(lookupWeightFromWebMock).not.toHaveBeenCalled();
  });

  it('(a) bevorzugt details.logistics.weight in der Kaskade', async () => {
    const product = {
      id: 'w2',
      identification: { name: 'Tampen Nasenspülsalz', brand: 'Tampen' },
      details: { logistics: { weight: 0.25 } },
    };
    const out = await enrichProductForKaufland(product, ['Gewicht']);
    expect(out.enriched.details.attributes.Gewicht).toBe('250 g');
    expect(lookupWeightFromWebMock).not.toHaveBeenCalled();
  });

  it('(a) scannt Gewichts-Attribute via normalizeToken ("Gewicht (kg)" numerisch = kg)', async () => {
    const product = {
      id: 'w3',
      identification: { name: 'Stuhl', brand: 'STOOLINK' },
      details: { attributes: { 'Gewicht (kg)': '2' } },
    };
    const out = await enrichProductForKaufland(product, ['Gewicht']);
    expect(out.enrichedFields).toContain('weight');
    expect(out.enriched.details.attributes.Gewicht).toBe('2 kg');
    expect(lookupWeightFromWebMock).not.toHaveBeenCalled();
  });

  it('(b) nutzt lib/weight-web-lookup als Fallback wenn lokal nichts parsebar', async () => {
    lookupWeightFromWebMock.mockResolvedValueOnce({ weight_grams: 850, confidence: 0.85, sources: [] });
    const product = {
      id: 'w4',
      identification: { name: 'Thule Bodenmatte', brand: 'Thule' },
      details: { identifiers: { ean: '4004764912345' } },
    };
    const out = await enrichProductForKaufland(product, ['Gewicht']);
    expect(lookupWeightFromWebMock).toHaveBeenCalledTimes(1);
    expect(lookupWeightFromWebMock).toHaveBeenCalledWith(
      expect.objectContaining({ brand: 'Thule', ean: '4004764912345' }),
      expect.objectContaining({ timeout: expect.any(Number) })
    );
    expect(out.enrichedFields).toContain('weight');
    expect(out.enriched.details.attributes.Gewicht).toBe('850 g');
  });

  it('(c) kein Ergebnis / zu niedrige Confidence → kein Gewicht, kein Crash', async () => {
    lookupWeightFromWebMock.mockResolvedValueOnce({ weight_grams: null, confidence: 0, sources: [] });
    const product = {
      id: 'w5',
      identification: { name: 'Thule Bodenmatte', brand: 'Thule' },
      details: {},
    };
    const out = await enrichProductForKaufland(product, ['Gewicht']);
    expect(out.enrichedFields).toEqual([]);
    expect(out.enriched.details.attributes?.Gewicht).toBeUndefined();

    // Low-confidence-Reject (Kandidaten widersprachen sich → 0.4)
    lookupWeightFromWebMock.mockResolvedValueOnce({ weight_grams: 500, confidence: 0.4, sources: [] });
    const out2 = await enrichProductForKaufland(product, ['Gewicht']);
    expect(out2.enrichedFields).toEqual([]);
  });
});

// ─── parse/format-Helper ───────────────────────────────────────────────────
describe('weight parse/format helpers', () => {
  it('parseWeightToGramsLoose: kg-Konvention für nackte Zahlen, Einheiten in Strings', () => {
    expect(parseWeightToGramsLoose(1.5)).toBe(1500);
    expect(parseWeightToGramsLoose('1,5 kg')).toBe(1500);
    expect(parseWeightToGramsLoose('500 g')).toBe(500);
    expect(parseWeightToGramsLoose('2')).toBe(2000); // bare == kg
    expect(parseWeightToGramsLoose('abc')).toBeNull();
    expect(parseWeightToGramsLoose(120)).toBeNull(); // 120 kg > Plausibilitätsfenster
    expect(parseWeightToGramsLoose(null)).toBeNull();
  });

  it('formatWeightForKaufland: "X g" unter 1 kg, "X kg" mit Dezimal-Komma darüber', () => {
    expect(formatWeightForKaufland(250)).toBe('250 g');
    expect(formatWeightForKaufland(1000)).toBe('1 kg');
    expect(formatWeightForKaufland(1500)).toBe('1,5 kg');
  });
});

// ─── Material-%-Gate in buildKauflandProductDataAttributes ─────────────────
describe('buildKauflandProductDataAttributes — Material-%-Gate', () => {
  it('submitted material_composition NICHT wenn der Wert keine Prozentangabe hat (invalid_text_format-Prävention)', async () => {
    const attrs = await repair.buildKauflandProductDataAttributes({
      identification: { name: 'Stradivarius Hose', brand: 'Stradivarius' },
      details: { attributes: { Materialzusammensetzung: 'Baumwollmischung mit Stretch' } },
    });
    expect(attrs.material_composition).toBeUndefined();
    expect(attrs.Materialzusammensetzung).toBeUndefined();
  });

  it('submitted material_composition wenn der Wert dem %-Muster entspricht', async () => {
    const attrs = await repair.buildKauflandProductDataAttributes({
      identification: { name: 'Stradivarius Hose', brand: 'Stradivarius' },
      details: { attributes: { Materialzusammensetzung: '80% Baumwolle, 20% Elasthan' } },
    });
    expect(attrs.material_composition).toEqual(['80% Baumwolle, 20% Elasthan']);
    expect(attrs.Materialzusammensetzung).toEqual(['80% Baumwolle, 20% Elasthan']);
  });

  it('Missing-Backfill schickt %-lose Materialwerte ebenfalls NICHT (andere Attribute unberührt)', async () => {
    const attrs = await repair.buildKauflandProductDataAttributes(
      {
        identification: { name: 'Stuhl', brand: 'STOOLINK' },
        details: { attributes: { Materialzusammensetzung: 'Samtstoff', Farbe: 'grau' } },
      },
      { missingAttributes: ['Materialzusammensetzung', 'Farbe'] }
    );
    expect(attrs.Materialzusammensetzung).toBeUndefined();
    expect(attrs.material_composition).toBeUndefined();
    expect(attrs.Farbe).toEqual(['grau']); // Nicht-Material-Backfill bleibt unverändert
  });
});

// ─── Declined-Hints: Force-Re-Format im Enricher ───────────────────────────
describe('enrichProductForKaufland — opts.declined', () => {
  it('erzwingt Material-Re-Format bei declined material_composition, auch wenn lokal ein %-Wert existiert', async () => {
    callGeminiVisionMock.mockResolvedValueOnce('95% Baumwolle, 5% Elasthan');
    const product = {
      id: 'd1',
      identification: { name: 'Stradivarius Hose', brand: 'Stradivarius', category: 'Bekleidung' },
      details: { attributes: { Materialzusammensetzung: '100% Baumwolle' } },
    };
    const out = await enrichProductForKaufland(product, [], {
      declined: [{ attribute: 'material_composition', message: 'material_composition_must_contain_%, invalid_text_format' }],
    });
    expect(callGeminiVisionMock).toHaveBeenCalledTimes(1);
    expect(out.enrichedFields).toContain('material');
    expect(out.enriched.details.attributes.Materialzusammensetzung).toBe('95% Baumwolle, 5% Elasthan');
  });

  it('opts.declined default [] — Verhalten ohne declined unverändert (kein Re-Format bei validem %-Wert)', async () => {
    const product = {
      id: 'd2',
      identification: { name: 'Stradivarius Hose', brand: 'Stradivarius' },
      details: { attributes: { Materialzusammensetzung: '100% Baumwolle' } },
    };
    const out = await enrichProductForKaufland(product, ['Materialzusammensetzung']);
    expect(callGeminiVisionMock).not.toHaveBeenCalled();
    expect(out.enriched.details.attributes.Materialzusammensetzung).toBe('100% Baumwolle');
  });
});

// ─── Declined-Durchreichung: Pending-Heal-Call-Site ────────────────────────
const NOW = Date.parse('2026-07-12T12:00:00.000Z');
const ONE_HOUR_AGO = new Date(NOW - 3600 * 1000).toISOString();

function makeHealDeps() {
  const updates = [];
  const firestore = {
    collection: (name) => ({
      doc: (id) => ({
        update: async (payload) => { updates.push({ collection: name, id, payload }); },
      }),
    }),
  };
  const FieldValue = {
    delete: () => '__FIELD_DELETE__',
    increment: (n) => ({ __increment: n }),
  };
  return {
    updates,
    deps: {
      firestore,
      FieldValue,
      now: () => NOW,
      kauflandApi: { getProductDataStatus: vi.fn(), createUnit: vi.fn() },
      enrichProductForKaufland: vi.fn().mockResolvedValue({ enriched: null, enrichedFields: [] }),
      tryRepairKauflandProductData: vi.fn().mockResolvedValue({ attempted: true, patchedKeys: [] }),
      saveProductV2: vi.fn().mockResolvedValue({}),
      mergeKauflandOverrides: vi.fn().mockResolvedValue({ shippingGroupId: 144080, warehouseId: 70462 }),
    },
  };
}

function buildPendingProduct({ id = 'P1', ean = '4036231080920' } = {}) {
  return {
    id,
    identification: { sku: `SKU-${id}` },
    details: { identifiers: { ean }, pricing: { sellPrice: 19.99 } },
    ops: {},
    marketplace: {
      kaufland: {
        publish_pending_at: ONE_HOUR_AGO,
        publish_pending: { reason: 'product_data_pending', storefront: 'de', attempts: 1 },
      },
    },
  };
}

describe('healPendingKauflandPublishes — declined-Durchreichung', () => {
  it('mappt attribute_values state=DECLINED auf opts.declined (reason:-Präfix gestrippt)', async () => {
    const { deps } = makeHealDeps();
    deps.kauflandApi.getProductDataStatus.mockResolvedValue({
      product_ready: false,
      missing_attributes: ['Materialzusammensetzung'],
      min_one_missing_attributes: [],
      attribute_values: [
        { attribute: 'material_composition', state: 'DECLINED', message: 'reason: invalid_text_format' },
        { attribute: 'title', state: 'ACCEPTED', message: '' },
      ],
    });

    const stats = await healPendingKauflandPublishes({
      products: [buildPendingProduct({ id: 'DP1' })],
      storefront: 'de',
      deps,
    });

    expect(stats.attempted).toBe(1);
    expect(deps.enrichProductForKaufland).toHaveBeenCalledTimes(1);
    expect(deps.enrichProductForKaufland.mock.calls[0][1]).toEqual(['Materialzusammensetzung']);
    expect(deps.enrichProductForKaufland.mock.calls[0][2]).toEqual({
      declined: [{ attribute: 'material_composition', message: 'invalid_text_format' }],
    });
  });

  it('declined-only (missing leer) triggert Enrich + Repair trotzdem', async () => {
    const { deps } = makeHealDeps();
    deps.kauflandApi.getProductDataStatus.mockResolvedValue({
      product_ready: false,
      missing_attributes: [],
      min_one_missing_attributes: [],
      attribute_values: [
        { attribute: 'material_composition', state: 'DECLINED', message: 'reason: invalid_text_format' },
      ],
    });

    await healPendingKauflandPublishes({
      products: [buildPendingProduct({ id: 'DP2' })],
      storefront: 'de',
      deps,
    });

    expect(deps.enrichProductForKaufland).toHaveBeenCalledTimes(1);
    expect(deps.enrichProductForKaufland.mock.calls[0][1]).toEqual([]);
    expect(deps.enrichProductForKaufland.mock.calls[0][2]).toEqual({
      declined: [{ attribute: 'material_composition', message: 'invalid_text_format' }],
    });
    expect(deps.tryRepairKauflandProductData).toHaveBeenCalledTimes(1);
  });

  it('ohne DECLINED-Einträge bleibt opts.declined leer (Bestandsverhalten)', async () => {
    const { deps } = makeHealDeps();
    deps.kauflandApi.getProductDataStatus.mockResolvedValue({
      product_ready: false,
      missing_attributes: ['Bild'],
      min_one_missing_attributes: [],
      attribute_values: [{ attribute: 'title', state: 'ACCEPTED', message: '' }],
    });

    await healPendingKauflandPublishes({
      products: [buildPendingProduct({ id: 'DP3' })],
      storefront: 'de',
      deps,
    });

    expect(deps.enrichProductForKaufland).toHaveBeenCalledTimes(1);
    expect(deps.enrichProductForKaufland.mock.calls[0][2]).toEqual({ declined: [] });
  });
});
