'use strict';

// Mock all enrichment dependencies via require.cache patching

const findEbayCategoryMock = vi.fn(() => ({ id: '112529', breadcrumb: 'TV, Video & Audio > Kopfhoerer' }));
const getCategoryAspectCatalogMock = vi.fn(() => ({
  required: [{ name: 'Marke' }, { name: 'Herstellernummer' }, { name: 'Produktart' }],
}));
// Realer Contract (lib/price-enrichment.js enrichPriceParallel): die Funktion
// MUTIERT das übergebene Produkt und returned nur { ok, updated, serpTrace } —
// die Preisdaten stehen NIE im Return-Wert. Der alte Mock returnte
// { lowest_price, price_confidence } und fixierte damit genau den PROD-BUG,
// durch den stage2.pricing.amount immer 0 war (Fix 2026-07-11).
const enrichPriceParallelMock = vi.fn(async (product) => {
  product.details = product.details || {};
  product.details.pricing = product.details.pricing || {};
  product.details.pricing.lowest_price = {
    amount: 289,
    currency: 'EUR',
    sources: [{ url: 'https://geizhals.de' }],
    last_checked_iso: new Date().toISOString(),
  };
  product.details.pricing.price_confidence = 0.85;
  return { ok: true, updated: true, serpTrace: [] };
});
const getManufacturerGpsrByNameMock = vi.fn(async () => ({
  found: true,
  data: { manufacturer_name: 'Sony Europe B.V.', manufacturer_address: 'Berlin', email: 'info@sony.eu' },
}));
const fetchCategoryTitleInsightsMock = vi.fn(async () => ({
  sampleTitles: ['Sony WH-1000XM5 Kopfhoerer Bluetooth', 'Sony WH-1000XM5 ANC Over-Ear'],
  topTokens: ['Sony', 'Bluetooth', 'Kopfhoerer', 'ANC'],
}));
const searchProductImagesMock = vi.fn(async () => [
  { url: 'https://sony.com/xm5.jpg', title: 'Sony XM5' },
]);
const confirmBarcodeWithWebMock = vi.fn(async () => ({ ok: true, barcode: '4548736132610', evidence: 'Sony WH-1000XM5' }));
const lookupWeightFromWebMock = vi.fn(async () => ({
  weight_grams: 280,
  confidence: 0.85,
  sources: ['https://vendor.de/spec'],
}));
const lookupGpsrFromWebMock = vi.fn(async () => ({
  manufacturer_name: 'Beispiel GmbH',
  manufacturer_address: 'Musterstr. 1, D-80331 München',
  manufacturer_email: 'info@beispiel.de',
  manufacturer_url: 'https://beispiel.de',
  confidence: 0.75,
  sources: ['https://beispiel.de/impressum'],
}));
// Phase B (2026-04-30): category-resolver-v2 is loaded lazily inside Stage 2.
// Default: returns null so the local findEbayCategory match wins (preserves
// pre-existing test behaviour). Per-test overrides set this for the new V2-
// integration assertions further down the file.
const resolveCategoryV2Mock = vi.fn(async () => null);

// Patch require.cache
const taxonomyPath = require.resolve('../../lib/ebay-taxonomy');
require(taxonomyPath);
require.cache[taxonomyPath] = {
  id: taxonomyPath, filename: taxonomyPath, loaded: true,
  exports: {
    findEbayCategory: findEbayCategoryMock,
    getCategoryAspectCatalog: getCategoryAspectCatalogMock,
    getRequiredAspects: vi.fn(() => []),
    buildRequiredAspectMeta: vi.fn(() => ({})),
    getRequiredAspectCatalogStats: vi.fn(() => ({})),
    isBannedEbayBreadcrumb: vi.fn(() => false),
  },
};

const pricePath = require.resolve('../../lib/price-enrichment');
require(pricePath);
require.cache[pricePath] = {
  id: pricePath, filename: pricePath, loaded: true,
  exports: { enrichPriceParallel: enrichPriceParallelMock, enrichPriceForProductBestEffort: vi.fn() },
};

const gpsrPath = require.resolve('../../lib/gpsr-manufacturer-registry');
require(gpsrPath);
require.cache[gpsrPath] = {
  id: gpsrPath, filename: gpsrPath, loaded: true,
  exports: { getManufacturerGpsrByName: getManufacturerGpsrByNameMock, scoreGpsr: vi.fn(() => 8) },
};

const titleInsightsPath = require.resolve('../../lib/ebay-browse-title-insights');
require(titleInsightsPath);
require.cache[titleInsightsPath] = {
  id: titleInsightsPath, filename: titleInsightsPath, loaded: true,
  exports: { fetchCategoryTitleInsights: fetchCategoryTitleInsightsMock, fetchBrowsePriceSamples: vi.fn() },
};

const imageSearchPath = require.resolve('../../lib/image-search');
require(imageSearchPath);
require.cache[imageSearchPath] = {
  id: imageSearchPath, filename: imageSearchPath, loaded: true,
  exports: { searchProductImages: searchProductImagesMock },
};

const barcodeConfirmPath = require.resolve('../../lib/barcode-web-confirm');
require(barcodeConfirmPath);
require.cache[barcodeConfirmPath] = {
  id: barcodeConfirmPath, filename: barcodeConfirmPath, loaded: true,
  exports: { confirmBarcodeWithWeb: confirmBarcodeWithWebMock },
};

const weightWebPath = require.resolve('../../lib/weight-web-lookup');
require(weightWebPath);
require.cache[weightWebPath] = {
  id: weightWebPath, filename: weightWebPath, loaded: true,
  exports: {
    lookupWeightFromWeb: lookupWeightFromWebMock,
    brandDomainGuess: vi.fn(() => null),
    parseWeightToGrams: vi.fn(() => null),
    extractWeightCandidates: vi.fn(() => []),
    buildQueries: vi.fn(() => []),
  },
};

const gpsrWebPath = require.resolve('../../lib/gpsr-web-fallback');
require(gpsrWebPath);
require.cache[gpsrWebPath] = {
  id: gpsrWebPath, filename: gpsrWebPath, loaded: true,
  exports: {
    lookupGpsrFromWeb: lookupGpsrFromWebMock,
    stripTags: vi.fn(() => ''),
    extractEmail: vi.fn(() => null),
    extractAddress: vi.fn(() => null),
    extractCompanyName: vi.fn(() => null),
    computeConfidence: vi.fn(() => 0),
    emailPriorityScore: vi.fn(() => 100),
  },
};

// Mock category-resolver so Stage 2's lazy `_tryRequireCategoryResolverV2()`
// returns our test double without hitting eBay APIs / Gemini.
const categoryResolverPath = require.resolve('../../services/category-resolver');
require.cache[categoryResolverPath] = {
  id: categoryResolverPath, filename: categoryResolverPath, loaded: true,
  exports: {
    resolveCategoryV2: resolveCategoryV2Mock,
    STRATEGY_ACCEPT_THRESHOLD: 0.85,
  },
};

const { runStage2Enrichment, withTimeout } = require('../../lib/identify-v3-stage2');

beforeEach(() => {
  vi.clearAllMocks();
  // Default: V2 returns null so the local lookup wins. Tests that need a V2
  // result override via mockResolvedValueOnce.
  resolveCategoryV2Mock.mockImplementation(async () => null);
});

const makeStage1 = (overrides = {}) => ({
  identity: {
    brand: 'Sony',
    model: 'WH-1000XM5',
    mpn: 'WH1000XM5B',
    variant: 'Schwarz',
    condition: 'Neu',
    internalCategory: 'Elektronik > Kopfhoerer > Over-Ear',
    weight_grams: 250,
    color: 'Schwarz',
    ...overrides.identity,
  },
  barcodes: {
    ean: '4548736132610',
    gtin: '',
    upc: '',
    ranked: [{ code: '4548736132610', type: 'ean13', valid: true }],
    explicit: ['4548736132610'],
    ...overrides.barcodes,
  },
  uploadedImages: [{ url: 'https://storage.example.com/img.jpg', width: 800, height: 600 }],
  ...overrides,
});

describe('runStage2Enrichment', () => {
  it('runs all 6 enrichments in parallel', async () => {
    const result = await runStage2Enrichment(makeStage1());

    expect(findEbayCategoryMock).toHaveBeenCalled();
    expect(getCategoryAspectCatalogMock).toHaveBeenCalled();
    expect(enrichPriceParallelMock).toHaveBeenCalled();
    expect(getManufacturerGpsrByNameMock).toHaveBeenCalledWith('Sony');
    expect(fetchCategoryTitleInsightsMock).toHaveBeenCalled();
    expect(searchProductImagesMock).toHaveBeenCalled();
    expect(confirmBarcodeWithWebMock).toHaveBeenCalled();
  });

  it('returns category with ebay breadcrumb', async () => {
    const result = await runStage2Enrichment(makeStage1());
    expect(result.category.ebayId).toBe('112529');
    expect(result.category.ebayBreadcrumb).toBe('TV, Video & Audio > Kopfhoerer');
  });

  it('returns required aspects from catalog', async () => {
    const result = await runStage2Enrichment(makeStage1());
    expect(result.requiredAspects).toEqual(['Marke', 'Herstellernummer', 'Produktart']);
  });

  it('returns pricing data', async () => {
    const result = await runStage2Enrichment(makeStage1());
    expect(result.pricing.amount).toBe(289);
    expect(result.pricing.currency).toBe('EUR');
    expect(result.pricing.confidence).toBe(0.85);
  });

  it('returns GPSR from registry', async () => {
    const result = await runStage2Enrichment(makeStage1());
    expect(result.gpsr.found).toBe(true);
    expect(result.gpsr.data.manufacturer_name).toBe('Sony Europe B.V.');
  });

  it('returns title insights', async () => {
    const result = await runStage2Enrichment(makeStage1());
    expect(result.titleInsights.sampleTitles.length).toBe(2);
    expect(result.titleInsights.topTokens).toContain('Bluetooth');
  });

  it('returns web images', async () => {
    const result = await runStage2Enrichment(makeStage1());
    expect(result.webImages.length).toBe(1);
    expect(result.webImages[0].url).toBe('https://sony.com/xm5.jpg');
  });

  it('returns barcode confirmation', async () => {
    const result = await runStage2Enrichment(makeStage1());
    expect(result.barcodeConfirmation.confirmed).toBe(true);
  });

  it('individual enrichment failure does not block others', async () => {
    enrichPriceParallelMock.mockRejectedValueOnce(new Error('Price API down'));
    getManufacturerGpsrByNameMock.mockRejectedValueOnce(new Error('GPSR API down'));

    const result = await runStage2Enrichment(makeStage1());

    // Price and GPSR failed, but rest should work
    expect(result.pricing).toBeNull();
    expect(result.gpsr).toEqual({ found: false, data: null });
    expect(result.category.ebayId).toBe('112529');
    expect(result.webImages.length).toBe(1);
    expect(result.titleInsights.sampleTitles.length).toBe(2);
  });

  it('skips enrichments when data is missing', async () => {
    const stage1 = makeStage1({
      identity: { brand: '', model: '', internalCategory: '' },
      barcodes: { ean: '', gtin: '', upc: '', ranked: [], explicit: [] },
    });
    findEbayCategoryMock.mockReturnValueOnce(null);

    const result = await runStage2Enrichment(stage1);

    expect(getManufacturerGpsrByNameMock).not.toHaveBeenCalled();
    expect(result.category.ebayId).toBe('');
    expect(result.requiredAspects).toEqual([]);
  });

  it('includes timing metadata', async () => {
    const result = await runStage2Enrichment(makeStage1());
    expect(result._meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(result._meta.enrichmentResults).toBeDefined();
  });

  describe('web-based fallbacks', () => {
    it('triggers weight web fallback when stage1 weight is null', async () => {
      const stage1 = makeStage1();
      stage1.identity.weight_grams = 0;
      const result = await runStage2Enrichment(stage1);

      expect(lookupWeightFromWebMock).toHaveBeenCalled();
      expect(result.weightFallback).not.toBeNull();
      expect(result.weightFallback.weight_grams).toBe(280);
      expect(result._meta.stage2.webFallback.weightTried).toBe(true);
      expect(result._meta.stage2.webFallback.weightFound).toBe(true);
    });

    it('triggers GPSR web fallback when registry result empty', async () => {
      getManufacturerGpsrByNameMock.mockResolvedValueOnce({ found: false, data: null });
      const result = await runStage2Enrichment(makeStage1());

      expect(lookupGpsrFromWebMock).toHaveBeenCalledWith('Sony');
      expect(result.gpsrWebFallback).not.toBeNull();
      expect(result.gpsrWebFallback.manufacturer_name).toBe('Beispiel GmbH');
      expect(result.gpsrWebFallback.manufacturer_email).toBe('info@beispiel.de');
      expect(result._meta.stage2.webFallback.gpsrTried).toBe(true);
      expect(result._meta.stage2.webFallback.gpsrFound).toBe(true);
    });

    it('skips both fallbacks when feature flags disabled', async () => {
      const prevWeight = process.env.STAGE2_WEIGHT_WEB_FALLBACK;
      const prevGpsr = process.env.STAGE2_GPSR_WEB_FALLBACK;
      process.env.STAGE2_WEIGHT_WEB_FALLBACK = 'false';
      process.env.STAGE2_GPSR_WEB_FALLBACK = 'false';
      try {
        // Force a scenario where both fallbacks would normally fire
        getManufacturerGpsrByNameMock.mockResolvedValueOnce({ found: false, data: null });
        const stage1 = makeStage1();
        stage1.identity.weight_grams = 0;
        const result = await runStage2Enrichment(stage1);

        expect(lookupWeightFromWebMock).not.toHaveBeenCalled();
        expect(lookupGpsrFromWebMock).not.toHaveBeenCalled();
        expect(result.weightFallback).toBeNull();
        expect(result.gpsrWebFallback).toBeNull();
        expect(result._meta.stage2.webFallback.weightTried).toBe(false);
        expect(result._meta.stage2.webFallback.gpsrTried).toBe(false);
      } finally {
        if (prevWeight == null) delete process.env.STAGE2_WEIGHT_WEB_FALLBACK;
        else process.env.STAGE2_WEIGHT_WEB_FALLBACK = prevWeight;
        if (prevGpsr == null) delete process.env.STAGE2_GPSR_WEB_FALLBACK;
        else process.env.STAGE2_GPSR_WEB_FALLBACK = prevGpsr;
      }
    });

    it('does not trigger weight fallback when stage1 weight present', async () => {
      const result = await runStage2Enrichment(makeStage1()); // default weight=250
      expect(lookupWeightFromWebMock).not.toHaveBeenCalled();
      expect(result.weightFallback).toBeNull();
      expect(result._meta.stage2.webFallback.weightTried).toBe(false);
    });
  });
});

describe('withTimeout', () => {
  it('resolves with the source value when source completes before timeout', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 200, 'test');
    expect(result).toBe('ok');
  });

  it('rejects with a timeout error when source hangs longer than the budget', async () => {
    const hung = new Promise(() => {}); // never resolves
    await expect(withTimeout(hung, 50, 'hung op')).rejects.toThrow(/hung op timeout after 50ms/);
  });

  it('does not surface a late source rejection as an unhandled rejection', async () => {
    // Reproduces the V4 stack-overflow scenario: source rejects AFTER timeout fires.
    let unhandled = null;
    const onUnhandled = (reason) => {
      unhandled = reason;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const late = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('late boom')), 30);
      });
      await expect(withTimeout(late, 10, 'late')).rejects.toThrow(/late timeout/);
      // Wait long enough for the late rejection to fire and be swallowed.
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toBeNull();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

// ─── Phase B (2026-04-30): Category-Resolver-V2 integration ──────────────────

describe('runStage2Enrichment — Category-Resolver-V2 integration', () => {
  it('uses local findEbayCategory by default when V2 returns no result', async () => {
    resolveCategoryV2Mock.mockResolvedValueOnce(null);
    const out = await runStage2Enrichment(makeStage1());
    expect(out.category.ebayId).toBe('112529');
    expect(out.category.resolver?.source).toBe('local');
  });

  it('prefers V2 result when confidence >= STRATEGY_ACCEPT_THRESHOLD (0.85)', async () => {
    resolveCategoryV2Mock.mockResolvedValueOnce({
      categoryId: '14969',
      breadcrumb: 'TV, Video & Audio > Audio fuer Heim',
      source: 'catalog',
      confidence: 0.95,
      keywordMatch: 0.7,
    });
    const out = await runStage2Enrichment(makeStage1());
    expect(out.category.ebayId).toBe('14969');
    expect(out.category.ebayBreadcrumb).toContain('Audio fuer Heim');
    expect(out.category.resolver?.source).toBe('v2:catalog');
    expect(out.category.resolver?.confidence).toBeCloseTo(0.95, 2);
  });

  it('falls back to local when V2 confidence is below threshold', async () => {
    resolveCategoryV2Mock.mockResolvedValueOnce({
      categoryId: '99999',
      breadcrumb: 'Generic',
      source: 'gemini',
      confidence: 0.6,
    });
    const out = await runStage2Enrichment(makeStage1());
    expect(out.category.ebayId).toBe('112529'); // local
    expect(out.category.resolver?.source).toBe('local');
    expect(out.category.resolver?.v2BelowThreshold).toMatchObject({
      categoryId: '99999',
      confidence: 0.6,
    });
  });

  it('falls back to local when V2 throws', async () => {
    resolveCategoryV2Mock.mockRejectedValueOnce(new Error('catalog API down'));
    const out = await runStage2Enrichment(makeStage1());
    expect(out.category.ebayId).toBe('112529');
    expect(out.category.resolver?.source).toBe('local');
  });

  it('skips V2 entirely when STAGE2_USE_CATEGORY_V2=false', async () => {
    const original = process.env.STAGE2_USE_CATEGORY_V2;
    process.env.STAGE2_USE_CATEGORY_V2 = 'false';
    try {
      const out = await runStage2Enrichment(makeStage1());
      expect(resolveCategoryV2Mock).not.toHaveBeenCalled();
      expect(out.category.ebayId).toBe('112529');
    } finally {
      if (original === undefined) delete process.env.STAGE2_USE_CATEGORY_V2;
      else process.env.STAGE2_USE_CATEGORY_V2 = original;
    }
  });
});
