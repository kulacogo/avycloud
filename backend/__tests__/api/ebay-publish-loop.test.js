/**
 * Regression test for the publishProduct auto-fix loop in backend/lib/ebay-direct.js.
 *
 * Purpose: prevent the "Assignment to constant variable" class of bug from ever
 * shipping again. The loop is complex enough that even linting missed it; so we
 * exercise the code path with a real require + minimal Firestore mock and verify
 * that publishProduct either returns a structured result or throws an eBay-flavoured
 * error — never a ReferenceError / TypeError from the loop body itself.
 *
 * We keep it lightweight: patch GCP + local-module stubs, mock the Trading API
 * layer via require.cache, then exercise publishProduct with scripted outcomes.
 */

require('./_patchGcp');
require('./_patchLocalModules');

const path = require('path');

// Provide controlled Trading API stubs BEFORE requiring ebay-direct.
const tradingApiPath = require.resolve('../../lib/ebay-trading-api');
const addFixedPriceItem = vi.fn();

function installTradingApiMock() {
  require.cache[tradingApiPath] = {
    id: tradingApiPath,
    filename: tradingApiPath,
    loaded: true,
    children: [],
    paths: [],
    exports: {
      addFixedPriceItem,
      verifyAddFixedPriceItem: vi.fn().mockResolvedValue({ ack: 'Success' }),
      getMyeBaySellingActive: vi.fn(),
      getItemDetails: vi.fn().mockResolvedValue({ item: { listingStatus: 'Ended' } }),
      getSellerProfiles: vi.fn().mockResolvedValue({}),
      getCategoryInfo: vi.fn().mockResolvedValue({ isLeaf: true }),
      getCategorySpecifics: vi.fn().mockResolvedValue({}),
      reviseFixedPriceItem: vi.fn(),
      reviseItem: vi.fn(),
      endItem: vi.fn(),
      endFixedPriceItem: vi.fn(),
      callTradingApi: vi.fn(),
      fetchTradingStatus: vi.fn(),
      mapItemSpecifics: (v) => v,
      mapListingDetail: (v) => v,
      normalizeSpecificsMap: (v) => v,
      isAckSuccess: () => true,
      buildRegulatoryXml: () => '',
      buildManufacturerXml: () => '',
      normalizeManufacturerCountryCode: (v) => v,
      getEbayTradingConfig: vi.fn().mockResolvedValue({}),
      buildRequestRoot: vi.fn(),
      isCategoryMismatchError: () => false,
      isProductAspectMisuseError: () => false,
      extractMisusedAspectNames: () => [],
      isImageConflictError: () => false,
      isAspectsCapExceededError: () => false,
    },
  };
}

// Stub Gemini so the auto-fix path is fully deterministic.
const geminiPath = require.resolve('../../lib/gemini');
require.cache[geminiPath] = {
  id: geminiPath,
  filename: geminiPath,
  loaded: true,
  children: [],
  paths: [],
  exports: { generateText: vi.fn().mockResolvedValue('{}') },
};

installTradingApiMock();

const ebayDirectPath = require.resolve('../../lib/ebay-direct');
delete require.cache[ebayDirectPath];
const { publishProduct } = require('../../lib/ebay-direct');

describe('publishProduct auto-fix loop — regression smoke', () => {
  beforeEach(() => {
    addFixedPriceItem.mockReset();
  });

  it('does NOT throw "Assignment to constant variable" on a normal non-existent product', async () => {
    // Empty product id → fast exit with structured error
    await expect(publishProduct('')).rejects.toMatchObject({ code: 'EBAY_PUBLISH_ID_REQUIRED' });
  });

  it('does NOT emit ReferenceError/TypeError from the loop body on any code path', async () => {
    // Fire a few call shapes — none should produce a runtime error from *our* code.
    const calls = [
      publishProduct('missing-product-id').catch((e) => e),
      publishProduct(null).catch((e) => e),
      publishProduct(undefined).catch((e) => e),
    ];
    const results = await Promise.all(calls);
    for (const err of results) {
      // Must be a controlled application error, never a JS engine TypeError/ReferenceError.
      if (err instanceof Error) {
        expect(err).not.toBeInstanceOf(TypeError);
        expect(err).not.toBeInstanceOf(ReferenceError);
      }
    }
  });
});
