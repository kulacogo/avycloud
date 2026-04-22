'use strict';

// Tests for backend/lib/identify-workers/identity-worker.js
//
// Patches services/atomic-tools via require.cache so we can control every
// executor return value. The worker's Gemini path is exercised via dependency
// injection (context.aiClient) with a stub chat object.

const atomicToolsPath = require.resolve('../../../services/atomic-tools');
// Load the real module once so that require.cache has an entry to overwrite.
const realAtomic = require(atomicToolsPath);

const executeLookupGtinMock = vi.fn(async () => ({
  ok: false,
  source: 'lookup_gtin',
  data: null,
  confidence: 0,
  meta: { durationMs: 1 },
}));
const executeVerifyBrandMock = vi.fn(async () => ({
  ok: false,
  source: 'verify_brand',
  data: null,
  confidence: 0,
  meta: { durationMs: 1 },
}));
const executeSearchAmazonProductMock = vi.fn(async () => ({
  ok: false,
  source: 'search_amazon_product',
  data: null,
  confidence: 0,
  meta: { durationMs: 1 },
}));

function buildExecutorMapMock() {
  return {
    lookup_gtin: executeLookupGtinMock,
    verify_brand: executeVerifyBrandMock,
    search_amazon_product: executeSearchAmazonProductMock,
    search_ebay_catalog: vi.fn(),
    get_required_aspects: vi.fn(),
    search_manufacturer_site: vi.fn(),
    fetch_url_content: vi.fn(),
    search_ebay_sold: vi.fn(),
    search_idealo: vi.fn(),
  };
}

require.cache[atomicToolsPath] = {
  id: atomicToolsPath,
  filename: atomicToolsPath,
  loaded: true,
  exports: {
    ...realAtomic,
    buildToolExecutorMap: () => buildExecutorMapMock(),
    executors: {
      ...realAtomic.executors,
      executeLookupGtin: executeLookupGtinMock,
      executeVerifyBrand: executeVerifyBrandMock,
      executeSearchAmazonProduct: executeSearchAmazonProductMock,
    },
  },
};

const { runIdentityWorker, DOMAIN, _testables } = require('../../../lib/identify-workers/identity-worker');

beforeEach(() => {
  vi.clearAllMocks();
  executeLookupGtinMock.mockReset();
  executeVerifyBrandMock.mockReset();
  executeSearchAmazonProductMock.mockReset();
  // Default: all silent.
  executeLookupGtinMock.mockResolvedValue({
    ok: false, source: 'lookup_gtin', data: null, confidence: 0, meta: { durationMs: 1 },
  });
  executeVerifyBrandMock.mockResolvedValue({
    ok: false, source: 'verify_brand', data: null, confidence: 0, meta: { durationMs: 1 },
  });
  executeSearchAmazonProductMock.mockResolvedValue({
    ok: false, source: 'search_amazon_product', data: null, confidence: 0, meta: { durationMs: 1 },
  });
});

// A verified-valid EAN-13 (Sony WH-1000XM5). Checksum-legitimate.
const SONY_EAN = '4548736132610';
const COCA_COLA_EAN = '5449000000996';

describe('identity-worker helpers', () => {
  it('extractCandidatesFromBarcodes handles string and array inputs', () => {
    expect(_testables.extractCandidatesFromBarcodes('1234,5678 9999')).toEqual(['1234', '5678', '9999']);
    expect(_testables.extractCandidatesFromBarcodes(['abc', { value: 'def' }, { code: 'ghi' }]))
      .toEqual(['abc', 'def', 'ghi']);
    expect(_testables.extractCandidatesFromBarcodes(null)).toEqual([]);
  });

  it('extractCandidatesFromText finds digit runs of length 8-14', () => {
    const text = 'Label shows EAN 4548736132610 and SKU 12345';
    const matches = _testables.extractCandidatesFromText(text);
    expect(matches).toContain('4548736132610');
    // SKU 12345 is only 5 digits — should NOT match the 8-14 digit regex.
    expect(matches).not.toContain('12345');
  });

  it('collectValidGtins filters out invalid checksums', () => {
    const ctx = {
      barcodes: `${SONY_EAN},9999999999999`,
      ocrPayload: { text: 'bad 1111111111116 good' },
    };
    const valid = _testables.collectValidGtins(ctx);
    expect(valid).toContain(SONY_EAN);
    expect(valid).not.toContain('9999999999999');
  });

  it('pickPrimaryGtin prefers EAN-13 over shorter codes', () => {
    const picked = _testables.pickPrimaryGtin(['40170725', SONY_EAN]); // EAN-8 + EAN-13
    expect(picked).toBe(SONY_EAN);
  });

  it('stripCorporateSuffix removes common legal forms', () => {
    expect(_testables.stripCorporateSuffix('Sony Europe GmbH')).toBe('Sony Europe');
    expect(_testables.stripCorporateSuffix('Acme Inc.')).toBe('Acme');
  });
});

describe('runIdentityWorker — GTIN path', () => {
  it('returns ok:true with valid GTIN from context.barcodes', async () => {
    executeLookupGtinMock.mockResolvedValueOnce({
      ok: true,
      source: 'lookup_gtin',
      data: {
        sources: [
          {
            data: { brand: 'Sony', productName: 'WH-1000XM5', mpn: 'WH1000XM5B' },
            confidence: 0.7,
          },
        ],
        summary: 'Sony WH-1000XM5',
      },
      confidence: 0.7,
      meta: { durationMs: 10 },
    });
    executeVerifyBrandMock.mockResolvedValueOnce({
      ok: true,
      source: 'verify_brand',
      data: { brand: 'Sony', resolved: true, via: 'gpsr_registry' },
      confidence: 0.8,
      meta: { durationMs: 5 },
    });

    const res = await runIdentityWorker({
      barcodes: SONY_EAN,
      identity: { brand: 'Sony', model: 'WH-1000XM5' },
    });

    expect(res.ok).toBe(true);
    expect(res.domain).toBe('identity');
    expect(res.resolved.gtin).toBe(SONY_EAN);
    expect(res.resolved.brand).toMatch(/sony/i);
    expect(executeLookupGtinMock).toHaveBeenCalledWith(
      expect.objectContaining({ gtin: SONY_EAN })
    );
  });

  it('rejects invalid GTIN and falls back to Gemini when aiClient is provided', async () => {
    // Simulate a Gemini client that calls finalize_identity immediately.
    const sendMessageMock = vi.fn(async () => ({
      functionCalls: [
        {
          id: 'f1',
          name: 'finalize_identity',
          args: {
            gtin: COCA_COLA_EAN,
            brand: 'Coca-Cola GmbH',
            mpn: 'CC-CLASSIC',
            confidence: 0.6,
            rationale: 'derived from brand+model hints',
          },
        },
      ],
      usageMetadata: { totalTokenCount: 1234 },
    }));
    const aiClient = {
      chats: {
        create: vi.fn(() => ({ sendMessage: sendMessageMock })),
      },
    };

    const res = await runIdentityWorker({
      barcodes: '9999999999998', // bad checksum
      ocrPayload: { text: 'random text no digits' },
      identity: { brand: 'Coca-Cola', model: 'Classic' },
      aiClient,
    });

    expect(res.domain).toBe('identity');
    expect(res.meta.geminiCalls).toBeGreaterThan(0);
    expect(res.resolved.brand).toBe('Coca-Cola');
    expect(res.resolved.gtin).toBe(COCA_COLA_EAN);
    // Lookup should NOT have been called with the invalid GTIN.
    expect(executeLookupGtinMock).not.toHaveBeenCalled();
  });

  it('cross-references 2+ sources → confidence >0.8 on GTIN when checksum valid', async () => {
    executeLookupGtinMock.mockResolvedValueOnce({
      ok: true,
      source: 'lookup_gtin',
      data: {
        sources: [
          { data: { brand: 'Sony', gtin: SONY_EAN }, confidence: 0.7 },
        ],
      },
      confidence: 0.7,
      meta: { durationMs: 3 },
    });
    executeSearchAmazonProductMock.mockResolvedValueOnce({
      ok: true,
      source: 'search_amazon_product',
      data: {
        region: 'DE',
        provider: 'serpapi',
        query: SONY_EAN,
        url: 'https://amazon.de/dp/B09XS7JWHH',
        result: { url: 'https://amazon.de/dp/B09XS7JWHH', summary: ['hit'] },
      },
      confidence: 0.75,
      meta: { durationMs: 8 },
    });
    executeVerifyBrandMock.mockResolvedValueOnce({
      ok: true,
      source: 'verify_brand',
      data: { brand: 'Sony', resolved: true },
      confidence: 0.85,
      meta: { durationMs: 5 },
    });

    const res = await runIdentityWorker({
      barcodes: SONY_EAN,
      identity: { brand: 'Sony' },
    });

    expect(res.ok).toBe(true);
    expect(res.confidence.gtin).toBeGreaterThan(0.8);
    // Brand should also be boosted by multiple sources.
    expect(res.confidence.brand).toBeGreaterThan(0.7);
  });

  it('single source → lower confidence (<0.9 for brand)', async () => {
    executeLookupGtinMock.mockResolvedValueOnce({
      ok: true,
      source: 'lookup_gtin',
      data: {
        sources: [
          { data: { brand: 'NicheBrand' }, confidence: 0.5 },
        ],
      },
      confidence: 0.5,
      meta: { durationMs: 2 },
    });
    executeVerifyBrandMock.mockResolvedValueOnce({
      ok: false,
      source: 'verify_brand',
      data: null,
      confidence: 0,
      meta: { durationMs: 1 },
    });

    const res = await runIdentityWorker({
      barcodes: SONY_EAN,
      identity: { brand: 'NicheBrand' },
    });

    expect(res.ok).toBe(true);
    expect(res.confidence.brand).toBeLessThan(0.9);
  });

  it('handles missing atomic-tools executors gracefully without throwing', async () => {
    // Temporarily swap the executor map to an empty object by re-patching.
    const original = require.cache[atomicToolsPath].exports;
    require.cache[atomicToolsPath].exports = {
      ...original,
      buildToolExecutorMap: () => ({}),
    };
    try {
      const res = await runIdentityWorker({
        barcodes: SONY_EAN,
        identity: { brand: 'Sony' },
      });
      expect(res.domain).toBe('identity');
      // The worker did not crash; tools all return EXECUTOR_MISSING.
      expect(res.meta.toolsCalled.length).toBeGreaterThan(0);
      expect(res.meta.toolsCalled.every((t) => t.ok === false)).toBe(true);
    } finally {
      require.cache[atomicToolsPath].exports = original;
    }
  });

  it('handles missing aiClient (no Gemini call path)', async () => {
    // No GTIN and no aiClient → no Gemini call attempted.
    const res = await runIdentityWorker({
      barcodes: '0000', // not a GTIN length
      identity: { brand: 'Philips' },
      // NO aiClient injected.
    });
    expect(res.domain).toBe('identity');
    expect(res.meta.geminiCalls).toBe(0);
    // Brand from context.identity is preserved.
    expect(res.resolved.brand).toBe('Philips');
  });

  it('preserves context.identity.brand when atomic tools are silent', async () => {
    // All executors return ok:false by default; with a valid GTIN the
    // worker still runs the brand preservation logic.
    const res = await runIdentityWorker({
      barcodes: SONY_EAN,
      identity: { brand: 'Sony Corporation GmbH' },
    });
    expect(res.ok).toBe(true);
    // Brand must be stripped of the legal suffix and preserved.
    expect(res.resolved.brand).toBe('Sony Corporation');
    // And there should be a confidence number for it.
    expect(typeof res.confidence.brand).toBe('number');
    expect(res.confidence.brand).toBeGreaterThan(0);
  });

  it('always returns domain: "identity"', async () => {
    const res1 = await runIdentityWorker({});
    expect(res1.domain).toBe('identity');

    const res2 = await runIdentityWorker({ barcodes: SONY_EAN });
    expect(res2.domain).toBe('identity');

    // Also when the code path throws internally (simulate by passing a
    // poisoned barcodes value that the regex can't handle).
    const res3 = await runIdentityWorker({ barcodes: { bogus: true } });
    expect(res3.domain).toBe('identity');
  });

  it('returns DOMAIN constant === "identity"', () => {
    expect(DOMAIN).toBe('identity');
  });
});
