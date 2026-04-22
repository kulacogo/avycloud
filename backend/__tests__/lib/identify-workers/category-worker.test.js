'use strict';

const Module = require('module');

const WORKER_PATH = '../../../lib/identify-workers/category-worker';

function patchLocalModule(modulePath, exportsOverride) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  const fakeModule = new Module(resolved);
  fakeModule.exports = exportsOverride;
  fakeModule.loaded = true;
  fakeModule.filename = resolved;
  require.cache[resolved] = fakeModule;
  return { resolved, revert: () => delete require.cache[resolved] };
}

function buildProduct(overrides = {}) {
  return {
    identification: {
      name: 'Sony WH-1000XM5 Noise Cancelling Kopfhörer',
      brand: 'Sony',
      category: 'Elektronik > Kopfhörer',
      ean: '4548736132610',
    },
    details: {
      identifiers: { ean: '4548736132610' },
      short_description: 'Over-Ear Bluetooth Kopfhörer',
      key_features: ['Noise Cancelling', 'Bluetooth 5.2'],
    },
    ...overrides,
  };
}

describe('category-worker', () => {
  let worker;
  const revertHandles = [];

  function install(patches) {
    for (const [modulePath, exportsOverride] of Object.entries(patches)) {
      revertHandles.push(patchLocalModule(modulePath, exportsOverride));
    }
    delete require.cache[require.resolve(WORKER_PATH)];
    worker = require(WORKER_PATH);
  }

  afterEach(() => {
    while (revertHandles.length) revertHandles.pop().revert();
    delete require.cache[require.resolve(WORKER_PATH)];
  });

  it('1. GTIN-Catalog-Match resolves categoryId with source=auto:catalog and confidence >= 0.95', async () => {
    install({
      '../../../lib/ebay-catalog': {
        lookupByGtin: async ({ gtin }) => ({
          ok: true,
          product: {
            ebayProductId: 'E1',
            gtin,
            categoryId: '177635',
            categoryName: 'Kopfhörer',
            aspects: [{ key: 'Marke', value: 'Sony' }],
          },
          source: 'ebay_catalog',
        }),
      },
      '../../../services/category-resolver': {
        resolveCategoryV2: async () => {
          throw new Error('should not be called on GTIN hit');
        },
      },
      '../../../services/atomic-tools': {
        executors: {
          executeGetRequiredAspects: async ({ categoryId }) => ({
            ok: true,
            data: {
              required: ['Marke', 'Modell'],
              recommended: ['Farbe'],
              optional: [],
              all: ['Marke', 'Modell', 'Farbe'],
              aspects: [],
              hasCatalogEntry: true,
            },
            source: 'get_required_aspects',
            confidence: 0.95,
            meta: { durationMs: 1, categoryId },
          }),
        },
      },
    });

    const out = await worker.runCategoryWorker({
      product: buildProduct(),
      barcodes: { ean: '4548736132610' },
      tenantId: 'trendocean',
    });
    expect(out.ok).toBe(true);
    expect(out.domain).toBe('category');
    expect(out.resolved.categoryId).toBe('177635');
    expect(out.resolved.categorySource).toBe('auto:catalog');
    expect(out.confidence.categoryId).toBeGreaterThanOrEqual(0.95);
    expect(out.resolved.requiredAspects).toEqual([{ name: 'Marke' }, { name: 'Modell' }]);
    expect(out.sources.some((s) => s.type === 'ebay_catalog')).toBe(true);
  });

  it('2. without GTIN falls back to resolveCategoryV2 with categorySource=auto:suggestions', async () => {
    install({
      '../../../lib/ebay-catalog': {
        lookupByGtin: async () => ({ ok: false, product: null, reason: 'invalid_gtin' }),
      },
      '../../../services/category-resolver': {
        resolveCategoryV2: async () => ({
          categoryId: '177635',
          breadcrumb: 'Elektronik > Kopfhörer',
          source: 'suggestions',
          confidence: 0.88,
        }),
      },
      '../../../services/atomic-tools': {
        executors: {
          executeGetRequiredAspects: async () => ({
            ok: true,
            data: { required: ['Marke'], recommended: [], optional: [], all: ['Marke'], aspects: [] },
          }),
        },
      },
    });

    const out = await worker.runCategoryWorker({
      product: buildProduct({ identification: { name: 'Kopfhörer', brand: 'Sony' }, details: {} }),
      barcodes: {},
      tenantId: 't1',
    });
    expect(out.ok).toBe(true);
    expect(out.resolved.categorySource).toBe('auto:suggestions');
    expect(out.resolved.categoryId).toBe('177635');
    expect(out.resolved.breadcrumb).toBe('Elektronik > Kopfhörer');
    expect(out.resolved.categoryName).toBe('Kopfhörer');
    expect(out.confidence.categoryId).toBeCloseTo(0.88, 3);
  });

  it('3. resolveCategoryV2 returns null → ok:false, meta.error set', async () => {
    install({
      '../../../lib/ebay-catalog': {
        lookupByGtin: async () => ({ ok: false, product: null, reason: 'no_catalog_match' }),
      },
      '../../../services/category-resolver': {
        resolveCategoryV2: async () => null,
      },
      '../../../services/atomic-tools': {
        executors: {
          executeGetRequiredAspects: async () => ({ ok: false, error: { code: 'x', message: 'x' } }),
        },
      },
    });

    const out = await worker.runCategoryWorker({
      product: buildProduct(),
      barcodes: {},
    });
    expect(out.ok).toBe(false);
    expect(out.resolved.categoryId).toBeUndefined();
    expect(out.meta.error).toBe('category_not_resolved');
    expect(out.confidence.categoryId).toBe(0);
    expect(Array.isArray(out.sources)).toBe(true);
  });

  it('4. Aspect-Catalog load succeeds → requiredAspects and recommendedAspects populated', async () => {
    install({
      '../../../lib/ebay-catalog': {
        lookupByGtin: async () => ({ ok: false, product: null }),
      },
      '../../../services/category-resolver': {
        resolveCategoryV2: async () => ({
          categoryId: '9355',
          breadcrumb: 'Handys & Kommunikation > Handys',
          source: 'local',
          confidence: 0.82,
        }),
      },
      '../../../services/atomic-tools': {
        executors: {
          executeGetRequiredAspects: async () => ({
            ok: true,
            data: {
              required: ['Marke', 'Modellreihe', 'Speicherkapazität'],
              recommended: ['Farbe', 'Betriebssystem'],
              optional: ['Zustand'],
              all: ['Marke', 'Modellreihe', 'Speicherkapazität', 'Farbe'],
              aspects: [{ name: 'Marke', required: true }],
              hasCatalogEntry: true,
            },
          }),
        },
      },
    });

    const out = await worker.runCategoryWorker({
      product: buildProduct(),
      barcodes: {},
    });
    expect(out.ok).toBe(true);
    expect(out.resolved.requiredAspects).toHaveLength(3);
    expect(out.resolved.recommendedAspects).toEqual([
      { name: 'Farbe' },
      { name: 'Betriebssystem' },
    ]);
    expect(out.resolved.aspectCatalog.hasCatalogEntry).toBe(true);
    expect(out.resolved.aspectCatalog.required).toContain('Marke');
  });

  it('5. Aspect-Catalog fails on both primary and fallback → keep categoryId, no aspects, lower confidence', async () => {
    install({
      '../../../lib/ebay-catalog': {
        lookupByGtin: async () => ({ ok: false, product: null }),
      },
      '../../../services/category-resolver': {
        resolveCategoryV2: async () => ({
          categoryId: '12345',
          breadcrumb: 'Elektronik > Zubehör',
          source: 'local',
          confidence: 0.9,
        }),
      },
      '../../../services/atomic-tools': {
        executors: {
          executeGetRequiredAspects: async () => ({
            ok: false,
            error: { code: 'NOT_IMPLEMENTED', message: 'missing' },
          }),
        },
      },
      '../../../lib/ebay-taxonomy': {
        getCategoryAspectCatalog: () => null,
      },
    });

    const out = await worker.runCategoryWorker({
      product: buildProduct(),
      barcodes: {},
    });
    expect(out.ok).toBe(true);
    expect(out.resolved.categoryId).toBe('12345');
    expect(out.resolved.requiredAspects).toBeUndefined();
    expect(out.resolved.aspectCatalog).toBeUndefined();
    // confidence reduced by 0.1 because aspects failed
    expect(out.confidence.categoryId).toBeLessThan(0.9);
    expect(out.confidence.categoryId).toBeGreaterThanOrEqual(0.79);
    expect(out.sources.some((s) => s.type === 'aspect_catalog' && s.ok === false)).toBe(true);
  });

  it('6. return-shape has domain="category" and retriesRequested=[]', async () => {
    install({
      '../../../lib/ebay-catalog': {
        lookupByGtin: async () => ({ ok: false, product: null }),
      },
      '../../../services/category-resolver': {
        resolveCategoryV2: async () => ({
          categoryId: '1',
          breadcrumb: 'A > B',
          source: 'local',
          confidence: 0.8,
        }),
      },
      '../../../services/atomic-tools': {
        executors: {
          executeGetRequiredAspects: async () => ({
            ok: true,
            data: { required: [], recommended: [], optional: [], all: [], aspects: [] },
          }),
        },
      },
    });

    const out = await worker.runCategoryWorker({
      product: buildProduct(),
      barcodes: {},
    });
    expect(out.domain).toBe('category');
    expect(out).toHaveProperty('retriesRequested');
    expect(out.retriesRequested).toEqual([]);
    expect(out).toHaveProperty('meta.durationMs');
    expect(typeof out.meta.toolsCalled).toBe('number');
  });

  it('7. missing context.product → ok:false with meta.error defined', async () => {
    install({
      '../../../lib/ebay-catalog': { lookupByGtin: async () => ({ ok: false }) },
      '../../../services/category-resolver': { resolveCategoryV2: async () => null },
      '../../../services/atomic-tools': { executors: {} },
    });

    const out1 = await worker.runCategoryWorker(null);
    expect(out1.ok).toBe(false);
    expect(out1.domain).toBe('category');
    expect(out1.meta.error).toBeDefined();

    const out2 = await worker.runCategoryWorker({ barcodes: {} });
    expect(out2.ok).toBe(false);
    expect(out2.meta.error).toBe('missing_product');
  });

  it('8. sources array is populated with type=ebay_catalog (GTIN path) or category_resolver (fallback path)', async () => {
    // GTIN path
    install({
      '../../../lib/ebay-catalog': {
        lookupByGtin: async () => ({
          ok: true,
          product: { categoryId: '177635', categoryName: 'Kopfhörer', aspects: [] },
          source: 'ebay_catalog',
        }),
      },
      '../../../services/category-resolver': {
        resolveCategoryV2: async () => null,
      },
      '../../../services/atomic-tools': {
        executors: {
          executeGetRequiredAspects: async () => ({
            ok: true,
            data: { required: ['Marke'], recommended: [], optional: [], all: [], aspects: [] },
          }),
        },
      },
    });

    const gtinOut = await worker.runCategoryWorker({
      product: buildProduct(),
      barcodes: { ean: '4548736132610' },
    });
    expect(gtinOut.sources.some((s) => s.type === 'ebay_catalog')).toBe(true);
    expect(gtinOut.sources.some((s) => s.type === 'aspect_catalog')).toBe(true);

    // reset + fallback path
    while (revertHandles.length) revertHandles.pop().revert();
    delete require.cache[require.resolve(WORKER_PATH)];

    install({
      '../../../lib/ebay-catalog': {
        lookupByGtin: async () => ({ ok: false, product: null }),
      },
      '../../../services/category-resolver': {
        resolveCategoryV2: async () => ({
          categoryId: '9355',
          breadcrumb: 'Handys > Smartphones',
          source: 'suggestions',
          confidence: 0.87,
        }),
      },
      '../../../services/atomic-tools': {
        executors: {
          executeGetRequiredAspects: async () => ({
            ok: true,
            data: { required: ['Marke'], recommended: [], optional: [], all: [], aspects: [] },
          }),
        },
      },
    });

    const fallbackOut = await worker.runCategoryWorker({
      product: buildProduct({ identification: { name: 'Smartphone', brand: 'X' } }),
      barcodes: {},
    });
    expect(fallbackOut.sources.some((s) => s.type === 'category_resolver')).toBe(true);
    expect(fallbackOut.sources.some((s) => s.type === 'aspect_catalog')).toBe(true);
  });

  it('9. falls back to ebay-taxonomy.getCategoryAspectCatalog when atomic-tools unavailable', async () => {
    install({
      '../../../lib/ebay-catalog': {
        lookupByGtin: async () => ({ ok: false, product: null }),
      },
      '../../../services/category-resolver': {
        resolveCategoryV2: async () => ({
          categoryId: '42',
          breadcrumb: 'A > B > C',
          source: 'local',
          confidence: 0.85,
        }),
      },
      '../../../services/atomic-tools': {
        executors: {
          executeGetRequiredAspects: async () => ({
            ok: false,
            error: { code: 'NOT_IMPLEMENTED', message: 'atomic tools missing' },
          }),
        },
      },
      '../../../lib/ebay-taxonomy': {
        getCategoryAspectCatalog: (id) => ({
          categoryId: id,
          hasCatalogEntry: true,
          requiredAspects: ['Marke', 'Modell'],
          recommendedAspects: ['Farbe'],
          optionalAspects: [],
          allAspects: ['Marke', 'Modell', 'Farbe'],
          aspects: [],
        }),
      },
    });

    const out = await worker.runCategoryWorker({
      product: buildProduct(),
      barcodes: {},
    });
    expect(out.ok).toBe(true);
    expect(out.resolved.requiredAspects).toEqual([{ name: 'Marke' }, { name: 'Modell' }]);
    expect(out.sources.some((s) => s.type === 'aspect_catalog' && s.via === 'ebay-taxonomy')).toBe(
      true
    );
  });
});
