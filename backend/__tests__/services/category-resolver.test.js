'use strict';

// Vitest globals (globals: true in vitest.config.js)

// ---------------------------------------------------------------------------
// Mock the remote taxonomy/catalog wrapper via require.cache
// ---------------------------------------------------------------------------
const searchCatalogByGtinMock = vi.fn();
const getCategorySuggestionsMock = vi.fn();

const remotePath = require.resolve('../../lib/ebay-taxonomy-remote');
require(remotePath);
require.cache[remotePath] = {
  id: remotePath,
  filename: remotePath,
  loaded: true,
  exports: {
    searchCatalogByGtin: searchCatalogByGtinMock,
    getCategorySuggestions: getCategorySuggestionsMock,
    _resetCaches: vi.fn(),
  },
};

// ---------------------------------------------------------------------------
// Mock findEbayCategory — simulate local taxonomy lookup
// ---------------------------------------------------------------------------
const taxonomyPath = require.resolve('../../lib/ebay-taxonomy');
require(taxonomyPath);
const origTaxonomy = require.cache[taxonomyPath].exports;

const findEbayCategoryMock = vi.fn((input) => {
  const v = String(input || '').trim();
  // Catalog-ID only paths (no breadcrumb) — used when catalog returns bare ID
  if (v === '15052') return { id: '15052', breadcrumb: 'TV, Video & Audio > Heim-Audio & HiFi > Kopfhörer' };
  if (v === '14969') return { id: '14969', breadcrumb: 'TV, Video & Audio > Zubehör > Kabel' };
  // Existing breadcrumb
  if (v === 'Elektronik > Audio > Kopfhörer') {
    return { id: '99999', breadcrumb: 'Elektronik > Audio > Kopfhörer' };
  }
  return null;
});

require.cache[taxonomyPath] = {
  id: taxonomyPath,
  filename: taxonomyPath,
  loaded: true,
  exports: {
    ...origTaxonomy,
    findEbayCategory: findEbayCategoryMock,
  },
};

// ---------------------------------------------------------------------------
// Mock MarketplaceLookup — return predictable IDs for known breadcrumbs
// ---------------------------------------------------------------------------
const lookupPath = require.resolve('../../lib/marketplace-lookup');
require(lookupPath);
class FakeMarketplaceLookup {
  constructor() {
    this._ebay = new Map([
      ['elektronik > audio > kopfhörer', '99999'],
    ]);
  }
  lookupEbay(str) {
    if (!str) return null;
    return this._ebay.get(String(str).trim().toLowerCase()) || null;
  }
  lookupKaufland() { return null; }
  isValidEbayId(id) { return !!id && /^\d+$/.test(String(id).trim()); }
  isValidKauflandId() { return false; }
  ensureEbay() { /* noop */ }
  ensureKaufland() { /* noop */ }
}
require.cache[lookupPath] = {
  id: lookupPath,
  filename: lookupPath,
  loaded: true,
  exports: { MarketplaceLookup: FakeMarketplaceLookup },
};

// ---------------------------------------------------------------------------
// Mock enrichment.resolveCategoryWithGemini for the fallback strategy
// ---------------------------------------------------------------------------
const enrichmentPath = require.resolve('../../services/enrichment');
const resolveCategoryWithGeminiMock = vi.fn();
require.cache[enrichmentPath] = {
  id: enrichmentPath,
  filename: enrichmentPath,
  loaded: true,
  exports: {
    resolveCategoryWithGemini: resolveCategoryWithGeminiMock,
  },
};

// Fresh require after cache is primed
const { resolveCategoryV2 } = require('../../services/category-resolver');

beforeEach(() => {
  searchCatalogByGtinMock.mockReset();
  getCategorySuggestionsMock.mockReset();
  resolveCategoryWithGeminiMock.mockReset();
  findEbayCategoryMock.mockClear();
});

describe('resolveCategoryV2', () => {
  it('uses Catalog GTIN voting (2×15052, 1×14969) and returns 15052 with confidence ≈ 0.67', async () => {
    searchCatalogByGtinMock.mockResolvedValueOnce({
      categoryId: '15052',
      breadcrumb: 'TV, Video & Audio > Heim-Audio & HiFi > Kopfhörer',
      confidence: 0.6666,
      votes: 2,
      total: 3,
    });

    const product = {
      identification: { brand: 'Sony', name: 'WH-1000XM5' },
      details: {
        identifiers: { ean: '4548736132610' },
      },
    };

    const result = await resolveCategoryV2(product, { reason: 'test' });
    expect(result).not.toBeNull();
    expect(result.categoryId).toBe('15052');
    expect(result.source).toBe('catalog');
    expect(result.confidence).toBeCloseTo(0.6666, 3);
    expect(searchCatalogByGtinMock).toHaveBeenCalledWith('4548736132610');
    // Below 0.8 threshold → suggestion should also be tried
    expect(getCategorySuggestionsMock).toHaveBeenCalled();
  });

  it('accepts a high-relevancy taxonomy suggestion when GTIN is missing', async () => {
    getCategorySuggestionsMock.mockResolvedValueOnce([
      {
        categoryId: '15052',
        breadcrumb: 'TV, Video & Audio > Heim-Audio & HiFi > Kopfhörer',
        relevancy: 0.95,
      },
      {
        categoryId: '14969',
        breadcrumb: 'TV, Video & Audio > Zubehör > Kabel',
        relevancy: 0.4,
      },
    ]);

    const product = {
      identification: { brand: 'Sony', name: 'WH-1000XM5 Kopfhörer' },
      details: { identifiers: {} },
    };

    const result = await resolveCategoryV2(product);
    expect(result).not.toBeNull();
    expect(result.source).toBe('suggestions');
    expect(result.categoryId).toBe('15052');
    expect(result.confidence).toBe(0.95);
    // Never called because GTIN absent
    expect(searchCatalogByGtinMock).not.toHaveBeenCalled();
  });

  it('falls through to local lookup when Catalog + Suggestions yield low/no confidence', async () => {
    searchCatalogByGtinMock.mockResolvedValueOnce(null);
    getCategorySuggestionsMock.mockResolvedValueOnce([]);

    const product = {
      identification: {
        brand: 'SomeBrand',
        name: 'Kopfhörer Wireless',
        category: 'Elektronik > Audio > Kopfhörer',
      },
      details: { identifiers: { ean: '4006381333931' } },
    };

    const result = await resolveCategoryV2(product);
    expect(result).not.toBeNull();
    expect(result.source).toBe('local');
    expect(result.categoryId).toBe('99999');
    expect(result.breadcrumb).toBe('Elektronik > Audio > Kopfhörer');
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(resolveCategoryWithGeminiMock).not.toHaveBeenCalled();
  });

  it('falls back to Gemini when the first three strategies all return null', async () => {
    searchCatalogByGtinMock.mockResolvedValueOnce(null);
    getCategorySuggestionsMock.mockResolvedValueOnce([]);
    resolveCategoryWithGeminiMock.mockResolvedValueOnce({
      id: '15052',
      path: 'TV, Video & Audio > Heim-Audio & HiFi > Kopfhörer',
    });

    const product = {
      identification: { brand: 'Sony', name: 'WH-1000XM5' },
      details: { identifiers: {} },
      // No usable identification.category breadcrumb → local lookup skipped
    };

    const result = await resolveCategoryV2(product);
    expect(result).not.toBeNull();
    expect(result.source).toBe('gemini');
    expect(result.categoryId).toBe('15052');
    expect(resolveCategoryWithGeminiMock).toHaveBeenCalled();
  });
});
