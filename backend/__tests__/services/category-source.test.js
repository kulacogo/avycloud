'use strict';

// Vitest globals (globals: true in vitest.config.js)
//
// B2 — Tests for the categorySource field + manual-source lock behaviour.
//
// We test two independent surfaces:
//   1. `shouldLockCategoryForManualSource` — pure helper exported from
//      lib/firestore.js that encodes the lock predicate. This drives the
//      additive block in saveProduct() that protects manually-chosen
//      categories from auto-triggered overrides.
//   2. `ensureCategories` in services/enrichment.js — must persist the
//      resolver's source string onto `details.categorySource` as
//      `auto:<source>` when the resolver returns a high-confidence result.

// ---------------------------------------------------------------------------
// Mock the category-resolver via require.cache so ensureCategories picks it up
// ---------------------------------------------------------------------------
const resolverPath = require.resolve('../../services/category-resolver');
const resolveCategoryV2Mock = vi.fn();
require.cache[resolverPath] = {
  id: resolverPath,
  filename: resolverPath,
  loaded: true,
  exports: {
    resolveCategoryV2: resolveCategoryV2Mock,
    STRATEGY_ACCEPT_THRESHOLD: 0.8,
    _internal: {},
  },
};

// ---------------------------------------------------------------------------
// Mock findEbayCategory so ensureCategories can validate incoming category IDs
// ---------------------------------------------------------------------------
const taxonomyPath = require.resolve('../../lib/ebay-taxonomy');
require(taxonomyPath);
const origTaxonomy = require.cache[taxonomyPath].exports;
require.cache[taxonomyPath] = {
  id: taxonomyPath,
  filename: taxonomyPath,
  loaded: true,
  exports: {
    ...origTaxonomy,
    findEbayCategory: vi.fn((id) => {
      const v = String(id || '').trim();
      if (v === '15052') return { id: '15052', breadcrumb: 'TV, Video & Audio > Heim-Audio & HiFi > Kopfhörer' };
      if (v === '20697') return { id: '20697', breadcrumb: 'Möbel & Wohnen > Beleuchtung > Tisch- & Klemmleuchten' };
      return null;
    }),
  },
};

// Mark env-flag BEFORE requiring enrichment so the resolver branch is active
process.env.CATEGORY_RESOLVER_V2 = 'true';

const { shouldLockCategoryForManualSource } = require('../../lib/firestore');
const { ensureCategories } = require('../../services/enrichment');

beforeEach(() => {
  resolveCategoryV2Mock.mockReset();
});

describe('shouldLockCategoryForManualSource', () => {
  it('locks category when existing product has categorySource=manual and save is not UI/manual', () => {
    const existing = {
      details: { categoryId: '15052', categorySource: 'manual' },
    };
    // saveSource !== 'ui' and mode !== 'manual' → isManualSave = false
    expect(shouldLockCategoryForManualSource(existing, { isManualSave: false })).toBe(true);
  });

  it('does NOT lock when the save itself is manual (UI / mode=manual)', () => {
    const existing = {
      details: { categoryId: '15052', categorySource: 'manual' },
    };
    expect(shouldLockCategoryForManualSource(existing, { isManualSave: true })).toBe(false);
  });

  it('does NOT lock when categorySource is an auto:* value', () => {
    const existing = {
      details: { categoryId: '15052', categorySource: 'auto:gemini' },
    };
    expect(shouldLockCategoryForManualSource(existing, { isManualSave: false })).toBe(false);
  });

  it('does NOT lock when categorySource is missing (legacy products)', () => {
    const existing = { details: { categoryId: '15052' } };
    expect(shouldLockCategoryForManualSource(existing, { isManualSave: false })).toBe(false);
  });

  it('handles undefined/null existing product safely', () => {
    expect(shouldLockCategoryForManualSource(null, { isManualSave: false })).toBe(false);
    expect(shouldLockCategoryForManualSource(undefined, { isManualSave: false })).toBe(false);
    expect(shouldLockCategoryForManualSource({}, { isManualSave: false })).toBe(false);
  });
});

describe('ensureCategories — categorySource persistence', () => {
  it('writes details.categorySource = "auto:<source>" when resolver returns a high-confidence result', async () => {
    resolveCategoryV2Mock.mockResolvedValueOnce({
      categoryId: '20697',
      breadcrumb: 'Möbel & Wohnen > Beleuchtung > Tisch- & Klemmleuchten',
      source: 'suggestions',
      confidence: 0.92,
    });

    const product = {
      id: 'p1',
      identification: { brand: 'AURA', name: 'Monaco LED-Klemmleuchte' },
      details: {
        // missing/bad category triggers the resolver
        attributes: {},
      },
    };

    await ensureCategories([product]);

    expect(resolveCategoryV2Mock).toHaveBeenCalledTimes(1);
    expect(product.details.categoryId).toBe('20697');
    expect(product.details.categorySource).toBe('auto:suggestions');
    expect(product.identification.category).toBe('Möbel & Wohnen > Beleuchtung > Tisch- & Klemmleuchten');
  });

  it('does NOT call resolver when categorySource is already "manual"', async () => {
    const product = {
      id: 'p2',
      identification: { brand: 'AURA', name: 'Monaco' },
      details: {
        categoryId: '15052',
        categorySource: 'manual',
        attributes: {},
      },
    };

    await ensureCategories([product]);

    expect(resolveCategoryV2Mock).not.toHaveBeenCalled();
    // Manual choice preserved
    expect(product.details.categoryId).toBe('15052');
    expect(product.details.categorySource).toBe('manual');
  });
});
