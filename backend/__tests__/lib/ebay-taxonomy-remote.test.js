'use strict';

// Vitest globals (globals: true in vitest.config.js)

// ---------------------------------------------------------------------------
// Mock rate limiter — resolve immediately, no throttling in tests
// ---------------------------------------------------------------------------
const rateLimiterPath = require.resolve('../../lib/ebay-rate-limiter');
require(rateLimiterPath);
require.cache[rateLimiterPath] = {
  id: rateLimiterPath,
  filename: rateLimiterPath,
  loaded: true,
  exports: {
    acquireSlot: vi.fn(async () => undefined),
    getUsage: vi.fn(() => ({})),
    _reset: vi.fn(),
  },
};

// ---------------------------------------------------------------------------
// Mock getAppToken — return a fixed token, no real OAuth
// ---------------------------------------------------------------------------
const insightsPath = require.resolve('../../lib/ebay-browse-title-insights');
require(insightsPath);
const origInsights = require.cache[insightsPath].exports;
require.cache[insightsPath] = {
  id: insightsPath,
  filename: insightsPath,
  loaded: true,
  exports: {
    ...origInsights,
    getAppToken: vi.fn(async () => 'test-token-abc'),
  },
};

let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock;
  // Reset cache between tests
  const mod = require('../../lib/ebay-taxonomy-remote');
  if (typeof mod._resetCaches === 'function') mod._resetCaches();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete global.fetch;
});

function makeJsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe('ebay-taxonomy-remote', () => {
  describe('getCategorySuggestions', () => {
    it('parses ancestors + leaf into a breadcrumb and maps relevancy', async () => {
      const { getCategorySuggestions } = require('../../lib/ebay-taxonomy-remote');

      fetchMock.mockImplementationOnce(() =>
        makeJsonResponse({
          categorySuggestions: [
            {
              category: { categoryId: '15052', categoryName: 'Kopfhörer' },
              categoryTreeNodeAncestors: [
                { categoryId: '58058', categoryName: 'TV, Video & Audio', categoryTreeNodeLevel: 1 },
                { categoryId: '112529', categoryName: 'Heim-Audio & HiFi', categoryTreeNodeLevel: 2 },
              ],
              relevancy: '0.95',
            },
            {
              category: { categoryId: '14969', categoryName: 'Zubehör' },
              categoryTreeNodeAncestors: [
                { categoryId: '58058', categoryName: 'TV, Video & Audio', categoryTreeNodeLevel: 1 },
              ],
              relevancy: 0.4,
            },
          ],
        })
      );

      const result = await getCategorySuggestions('Sony WH-1000XM5 Kopfhörer');
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
      expect(result[0]).toMatchObject({
        categoryId: '15052',
        breadcrumb: 'TV, Video & Audio > Heim-Audio & HiFi > Kopfhörer',
        relevancy: 0.95,
      });
      expect(result[1]).toMatchObject({
        categoryId: '14969',
        breadcrumb: 'TV, Video & Audio > Zubehör',
        relevancy: 0.4,
      });

      // URL + headers sanity
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toContain('/commerce/taxonomy/v1/category_tree/77/get_category_suggestions');
      expect(url).toContain('q=');
      expect(opts.headers['X-EBAY-C-MARKETPLACE-ID']).toBe('EBAY_DE');
      expect(opts.headers.Authorization).toBe('Bearer test-token-abc');
    });

    it('returns an empty array when the API responds with a non-ok status', async () => {
      const { getCategorySuggestions } = require('../../lib/ebay-taxonomy-remote');
      fetchMock.mockImplementationOnce(() =>
        Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('oops') })
      );
      const result = await getCategorySuggestions('whatever');
      expect(result).toEqual([]);
    });
  });

  describe('searchCatalogByGtin', () => {
    it('votes across primaryCategory occurrences and returns the winner with confidence', async () => {
      const { searchCatalogByGtin } = require('../../lib/ebay-taxonomy-remote');

      fetchMock.mockImplementationOnce(() =>
        makeJsonResponse({
          productSummaries: [
            { primaryCategory: { categoryId: '15052', categoryName: 'Kopfhörer' } },
            { primaryCategory: { categoryId: '15052', categoryName: 'Kopfhörer' } },
            { primaryCategory: { categoryId: '14969', categoryName: 'Zubehör' } },
          ],
        })
      );

      const result = await searchCatalogByGtin('4548736132610');
      expect(result).not.toBeNull();
      expect(result.categoryId).toBe('15052');
      expect(result.votes).toBe(2);
      expect(result.total).toBe(3);
      // 2/3 ≈ 0.6667
      expect(result.confidence).toBeGreaterThan(0.66);
      expect(result.confidence).toBeLessThan(0.67);

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('/commerce/catalog/v1_beta/product_summary/search');
      expect(url).toContain('gtin=4548736132610');
    });

    it('returns null when no matching summaries are found', async () => {
      const { searchCatalogByGtin } = require('../../lib/ebay-taxonomy-remote');
      fetchMock.mockImplementationOnce(() => makeJsonResponse({ productSummaries: [] }));
      const result = await searchCatalogByGtin('4006381333931');
      expect(result).toBeNull();
    });
  });
});
