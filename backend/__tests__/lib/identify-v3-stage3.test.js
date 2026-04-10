'use strict';

// Mock dependencies via require.cache

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
    expect(call.enrichment.requiredAspects).toEqual(['Marke', 'Modell', 'Farbe']);
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
});
