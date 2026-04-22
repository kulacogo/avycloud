'use strict';

// Mock dependencies via require.cache

const gemini3GenerateJSONMock = vi.fn();

const generateProductContentMock = vi.fn(async () => ({
  title_ebay: 'Sony WH-1000XM5 Kabellos Bluetooth Over-Ear Kopfhoerer Schwarz',
  title_kaufland: 'Sony WH-1000XM5 Noise-Cancelling Over-Ear Bluetooth Kopfhoerer Schwarz',
  description_ebay: '<p>Premium Noise-Cancelling Kopfhoerer von Sony.</p><ul><li>Bluetooth 5.2</li></ul>',
  description_kaufland: '<p>Sony WH-1000XM5 mit erstklassiger Geraeuschunterdrueckung.</p>',
  key_features: [
    'Branchenführende Geräuschunterdrückung – Dual Noise Sensor Technologie',
    'Bluetooth 5.2 Multipoint – Zwei Geräte gleichzeitig verbinden',
    '30 Stunden Akkulaufzeit – Ganztägig Musik genießen',
  ],
  item_specifics: [
    { key: 'Marke', value: 'Sony' },
    { key: 'Modell', value: 'WH-1000XM5' },
    { key: 'Farbe', value: 'Schwarz' },
    { key: 'Konnektivität', value: 'Bluetooth' },
    { key: 'Formfaktor', value: 'Over-Ear' },
  ],
  mobile_snippet: 'Sony WH-1000XM5 Premium Bluetooth Kopfhoerer mit Noise-Cancelling.',
  gpsr_manufacturer_name: 'Sony Europe B.V.',
  gpsr_manufacturer_address: 'Da Vincilaan 7-D1, Zaventem',
  gpsr_manufacturer_email: 'info@sony.eu',
}));

const geminiPath = require.resolve('../../lib/gemini3-client');
require(geminiPath);
require.cache[geminiPath] = {
  id: geminiPath, filename: geminiPath, loaded: true,
  exports: {
    generateProductContent: generateProductContentMock,
    gemini3GenerateJSON: gemini3GenerateJSONMock,
    buildImprovePromptExtension: vi.fn(() => ''),
    getGenAIClient: vi.fn(),
    identifyProductWithGrounding: vi.fn(),
    identifyProductFocused: vi.fn(),
    FULL_PRODUCT_SCHEMA: {},
    RECOGNITION_SCHEMA: {},
    CONTENT_SCHEMA: {},
    DEFAULT_MODEL: 'gemini-3-pro-preview',
  },
};

// Mock post-processing functions
const sanitizePath = require.resolve('../../lib/listing-sanitize');
require(sanitizePath);
require.cache[sanitizePath] = {
  id: sanitizePath, filename: sanitizePath, loaded: true,
  exports: { sanitizeDescriptionToHtml: vi.fn((html) => html), PRICE_SENTENCE_RE: /preis/i },
};

const highlightsPath = require.resolve('../../lib/highlights-policy');
require(highlightsPath);
require.cache[highlightsPath] = {
  id: highlightsPath, filename: highlightsPath, loaded: true,
  exports: { normalizeHighlightsStrict: vi.fn((_, list) => list) },
};

const attrPath = require.resolve('../../lib/attribute-policy');
require(attrPath);
require.cache[attrPath] = {
  id: attrPath, filename: attrPath, loaded: true,
  exports: { canonicalizeAttributesStrict: vi.fn((obj) => obj) },
};

const titlePath = require.resolve('../../lib/title-policy');
require(titlePath);
require.cache[titlePath] = {
  id: titlePath, filename: titlePath, loaded: true,
  exports: {
    coerceTitleToPolicy: vi.fn((title) => ({ title, violations: [] })),
    validateTitleToPolicy: vi.fn(() => ({ valid: true })),
    inferTitleCategory: vi.fn(),
  },
};

const { runStage3ContentGeneration } = require('../../lib/identify-v3-stage3');

beforeEach(() => {
  vi.clearAllMocks();
});

const makeStage1 = () => ({
  identity: {
    brand: 'Sony',
    model: 'WH-1000XM5',
    mpn: 'WH1000XM5B.CE7',
    variant: 'Schwarz',
    condition: 'Neu',
    internalCategory: 'Elektronik > Kopfhoerer > Over-Ear',
    color: 'Schwarz',
    size: '',
    material: '',
  },
  barcodes: { ean: '4548736132610', gtin: '', upc: '' },
  imageParts: [{ data: 'base64data', mimeType: 'image/jpeg' }],
});

const makeStage2 = () => ({
  category: { ebayId: '112529', ebayBreadcrumb: 'TV, Video & Audio > Kopfhoerer' },
  requiredAspects: ['Marke', 'Modell', 'Farbe'],
  pricing: { amount: 289, currency: 'EUR', sources: [{ url: 'https://geizhals.de' }] },
  gpsr: { found: true, data: { manufacturer_name: 'Sony Europe B.V.', email: 'info@sony.eu' } },
  titleInsights: {
    sampleTitles: ['Sony WH-1000XM5 Kopfhoerer', 'Sony WH-1000XM5 ANC'],
    topTokens: ['Sony', 'Bluetooth', 'ANC'],
  },
});

describe('runStage3ContentGeneration', () => {
  it('calls generateProductContent with identity and enrichment', async () => {
    await runStage3ContentGeneration(makeStage1(), makeStage2());

    expect(generateProductContentMock).toHaveBeenCalledTimes(1);
    const call = generateProductContentMock.mock.calls[0][0];
    expect(call.identity.brand).toBe('Sony');
    expect(call.identity.model).toBe('WH-1000XM5');
    // Aspects with no allowed values from the catalog stay as plain strings.
    expect(call.enrichment.requiredAspects.map(String))
      .toEqual(['Marke', 'Modell', 'Farbe']);
  });

  it('returns generated content fields', async () => {
    const result = await runStage3ContentGeneration(makeStage1(), makeStage2());

    expect(result.title_ebay).toContain('Sony');
    expect(result.title_kaufland).toContain('Sony');
    expect(result.description_ebay).toContain('<p>');
    expect(result.key_features.length).toBeGreaterThanOrEqual(3);
    expect(result.item_specifics.length).toBeGreaterThanOrEqual(3);
  });

  it('applies title policy normalization', async () => {
    const { coerceTitleToPolicy } = require('../../lib/title-policy');
    await runStage3ContentGeneration(makeStage1(), makeStage2());

    expect(coerceTitleToPolicy).toHaveBeenCalled();
  });

  it('applies description sanitization', async () => {
    const { sanitizeDescriptionToHtml } = require('../../lib/listing-sanitize');
    await runStage3ContentGeneration(makeStage1(), makeStage2());

    expect(sanitizeDescriptionToHtml).toHaveBeenCalled();
  });

  it('uses fallback content when Gemini fails', async () => {
    generateProductContentMock.mockRejectedValueOnce(new Error('Gemini unavailable'));

    const result = await runStage3ContentGeneration(makeStage1(), makeStage2());

    expect(result.title_ebay).toContain('Sony');
    expect(result.title_ebay).toContain('WH-1000XM5');
    expect(result.item_specifics.find((s) => s.key === 'Marke')).toBeDefined();
  });

  it('includes GPSR data from content generation', async () => {
    const result = await runStage3ContentGeneration(makeStage1(), makeStage2());
    expect(result.gpsr_manufacturer_name).toBe('Sony Europe B.V.');
  });

  it('includes timing metadata', async () => {
    const result = await runStage3ContentGeneration(makeStage1(), makeStage2());
    expect(result._meta.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('passes image parts to generateProductContent', async () => {
    await runStage3ContentGeneration(makeStage1(), makeStage2());
    const call = generateProductContentMock.mock.calls[0][0];
    expect(call.imageParts.length).toBe(1);
  });

  it('fills missing required aspects with "Unbekannt" when Gemini omits them', async () => {
    generateProductContentMock.mockResolvedValueOnce({
      title_ebay: 'Sony WH-1000XM5 Kopfhoerer',
      title_kaufland: 'Sony WH-1000XM5 Kopfhoerer',
      description_ebay: '<p>Sony WH-1000XM5</p>',
      description_kaufland: '<p>Sony WH-1000XM5</p>',
      key_features: ['A', 'B', 'C'],
      // Only 'Marke' present — 'Modell', 'Farbe', 'Konnektivitaet' are missing.
      item_specifics: [{ key: 'Marke', value: 'Sony' }],
      mobile_snippet: 'Sony WH-1000XM5',
    });

    const stage2 = makeStage2();
    stage2.requiredAspects = ['Marke', 'Modell', 'Farbe', 'Konnektivitaet'];
    const result = await runStage3ContentGeneration(makeStage1(), stage2);

    const keys = result.item_specifics.map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(['Marke', 'Modell', 'Farbe', 'Konnektivitaet']));
    const modellEntry = result.item_specifics.find((s) => s.key === 'Modell');
    expect(modellEntry.value).toBe('Unbekannt');
    expect(result.item_specifics_confidence.Modell).toBe(0);
    expect(result._meta.aspectEnforcement.missing).toEqual(
      expect.arrayContaining(['Modell', 'Farbe', 'Konnektivitaet'])
    );
  });

  it('respects allowed values from requiredAspects[].values', async () => {
    generateProductContentMock.mockResolvedValueOnce({
      title_ebay: 'Produkt',
      title_kaufland: 'Produkt',
      description_ebay: '<p>x</p>',
      description_kaufland: '<p>x</p>',
      key_features: ['A', 'B'],
      item_specifics: [{ key: 'Marke', value: 'Sony' }],
      mobile_snippet: 'x',
    });

    const stage2 = makeStage2();
    // Pass objects with allowed values — "Schwarz" is first, should be picked as
    // the placeholder instead of literal "Unbekannt".
    stage2.requiredAspects = [
      { name: 'Marke' },
      { name: 'Farbe', values: ['Schwarz', 'Weiß', 'Rot'] },
    ];

    const result = await runStage3ContentGeneration(makeStage1(), stage2);

    const farbe = result.item_specifics.find((s) => s.key === 'Farbe');
    expect(farbe).toBeDefined();
    // Either picks one of the allowed values, not "Unbekannt" verbatim.
    expect(['Schwarz', 'Weiß', 'Rot']).toContain(farbe.value);
    // Also: the prompt-facing aspect is decorated with the allowed-values hint.
    const call = generateProductContentMock.mock.calls[0][0];
    const farbeAspect = call.enrichment.requiredAspects.find(
      (a) => String(a).startsWith('Farbe')
    );
    expect(String(farbeAspect)).toContain('erlaubt: Schwarz, Weiß, Rot');
  });

  it('triggers repair call when > 30% of required aspects are unknown', async () => {
    // Gemini returns 4 required aspects but only 'Marke' gets a value.
    generateProductContentMock.mockResolvedValueOnce({
      title_ebay: 't',
      title_kaufland: 't',
      description_ebay: '<p>x</p>',
      description_kaufland: '<p>x</p>',
      key_features: ['A'],
      item_specifics: [{ key: 'Marke', value: 'Sony' }],
      mobile_snippet: 'x',
    });
    gemini3GenerateJSONMock.mockResolvedValueOnce({
      repaired: {
        Modell: 'WH-1000XM5',
        Farbe: 'Schwarz',
        Konnektivitaet: 'Bluetooth',
      },
      confidence: {
        Modell: 0.9,
        Farbe: 0.8,
        Konnektivitaet: 0.7,
      },
    });

    const stage2 = makeStage2();
    stage2.requiredAspects = ['Marke', 'Modell', 'Farbe', 'Konnektivitaet'];
    const result = await runStage3ContentGeneration(makeStage1(), stage2);

    expect(gemini3GenerateJSONMock).toHaveBeenCalledTimes(1);
    const modell = result.item_specifics.find((s) => s.key === 'Modell');
    expect(modell.value).toBe('WH-1000XM5');
    expect(result.item_specifics_confidence.Modell).toBeCloseTo(0.9, 2);
    expect(result._meta.aspectEnforcement.repairApplied).toBe(true);
  });

  it('does not trigger repair call when all required aspects are known', async () => {
    // Default mock already has all required aspects filled.
    const stage2 = makeStage2();
    stage2.requiredAspects = ['Marke', 'Modell', 'Farbe'];
    await runStage3ContentGeneration(makeStage1(), stage2);
    expect(gemini3GenerateJSONMock).not.toHaveBeenCalled();
  });

  it('can disable aspect enforcement via STAGE3_ASPECT_ENFORCEMENT=false', async () => {
    const original = process.env.STAGE3_ASPECT_ENFORCEMENT;
    process.env.STAGE3_ASPECT_ENFORCEMENT = 'false';
    try {
      generateProductContentMock.mockResolvedValueOnce({
        title_ebay: 'Produkt',
        title_kaufland: 'Produkt',
        description_ebay: '<p>x</p>',
        description_kaufland: '<p>x</p>',
        key_features: ['A', 'B'],
        item_specifics: [{ key: 'Marke', value: 'Sony' }],
        mobile_snippet: 'x',
      });

      const stage2 = makeStage2();
      stage2.requiredAspects = ['Marke', 'Modell', 'Farbe'];
      const result = await runStage3ContentGeneration(makeStage1(), stage2);

      // Should NOT back-fill — only 'Marke' is present (after canonicalization).
      const keys = result.item_specifics.map((s) => s.key);
      expect(keys).not.toContain('Modell');
      expect(keys).not.toContain('Farbe');
      expect(result._meta.aspectEnforcement).toBeNull();
    } finally {
      if (original === undefined) delete process.env.STAGE3_ASPECT_ENFORCEMENT;
      else process.env.STAGE3_ASPECT_ENFORCEMENT = original;
    }
  });

  it('can disable repair call via STAGE3_ASPECT_REPAIR=false', async () => {
    const original = process.env.STAGE3_ASPECT_REPAIR;
    process.env.STAGE3_ASPECT_REPAIR = 'false';
    try {
      generateProductContentMock.mockResolvedValueOnce({
        title_ebay: 't',
        title_kaufland: 't',
        description_ebay: '<p>x</p>',
        description_kaufland: '<p>x</p>',
        key_features: ['A'],
        item_specifics: [{ key: 'Marke', value: 'Sony' }],
        mobile_snippet: 'x',
      });

      const stage2 = makeStage2();
      stage2.requiredAspects = ['Marke', 'Modell', 'Farbe', 'Konnektivitaet'];
      await runStage3ContentGeneration(makeStage1(), stage2);

      expect(gemini3GenerateJSONMock).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.STAGE3_ASPECT_REPAIR;
      else process.env.STAGE3_ASPECT_REPAIR = original;
    }
  });
});
