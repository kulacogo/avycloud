'use strict';

// Patch dependencies before loading the module under test
const evaluateEbayReadyMock = vi.fn(() => ({ ok: true, issues: [], issuesDetailed: [], snapshot: {} }));
const scoreGpsrMock = vi.fn(() => 8);

// Patch CJS require.cache for dependencies
const dsqPath = require.resolve('../../lib/datasheet-quality');
require(dsqPath);
require.cache[dsqPath] = {
  id: dsqPath,
  filename: dsqPath,
  loaded: true,
  exports: { evaluateEbayReady: evaluateEbayReadyMock },
};

const gpsrPath = require.resolve('../../lib/gpsr-manufacturer-registry');
require(gpsrPath);
require.cache[gpsrPath] = {
  id: gpsrPath,
  filename: gpsrPath,
  loaded: true,
  exports: { scoreGpsr: scoreGpsrMock, getManufacturerGpsrByName: vi.fn() },
};

const { computeFieldConfidence, computeAspectCoverage, runStage4Validation } =
  require('../../lib/identify-v3-stage4');

beforeEach(() => {
  vi.clearAllMocks();
  evaluateEbayReadyMock.mockReturnValue({ ok: true, issues: [], issuesDetailed: [], snapshot: {} });
  scoreGpsrMock.mockReturnValue(8);
});

describe('computeFieldConfidence', () => {
  it('returns high confidence when multiple sources agree on brand', () => {
    const result = computeFieldConfidence('brand', 'Sony', {
      grounding: 'Sony',
      ean_db: 'Sony',
      barcode_confirm: true,
    });
    expect(result.score).toBeGreaterThanOrEqual(0.9);
    expect(result.sources.length).toBeGreaterThanOrEqual(2);
  });

  it('returns lower confidence with single source', () => {
    const result = computeFieldConfidence('brand', 'Sony', {
      grounding: 'Sony',
    });
    expect(result.score).toBeLessThan(0.9);
    expect(result.sources).toEqual(['grounding']);
  });

  it('returns 0 confidence for empty field', () => {
    const result = computeFieldConfidence('brand', '', {});
    expect(result.score).toBe(0);
    expect(result.sources).toEqual([]);
  });

  it('returns 0 confidence for null field', () => {
    const result = computeFieldConfidence('brand', null, {});
    expect(result.score).toBe(0);
  });

  it('returns 0.5 for unverified value', () => {
    const result = computeFieldConfidence('brand', 'Sony', {
      grounding: 'Samsung', // disagrees
    });
    expect(result.score).toBe(0.5);
    expect(result.sources).toEqual(['unverified']);
  });

  it('handles boolean sources (barcode_confirm)', () => {
    const result = computeFieldConfidence('ean', '4548736132610', {
      barcode_confirm: true,
    });
    expect(result.score).toBe(0.9); // barcode_confirm base = 0.9
    expect(result.sources).toEqual(['barcode_confirm']);
  });

  it('boosts score for 3+ agreeing sources', () => {
    const result = computeFieldConfidence('brand', 'Sony', {
      grounding: 'Sony',
      ean_db: 'Sony',
      barcode_confirm: true,
    });
    // Best base (barcode_confirm=0.9) + 0.25 boost, capped at 1.0
    expect(result.score).toBe(1.0);
  });

  it('is case-insensitive for source agreement', () => {
    const result = computeFieldConfidence('brand', 'Sony', {
      grounding: 'SONY',
      ean_db: 'sony',
    });
    expect(result.sources).toContain('grounding');
    expect(result.sources).toContain('ean_db');
  });
});

describe('computeAspectCoverage', () => {
  it('calculates coverage correctly', () => {
    const required = ['Marke', 'Herstellernummer', 'Produktart', 'Farbe'];
    const provided = [
      { key: 'Marke', value: 'Sony' },
      { key: 'Farbe', value: 'Schwarz' },
    ];
    const result = computeAspectCoverage(required, provided);
    expect(result.total).toBe(4);
    expect(result.filled).toBe(2);
    expect(result.missing).toEqual(['Herstellernummer', 'Produktart']);
    expect(result.coverage).toBeCloseTo(0.5);
  });

  it('returns 100% coverage when all aspects filled', () => {
    const required = ['Marke', 'Farbe'];
    const provided = [
      { key: 'Marke', value: 'Sony' },
      { key: 'Farbe', value: 'Schwarz' },
    ];
    const result = computeAspectCoverage(required, provided);
    expect(result.coverage).toBe(1);
    expect(result.missing).toEqual([]);
  });

  it('returns coverage 1 for empty required list', () => {
    const result = computeAspectCoverage([], [{ key: 'X', value: 'Y' }]);
    expect(result.coverage).toBe(1);
  });

  it('is case-insensitive for aspect matching', () => {
    const required = ['MARKE'];
    const provided = [{ key: 'marke', value: 'Sony' }];
    const result = computeAspectCoverage(required, provided);
    expect(result.filled).toBe(1);
    expect(result.missing).toEqual([]);
  });

  it('handles null/undefined inputs gracefully', () => {
    const result = computeAspectCoverage(null, undefined);
    expect(result.total).toBe(0);
    expect(result.coverage).toBe(1);
  });
});

describe('runStage4Validation', () => {
  const stage1 = {
    identity: { brand: 'Sony', internalCategory: 'Elektronik > Kopfhoerer', mpn: 'WH1000XM5' },
    barcodes: { ean: '4548736132610', gtin: '', upc: '', ranked: [{ code: '4548736132610' }] },
    eanLookup: { brand: 'Sony' },
    ocrPayload: { barcodes: ['4548736132610'] },
  };

  const stage2 = {
    category: { ebayId: '112529', ebayBreadcrumb: 'TV, Video & Audio > Kopfhoerer' },
    pricing: { amount: 289, currency: 'EUR', via: 'web', sources: [] },
    gpsr: { found: true, data: { manufacturer_name: 'Sony Europe B.V.', manufacturer_address: 'Berlin' } },
    barcodeConfirmation: { confirmed: true },
    requiredAspects: ['Marke', 'Modell', 'Farbe'],
  };

  const stage3 = {
    title_ebay: 'Sony WH-1000XM5 Bluetooth Kopfhoerer Schwarz',
    title_kaufland: 'Sony WH-1000XM5 Noise-Cancelling Kopfhoerer',
    description_ebay: '<p>Premium Kopfhoerer</p>',
    description_kaufland: '<p>Premium Kopfhoerer</p>',
    item_specifics: [
      { key: 'Marke', value: 'Sony' },
      { key: 'Modell', value: 'WH-1000XM5' },
      { key: 'Farbe', value: 'Schwarz' },
    ],
    key_features: ['Noise-Cancelling', 'Bluetooth 5.2'],
  };

  const product = {
    identification: { name: 'Sony WH-1000XM5', brand: 'Sony', category: 'Kopfhoerer' },
    details: {
      attributes: { Marke: 'Sony' },
      images: [{ url_or_base64: 'https://example.com/img.jpg' }],
      pricing: { lowest_price: { amount: 289, currency: 'EUR', sources: [{ url: 'https://x.com' }] } },
      gpsr: { manufacturer_name: 'Sony Europe B.V.' },
    },
  };

  it('computes overall score as weighted composite', () => {
    const result = runStage4Validation(stage1, stage2, stage3, product);
    expect(result.overallScore).toBeGreaterThan(0);
    expect(result.overallScore).toBeLessThanOrEqual(1);
  });

  it('includes field confidence for all key fields', () => {
    const result = runStage4Validation(stage1, stage2, stage3, product);
    expect(result.fieldConfidence).toHaveProperty('brand');
    expect(result.fieldConfidence).toHaveProperty('ean');
    expect(result.fieldConfidence).toHaveProperty('category');
    expect(result.fieldConfidence).toHaveProperty('price');
    expect(result.fieldConfidence).toHaveProperty('title_ebay');
    expect(result.fieldConfidence).toHaveProperty('gpsr');
  });

  it('includes aspect coverage', () => {
    const result = runStage4Validation(stage1, stage2, stage3, product);
    expect(result.requiredAspectsCoverage.total).toBe(3);
    expect(result.requiredAspectsCoverage.filled).toBe(3);
    expect(result.requiredAspectsCoverage.coverage).toBe(1);
  });

  it('calls evaluateEbayReady with force=true', () => {
    runStage4Validation(stage1, stage2, stage3, product);
    expect(evaluateEbayReadyMock).toHaveBeenCalledWith(product, { force: true });
  });

  it('calls scoreGpsr with product gpsr data', () => {
    runStage4Validation(stage1, stage2, stage3, product);
    expect(scoreGpsrMock).toHaveBeenCalledWith(product.details.gpsr);
  });

  it('sets ebay ready when quality gate passes and aspect coverage >= 70%', () => {
    const result = runStage4Validation(stage1, stage2, stage3, product);
    expect(result.marketplaceReadiness.ebay.ready).toBe(true);
  });

  it('sets ebay not ready when quality gate fails', () => {
    evaluateEbayReadyMock.mockReturnValueOnce({ ok: false, issues: ['missing title'], issuesDetailed: [] });
    const result = runStage4Validation(stage1, stage2, stage3, product);
    expect(result.marketplaceReadiness.ebay.ready).toBe(false);
  });

  it('sets kaufland ready when titles and descriptions present', () => {
    const result = runStage4Validation(stage1, stage2, stage3, product);
    expect(result.marketplaceReadiness.kaufland.ready).toBe(true);
  });

  it('handles missing stage data gracefully', () => {
    const minimal1 = { identity: {}, barcodes: {}, eanLookup: null, ocrPayload: {} };
    const minimal2 = { category: {}, pricing: {}, gpsr: {}, barcodeConfirmation: {} };
    const minimal3 = {};
    const minimalProduct = { identification: {}, details: {} };

    const result = runStage4Validation(minimal1, minimal2, minimal3, minimalProduct);
    expect(result.overallScore).toBeGreaterThanOrEqual(0);
    expect(result.fieldConfidence.brand.score).toBe(0);
  });
});
