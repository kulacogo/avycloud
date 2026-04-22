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
  // Existing breadcrumbs
  if (v === 'Elektronik > Audio > Kopfhörer') {
    return { id: '99999', breadcrumb: 'Elektronik > Audio > Kopfhörer' };
  }
  if (v === 'Elektronik > Powerbanks') {
    return { id: '88888', breadcrumb: 'Elektronik > Powerbanks' };
  }
  if (v === 'Bootsport > Anker & Festmacher') {
    return { id: '77777', breadcrumb: 'Bootsport > Anker & Festmacher' };
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
      ['elektronik > powerbanks', '88888'],
      ['bootsport > anker & festmacher', '77777'],
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
const {
  resolveCategoryV2,
  computeKeywordMatch,
  computeCatalogConfidence,
  computeSuggestionConfidence,
  computeLocalLookupConfidence,
  computeGeminiConfidence,
  isBannedOrTooGenericBreadcrumb,
} = require('../../services/category-resolver');

beforeEach(() => {
  searchCatalogByGtinMock.mockReset();
  getCategorySuggestionsMock.mockReset();
  resolveCategoryWithGeminiMock.mockReset();
  findEbayCategoryMock.mockClear();
  // Ensure dynamic confidence is ON by default for each test unless overridden
  delete process.env.CATEGORY_RESOLVER_DYNAMIC_CONFIDENCE;
});

describe('resolveCategoryV2', () => {
  it('uses Catalog GTIN voting and applies dynamic confidence (≈ 0.9 for strong match)', async () => {
    // Kopfhörer breadcrumb matches product name "Kopfhörer" ⇒ keyword-match ≥ 0.3, no penalty
    searchCatalogByGtinMock.mockResolvedValueOnce({
      categoryId: '15052',
      breadcrumb: 'TV, Video & Audio > Heim-Audio & HiFi > Kopfhörer',
      confidence: 0.6666,
      votes: 2,
      total: 3,
    });

    const product = {
      identification: { brand: 'Sony', name: 'WH-1000XM5 Kopfhörer' },
      details: {
        identifiers: { ean: '4548736132610' },
      },
    };

    const result = await resolveCategoryV2(product, { reason: 'test' });
    expect(result).not.toBeNull();
    expect(result.categoryId).toBe('15052');
    expect(result.source).toBe('catalog');
    // Base 0.9, no votes≥3 boost, keyword-match ≥ 0.3 → final 0.9
    expect(result.confidence).toBeCloseTo(0.9, 3);
    expect(result.confidenceBreakdown).toBeDefined();
    expect(result.confidenceBreakdown.base).toBe(0.9);
    expect(searchCatalogByGtinMock).toHaveBeenCalledWith('4548736132610');
  });

  it('accepts a high-relevancy taxonomy suggestion when GTIN is missing (capped at 0.92)', async () => {
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
    // Suggestion cap is 0.92 under dynamic scoring
    expect(result.confidence).toBe(0.92);
    // Never called because GTIN absent
    expect(searchCatalogByGtinMock).not.toHaveBeenCalled();
  });

  it('falls through to local lookup (dynamic confidence yields ~0.75 with leaf keyword match)', async () => {
    searchCatalogByGtinMock.mockResolvedValueOnce(null);
    getCategorySuggestionsMock.mockResolvedValueOnce([]);
    // Gemini returns nothing — local remains the "best" candidate
    resolveCategoryWithGeminiMock.mockResolvedValueOnce(null);

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
    // Base 0.6 + leaf_keyword_match(0.15) = 0.75 (below 0.8 threshold, so
    // gemini is consulted, but with dynamic scoring local remains best)
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.confidence).toBeLessThanOrEqual(0.85);
  });

  it('falls back to Gemini when the first three strategies all return null', async () => {
    searchCatalogByGtinMock.mockResolvedValueOnce(null);
    getCategorySuggestionsMock.mockResolvedValueOnce([]);
    resolveCategoryWithGeminiMock.mockResolvedValueOnce({
      id: '15052',
      path: 'TV, Video & Audio > Heim-Audio & HiFi > Kopfhörer',
    });

    const product = {
      identification: { brand: 'Sony', name: 'WH-1000XM5 Kopfhörer' },
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

// ---------------------------------------------------------------------------
// Dynamic confidence rekalibrierung (Strategy 3 + 4) — neue Tests
// ---------------------------------------------------------------------------
describe('dynamic confidence calibration', () => {
  it('1. Catalog match WITH brand in breadcrumb and strong votes → confidence ≥ 0.9', () => {
    const product = {
      identification: { brand: 'Sony', name: 'Sony WH-1000XM5 Kopfhörer' },
    };
    const catalogResult = {
      categoryId: '15052',
      breadcrumb: 'Sony > Heim-Audio > Kopfhörer',
      confidence: 0.66,
      votes: 4,
      total: 5,
    };
    const { confidence, breakdown } = computeCatalogConfidence(catalogResult, product);
    expect(confidence).toBeGreaterThanOrEqual(0.9);
    expect(breakdown.base).toBe(0.9);
    expect(breakdown.boosts.strong_vote_count).toBe(0.05);
  });

  it('2. Catalog match WITHOUT keyword match → penalty applied, confidence < 0.9', () => {
    const product = {
      identification: { brand: 'Anker', name: 'Anker Powerbank 20000mAh' },
    };
    // Wrong category (the actual bug we are fixing): the "Anker" brand matches
    // but the breadcrumb is sailing equipment.
    const catalogResult = {
      categoryId: '77777',
      breadcrumb: 'Bootsport > Anker & Festmacher',
      confidence: 0.8,
      votes: 1,
      total: 2,
    };
    const { confidence, breakdown } = computeCatalogConfidence(catalogResult, product);
    // Base 0.9, no vote-boost, keyword-match < 0.3 → -0.10 penalty → 0.8
    expect(confidence).toBeLessThan(0.9);
    expect(breakdown.penalties.low_keyword_match).toBe(-0.1);
  });

  it('3. Local lookup with clear keyword overlap → confidence ~0.75', () => {
    const product = {
      identification: { brand: 'Anker', name: 'Anker Powerbank 20000mAh' },
    };
    // Level-3 breadcrumb (avoids level≤2 generic penalty)
    const breadcrumb = 'Elektronik > Ladegeräte > Powerbanks';
    const { confidence, breakdown } = computeLocalLookupConfidence(breadcrumb, product);
    // Base 0.6 + leaf_keyword_match (+0.15) = 0.75. Brand "anker" does not
    // appear in breadcrumb text ⇒ no brand boost.
    expect(confidence).toBeCloseTo(0.75, 2);
    expect(breakdown.base).toBe(0.6);
    expect(breakdown.boosts.leaf_keyword_match).toBe(0.15);
    expect(breakdown.boosts.brand_in_breadcrumb).toBeUndefined();
  });

  it('4. Gemini fallback without keyword match → confidence ~0.55', () => {
    const product = {
      identification: { brand: 'XYZ', name: 'XYZ-42 Foo Bar' },
    };
    const breadcrumb = 'Heim & Garten > Werkzeug > Schraubendreher';
    const { confidence, breakdown } = computeGeminiConfidence(breadcrumb, product);
    expect(confidence).toBeCloseTo(0.55, 2);
    expect(breakdown.base).toBe(0.55);
    expect(breakdown.boosts.keyword_match).toBeUndefined();
  });

  it('5. Banned/too-generic breadcrumb triggers penalty in suggestions scoring', () => {
    const product = {
      identification: { brand: 'Acme', name: 'Acme Widget' },
    };
    // Level-2 path with banned root — should be flagged
    const suggestion = {
      categoryId: '1',
      breadcrumb: 'Antiquitäten & Kunst > Antiquitäten',
      relevancy: 0.85,
      _hasAlternatives: true,
    };
    const { breakdown } = computeSuggestionConfidence(suggestion, product);
    expect(breakdown.penalties.banned_breadcrumb).toBe(-0.15);

    // Helper must directly flag it as banned/too-generic
    expect(isBannedOrTooGenericBreadcrumb('Antiquitäten & Kunst > Antiquitäten')).toBe(true);
    // Single-level breadcrumb → too generic
    expect(isBannedOrTooGenericBreadcrumb('Elektronik')).toBe(true);
    // "Sonstiges" leaf when alternatives exist → too generic
    expect(isBannedOrTooGenericBreadcrumb('Elektronik > Audio > Sonstiges', { hasAlternatives: true })).toBe(true);
    // Level-3 non-banned → accepted
    expect(isBannedOrTooGenericBreadcrumb('Elektronik > Audio > Kopfhörer')).toBe(false);
  });

  it('6. computeKeywordMatch returns > 0.3 for "Anker Powerbank 20000mAh" vs "Elektronik > Powerbanks"', () => {
    const ratio = computeKeywordMatch('Anker Powerbank 20000mAh', 'Elektronik > Powerbanks');
    expect(ratio).toBeGreaterThan(0.3);

    // Sanity: unrelated strings yield ~0
    const none = computeKeywordMatch('Sony WH-1000XM5', 'Bootsport > Anker & Festmacher');
    expect(none).toBe(0);
  });

  it('7. Dynamic confidence DISABLED via ENV → falls back to hard-coded 0.9 for local lookup', async () => {
    process.env.CATEGORY_RESOLVER_DYNAMIC_CONFIDENCE = 'false';

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
    // Legacy hard-coded LOCAL_DEFAULT_CONFIDENCE = 0.9
    expect(result.confidence).toBe(0.9);
    expect(result.confidenceBreakdown).toBeUndefined();
  });
});
