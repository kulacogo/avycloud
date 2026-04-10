'use strict';

// Mock all enrichment dependencies via require.cache patching

const findEbayCategoryMock = vi.fn(() => ({ id: '112529', breadcrumb: 'TV, Video & Audio > Kopfhoerer' }));
const getCategoryAspectCatalogMock = vi.fn(() => ({
  required: [{ name: 'Marke' }, { name: 'Herstellernummer' }, { name: 'Produktart' }],
}));
const enrichPriceParallelMock = vi.fn(async () => ({
  lowest_price: { amount: 289, currency: 'EUR', sources: [{ url: 'https://geizhals.de' }] },
  price_confidence: 0.85,
}));
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

const { runStage2Enrichment } = require('../../lib/identify-v3-stage2');

beforeEach(() => {
  vi.clearAllMocks();
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
});
