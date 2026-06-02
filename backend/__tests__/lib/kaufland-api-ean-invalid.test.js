/**
 * Regression test for the Kaufland "Parameter [item] is missing or has wrong
 * value" listing failure (incident 2026-06-02).
 *
 * Root cause: products with pseudo-EANs (date-derived fakes, GS1
 * restricted-distribution 2xx in-store codes, unregistered barcodes) cannot
 * bind to a Kaufland catalog item. Kaufland rejects them on the EAN lookup
 * ("Invalid EAN provided") AND on product-data submission ("EAN ... is not
 * valid"), then POST /units fails with the cryptic, unactionable
 * "Parameter [item] is missing or has wrong value".
 *
 * The fix surfaces a clear, actionable KAUFLAND_EAN_INVALID error instead of
 * the cryptic one, via:
 *   1. a structural pre-flight (isValidGtin) that rejects restricted /
 *      malformed EANs before any API call, and
 *   2. capturing Kaufland's own "invalid EAN" responses and short-circuiting
 *      before the doomed POST /units when the EAN was rejected.
 *
 * Zero-regression: a structurally valid, registered GTIN must still pass the
 * pre-flight untouched.
 */

// ─── 1. Stub secret-values so signing works ──────────────────────────────────
const secretValuesPath = require.resolve('../../lib/secret-values');
require.cache[secretValuesPath] = {
  id: secretValuesPath,
  filename: secretValuesPath,
  loaded: true,
  exports: { getSecretValue: vi.fn().mockResolvedValue('test-secret') },
  children: [],
  paths: [],
};

// ─── 2. Stub the product-data repair service (lazy-required inside createUnit) ─
// Return empty attributes so no decideCategory / putProductData network calls
// fire — keeps the response-capture path isolated to the EAN lookup.
const repairPath = require.resolve('../../services/kaufland-product-data-repair');
require.cache[repairPath] = {
  id: repairPath,
  filename: repairPath,
  loaded: true,
  exports: {
    buildKauflandProductDataAttributes: vi.fn().mockResolvedValue({}),
    tryRepairKauflandProductData: vi.fn().mockResolvedValue({ attempted: false }),
  },
  children: [],
  paths: [],
};

// ─── 3. Stub node-fetch with a recording queue ───────────────────────────────
const nodeFetchPath = require.resolve('node-fetch');
const fetchCalls = [];
const responseQueue = [];
const fetchStub = vi.fn(async (url, opts) => {
  fetchCalls.push({ url: String(url), opts });
  if (!responseQueue.length) {
    throw new Error(`fetch stub queue exhausted (url=${url})`);
  }
  return responseQueue.shift();
});
require.cache[nodeFetchPath] = {
  id: nodeFetchPath,
  filename: nodeFetchPath,
  loaded: true,
  exports: fetchStub,
  children: [],
  paths: [],
};

// Force-reload kaufland-api so it picks up the stubs
const kauflandApiPath = require.resolve('../../lib/kaufland-api');
delete require.cache[kauflandApiPath];
const { createUnit, isValidGtin, isEanRejectionError } = require('../../lib/kaufland-api');

function mockErr(status, json) {
  return {
    ok: false,
    status,
    text: async () => JSON.stringify(json),
    headers: { get: () => null },
  };
}

function productWithEan(ean, extra = {}) {
  return {
    id: 'prod-' + ean,
    identification: { sku: 'SKU-' + ean, barcodes: [ean] },
    details: {
      identifiers: { ean, sku: 'SKU-' + ean },
      pricing: { sellPrice: 19.95 },
      ...extra,
    },
    inventory: { quantity: 1 },
  };
}

beforeEach(() => {
  fetchCalls.length = 0;
  responseQueue.length = 0;
});

describe('isValidGtin', () => {
  it('accepts structurally valid registered GTIN-13s (no regression)', () => {
    // Real GTINs that currently list successfully on Kaufland
    expect(isValidGtin('4057309637846')).toBe(true); // Cordhose
    expect(isValidGtin('7613108802860')).toBe(true); // Bikini-Oberteil
    expect(isValidGtin('4260012351552')).toBe(true);
    expect(isValidGtin('8719558505043')).toBe(true);
  });

  it('accepts a valid GTIN-14', () => {
    expect(isValidGtin('04057309637846')).toBe(true); // GTIN-13 zero-padded to 14
  });

  it('rejects GS1 restricted-distribution 2xx EAN-13 in-store codes', () => {
    expect(isValidGtin('2001166900003')).toBe(false);
    expect(isValidGtin('2452014202112')).toBe(false);
  });

  it('rejects wrong length', () => {
    expect(isValidGtin('12345')).toBe(false);
    expect(isValidGtin('442922550988')).toBe(false); // 12-digit UPC
    expect(isValidGtin('')).toBe(false);
  });

  it('rejects a failed mod-10 check digit', () => {
    expect(isValidGtin('4057309637840')).toBe(false); // last digit tampered
  });
});

describe('isEanRejectionError', () => {
  it('matches Kaufland invalid-EAN phrasings', () => {
    expect(isEanRejectionError('Invalid EAN provided')).toBe(true);
    expect(isEanRejectionError('EAN "1532759310516" is not valid')).toBe(true);
  });
  it('does not match unrelated errors', () => {
    expect(isEanRejectionError('Parameter [item] is missing or has wrong value')).toBe(false);
    expect(isEanRejectionError('rate limited')).toBe(false);
  });
});

describe('createUnit EAN rejection', () => {
  it('rejects a restricted 2xx EAN in pre-flight WITHOUT any API call', async () => {
    await expect(createUnit(productWithEan('2001166900003'), { storefront: 'de' }))
      .rejects.toMatchObject({ code: 'KAUFLAND_EAN_INVALID' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('surfaces KAUFLAND_EAN_INVALID (not the cryptic [item] error) when Kaufland rejects the EAN on lookup', async () => {
    // EAN is structurally valid (passes pre-flight) but unregistered →
    // Kaufland's /products/ean lookup returns "Invalid EAN provided".
    responseQueue.push(mockErr(400, { message: 'Invalid EAN provided' }));

    let thrown = null;
    try {
      await createUnit(productWithEan('1532759310516'), { storefront: 'de' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeTruthy();
    expect(thrown.code).toBe('KAUFLAND_EAN_INVALID');
    expect(thrown.message).not.toMatch(/\[item\]/);
    // POST /units must never be attempted — only the lookup fetch happened.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('/products/ean/');
    expect(fetchCalls.some((c) => c.opts?.method === 'POST' && c.url.includes('/units'))).toBe(false);
  });
});
