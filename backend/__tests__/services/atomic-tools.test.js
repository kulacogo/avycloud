'use strict';

// Vitest globals (globals: true in vitest.config.js)
//
// Tests for backend/services/atomic-tools.js
//
// Philosophy: atomic Poka-Yoke tools for Gemini function-calling. Each
// executor must (1) have a uniform response shape, (2) degrade gracefully
// when an optional dependency is missing, (3) never throw.
//
// Mocking strategy: require.cache patching (vi.mock() does not intercept
// CJS require() in Vitest 4.x for local modules). See
// __tests__/api/_patchLocalModules.js for the canonical reference.

// ---------------------------------------------------------------------------
// 1. Patch optional dependencies BEFORE the atomic-tools module is loaded.
// ---------------------------------------------------------------------------

function patchLocalModule(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
    children: [],
    paths: [],
  };
  return resolved;
}

// ean-database: default mock returns "not found"; tests override.
const lookupEanMock = vi.fn().mockResolvedValue({
  found: false,
  source: null,
  productName: null,
  brand: null,
  category: null,
  description: null,
  imageUrl: null,
});
patchLocalModule('../../lib/ean-database', { lookupEan: lookupEanMock });

// gtin library — keep the real isValidGtin so checksum rules run.
const realGtin = require('../../lib/gtin');
patchLocalModule('../../lib/gtin', realGtin);

// ebay-taxonomy remote (category suggestions + GTIN catalog)
const searchCatalogByGtinMock = vi.fn();
const getCategorySuggestionsMock = vi.fn();
patchLocalModule('../../lib/ebay-taxonomy-remote', {
  searchCatalogByGtin: searchCatalogByGtinMock,
  getCategorySuggestions: getCategorySuggestionsMock,
  _resetCaches: () => {},
});

// ebay-taxonomy (required aspects catalog)
const getCategoryAspectCatalogMock = vi.fn();
patchLocalModule('../../lib/ebay-taxonomy', {
  getCategoryAspectCatalog: getCategoryAspectCatalogMock,
  findEbayCategory: vi.fn(),
  getRequiredAspects: vi.fn(),
  isKnownEbayCategoryId: vi.fn(() => true),
  buildRequiredAspectMeta: vi.fn(() => ({})),
  getRequiredAspectCatalogStats: vi.fn(() => ({})),
});

// gpsr registry
const getManufacturerGpsrByNameMock = vi.fn();
patchLocalModule('../../lib/gpsr-manufacturer-registry', {
  getManufacturerGpsrByName: getManufacturerGpsrByNameMock,
});

// toolkit (serpapi + brightdata + web fetch)
const executeSerpapiToolCallMock = vi.fn();
const executeBrightdataSearchToolCallMock = vi.fn();
const executeWebFetchToolCallMock = vi.fn();
patchLocalModule('../../services/toolkit', {
  executeSerpapiToolCall: executeSerpapiToolCallMock,
  executeBrightdataSearchToolCall: executeBrightdataSearchToolCallMock,
  executeWebFetchToolCall: executeWebFetchToolCallMock,
  serpapiToolDefinition: { name: 'serpapi' },
  brightdataSearchToolDefinition: { name: 'brightdata' },
  webFetchToolDefinition: { name: 'web_fetch' },
});

// ---------------------------------------------------------------------------
// 2. Now load the module under test.
// ---------------------------------------------------------------------------
const atomicTools = require('../../services/atomic-tools');
const {
  declarations,
  executors,
  buildToolList,
  buildToolExecutorMap,
  brandDomainGuess,
} = atomicTools;

beforeEach(() => {
  lookupEanMock.mockReset();
  lookupEanMock.mockResolvedValue({
    found: false,
    source: null,
    productName: null,
    brand: null,
    category: null,
    description: null,
    imageUrl: null,
  });
  searchCatalogByGtinMock.mockReset();
  getCategorySuggestionsMock.mockReset();
  getCategoryAspectCatalogMock.mockReset();
  getManufacturerGpsrByNameMock.mockReset();
  executeSerpapiToolCallMock.mockReset();
  executeBrightdataSearchToolCallMock.mockReset();
  executeWebFetchToolCallMock.mockReset();
});

// Helper — every executor must return this shape.
function assertResponseShape(response, expectedSource) {
  expect(response).toBeTypeOf('object');
  expect(response).not.toBeNull();
  expect(response).toHaveProperty('ok');
  expect(typeof response.ok).toBe('boolean');
  expect(response).toHaveProperty('source', expectedSource);
  expect(response).toHaveProperty('data');
  expect(response).toHaveProperty('confidence');
  expect(typeof response.confidence).toBe('number');
  expect(response.confidence).toBeGreaterThanOrEqual(0);
  expect(response.confidence).toBeLessThanOrEqual(1);
  expect(response).toHaveProperty('meta');
  expect(response.meta).toBeTypeOf('object');
  expect(typeof response.meta.durationMs).toBe('number');
  if (!response.ok) {
    expect(response).toHaveProperty('error');
    expect(response.error).toHaveProperty('code');
    expect(response.error).toHaveProperty('message');
  }
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

describe('declarations — JSON Schema shape', () => {
  it('every declaration has name, description and parameters', () => {
    for (const decl of Object.values(declarations)) {
      expect(decl).toHaveProperty('name');
      expect(typeof decl.name).toBe('string');
      expect(decl.name.length).toBeGreaterThan(0);
      expect(decl).toHaveProperty('description');
      expect(typeof decl.description).toBe('string');
      expect(decl).toHaveProperty('parameters');
      expect(decl.parameters).toMatchObject({ type: 'object', properties: expect.any(Object) });
    }
  });

  it('lookup_gtin declaration marks gtin as required', () => {
    expect(declarations.lookupGtin.name).toBe('lookup_gtin');
    expect(declarations.lookupGtin.parameters.required).toContain('gtin');
  });

  it('get_required_aspects declaration marks categoryId as required', () => {
    expect(declarations.getRequiredAspects.parameters.required).toContain('categoryId');
  });

  it('fetch_url_content declaration marks url as required and accepts extractImages', () => {
    expect(declarations.fetchUrlContent.parameters.required).toContain('url');
    expect(declarations.fetchUrlContent.parameters.properties).toHaveProperty('extractImages');
  });
});

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

describe('buildToolList / buildToolExecutorMap', () => {
  it('buildToolList() returns all 7 declarations by default', () => {
    const list = buildToolList();
    expect(list).toHaveLength(7);
    const names = list.map((d) => d.name).sort();
    expect(names).toEqual(
      [
        'fetch_url_content',
        'get_required_aspects',
        'lookup_gtin',
        'search_amazon_product',
        'search_ebay_catalog',
        'search_manufacturer_site',
        'verify_brand',
      ]
    );
  });

  it('buildToolList({ includeAmazon: false }) omits Amazon', () => {
    const list = buildToolList({ includeAmazon: false });
    expect(list.find((d) => d.name === 'search_amazon_product')).toBeUndefined();
  });

  it('buildToolExecutorMap() contains all 7 keys and only functions', () => {
    const map = buildToolExecutorMap();
    const keys = Object.keys(map).sort();
    expect(keys).toEqual(
      [
        'fetch_url_content',
        'get_required_aspects',
        'lookup_gtin',
        'search_amazon_product',
        'search_ebay_catalog',
        'search_manufacturer_site',
        'verify_brand',
      ]
    );
    for (const fn of Object.values(map)) {
      expect(typeof fn).toBe('function');
    }
  });
});

// ---------------------------------------------------------------------------
// brandDomainGuess
// ---------------------------------------------------------------------------

describe('brandDomainGuess', () => {
  it('resolves well-known brands via the alias table', () => {
    expect(brandDomainGuess('Philips')).toBe('philips.de');
    expect(brandDomainGuess('Samsung')).toBe('samsung.com');
    expect(brandDomainGuess('Bosch')).toBe('bosch.de');
  });

  it('strips GmbH / AG suffixes and falls back to <slug>.de', () => {
    expect(brandDomainGuess('Acme GmbH')).toBe('acme.de');
    expect(brandDomainGuess('Foo Bar AG')).toBe('foobar.de');
  });

  it('returns null for empty/invalid input', () => {
    expect(brandDomainGuess('')).toBeNull();
    expect(brandDomainGuess(null)).toBeNull();
    expect(brandDomainGuess(undefined)).toBeNull();
    expect(brandDomainGuess(123)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// executeLookupGtin
// ---------------------------------------------------------------------------

describe('executeLookupGtin', () => {
  it('rejects missing gtin with INVALID_GTIN', async () => {
    const res = await executors.executeLookupGtin({});
    assertResponseShape(res, 'lookup_gtin');
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('INVALID_GTIN');
  });

  it('rejects structurally invalid gtin with INVALID_GTIN', async () => {
    const res = await executors.executeLookupGtin({ gtin: '12345' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('INVALID_GTIN');
    expect(lookupEanMock).not.toHaveBeenCalled();
  });

  it('forwards valid gtin to lookupEan and maps found result', async () => {
    // 4006381333931 is a well-formed EAN-13.
    lookupEanMock.mockResolvedValueOnce({
      found: true,
      source: 'open_ean_db',
      productName: 'Test Pen',
      brand: 'Faber-Castell',
      category: 'Stationery',
      description: 'blue',
      imageUrl: null,
    });
    const res = await executors.executeLookupGtin({ gtin: '4006381333931', locale: 'de-DE' });
    assertResponseShape(res, 'lookup_gtin');
    expect(lookupEanMock).toHaveBeenCalledWith('4006381333931');
    expect(res.ok).toBe(true);
    expect(res.data.sources).toHaveLength(1);
    expect(res.data.sources[0].provider).toBe('open_ean_db');
    expect(res.data.summary).toContain('Test Pen');
    expect(res.data.locale).toBe('de-DE');
    expect(res.confidence).toBeGreaterThan(0.5);
  });

  it('returns ok:true with empty sources when lookupEan finds nothing', async () => {
    const res = await executors.executeLookupGtin({ gtin: '4006381333931' });
    assertResponseShape(res, 'lookup_gtin');
    expect(res.ok).toBe(true);
    expect(res.data.sources).toHaveLength(0);
    expect(res.confidence).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// executeSearchEbayCatalog
// ---------------------------------------------------------------------------

describe('executeSearchEbayCatalog', () => {
  it('errors when neither gtin nor query is given', async () => {
    const res = await executors.executeSearchEbayCatalog({});
    assertResponseShape(res, 'search_ebay_catalog');
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('MISSING_ARGUMENT');
  });

  it('uses searchCatalogByGtin path for valid GTIN', async () => {
    searchCatalogByGtinMock.mockResolvedValueOnce({ categoryId: '15052', top: 'Kopfhörer' });
    const res = await executors.executeSearchEbayCatalog({ gtin: '4006381333931' });
    expect(searchCatalogByGtinMock).toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.data.mode).toBe('gtin');
    expect(res.data.catalog.categoryId).toBe('15052');
    expect(res.confidence).toBeGreaterThan(0.5);
  });

  it('falls back to getCategorySuggestions for free-text query', async () => {
    getCategorySuggestionsMock.mockResolvedValueOnce([{ categoryId: '20697', score: 0.9 }]);
    const res = await executors.executeSearchEbayCatalog({ query: 'Desk lamp LED' });
    expect(getCategorySuggestionsMock).toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.data.mode).toBe('query');
    expect(res.data.suggestions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// executeGetRequiredAspects
// ---------------------------------------------------------------------------

describe('executeGetRequiredAspects', () => {
  it('errors when categoryId missing', async () => {
    const res = await executors.executeGetRequiredAspects({});
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('MISSING_ARGUMENT');
  });

  it('returns structured aspects for a known category', async () => {
    getCategoryAspectCatalogMock.mockReturnValueOnce({
      categoryId: '15052',
      hasCatalogEntry: true,
      hasAspectData: true,
      requiredAspects: ['Brand', 'Type'],
      recommendedAspects: ['Colour'],
      optionalAspects: ['Features'],
      allAspects: ['Brand', 'Type', 'Colour', 'Features'],
      aspects: [{ name: 'Brand', required: true }],
    });
    const res = await executors.executeGetRequiredAspects({ categoryId: '15052' });
    assertResponseShape(res, 'get_required_aspects');
    expect(res.ok).toBe(true);
    expect(res.data.required).toEqual(['Brand', 'Type']);
    expect(res.data.recommended).toEqual(['Colour']);
    expect(res.data.hasCatalogEntry).toBe(true);
    expect(res.confidence).toBeGreaterThan(0.8);
  });
});

// ---------------------------------------------------------------------------
// executeVerifyBrand
// ---------------------------------------------------------------------------

describe('executeVerifyBrand', () => {
  it('errors without a brand', async () => {
    const res = await executors.executeVerifyBrand({});
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('MISSING_ARGUMENT');
  });

  it('returns canonical brand when GPSR registry resolves', async () => {
    getManufacturerGpsrByNameMock.mockResolvedValueOnce({
      manufacturer_name: 'Philips GmbH',
      gpsr: { address: 'Lübeckertordamm 5, 20099 Hamburg' },
      confidence: 0.92,
      sources: ['impressum.philips.de'],
    });
    const res = await executors.executeVerifyBrand({ brand: 'Philips' });
    expect(res.ok).toBe(true);
    expect(res.data.resolved).toBe(true);
    expect(res.data.via).toBe('gpsr_registry');
    expect(res.data.brand).toBe('Philips GmbH');
    expect(res.confidence).toBeCloseTo(0.92);
  });

  it('falls back to domain guess when GPSR misses', async () => {
    getManufacturerGpsrByNameMock.mockResolvedValueOnce(null);
    const res = await executors.executeVerifyBrand({ brand: 'UnknownMicroBrand' });
    expect(res.ok).toBe(true);
    expect(res.data.resolved).toBe(false);
    expect(res.data.via).toBe('domain_guess');
    expect(res.data.guess.domain).toMatch(/unknownmicrobrand/);
  });
});

// ---------------------------------------------------------------------------
// executeSearchAmazonProduct
// ---------------------------------------------------------------------------

describe('executeSearchAmazonProduct', () => {
  it('errors when no arguments provided', async () => {
    const res = await executors.executeSearchAmazonProduct({});
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('MISSING_ARGUMENT');
  });

  it('prefers SerpAPI when available', async () => {
    executeSerpapiToolCallMock.mockResolvedValueOnce({
      engine: 'amazon',
      summary: [{ title: 'Echo Dot' }],
      raw: {},
    });
    const res = await executors.executeSearchAmazonProduct({ asin: 'B08L5WHFT9', region: 'DE' });
    expect(executeSerpapiToolCallMock).toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.data.provider).toBe('serpapi');
    expect(res.data.domain).toBe('amazon.de');
  });

  it('falls back to BrightData when SerpAPI errors', async () => {
    executeSerpapiToolCallMock.mockResolvedValueOnce({ error: 'disabled' });
    executeBrightdataSearchToolCallMock.mockResolvedValueOnce({
      ok: true,
      engine: 'brightdata',
      results: [{ url: 'https://amazon.com/product' }],
    });
    const res = await executors.executeSearchAmazonProduct({ query: 'Echo Dot', region: 'COM' });
    expect(executeBrightdataSearchToolCallMock).toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.data.provider).toBe('brightdata');
    expect(res.data.domain).toBe('amazon.com');
  });
});

// ---------------------------------------------------------------------------
// executeSearchManufacturerSite
// ---------------------------------------------------------------------------

describe('executeSearchManufacturerSite', () => {
  it('errors without a brand', async () => {
    const res = await executors.executeSearchManufacturerSite({});
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('MISSING_ARGUMENT');
  });

  it('builds a site-scoped query for known brands', async () => {
    executeBrightdataSearchToolCallMock.mockResolvedValueOnce({
      ok: true,
      results: [{ url: 'https://philips.de/x' }],
    });
    const res = await executors.executeSearchManufacturerSite({
      brand: 'Philips',
      model: 'HX6807',
    });
    expect(res.ok).toBe(true);
    expect(res.data.domain).toBe('philips.de');
    expect(res.data.query).toContain('site:philips.de');
    const callArgs = JSON.parse(executeBrightdataSearchToolCallMock.mock.calls[0][0].arguments);
    expect(callArgs.sites).toEqual(['philips.de']);
  });
});

// ---------------------------------------------------------------------------
// executeFetchUrlContent
// ---------------------------------------------------------------------------

describe('executeFetchUrlContent', () => {
  it('rejects missing url', async () => {
    const res = await executors.executeFetchUrlContent({});
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('MISSING_ARGUMENT');
  });

  it('rejects non-http URLs', async () => {
    const res = await executors.executeFetchUrlContent({ url: 'ftp://example.com' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('INVALID_URL');
    expect(executeWebFetchToolCallMock).not.toHaveBeenCalled();
  });

  it('forwards valid url to toolkit and returns fetched text', async () => {
    executeWebFetchToolCallMock.mockResolvedValueOnce({
      success: true,
      url: 'https://example.com',
      body: '<html>ok</html>',
    });
    const res = await executors.executeFetchUrlContent({ url: 'https://example.com' });
    assertResponseShape(res, 'fetch_url_content');
    expect(res.ok).toBe(true);
    expect(res.data.url).toBe('https://example.com');
    expect(res.data.result.body).toContain('<html>ok</html>');
    const callArgs = JSON.parse(executeWebFetchToolCallMock.mock.calls[0][0].arguments);
    expect(callArgs.url).toBe('https://example.com');
  });

  it('returns FETCH_FAILED when toolkit signals failure', async () => {
    executeWebFetchToolCallMock.mockResolvedValueOnce({
      success: false,
      url: 'https://example.com',
      error: 'unreachable',
    });
    const res = await executors.executeFetchUrlContent({ url: 'https://example.com' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('FETCH_FAILED');
  });
});

// ---------------------------------------------------------------------------
// Uniform response shape — exhaustive sweep
// ---------------------------------------------------------------------------

describe('uniform response shape', () => {
  it('every executor returns the canonical shape even for errors', async () => {
    const sweep = [
      [executors.executeLookupGtin, {}, 'lookup_gtin'],
      [executors.executeSearchEbayCatalog, {}, 'search_ebay_catalog'],
      [executors.executeGetRequiredAspects, {}, 'get_required_aspects'],
      [executors.executeVerifyBrand, {}, 'verify_brand'],
      [executors.executeSearchAmazonProduct, {}, 'search_amazon_product'],
      [executors.executeSearchManufacturerSite, {}, 'search_manufacturer_site'],
      [executors.executeFetchUrlContent, {}, 'fetch_url_content'],
    ];
    for (const [fn, args, source] of sweep) {
      // eslint-disable-next-line no-await-in-loop
      const res = await fn(args);
      assertResponseShape(res, source);
    }
  });
});
