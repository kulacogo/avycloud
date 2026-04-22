'use strict';

const Module = require('module');

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

describe('ebay-catalog', () => {
  let catalog;
  let browseHandle;

  beforeEach(() => {
    delete require.cache[require.resolve('../../lib/ebay-catalog')];
    browseHandle = patchLocalModule('../../lib/ebay-browse-title-insights', {
      getAppToken: () => Promise.resolve('fake-token'),
    });
    catalog = require('../../lib/ebay-catalog');
    catalog._internal.CACHE.clear();
  });

  afterEach(() => {
    browseHandle.revert();
    globalThis.fetch = undefined;
  });

  describe('extractCatalogAspects', () => {
    it('extracts from Catalog API aspects[] shape', () => {
      const out = catalog.extractCatalogAspects({
        aspects: [
          { localizedName: 'Brand', localizedValues: ['Sony'] },
          { name: 'Model', values: ['WH-1000XM5'] },
        ],
      });
      expect(out).toEqual([
        { key: 'Brand', value: 'Sony' },
        { key: 'Model', value: 'WH-1000XM5' },
      ]);
    });

    it('extracts from Browse API aspectDistributions shape', () => {
      const out = catalog.extractCatalogAspects({
        aspectDistributions: [
          {
            localizedAspectName: 'Brand',
            aspectValueDistributions: [{ localizedAspectValue: 'Sony' }],
          },
        ],
      });
      expect(out).toEqual([{ key: 'Brand', value: 'Sony' }]);
    });

    it('returns [] for missing input', () => {
      expect(catalog.extractCatalogAspects(null)).toEqual([]);
      expect(catalog.extractCatalogAspects({})).toEqual([]);
    });
  });

  describe('_internal.normalizeCatalogProduct', () => {
    it('normalizes a Catalog API product_summary', () => {
      const out = catalog._internal.normalizeCatalogProduct(
        {
          epid: '123456',
          title: 'Sony WH-1000XM5',
          brand: 'Sony',
          gtin: '4548736132610',
          primaryCategory: { categoryId: '177635', categoryName: 'Kopfhörer' },
          image: { imageUrl: 'https://example.com/a.jpg' },
          aspects: [{ name: 'Color', values: ['Black'] }],
        },
        'ebay_catalog'
      );
      expect(out.ebayProductId).toBe('123456');
      expect(out.brand).toBe('Sony');
      expect(out.categoryId).toBe('177635');
      expect(out.imageUrl).toBe('https://example.com/a.jpg');
      expect(out.aspects).toHaveLength(1);
      expect(out.source).toBe('ebay_catalog');
    });

    it('returns null for invalid input', () => {
      expect(catalog._internal.normalizeCatalogProduct(null, 's')).toBeNull();
    });
  });

  describe('lookupByGtin', () => {
    it('rejects invalid GTIN (<8 chars)', async () => {
      const res = await catalog.lookupByGtin({ gtin: '123' });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('invalid_gtin');
    });

    it('returns catalog product when Catalog API succeeds', async () => {
      globalThis.fetch = (url) => {
        if (url.includes('/commerce/catalog/')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                productSummaries: [
                  {
                    epid: 'E123',
                    title: 'Sony WH-1000XM5',
                    brand: 'Sony',
                    primaryCategory: { categoryId: '177635' },
                    aspects: [{ name: 'Farbe', values: ['Schwarz'] }],
                  },
                ],
              }),
          });
        }
        return Promise.reject(new Error('unexpected url'));
      };

      const res = await catalog.lookupByGtin({ gtin: '4548736132610' });
      expect(res.ok).toBe(true);
      expect(res.product.ebayProductId).toBe('E123');
      expect(res.source).toBe('ebay_catalog');
    });

    it('falls back to Browse API when Catalog API fails', async () => {
      globalThis.fetch = (url) => {
        if (url.includes('/commerce/catalog/')) {
          return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
        }
        if (url.includes('/buy/browse/')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                itemSummaries: [
                  {
                    epid: 'E456',
                    title: 'Sony WH-1000XM5',
                    primaryCategoryId: '177635',
                    image: { imageUrl: 'https://example.com/b.jpg' },
                  },
                ],
                aspectDistributions: [
                  {
                    localizedAspectName: 'Brand',
                    aspectValueDistributions: [{ localizedAspectValue: 'Sony' }],
                  },
                ],
              }),
          });
        }
        return Promise.reject(new Error('unexpected'));
      };

      const res = await catalog.lookupByGtin({ gtin: '4548736132610' });
      expect(res.ok).toBe(true);
      expect(res.source).toBe('ebay_browse_gtin');
      expect(res.product.ebayProductId).toBe('E456');
      expect(res.product.aspects.length).toBeGreaterThan(0);
    });

    it('returns no_catalog_match when both APIs fail', async () => {
      globalThis.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      const res = await catalog.lookupByGtin({ gtin: '4548736132610' });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('no_catalog_match');
    });

    it('caches successful lookups', async () => {
      let callCount = 0;
      globalThis.fetch = (url) => {
        callCount += 1;
        if (url.includes('/commerce/catalog/')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                productSummaries: [{ epid: 'E123', title: 'Sony', brand: 'Sony' }],
              }),
          });
        }
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      };

      const first = await catalog.lookupByGtin({ gtin: '4548736132610' });
      const second = await catalog.lookupByGtin({ gtin: '4548736132610' });
      expect(first.ok).toBe(true);
      expect(second.cached).toBe(true);
      // Only 1 fetch call for the catalog API on first invocation
      expect(callCount).toBe(1);
    });

    it('handles missing app token gracefully', async () => {
      browseHandle.revert();
      browseHandle = patchLocalModule('../../lib/ebay-browse-title-insights', {
        getAppToken: () => Promise.resolve(null),
      });
      delete require.cache[require.resolve('../../lib/ebay-catalog')];
      catalog = require('../../lib/ebay-catalog');
      const res = await catalog.lookupByGtin({ gtin: '4548736132610' });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('no_catalog_match');
    });
  });
});
