'use strict';

/**
 * identify-v4-spiegel-feld.test.js — Task D.4 Regression
 *
 * Verifies that `assembleProductV4()` writes the top-level mirror field
 * `identifyCheckedAtIso` (mirrored from
 * `ops.data_quality.identify_v4.checked_at_iso`). Firestore composite indexes
 * cannot efficiently index nested map fields, so admin-endpoint queries
 * depend on this top-level mirror.
 *
 * Also verifies that the V3 pipeline writes `identifyV3CheckedAtIso`
 * analogously, and that `firestore.indexes.json` parses as valid JSON with
 * the two new composite indexes present.
 */

const fs = require('fs');
const path = require('path');

// --- Mocks for V4 (mirror identify-v4.test.js skeleton) -------------------

const baseStage1 = {
  identity: {
    brand: 'Sony',
    model: 'WH-1000XM5',
    variant: 'Schwarz',
    color: 'Schwarz',
    weight_grams: 250,
    internalCategory: 'Elektronik > Kopfhoerer',
  },
  barcodes: { ean: '4548736132610', gtin: '', upc: '', ranked: [], explicit: [] },
  ocrPayload: { text: 'Sony WH-1000XM5' },
  imageParts: [{ data: 'base64', mimeType: 'image/jpeg' }],
  uploadedImages: [{ url: 'https://storage.example/x.jpg' }],
  webImageUrls: [],
  _meta: { durationMs: 42 },
};

const stage1Mock = vi.fn(async () => JSON.parse(JSON.stringify(baseStage1)));

const identityWorkerMock = vi.fn(async () => ({
  ok: true,
  domain: 'identity',
  resolved: { ean: '4548736132610', gtin: '4548736132610', brand: 'Sony', mpn: 'WH1000XM5B' },
  confidence: { ean: 0.95, gtin: 0.95, brand: 0.92, mpn: 0.85 },
  sources: [{ type: 'lookup_gtin', url: 'https://ean.example/x' }],
  meta: { durationMs: 100, toolsCalled: [{ name: 'lookup_gtin', ok: true }] },
}));

const categoryWorkerMock = vi.fn(async () => ({
  ok: true,
  domain: 'category',
  resolved: {
    categoryId: '112529',
    breadcrumb: 'TV, Video & Audio > Kopfhoerer',
    categoryName: 'Kopfhoerer',
    categorySource: 'auto:catalog',
    requiredAspects: [{ name: 'Marke' }, { name: 'Modell' }],
    recommendedAspects: [{ name: 'Farbe' }],
  },
  confidence: { categoryId: 0.95 },
  sources: [{ type: 'ebay_catalog', via: 'catalog', categoryId: '112529', confidence: 0.95 }],
  meta: { durationMs: 80 },
}));

const criticWorkerMock = vi.fn(async () => ({
  ok: true,
  domain: 'critic',
  resolved: {
    critiqued: true,
    issues: [],
    fix_hints: [],
    ebay_ready_score: 0.85,
    aspect_cap_applied: false,
    refinement_needed_workers: [],
  },
  confidence: { ebay_ready: 0.85 },
  sources: [],
  meta: { durationMs: 30, geminiCalls: 0 },
}));

const saveProductV2Mock = vi.fn(async (product) => ({ id: product.id, ok: true }));

// Patch require.cache for all V4 worker + stage1 + product-store dependencies
const stage1Path = require.resolve('../../lib/identify-v3-stage1');
require(stage1Path);
require.cache[stage1Path] = {
  id: stage1Path,
  filename: stage1Path,
  loaded: true,
  exports: { runStage1Recognition: stage1Mock },
};

const identityPath = require.resolve('../../lib/identify-workers/identity-worker');
require(identityPath);
require.cache[identityPath] = {
  id: identityPath,
  filename: identityPath,
  loaded: true,
  exports: { runIdentityWorker: identityWorkerMock },
};

const categoryPath = require.resolve('../../lib/identify-workers/category-worker');
require(categoryPath);
require.cache[categoryPath] = {
  id: categoryPath,
  filename: categoryPath,
  loaded: true,
  exports: { runCategoryWorker: categoryWorkerMock },
};

const criticPath = require.resolve('../../lib/identify-workers/critic-worker');
require(criticPath);
require.cache[criticPath] = {
  id: criticPath,
  filename: criticPath,
  loaded: true,
  exports: { runCriticWorker: criticWorkerMock },
};

const noopWaveWorker = (domain) => async () => ({
  ok: true,
  domain,
  resolved: {},
  confidence: {},
  sources: [],
  retriesRequested: [],
  meta: { durationMs: 1, toolsCalled: [], geminiCalls: 0, error: null },
});

const wave2WorkerMocks = {
  attributes: vi.fn(noopWaveWorker('attributes')),
  seo: vi.fn(noopWaveWorker('seo')),
  pricing: vi.fn(noopWaveWorker('pricing')),
  image: vi.fn(noopWaveWorker('image')),
  gpsr: vi.fn(noopWaveWorker('gpsr')),
};

for (const [domain, relpath] of [
  ['attributes', '../../lib/identify-workers/attributes-worker'],
  ['seo', '../../lib/identify-workers/seo-worker'],
  ['pricing', '../../lib/identify-workers/pricing-worker'],
  ['image', '../../lib/identify-workers/image-worker'],
  ['gpsr', '../../lib/identify-workers/gpsr-worker'],
]) {
  const p = require.resolve(relpath);
  require(p);
  const runnerName = `run${domain.charAt(0).toUpperCase()}${domain.slice(1)}Worker`;
  require.cache[p] = {
    id: p,
    filename: p,
    loaded: true,
    exports: { [runnerName]: wave2WorkerMocks[domain], DOMAIN: domain },
  };
}

const productStorePath = require.resolve('../../lib/product-store');
const realProductStore = require(productStorePath);
require.cache[productStorePath] = {
  id: productStorePath,
  filename: productStorePath,
  loaded: true,
  exports: {
    ...realProductStore,
    saveProductV2: saveProductV2Mock,
  },
};

const { identifyProductV4, _testables } = require('../../services/identify-v4');
const { assembleProductV4 } = _testables;

// --- V3 Mocks (mirror identify-v3.test.js skeleton) -----------------------

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
  titleInsights: { sampleTitles: [], topTokens: [] },
  webImages: [],
  barcodeConfirmation: { confirmed: true },
  _meta: { durationMs: 12000, enrichmentResults: {} },
};

const mockStage3Result = {
  title_ebay: 'Sony WH-1000XM5 Bluetooth Over-Ear Kopfhoerer Schwarz',
  title_kaufland: 'Sony WH-1000XM5 Noise-Cancelling Kopfhoerer',
  description_ebay: '<p>Premium Kopfhoerer</p>',
  description_kaufland: '<p>Sony Kopfhoerer</p>',
  key_features: ['Noise-Cancelling'],
  item_specifics: [{ key: 'Marke', value: 'Sony' }],
  mobile_snippet: 'Sony WH-1000XM5 Kopfhoerer',
  _meta: { durationMs: 6000 },
};

const v3Stage1Mock = vi.fn(async () => JSON.parse(JSON.stringify(mockStage1Result)));
const v3Stage2Mock = vi.fn(async () => JSON.parse(JSON.stringify(mockStage2Result)));
const v3Stage3Mock = vi.fn(async () => JSON.parse(JSON.stringify(mockStage3Result)));
const v3Stage4Mock = vi.fn(() => ({
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

// stage1 module is already cached for V4; V3 uses the SAME require path, so
// flip its mock impl. V3 calls runStage1Recognition through the cached export.
require.cache[stage1Path].exports.runStage1Recognition = v3Stage1Mock;

const stage2Path = require.resolve('../../lib/identify-v3-stage2');
require(stage2Path);
require.cache[stage2Path] = {
  id: stage2Path,
  filename: stage2Path,
  loaded: true,
  exports: { runStage2Enrichment: v3Stage2Mock },
};

const stage3Path = require.resolve('../../lib/identify-v3-stage3');
require(stage3Path);
require.cache[stage3Path] = {
  id: stage3Path,
  filename: stage3Path,
  loaded: true,
  exports: { runStage3ContentGeneration: v3Stage3Mock },
};

const stage4Path = require.resolve('../../lib/identify-v3-stage4');
require(stage4Path);
require.cache[stage4Path] = {
  id: stage4Path,
  filename: stage4Path,
  loaded: true,
  exports: {
    runStage4Validation: v3Stage4Mock,
    computeFieldConfidence: vi.fn(),
    computeAspectCoverage: vi.fn(),
  },
};

const { identifyProductV3 } = require('../../services/identify-v3');

// --- Tests ----------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  stage1Mock.mockImplementation(async () => JSON.parse(JSON.stringify(baseStage1)));
  v3Stage1Mock.mockImplementation(async () => JSON.parse(JSON.stringify(mockStage1Result)));
  v3Stage2Mock.mockImplementation(async () => JSON.parse(JSON.stringify(mockStage2Result)));
  v3Stage3Mock.mockImplementation(async () => JSON.parse(JSON.stringify(mockStage3Result)));
  saveProductV2Mock.mockImplementation(async (p) => ({ id: p.id, ok: true }));
  for (const fn of Object.values(wave2WorkerMocks)) fn.mockClear();
});

describe('Task D.4 — Top-Level-Spiegel-Feld for Composite-Index', () => {
  describe('V4 assembleProductV4()', () => {
    it('writes top-level identifyCheckedAtIso mirrored from nested data_quality.identify_v4.checked_at_iso', () => {
      const ctx = {
        locale: 'de-DE',
        identity: { brand: 'Sony', model: 'WH-1000XM5' },
        workerResults: {
          identity: { ok: true, domain: 'identity', resolved: { brand: 'Sony', ean: '4548736132610' }, confidence: { brand: 0.95 }, meta: {} },
          category: { ok: true, domain: 'category', resolved: { categoryId: '112529', breadcrumb: 'TV > Audio' }, confidence: { categoryId: 0.95 }, meta: {} },
          critic: { ok: true, domain: 'critic', resolved: { critiqued: true, ebay_ready_score: 0.85, issues: [], fix_hints: [], refinement_needed_workers: [] }, confidence: {}, meta: {} },
        },
        confidence: {},
        _waveHistory: [],
        _crossRefResolved: { brand: 'Sony', ean: '4548736132610' },
        _crossRefConfidence: {},
        _crossRefConflicts: [],
      };
      const product = assembleProductV4(ctx);

      // Nested struct still set (backwards-compat)
      expect(product.ops.data_quality.identify_v4.checked_at_iso).toBeTruthy();
      // Top-level mirror field set + identical value
      expect(product.identifyCheckedAtIso).toBeTruthy();
      expect(product.identifyCheckedAtIso).toBe(
        product.ops.data_quality.identify_v4.checked_at_iso
      );
      // Looks like an ISO 8601 timestamp
      expect(product.identifyCheckedAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('full V4 pipeline emits identifyCheckedAtIso on the saved product', async () => {
      const res = await identifyProductV4({
        files: [{ buffer: Buffer.from('x'), mimetype: 'image/jpeg' }],
        barcodes: '4548736132610',
      });
      expect(res.ok).toBe(true);
      expect(res.product.identifyCheckedAtIso).toBeTruthy();
      expect(res.product.identifyCheckedAtIso).toBe(
        res.product.ops.data_quality.identify_v4.checked_at_iso
      );
      // saveProductV2 received a product containing the mirror field
      expect(saveProductV2Mock).toHaveBeenCalled();
      const savedProduct = saveProductV2Mock.mock.calls[0][0];
      expect(savedProduct.identifyCheckedAtIso).toBeTruthy();
    });
  });

  describe('V3 identifyProductV3()', () => {
    it('writes top-level identifyV3CheckedAtIso mirrored from nested data_quality.identify_v3.checked_at_iso', async () => {
      const { product } = await identifyProductV3({
        files: [{ buffer: Buffer.from('img'), mimetype: 'image/jpeg' }],
        barcodes: '4548736132610',
      });

      // Nested struct still set (backwards-compat)
      expect(product.ops.data_quality.identify_v3.checked_at_iso).toBeTruthy();
      // Top-level mirror field set + identical value
      expect(product.identifyV3CheckedAtIso).toBeTruthy();
      expect(product.identifyV3CheckedAtIso).toBe(
        product.ops.data_quality.identify_v3.checked_at_iso
      );
      expect(product.identifyV3CheckedAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('firestore.indexes.json', () => {
    const indexesPath = path.resolve(__dirname, '../../../firestore.indexes.json');

    it('parses as valid JSON', () => {
      const raw = fs.readFileSync(indexesPath, 'utf-8');
      expect(() => JSON.parse(raw)).not.toThrow();
    });

    it('contains composite index for products_v2 tenantId + identifyCheckedAtIso', () => {
      const j = JSON.parse(fs.readFileSync(indexesPath, 'utf-8'));
      const match = j.indexes.find((idx) =>
        idx.collectionGroup === 'products_v2'
        && Array.isArray(idx.fields)
        && idx.fields.length === 2
        && idx.fields[0].fieldPath === 'tenantId'
        && idx.fields[0].order === 'ASCENDING'
        && idx.fields[1].fieldPath === 'identifyCheckedAtIso'
        && idx.fields[1].order === 'DESCENDING'
      );
      expect(match).toBeTruthy();
    });

    it('contains composite index for products_v2 tenantId + identifyV3CheckedAtIso', () => {
      const j = JSON.parse(fs.readFileSync(indexesPath, 'utf-8'));
      const match = j.indexes.find((idx) =>
        idx.collectionGroup === 'products_v2'
        && Array.isArray(idx.fields)
        && idx.fields.length === 2
        && idx.fields[0].fieldPath === 'tenantId'
        && idx.fields[0].order === 'ASCENDING'
        && idx.fields[1].fieldPath === 'identifyV3CheckedAtIso'
        && idx.fields[1].order === 'DESCENDING'
      );
      expect(match).toBeTruthy();
    });
  });
});
