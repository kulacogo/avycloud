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
  exports: {
    sanitizeDescriptionToHtml: vi.fn((html) => html),
    sanitizeDescriptionProse: vi.fn((html) => html),
    PRICE_SENTENCE_RE: /preis/i,
  },
};

const highlightsPath = require.resolve('../../lib/highlights-policy');
require(highlightsPath);
require.cache[highlightsPath] = {
  id: highlightsPath, filename: highlightsPath, loaded: true,
  // Mirror the REAL return shape: an object { ok, highlights, issues }, NOT a bare array.
  exports: {
    normalizeHighlightsStrict: vi.fn((_, list) => ({ ok: true, highlights: list, issues: [] })),
  },
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

// Mock the agentic stage-3 module so existing Stage-3 tests don't make real
// Gemini calls now that STAGE3_AGENTIC defaults to ON. Tests that explicitly
// exercise the agentic path live in `identify-v3-stage3-agentic.test.js`.
const agenticPath = require.resolve('../../lib/identify-v3-stage3-agentic');
require.cache[agenticPath] = {
  id: agenticPath, filename: agenticPath, loaded: true,
  exports: {
    generateProductContentAgentic: vi.fn(),
    isAgenticEnabled: vi.fn(() => false),
    _internal: {},
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

  it('sanitizes the description as flowing prose, not bullets', async () => {
    const { sanitizeDescriptionProse, sanitizeDescriptionToHtml } = require('../../lib/listing-sanitize');
    await runStage3ContentGeneration(makeStage1(), makeStage2());

    // Beschreibung = Fließtext: the prose sanitizer runs, the bulletizer does NOT.
    expect(sanitizeDescriptionProse).toHaveBeenCalled();
    expect(sanitizeDescriptionToHtml).not.toHaveBeenCalled();
  });

  it('applies the normalized highlights (uses .highlights from the policy result)', async () => {
    const { normalizeHighlightsStrict } = require('../../lib/highlights-policy');
    // The policy returns a CLEANED list distinct from the raw model output.
    normalizeHighlightsStrict.mockReturnValueOnce({
      ok: true,
      highlights: ['Kundennutzen – technische Spec'],
      issues: [],
    });

    const result = await runStage3ContentGeneration(makeStage1(), makeStage2());

    // The cleaned highlights must win — not the raw passthrough.
    expect(result.key_features).toEqual(['Kundennutzen – technische Spec']);
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

// ─── Phase 2 (2026-04-30): Stage 3 data-feeding regression tests ───────────────
//
// Verifies that the data Stage 1 + Stage 2 collected actually reaches Stage 3.
// Until 2026-04-30 OCR text, EAN-DB hits, GPSR web fallback and 2 of 4 images
// were silently dropped before generateProductContent — Stage 3 was effectively
// blind.

describe('runStage3ContentGeneration — data feed (Phase 2)', () => {
  it('forwards OCR text snippets from stage1.ocrPayload.textSnippets', async () => {
    const stage1 = makeStage1();
    stage1.ocrPayload = {
      barcodes: ['4548736132610'],
      textSnippets: [
        'Sony WH-1000XM5 Wireless Noise Cancelling Headphones',
        'Bluetooth 5.2 / 30h Battery / Black',
        'Made in Malaysia. Manufactured by Sony Corporation, Tokyo.',
      ],
    };
    await runStage3ContentGeneration(stage1, makeStage2());
    const call = generateProductContentMock.mock.calls[0][0];
    expect(Array.isArray(call.ocrSnippets)).toBe(true);
    expect(call.ocrSnippets.length).toBe(3);
    expect(call.ocrSnippets[0]).toContain('Sony WH-1000XM5');
  });

  it('forwards eanLookup from stage1', async () => {
    const stage1 = makeStage1();
    stage1.eanLookup = { found: true, brand: 'Sony', productName: 'WH-1000XM5', category: 'Audio' };
    await runStage3ContentGeneration(stage1, makeStage2());
    const call = generateProductContentMock.mock.calls[0][0];
    expect(call.eanLookup).toEqual(stage1.eanLookup);
  });

  it('forwards stage2.gpsrWebFallback (previously discarded)', async () => {
    const stage2 = makeStage2();
    stage2.gpsr = { found: false, data: null };
    stage2.gpsrWebFallback = {
      manufacturer_name: 'Sony Europe B.V.',
      manufacturer_address: 'Da Vincilaan 7-D1, 1930 Zaventem',
      email: 'gpsr@sony.eu',
    };
    await runStage3ContentGeneration(makeStage1(), stage2);
    const call = generateProductContentMock.mock.calls[0][0];
    expect(call.gpsrWebFallback).toEqual(stage2.gpsrWebFallback);
  });

  it('forwards stage2.weightFallback', async () => {
    const stage2 = makeStage2();
    stage2.weightFallback = { weight_grams: 250, sources: [{ url: 'https://sony.com' }] };
    await runStage3ContentGeneration(makeStage1(), stage2);
    const call = generateProductContentMock.mock.calls[0][0];
    expect(call.weightFallback).toEqual(stage2.weightFallback);
  });

  it('forwards stage2.barcodeConfirmation', async () => {
    const stage2 = makeStage2();
    stage2.barcodeConfirmation = { confirmed: true, evidence: [{ url: 'https://sony.de', title: 'Sony XM5' }] };
    await runStage3ContentGeneration(makeStage1(), stage2);
    const call = generateProductContentMock.mock.calls[0][0];
    expect(call.barcodeConfirmation).toEqual(stage2.barcodeConfirmation);
  });

  it('forwards ALL imageParts (no longer slice(0, 2))', async () => {
    const stage1 = makeStage1();
    stage1.imageParts = [
      { data: 'img1', mimeType: 'image/jpeg' },
      { data: 'img2', mimeType: 'image/jpeg' },
      { data: 'img3', mimeType: 'image/jpeg' },
      { data: 'img4', mimeType: 'image/jpeg' },
    ];
    await runStage3ContentGeneration(stage1, makeStage2());
    const call = generateProductContentMock.mock.calls[0][0];
    expect(call.imageParts.length).toBe(4);
  });

  it('handles missing optional fields gracefully (back-compat)', async () => {
    const stage1 = makeStage1();
    delete stage1.ocrPayload;
    delete stage1.eanLookup;
    const stage2 = makeStage2();
    delete stage2.gpsrWebFallback;
    delete stage2.weightFallback;
    delete stage2.barcodeConfirmation;

    const result = await runStage3ContentGeneration(stage1, stage2);
    expect(result.title_ebay).toBeTruthy();
    const call = generateProductContentMock.mock.calls[0][0];
    expect(call.ocrSnippets).toEqual([]);
    expect(call.eanLookup).toBeNull();
    expect(call.gpsrWebFallback).toBeNull();
    expect(call.weightFallback).toBeNull();
    expect(call.barcodeConfirmation).toBeNull();
  });
});

// ─── Phase 2 (2026-04-30): Lower aspect-repair threshold ─────────────────────
//
// Until 2026-04-30 the repair Gemini call only fired when MORE than 30 % of
// required aspects were unknown. eBay Cassini penalises every individual gap
// — at 25 % unknown the listing still loses ranking. Default lowered to 10 %.

describe('runStage3ContentGeneration — aspect-repair threshold (Phase 2)', () => {
  it('triggers repair when >= 10% (default) of required aspects are unknown', async () => {
    // 1 of 10 unknown == 10 % — at the new default threshold, repair triggers.
    generateProductContentMock.mockResolvedValueOnce({
      title_ebay: 't', title_kaufland: 't',
      description_ebay: '<p>x</p>', description_kaufland: '<p>x</p>',
      key_features: ['A'],
      item_specifics: [
        { key: 'Marke', value: 'Sony' }, { key: 'Modell', value: 'X' },
        { key: 'Farbe', value: 'Schwarz' }, { key: 'A', value: 'a' },
        { key: 'B', value: 'b' }, { key: 'C', value: 'c' },
        { key: 'D', value: 'd' }, { key: 'E', value: 'e' },
        { key: 'F', value: 'f' },
        // 'G' missing → 1/10 unknown = 10 %.
      ],
      mobile_snippet: 'x',
    });
    gemini3GenerateJSONMock.mockResolvedValueOnce({ repaired: { G: 'g-value' }, confidence: { G: 0.8 } });

    const stage2 = makeStage2();
    stage2.requiredAspects = ['Marke', 'Modell', 'Farbe', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];
    await runStage3ContentGeneration(makeStage1(), stage2);
    expect(gemini3GenerateJSONMock).toHaveBeenCalledTimes(1);
  });

  it('respects STAGE3_ASPECT_REPAIR_THRESHOLD env override (e.g. 0.5)', async () => {
    const original = process.env.STAGE3_ASPECT_REPAIR_THRESHOLD;
    process.env.STAGE3_ASPECT_REPAIR_THRESHOLD = '0.5';
    try {
      // 2 of 5 unknown = 40 % — below the 50 % threshold → no repair.
      generateProductContentMock.mockResolvedValueOnce({
        title_ebay: 't', title_kaufland: 't',
        description_ebay: '<p>x</p>', description_kaufland: '<p>x</p>',
        key_features: ['A'],
        item_specifics: [
          { key: 'Marke', value: 'Sony' },
          { key: 'Modell', value: 'X' },
          { key: 'Farbe', value: 'Schwarz' },
        ],
        mobile_snippet: 'x',
      });

      const stage2 = makeStage2();
      stage2.requiredAspects = ['Marke', 'Modell', 'Farbe', 'D', 'E'];
      await runStage3ContentGeneration(makeStage1(), stage2);
      expect(gemini3GenerateJSONMock).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.STAGE3_ASPECT_REPAIR_THRESHOLD;
      else process.env.STAGE3_ASPECT_REPAIR_THRESHOLD = original;
    }
  });

  it('does not fire repair when zero aspects are unknown', async () => {
    const stage2 = makeStage2();
    stage2.requiredAspects = ['Marke', 'Modell', 'Farbe'];
    await runStage3ContentGeneration(makeStage1(), stage2);
    expect(gemini3GenerateJSONMock).not.toHaveBeenCalled();
  });
});

// ─── Phase 3 (2026-05-07): Fallback description regression tests ───────────────
//
// When Gemini fails, buildFallbackContent() previously returned
// `<p>${name}</p>` — title repeated as description. The wizard then showed a
// near-empty product. The new fallback enriches the description from
// identity + stage2 signals (category, color, weight, MPN, ...).
describe('runStage3ContentGeneration — richer fallback (Phase 3)', () => {
  it('builds a description with category + color bullets when Gemini fails', async () => {
    generateProductContentMock.mockRejectedValueOnce(new Error('Gemini timeout'));
    const stage1 = makeStage1();
    stage1.identity.color = 'Schwarz';
    stage1.identity.material = 'Aluminium';
    const stage2 = makeStage2();
    stage2.category.ebayBreadcrumb = 'TV, Video & Audio > Kopfhoerer';
    stage2.weightFallback = { weight_grams: 250, confidence: 0.6 };

    const result = await runStage3ContentGeneration(stage1, stage2);

    expect(result.description_ebay).toContain('Sony WH-1000XM5');
    expect(result.description_ebay).toContain('Kopfhoerer');
    expect(result.description_ebay).toContain('Schwarz');
    expect(result.description_ebay).toContain('Aluminium');
    expect(result.description_ebay).toMatch(/250 g|0\.25 kg/);
    expect(result.description_ebay).toContain('<ul>');
    expect(result.description_ebay).not.toBe(result.title_ebay);
  });

  it('falls back to plain <p>name</p> when no enrichment context is available', async () => {
    generateProductContentMock.mockRejectedValueOnce(new Error('Gemini failed'));
    const stage1 = makeStage1();
    stage1.identity.color = '';
    stage1.identity.material = '';
    stage1.identity.size = '';
    stage1.identity.mpn = '';
    const stage2 = makeStage2();
    stage2.category.ebayBreadcrumb = '';

    const result = await runStage3ContentGeneration(stage1, stage2);

    expect(result.description_ebay).toContain('<p>');
    expect(result.description_ebay).toContain('Sony WH-1000XM5');
    expect(result.description_ebay).not.toContain('<ul>');
  });

  it('formats kg weights for items above 1000 g', async () => {
    generateProductContentMock.mockRejectedValueOnce(new Error('boom'));
    const stage1 = makeStage1();
    stage1.identity.weight_grams = 2500;
    const stage2 = makeStage2();

    const result = await runStage3ContentGeneration(stage1, stage2);
    expect(result.description_ebay).toMatch(/2[.,]5\s*kg/);
  });

  it('builds key_features from identity + category leaf in fallback', async () => {
    generateProductContentMock.mockRejectedValueOnce(new Error('boom'));
    const stage1 = makeStage1();
    stage1.identity.color = 'Schwarz';
    const stage2 = makeStage2();
    stage2.category.ebayBreadcrumb = 'TV, Video & Audio > Kopfhoerer';

    const result = await runStage3ContentGeneration(stage1, stage2);
    expect(result.key_features).toEqual(expect.arrayContaining(['Sony', 'WH-1000XM5', 'Schwarz', 'Kopfhoerer']));
  });
});
