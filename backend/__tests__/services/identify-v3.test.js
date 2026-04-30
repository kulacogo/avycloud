'use strict';

// Mock all stage modules via require.cache

const mockStage1Result = {
  identity: {
    brand: 'Sony', model: 'WH-1000XM5', mpn: 'WH1000XM5B', variant: 'Schwarz',
    condition: 'Neu', internalCategory: 'Elektronik > Kopfhoerer', weight_grams: 250,
    color: 'Schwarz', size: '', material: '',
  },
  barcodes: {
    ean: '4548736132610', gtin: '', upc: '',
    ranked: [{ code: '4548736132610', type: 'ean13', valid: true }],
    explicit: ['4548736132610'],
  },
  eanLookup: { found: true, brand: 'Sony' },
  ocrPayload: { barcodes: ['4548736132610'], textSnippets: ['Sony'] },
  uploadedImages: [{ url: 'https://storage.example.com/img.jpg', width: 800, height: 600 }],
  imageParts: [{ data: 'base64data', mimeType: 'image/jpeg' }],
  _meta: { durationMs: 5000, groundingUsed: true },
};

const mockStage2Result = {
  category: { ebayId: '112529', ebayBreadcrumb: 'TV, Video & Audio > Kopfhoerer' },
  requiredAspects: ['Marke', 'Modell', 'Farbe'],
  pricing: { amount: 289, currency: 'EUR', sources: [{ url: 'https://geizhals.de' }], confidence: 0.85 },
  gpsr: { found: true, data: { manufacturer_name: 'Sony Europe B.V.', manufacturer_address: 'Berlin', email: 'info@sony.eu' } },
  titleInsights: { sampleTitles: ['Sony XM5 Kopfhoerer'], topTokens: ['Sony', 'Bluetooth'] },
  webImages: [{ url: 'https://sony.com/xm5.jpg', title: 'Sony XM5' }],
  barcodeConfirmation: { confirmed: true },
  _meta: { durationMs: 12000, enrichmentResults: {} },
};

const mockStage3Result = {
  title_ebay: 'Sony WH-1000XM5 Bluetooth Over-Ear Kopfhoerer Schwarz',
  title_kaufland: 'Sony WH-1000XM5 Noise-Cancelling Kopfhoerer',
  description_ebay: '<p>Premium Kopfhoerer</p>',
  description_kaufland: '<p>Sony Kopfhoerer</p>',
  key_features: ['Noise-Cancelling', 'Bluetooth 5.2', '30h Akku'],
  item_specifics: [
    { key: 'Marke', value: 'Sony' },
    { key: 'Modell', value: 'WH-1000XM5' },
    { key: 'Farbe', value: 'Schwarz' },
  ],
  mobile_snippet: 'Sony WH-1000XM5 Kopfhoerer',
  gpsr_manufacturer_name: 'Sony Europe B.V.',
  _meta: { durationMs: 6000 },
};

const runStage1Mock = vi.fn(async () => ({ ...mockStage1Result }));
const runStage2Mock = vi.fn(async () => ({ ...mockStage2Result }));
const runStage3Mock = vi.fn(async () => ({ ...mockStage3Result }));
const runStage4Mock = vi.fn(() => ({
  overallScore: 0.87,
  fieldConfidence: { brand: { score: 0.95 }, ean: { score: 0.9 } },
  requiredAspectsCoverage: { total: 3, filled: 3, missing: [], coverage: 1 },
  marketplaceReadiness: {
    ebay: { ready: true, issues: [], score: 0.87 },
    kaufland: { ready: true, issues: [], score: 0.87 },
  },
  gpsrScore: 8,
  qualityGate: { ok: true, issues: [] },
}));

// Patch require.cache
const stage1Path = require.resolve('../../lib/identify-v3-stage1');
require(stage1Path);
require.cache[stage1Path] = {
  id: stage1Path, filename: stage1Path, loaded: true,
  exports: { runStage1Recognition: runStage1Mock },
};

const stage2Path = require.resolve('../../lib/identify-v3-stage2');
require(stage2Path);
require.cache[stage2Path] = {
  id: stage2Path, filename: stage2Path, loaded: true,
  exports: { runStage2Enrichment: runStage2Mock },
};

const stage3Path = require.resolve('../../lib/identify-v3-stage3');
require(stage3Path);
require.cache[stage3Path] = {
  id: stage3Path, filename: stage3Path, loaded: true,
  exports: { runStage3ContentGeneration: runStage3Mock },
};

const stage4Path = require.resolve('../../lib/identify-v3-stage4');
require(stage4Path);
require.cache[stage4Path] = {
  id: stage4Path, filename: stage4Path, loaded: true,
  exports: {
    runStage4Validation: runStage4Mock,
    computeFieldConfidence: vi.fn(),
    computeAspectCoverage: vi.fn(),
  },
};

const { identifyProductV3 } = require('../../services/identify-v3');

beforeEach(() => {
  vi.clearAllMocks();
  runStage1Mock.mockImplementation(async () => JSON.parse(JSON.stringify(mockStage1Result)));
  runStage2Mock.mockImplementation(async () => JSON.parse(JSON.stringify(mockStage2Result)));
  runStage3Mock.mockImplementation(async () => JSON.parse(JSON.stringify(mockStage3Result)));
});

describe('identifyProductV3', () => {
  it('runs all 4 stages in sequence', async () => {
    const { product, meta } = await identifyProductV3({
      files: [{ buffer: Buffer.from('img'), mimetype: 'image/jpeg' }],
      barcodes: '4548736132610',
    });

    expect(runStage1Mock).toHaveBeenCalledTimes(1);
    expect(runStage2Mock).toHaveBeenCalledTimes(1);
    expect(runStage3Mock).toHaveBeenCalledTimes(1);
    expect(runStage4Mock).toHaveBeenCalledTimes(1);
    expect(meta.pipeline).toBe('v3');
  });

  it('produces canonical Product matching types.ts interface', async () => {
    const { product } = await identifyProductV3({
      files: [],
      barcodes: '4548736132610',
    });

    // identification
    expect(product.identification).toBeDefined();
    expect(product.identification.name).toContain('Sony');
    expect(product.identification.brand).toBe('Sony');
    expect(product.identification.category).toContain('Kopfhoerer');
    expect(typeof product.identification.confidence).toBe('number');

    // details
    expect(product.details).toBeDefined();
    expect(product.details.identifiers.ean).toBe('4548736132610');
    expect(product.details.short_description).toContain('<p>');
    expect(Array.isArray(product.details.key_features)).toBe(true);
    expect(product.details.attributes.Marke).toBe('Sony');
    expect(Array.isArray(product.details.images)).toBe(true);
    expect(product.details.pricing.lowest_price.amount).toBe(289);

    // ops
    expect(product.ops.sync_status).toBe('pending');
    expect(product.ops.revision).toBe(0);
    expect(product.ops.identify_pipeline).toBe('v3');

    // marketplace
    expect(product.marketplace.ebay.title).toContain('Sony');
    expect(product.marketplace.kaufland.title).toContain('Sony');

    // inventory
    expect(product.inventory).toBeDefined();
  });

  it('attaches Stage 4 confidence to ops.data_quality', async () => {
    const { product } = await identifyProductV3({
      files: [],
      barcodes: '4548736132610',
    });

    const dq = product.ops.data_quality.identify_v3;
    expect(dq.overall_score).toBe(0.87);
    expect(dq.field_confidence.brand.score).toBe(0.95);
    expect(dq.aspect_coverage.coverage).toBe(1);
    expect(dq.marketplace_readiness.ebay.ready).toBe(true);
  });

  it('includes per-stage timing metadata', async () => {
    const { meta } = await identifyProductV3({
      files: [],
      barcodes: '4548736132610',
    });

    expect(meta.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(meta.stages.stage1.durationMs).toBe(5000);
    expect(meta.stages.stage2.durationMs).toBe(12000);
    expect(meta.stages.stage3.durationMs).toBe(6000);
  });

  it('includes GPSR from registry when available', async () => {
    const { product } = await identifyProductV3({
      files: [],
      barcodes: '4548736132610',
    });

    expect(product.details.gpsr.manufacturer_name).toBe('Sony Europe B.V.');
  });

  it('includes web images from Stage 2', async () => {
    const { product } = await identifyProductV3({
      files: [],
      barcodes: '4548736132610',
    });

    const webImgs = product.details.images.filter((i) => i.source === 'web_search');
    expect(webImgs.length).toBe(1);
    expect(webImgs[0].url_or_base64).toBe('https://sony.com/xm5.jpg');
  });

  it('sets palette data when provided', async () => {
    const { product } = await identifyProductV3({
      files: [],
      barcodes: '4548736132610',
      paletteCode: 'PAL-001',
      inventoryId: 'inv-123',
    });

    expect(product.ops.sourcePalette).toBe('PAL-001');
    expect(product.ops.sourcePaletteAt).toBeTruthy();
    expect(product.inventory.inventoryId).toBe('inv-123');
  });

  it('generates valid UUID for product id', async () => {
    const { product } = await identifyProductV3({
      files: [],
      barcodes: '4548736132610',
    });

    expect(product.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('uses fallback name when Stage 3 title is empty', async () => {
    runStage3Mock.mockImplementation(async () => ({
      ...mockStage3Result,
      title_ebay: '',
    }));

    const { product } = await identifyProductV3({
      files: [],
      barcodes: '4548736132610',
    });

    expect(product.identification.name).toBe('Sony WH-1000XM5 Schwarz');
  });

  // ─── Phase 2 (2026-04-30): Brand-resolution + GPSR tier 3 ──────────────────

  describe('brand resolution', () => {
    it('does NOT fall back to first word of title (regression: "Hochwertige" was becoming brand)', async () => {
      // Stage 1 yields no brand, Stage 3 yields a generic adjective-led title.
      runStage1Mock.mockImplementation(async () => ({
        ...JSON.parse(JSON.stringify(mockStage1Result)),
        identity: { ...mockStage1Result.identity, brand: '' },
        eanLookup: null,
        v2FallbackRecord: null,
      }));
      runStage3Mock.mockImplementation(async () => ({
        ...JSON.parse(JSON.stringify(mockStage3Result)),
        title_ebay: 'Hochwertige Powerbank 20000mAh USB-C',
        item_specifics: [{ key: 'Modell', value: 'PB-20K' }],
      }));

      const { product } = await identifyProductV3({ files: [], barcodes: '' });
      expect(product.identification.brand).toBe('');
    });

    it('uses Stage 3 item_specifics["Marke"] when identity.brand is missing', async () => {
      runStage1Mock.mockImplementation(async () => ({
        ...JSON.parse(JSON.stringify(mockStage1Result)),
        identity: { ...mockStage1Result.identity, brand: '' },
        eanLookup: null,
        v2FallbackRecord: null,
      }));
      runStage3Mock.mockImplementation(async () => ({
        ...JSON.parse(JSON.stringify(mockStage3Result)),
        item_specifics: [{ key: 'Marke', value: 'Anker' }, { key: 'Modell', value: 'A1234' }],
      }));

      const { product } = await identifyProductV3({ files: [], barcodes: '' });
      expect(product.identification.brand).toBe('Anker');
    });

    it('rejects placeholder values in Stage 3 brand spec', async () => {
      runStage1Mock.mockImplementation(async () => ({
        ...JSON.parse(JSON.stringify(mockStage1Result)),
        identity: { ...mockStage1Result.identity, brand: '' },
        eanLookup: null,
        v2FallbackRecord: null,
      }));
      runStage3Mock.mockImplementation(async () => ({
        ...JSON.parse(JSON.stringify(mockStage3Result)),
        item_specifics: [{ key: 'Marke', value: 'Unbekannt' }],
      }));

      const { product } = await identifyProductV3({ files: [], barcodes: '' });
      expect(product.identification.brand).toBe('');
    });

    it('uses stage1.eanLookup.brand when identity.brand is missing', async () => {
      runStage1Mock.mockImplementation(async () => ({
        ...JSON.parse(JSON.stringify(mockStage1Result)),
        identity: { ...mockStage1Result.identity, brand: '' },
        eanLookup: { found: true, brand: 'Bose' },
      }));

      const { product } = await identifyProductV3({ files: [], barcodes: '4548736132610' });
      expect(product.identification.brand).toBe('Bose');
    });
  });

  describe('GPSR tier resolution', () => {
    it('uses gpsrWebFallback when registry empty AND Stage 3 yields no GPSR', async () => {
      runStage2Mock.mockImplementation(async () => ({
        ...JSON.parse(JSON.stringify(mockStage2Result)),
        gpsr: { found: false, data: null },
        gpsrWebFallback: {
          manufacturer_name: 'Sony Europe B.V.',
          manufacturer_address: 'Da Vincilaan 7-D1, 1930 Zaventem',
          email: 'gpsr@sony.eu',
        },
      }));
      runStage3Mock.mockImplementation(async () => ({
        ...JSON.parse(JSON.stringify(mockStage3Result)),
        gpsr_manufacturer_name: '',
        gpsr_manufacturer_address: '',
        gpsr_manufacturer_email: '',
      }));

      const { product } = await identifyProductV3({ files: [], barcodes: '4548736132610' });
      expect(product.details.gpsr).toBeDefined();
      expect(product.details.gpsr.manufacturer_name).toBe('Sony Europe B.V.');
      expect(product.details.gpsr.manufacturer_address).toContain('Zaventem');
    });

    it('still prefers Registry data over web fallback', async () => {
      runStage2Mock.mockImplementation(async () => ({
        ...JSON.parse(JSON.stringify(mockStage2Result)),
        gpsr: { found: true, data: { manufacturer_name: 'Registry Brand', email: 'reg@example.com' } },
        gpsrWebFallback: { manufacturer_name: 'Wrong Web Brand' },
      }));

      const { product } = await identifyProductV3({ files: [], barcodes: '4548736132610' });
      expect(product.details.gpsr.manufacturer_name).toBe('Registry Brand');
    });

    it('still prefers Stage 3 GPSR over web fallback', async () => {
      runStage2Mock.mockImplementation(async () => ({
        ...JSON.parse(JSON.stringify(mockStage2Result)),
        gpsr: { found: false, data: null },
        gpsrWebFallback: { manufacturer_name: 'Web Fallback Brand' },
      }));
      runStage3Mock.mockImplementation(async () => ({
        ...JSON.parse(JSON.stringify(mockStage3Result)),
        gpsr_manufacturer_name: 'Stage3 LLM Brand',
        gpsr_manufacturer_address: 'LLM Address',
      }));

      const { product } = await identifyProductV3({ files: [], barcodes: '4548736132610' });
      expect(product.details.gpsr.manufacturer_name).toBe('Stage3 LLM Brand');
    });

    it('leaves gpsr undefined when nothing is found', async () => {
      runStage2Mock.mockImplementation(async () => ({
        ...JSON.parse(JSON.stringify(mockStage2Result)),
        gpsr: { found: false, data: null },
        gpsrWebFallback: null,
      }));
      runStage3Mock.mockImplementation(async () => ({
        ...JSON.parse(JSON.stringify(mockStage3Result)),
        gpsr_manufacturer_name: '',
      }));

      const { product } = await identifyProductV3({ files: [], barcodes: '4548736132610' });
      expect(product.details.gpsr).toBeUndefined();
    });
  });
});
