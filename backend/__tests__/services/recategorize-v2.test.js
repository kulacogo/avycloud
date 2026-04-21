'use strict';

// Vitest globals (globals: true in vitest.config.js)
//
// B3 — Tests for the "recategorize_v2" bulk audit action.
//
// All external I/O is stubbed via require.cache patching (the established
// CommonJS pattern; vi.mock does not intercept CJS require in Vitest 4.x).

// ─── 1. Neutralise @google-cloud/* packages (fire-and-forget init in storage.js)
require('../api/_patchGcp');

// ─── 2. Patch backend libs BEFORE requiring admin-bulk-actions ────────────────

// --- lib/firestore ------------------------------------------------------------
const firestorePath = require.resolve('../../lib/firestore');
try { require(firestorePath); } catch (_) {}
const getAllProductsMock = vi.fn();
const getProductMock = vi.fn();
require.cache[firestorePath] = {
  id: firestorePath,
  filename: firestorePath,
  loaded: true,
  exports: {
    firestore: {},
    getAllProducts: getAllProductsMock,
    getProduct: getProductMock,
    // Minimal helpers that other code paths might touch if transitively loaded.
    shouldLockCategoryForManualSource: () => false,
  },
};

// --- lib/product-store --------------------------------------------------------
const productStorePath = require.resolve('../../lib/product-store');
try { require(productStorePath); } catch (_) {}
const saveProductV2Mock = vi.fn().mockResolvedValue({ id: 'mock' });
require.cache[productStorePath] = {
  id: productStorePath,
  filename: productStorePath,
  loaded: true,
  exports: {
    saveProductV2: saveProductV2Mock,
    getProductV2: vi.fn(),
    getAllProductsV2: vi.fn(),
    getProductWeightBySku: vi.fn(),
  },
};

// --- lib/storage --------------------------------------------------------------
const storagePath = require.resolve('../../lib/storage');
try { require(storagePath); } catch (_) {}
const uploadJobFileMock = vi.fn(async (buf, mime, jobId, name) => ({
  path: `jobs/${jobId}/${name}`,
  mimeType: mime,
  originalName: name,
  size: Buffer.isBuffer(buf) ? buf.length : 0,
}));
require.cache[storagePath] = {
  id: storagePath,
  filename: storagePath,
  loaded: true,
  exports: {
    uploadImage: vi.fn(),
    uploadBase64Image: vi.fn(),
    deleteProductImages: vi.fn(),
    uploadJobFile: uploadJobFileMock,
    downloadFile: vi.fn(),
  },
};

// --- services/category-resolver ----------------------------------------------
const resolverPath = require.resolve('../../services/category-resolver');
try { require(resolverPath); } catch (_) {}
const resolveCategoryV2Mock = vi.fn();
require.cache[resolverPath] = {
  id: resolverPath,
  filename: resolverPath,
  loaded: true,
  exports: {
    resolveCategoryV2: resolveCategoryV2Mock,
    STRATEGY_ACCEPT_THRESHOLD: 0.8,
  },
};

// --- lib/ebay-taxonomy + marketplace-lookup -----------------------------------
// admin-bulk-actions loads these for other bulk actions; make sure they don't
// attempt to read CSV files from disk during module init for unrelated code
// paths. The recategorize_v2 branch does NOT touch them directly.
const taxonomyPath = require.resolve('../../lib/ebay-taxonomy');
try { require(taxonomyPath); } catch (_) {}
const origTaxonomy = require.cache[taxonomyPath]?.exports || {};
require.cache[taxonomyPath] = {
  id: taxonomyPath,
  filename: taxonomyPath,
  loaded: true,
  exports: {
    ...origTaxonomy,
    findEbayCategory: vi.fn(() => null),
  },
};

// ─── 3. Now safe to load the subject under test ─────────────────────────────
const { runBulkAction } = require('../../services/admin-bulk-actions');

beforeEach(() => {
  getAllProductsMock.mockReset();
  getProductMock.mockReset();
  saveProductV2Mock.mockReset();
  saveProductV2Mock.mockResolvedValue({ id: 'mock' });
  uploadJobFileMock.mockClear();
  resolveCategoryV2Mock.mockReset();
});

function fakeProducts() {
  return [
    {
      id: 'p1',
      identification: { sku: 'SKU-1', brand: 'AURA', name: 'Monaco LED', category: 'Möbel > Alt' },
      details: {
        categoryId: '99999',
        categorySource: 'manual',
        attributes: {},
      },
    },
    {
      id: 'p2',
      identification: { sku: 'SKU-2', brand: 'AURA', name: 'Monaco LED' },
      details: {
        categoryId: '99999',
        attributes: {},
      },
      ops: { last_saved_source: 'ui' },
    },
    {
      id: 'p3',
      identification: { sku: 'SKU-3', brand: 'AURA', name: 'Monaco LED-Klemmleuchte', category: 'Sammeln & Seltenes > Reklame' },
      details: {
        categoryId: '888',
        categorySource: 'auto:local',
        attributes: {},
      },
    },
  ];
}

describe('runBulkRecategorizeV2 — DryRun', () => {
  it('skips manual + UI products and marks the remaining one as would_update', async () => {
    const products = fakeProducts();
    getAllProductsMock.mockResolvedValue(products);
    getProductMock.mockImplementation(async (id) => products.find((p) => p.id === id) || null);

    resolveCategoryV2Mock.mockImplementation(async (cur) => {
      if (cur.id === 'p3') {
        return {
          categoryId: '20697',
          breadcrumb: 'Möbel & Wohnen > Beleuchtung > Tisch- & Klemmleuchten',
          source: 'suggestions',
          confidence: 0.95,
        };
      }
      return null;
    });

    const result = await runBulkAction('recategorize_v2', {
      apply: false,
      limit: 100,
      offset: 0,
    });

    expect(result.summary.action).toBe('recategorize_v2');
    expect(result.summary.dryRun).toBe(true);
    expect(result.summary.selected).toBe(3);
    expect(result.summary.skipped_manual).toBe(1);
    expect(result.summary.skipped_ui).toBe(1);
    expect(result.summary.would_update).toBe(1);
    expect(result.summary.updated).toBe(0);
    expect(saveProductV2Mock).not.toHaveBeenCalled();

    // Resolver only runs against the unlocked product (p3).
    expect(resolveCategoryV2Mock).toHaveBeenCalledTimes(1);
    expect(resolveCategoryV2Mock.mock.calls[0][0].id).toBe('p3');

    // Samples include the candidate.
    const wouldSample = result.samples.find((s) => s.status === 'would_update');
    expect(wouldSample).toBeTruthy();
    expect(wouldSample.to.id).toBe('20697');
    expect(wouldSample.source).toBe('suggestions');
  });
});

describe('runBulkRecategorizeV2 — Apply', () => {
  it('calls saveProductV2 exactly once with the resolved category + auto:<source>', async () => {
    const products = fakeProducts();
    getAllProductsMock.mockResolvedValue(products);
    getProductMock.mockImplementation(async (id) => products.find((p) => p.id === id) || null);

    resolveCategoryV2Mock.mockImplementation(async (cur) => {
      if (cur.id === 'p3') {
        return {
          categoryId: '20697',
          breadcrumb: 'Möbel & Wohnen > Beleuchtung > Tisch- & Klemmleuchten',
          source: 'suggestions',
          confidence: 0.95,
        };
      }
      return null;
    });

    const result = await runBulkAction('recategorize_v2', {
      apply: true,
      limit: 100,
      offset: 0,
    });

    expect(saveProductV2Mock).toHaveBeenCalledTimes(1);

    const [nextArg, opts] = saveProductV2Mock.mock.calls[0];
    expect(nextArg.id).toBe('p3');
    expect(nextArg.details.categoryId).toBe('20697');
    expect(nextArg.details.categorySource).toBe('auto:suggestions');
    expect(nextArg.identification.category).toBe('Möbel & Wohnen > Beleuchtung > Tisch- & Klemmleuchten');
    expect(nextArg.ops.data_quality.recategorize_v2).toBeTruthy();
    expect(nextArg.ops.data_quality.recategorize_v2.from.id).toBe('888');
    expect(nextArg.ops.data_quality.recategorize_v2.to.id).toBe('20697');
    expect(opts).toEqual(
      expect.objectContaining({ source: 'admin-bulk-recategorize-v2', allowCategoryChange: true })
    );

    expect(result.summary.updated).toBe(1);
    expect(result.summary.would_update).toBe(0);
    expect(result.summary.skipped_manual).toBe(1);
    expect(result.summary.skipped_ui).toBe(1);
    expect(result.summary.dryRun).toBe(false);
  });
});

describe('runBulkRecategorizeV2 — Pre-flight count guard', () => {
  it('throws when expectedCount does not match actual collection size', async () => {
    const products = fakeProducts(); // 3 products
    getAllProductsMock.mockResolvedValue(products);

    await expect(
      runBulkAction('recategorize_v2', {
        apply: true,
        limit: 100,
        offset: 0,
        expectedCount: 5,
      })
    ).rejects.toThrow(/Pre-flight count mismatch/);

    // Must fail BEFORE any resolver or save call.
    expect(resolveCategoryV2Mock).not.toHaveBeenCalled();
    expect(saveProductV2Mock).not.toHaveBeenCalled();
  });
});

describe('runBulkRecategorizeV2 — low-confidence protection', () => {
  it('never writes when resolver confidence is below MIN_APPLY_CONFIDENCE (0.8)', async () => {
    const products = [
      {
        id: 'p-weak',
        identification: { sku: 'SKU-WEAK', brand: 'Foo', name: 'Generic Product' },
        details: { categoryId: '11111', attributes: {} },
      },
    ];
    getAllProductsMock.mockResolvedValue(products);
    getProductMock.mockImplementation(async (id) => products.find((p) => p.id === id) || null);
    resolveCategoryV2Mock.mockResolvedValue({
      categoryId: '99999',
      breadcrumb: 'Weak > Suggestion',
      source: 'gemini',
      confidence: 0.55,
    });

    const result = await runBulkAction('recategorize_v2', {
      apply: true,
      limit: 10,
      offset: 0,
    });

    expect(result.summary.low_confidence).toBe(1);
    expect(result.summary.updated).toBe(0);
    expect(saveProductV2Mock).not.toHaveBeenCalled();
    const row = result.samples.find((s) => s.status === 'low_confidence');
    expect(row).toBeTruthy();
    expect(row.confidence).toBe(0.55);
  });

  it('allows override via minConfidence payload', async () => {
    const products = [
      {
        id: 'p-mid',
        identification: { sku: 'SKU-MID', brand: 'Foo', name: 'Product' },
        details: { categoryId: '11111', attributes: {} },
      },
    ];
    getAllProductsMock.mockResolvedValue(products);
    getProductMock.mockImplementation(async (id) => products.find((p) => p.id === id) || null);
    resolveCategoryV2Mock.mockResolvedValue({
      categoryId: '99999',
      breadcrumb: 'Mid > Confidence',
      source: 'suggestions',
      confidence: 0.7,
    });

    const result = await runBulkAction('recategorize_v2', {
      apply: true,
      limit: 10,
      offset: 0,
      minConfidence: 0.6,
    });

    expect(result.summary.updated).toBe(1);
    expect(saveProductV2Mock).toHaveBeenCalledTimes(1);
  });
});

describe('runBulkRecategorizeV2 — resolver returns null', () => {
  it('counts products as unresolved and does not save', async () => {
    const products = [
      {
        id: 'p-null',
        identification: { sku: 'SKU-NULL', brand: 'Foo', name: 'Bar' },
        details: { categoryId: '123', attributes: {} },
      },
    ];
    getAllProductsMock.mockResolvedValue(products);
    getProductMock.mockImplementation(async (id) => products.find((p) => p.id === id) || null);
    resolveCategoryV2Mock.mockResolvedValue(null);

    const result = await runBulkAction('recategorize_v2', {
      apply: false,
      limit: 10,
      offset: 0,
    });

    expect(result.summary.unresolved).toBe(1);
    expect(result.summary.would_update).toBe(0);
    expect(saveProductV2Mock).not.toHaveBeenCalled();
    const unresolvedSample = result.samples.find((s) => s.status === 'unresolved');
    expect(unresolvedSample).toBeTruthy();
  });
});
