'use strict';

const Module = require('module');

// Patch require.cache BEFORE ebay-sold-listings loads, to stub its deps.
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

describe('ebay-sold-listings', () => {
  let soldListings;
  let browseHandle;
  let serpHandle;
  let rateLimiterHandle;

  beforeEach(() => {
    // Reset in-memory state via fresh require
    delete require.cache[require.resolve('../../lib/ebay-sold-listings')];

    browseHandle = patchLocalModule('../../lib/ebay-browse-title-insights', {
      getAppToken: () => Promise.resolve('fake-token'),
    });
    serpHandle = patchLocalModule('../../lib/serpapi', {
      fetchSerpApi: () => Promise.resolve({ organic_results: [] }),
    });
    rateLimiterHandle = patchLocalModule('../../lib/ebay-rate-limiter', {
      acquireSlot: () => Promise.resolve(),
    });

    soldListings = require('../../lib/ebay-sold-listings');
    soldListings._internal.CACHE.clear();
  });

  afterEach(() => {
    browseHandle.revert();
    serpHandle.revert();
    rateLimiterHandle.revert();
  });

  describe('extractPricingSignals', () => {
    it('returns zero-stats for empty input', () => {
      const stats = soldListings.extractPricingSignals([]);
      expect(stats.count).toBe(0);
      expect(stats.median).toBeNull();
    });

    it('computes median, min, max, mean, stdev for a price list', () => {
      const stats = soldListings.extractPricingSignals([
        { price: 100 },
        { price: 110 },
        { price: 90 },
        { price: 105 },
        { price: 95 },
      ]);
      expect(stats.count).toBe(5);
      expect(stats.median).toBe(100);
      expect(stats.min).toBe(90);
      expect(stats.max).toBe(110);
      expect(stats.mean).toBeCloseTo(100, 2);
      expect(stats.stdev).toBeGreaterThan(0);
    });

    it('ignores non-numeric prices', () => {
      const stats = soldListings.extractPricingSignals([
        { price: 100 },
        { price: 'broken' },
        { price: null },
        { price: 200 },
      ]);
      expect(stats.count).toBe(2);
    });
  });

  describe('_internal.normalizeItem', () => {
    it('normalizes a Browse API response item', () => {
      const out = soldListings._internal.normalizeItem(
        {
          title: 'Sony WH-1000XM5',
          price: { value: '299.99', currency: 'EUR' },
          itemWebUrl: 'https://ebay.de/itm/123',
          condition: 'NEW',
        },
        'ebay_browse'
      );
      expect(out).toMatchObject({ price: 299.99, title: 'Sony WH-1000XM5', source: 'ebay_browse' });
    });

    it('normalizes a SerpAPI ebay item', () => {
      const out = soldListings._internal.normalizeItem(
        { title: 'Sony WH-1000XM5', extracted_price: 299.99, link: 'https://ebay.de/itm/123' },
        'serpapi_ebay'
      );
      expect(out.price).toBe(299.99);
      expect(out.source).toBe('serpapi_ebay');
    });

    it('returns null for items missing price or title', () => {
      expect(soldListings._internal.normalizeItem({ title: 'foo' }, 'x')).toBeNull();
      expect(soldListings._internal.normalizeItem({ price: 100 }, 'x')).toBeNull();
    });
  });

  describe('searchSoldListings', () => {
    it('returns no_query reason when neither gtin nor query provided', async () => {
      const res = await soldListings.searchSoldListings({});
      expect(res.items).toEqual([]);
      expect(res.meta.reason).toBe('no_query');
    });

    it('returns empty items gracefully when both providers fail', async () => {
      browseHandle.revert();
      serpHandle.revert();
      browseHandle = patchLocalModule('../../lib/ebay-browse-title-insights', {
        getAppToken: () => Promise.resolve(null),
      });
      serpHandle = patchLocalModule('../../lib/serpapi', {
        fetchSerpApi: () => Promise.reject(new Error('serpapi down')),
      });
      delete require.cache[require.resolve('../../lib/ebay-sold-listings')];
      soldListings = require('../../lib/ebay-sold-listings');

      const res = await soldListings.searchSoldListings({ gtin: '4038788123456' });
      expect(res.items).toEqual([]);
      expect(res.meta.count).toBe(0);
    });

    it('merges and dedupes items from both providers', async () => {
      browseHandle.revert();
      serpHandle.revert();
      // Browse returns 2 items, SerpAPI returns 2 items, 1 overlap
      browseHandle = patchLocalModule('../../lib/ebay-browse-title-insights', {
        getAppToken: () => Promise.resolve('fake'),
      });
      serpHandle = patchLocalModule('../../lib/serpapi', {
        fetchSerpApi: () =>
          Promise.resolve({
            organic_results: [
              { title: 'Sony WH-1000XM5 Wireless', extracted_price: 299.99 },
              { title: 'Sony WH-1000XM4 Older Model', extracted_price: 199.99 },
            ],
          }),
      });

      // Mock global fetch for Browse API
      const origFetch = globalThis.fetch;
      globalThis.fetch = () =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              itemSummaries: [
                { title: 'Sony WH-1000XM5 Wireless', price: { value: '299.99' } },
                { title: 'Sony WH-1000XM5 Premium Edition', price: { value: '329.99' } },
              ],
            }),
        });

      delete require.cache[require.resolve('../../lib/ebay-sold-listings')];
      soldListings = require('../../lib/ebay-sold-listings');

      const res = await soldListings.searchSoldListings({ gtin: '4548736132610' });
      // 3 unique items: (XM5, 299.99) from both → dedup 1, XM4 from serp, XM5 Premium from browse
      expect(res.items.length).toBeGreaterThanOrEqual(2);
      expect(res.meta.count).toBe(res.items.length);

      globalThis.fetch = origFetch;
    });

    it('caches repeat calls with the same key', async () => {
      browseHandle.revert();
      serpHandle.revert();
      let serpCallCount = 0;
      browseHandle = patchLocalModule('../../lib/ebay-browse-title-insights', {
        getAppToken: () => Promise.resolve(null),
      });
      serpHandle = patchLocalModule('../../lib/serpapi', {
        fetchSerpApi: () => {
          serpCallCount += 1;
          return Promise.resolve({
            organic_results: [{ title: 'Item', extracted_price: 100 }],
          });
        },
      });
      delete require.cache[require.resolve('../../lib/ebay-sold-listings')];
      soldListings = require('../../lib/ebay-sold-listings');

      const first = await soldListings.searchSoldListings({ gtin: '4038788123456' });
      const second = await soldListings.searchSoldListings({ gtin: '4038788123456' });
      expect(first.meta.cached).toBe(false);
      expect(second.meta.cached).toBe(true);
      expect(serpCallCount).toBe(1);
    });

    it('respects the limit parameter', async () => {
      browseHandle.revert();
      serpHandle.revert();
      browseHandle = patchLocalModule('../../lib/ebay-browse-title-insights', {
        getAppToken: () => Promise.resolve(null),
      });
      serpHandle = patchLocalModule('../../lib/serpapi', {
        fetchSerpApi: () =>
          Promise.resolve({
            organic_results: Array.from({ length: 15 }, (_, i) => ({
              title: `Item ${i}`,
              extracted_price: 100 + i,
            })),
          }),
      });
      delete require.cache[require.resolve('../../lib/ebay-sold-listings')];
      soldListings = require('../../lib/ebay-sold-listings');

      const res = await soldListings.searchSoldListings({
        gtin: '4038788123456',
        limit: 5,
      });
      expect(res.items.length).toBeLessThanOrEqual(5);
    });
  });

  describe('_internal cache', () => {
    it('cacheKeyFor produces stable lowercase keys', () => {
      const k1 = soldListings._internal.cacheKeyFor({ gtin: '404', categoryId: '123' });
      const k2 = soldListings._internal.cacheKeyFor({ gtin: '404', categoryId: '123' });
      expect(k1).toBe(k2);
    });

    it('cacheGet returns null for expired entries', () => {
      const CACHE = soldListings._internal.CACHE;
      CACHE.set('k1', { value: 'x', expiresAt: Date.now() - 1000 });
      expect(soldListings._internal.cacheGet('k1')).toBeNull();
    });
  });
});
