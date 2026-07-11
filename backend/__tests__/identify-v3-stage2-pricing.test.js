/**
 * PROD-BUG (Fix 2026-07-11): Stage 2 rief enrichPriceParallel(tempProduct,
 * { force: true }) auf und las den Preis anschließend vom RETURN-Wert. Der
 * Return-Wert ist aber nur { ok, updated, serpTrace } — die Preisdaten schreibt
 * enrichPriceParallel per MUTATION in product.details.pricing. Folge:
 * stage2.pricing.amount war IMMER 0, V3-erfasste Produkte starteten ohne Preis.
 *
 * Diese Tests fixieren den echten Contract: Stage 2 liest lowest_price inkl.
 * sources + price_confidence aus dem mutierten tempProduct.
 *
 * Setup: require.cache-Patching wie __tests__/lib/identify-v3-stage2.test.js.
 */

const findEbayCategoryMock = vi.fn(() => ({ id: '112529', breadcrumb: 'TV, Video & Audio > Kopfhoerer' }));
const getCategoryAspectCatalogMock = vi.fn(() => ({ required: [{ name: 'Marke' }] }));

// Realer Contract: MUTIERT das übergebene Produkt, Return nur { ok, updated, serpTrace }.
const enrichPriceParallelMock = vi.fn(async (product) => {
  product.details = product.details || {};
  product.details.pricing = product.details.pricing || {};
  product.details.pricing.lowest_price = {
    amount: 129.99,
    currency: 'EUR',
    sources: [
      { name: 'eBay', url: 'https://www.ebay.de/itm/1234567890', price: 129.99 },
      { name: 'Amazon', url: 'https://www.amazon.de/dp/B0C5351V75', price: 134.5 },
    ],
    last_checked_iso: new Date().toISOString(),
  };
  product.details.pricing.price_confidence = 0.7;
  product.ops = product.ops || {};
  product.ops.data_quality = { price_enrich_v1: { via: 'ebay_browse' } };
  return { ok: true, updated: true, serpTrace: [] };
});

const getManufacturerGpsrByNameMock = vi.fn(async () => ({
  found: true,
  data: { manufacturer_name: 'Sony Europe B.V.', manufacturer_address: 'Berlin', email: 'info@sony.eu' },
}));
const fetchCategoryTitleInsightsMock = vi.fn(async () => null);
const searchProductImagesMock = vi.fn(async () => []);
const confirmBarcodeWithWebMock = vi.fn(async () => ({ ok: false }));
const lookupWeightFromWebMock = vi.fn(async () => null);
const lookupGpsrFromWebMock = vi.fn(async () => null);
const resolveCategoryV2Mock = vi.fn(async () => null);

// ─── Patch require.cache ─────────────────────────────────────────────────────

const taxonomyPath = require.resolve('../lib/ebay-taxonomy');
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

const pricePath = require.resolve('../lib/price-enrichment');
require(pricePath);
require.cache[pricePath] = {
  id: pricePath, filename: pricePath, loaded: true,
  exports: { enrichPriceParallel: enrichPriceParallelMock, enrichPriceForProductBestEffort: vi.fn() },
};

const gpsrPath = require.resolve('../lib/gpsr-manufacturer-registry');
require(gpsrPath);
require.cache[gpsrPath] = {
  id: gpsrPath, filename: gpsrPath, loaded: true,
  exports: { getManufacturerGpsrByName: getManufacturerGpsrByNameMock, scoreGpsr: vi.fn(() => 8) },
};

const titleInsightsPath = require.resolve('../lib/ebay-browse-title-insights');
require(titleInsightsPath);
require.cache[titleInsightsPath] = {
  id: titleInsightsPath, filename: titleInsightsPath, loaded: true,
  exports: { fetchCategoryTitleInsights: fetchCategoryTitleInsightsMock, fetchBrowsePriceSamples: vi.fn() },
};

const imageSearchPath = require.resolve('../lib/image-search');
require(imageSearchPath);
require.cache[imageSearchPath] = {
  id: imageSearchPath, filename: imageSearchPath, loaded: true,
  exports: { searchProductImages: searchProductImagesMock },
};

const barcodeConfirmPath = require.resolve('../lib/barcode-web-confirm');
require(barcodeConfirmPath);
require.cache[barcodeConfirmPath] = {
  id: barcodeConfirmPath, filename: barcodeConfirmPath, loaded: true,
  exports: { confirmBarcodeWithWeb: confirmBarcodeWithWebMock },
};

const weightWebPath = require.resolve('../lib/weight-web-lookup');
require(weightWebPath);
require.cache[weightWebPath] = {
  id: weightWebPath, filename: weightWebPath, loaded: true,
  exports: { lookupWeightFromWeb: lookupWeightFromWebMock },
};

const gpsrWebPath = require.resolve('../lib/gpsr-web-fallback');
require(gpsrWebPath);
require.cache[gpsrWebPath] = {
  id: gpsrWebPath, filename: gpsrWebPath, loaded: true,
  exports: { lookupGpsrFromWeb: lookupGpsrFromWebMock },
};

const categoryResolverPath = require.resolve('../services/category-resolver');
require.cache[categoryResolverPath] = {
  id: categoryResolverPath, filename: categoryResolverPath, loaded: true,
  exports: { resolveCategoryV2: resolveCategoryV2Mock, STRATEGY_ACCEPT_THRESHOLD: 0.85 },
};

const { runStage2Enrichment } = require('../lib/identify-v3-stage2');

const makeStage1 = () => ({
  identity: {
    brand: 'Sony',
    model: 'WH-1000XM5',
    mpn: 'WH1000XM5B',
    internalCategory: 'Elektronik > Kopfhoerer > Over-Ear',
    weight_grams: 250,
  },
  barcodes: {
    ean: '4548736132610',
    gtin: '',
    upc: '',
    ranked: [{ code: '4548736132610', type: 'ean13', valid: true }],
    explicit: ['4548736132610'],
  },
  uploadedImages: [],
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runStage2Enrichment — Pricing aus mutiertem tempProduct (Fix 2026-07-11)', () => {
  it('übernimmt amount/sources/confidence aus tempProduct.details.pricing, nicht vom Return-Wert', async () => {
    const result = await runStage2Enrichment(makeStage1());

    expect(enrichPriceParallelMock).toHaveBeenCalledTimes(1);
    expect(result.pricing).not.toBeNull();
    expect(result.pricing.amount).toBe(129.99);
    expect(result.pricing.currency).toBe('EUR');
    expect(result.pricing.confidence).toBe(0.7);
    expect(result.pricing.via).toBe('ebay_browse');
    expect(result.pricing.sources.map((s) => s.url)).toEqual([
      'https://www.ebay.de/itm/1234567890',
      'https://www.amazon.de/dp/B0C5351V75',
    ]);
  });

  it('REGRESSION alter Buggy-Contract: Preisdaten NUR im Return-Wert (keine Mutation) → pricing null', async () => {
    // So sah der falsche Mock/Contract vor dem Fix aus — enrichPriceParallel
    // returned diese Shape in Wirklichkeit NIE. Stage 2 darf dem Return-Wert
    // keine Preisdaten mehr entnehmen.
    enrichPriceParallelMock.mockImplementationOnce(async () => ({
      lowest_price: { amount: 289, currency: 'EUR', sources: [{ url: 'https://geizhals.de' }] },
      price_confidence: 0.85,
    }));

    const result = await runStage2Enrichment(makeStage1());
    expect(result.pricing).toBeNull();
  });

  it('enrichPriceParallel ok:false (kein Preis gefunden) → pricing null', async () => {
    enrichPriceParallelMock.mockImplementationOnce(async () => ({
      ok: false, updated: false, error: 'no_price_found', serpTrace: [],
    }));

    const result = await runStage2Enrichment(makeStage1());
    expect(result.pricing).toBeNull();
  });

  it('Mutation mit amount 0 → pricing null (kein 0€-Phantom-Preis)', async () => {
    enrichPriceParallelMock.mockImplementationOnce(async (product) => {
      product.details = product.details || {};
      product.details.pricing = {
        lowest_price: { amount: 0, currency: 'EUR', sources: [] },
        price_confidence: 0,
      };
      return { ok: true, updated: true, serpTrace: [] };
    });

    const result = await runStage2Enrichment(makeStage1());
    expect(result.pricing).toBeNull();
  });

  it('Fehler in enrichPriceParallel blockiert die übrigen Enrichments nicht', async () => {
    enrichPriceParallelMock.mockRejectedValueOnce(new Error('Price API down'));

    const result = await runStage2Enrichment(makeStage1());
    expect(result.pricing).toBeNull();
    expect(result.category.ebayId).toBe('112529');
    expect(result.gpsr.found).toBe(true);
  });
});
