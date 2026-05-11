'use strict';

/**
 * Tenant-threading tests for product-chat-v2.
 *
 * Verifies that the new `tenantId` option on runProductChatV2 is forwarded
 * verbatim to resolveScopeConfig() (which is responsible for selecting per-
 * tenant scope overrides). Default (omitted) must remain `null` for
 * backwards-compat with the previous signature.
 *
 * Uses require.cache patching (CJS) — vi.mock() does not intercept local
 * CommonJS requires reliably in Vitest 4.x. Same pattern as
 * caller-config-snapshots-f1b3.test.js.
 */

// ─── Patch lib/llm-config ───────────────────────────────────────────────────
const llmConfigPath = require.resolve('../../lib/llm-config');
const realLlmConfig = require(llmConfigPath);
const resolveScopeConfigMock = vi.fn();
const getActiveLlmConfigMock = vi.fn(async () => null);
require.cache[llmConfigPath] = {
  id: llmConfigPath,
  filename: llmConfigPath,
  loaded: true,
  exports: {
    ...realLlmConfig,
    resolveScopeConfig: resolveScopeConfigMock,
    getActiveLlmConfig: getActiveLlmConfigMock,
  },
};

// ─── Silence the optional logger ────────────────────────────────────────────
try {
  const loggerPath = require.resolve('../../lib/logger');
  try { require(loggerPath); } catch (_) {}
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
} catch (_) { /* logger optional */ }

// ─── Fake Gemini client (captures chats.create + short-circuits sendMessage) ─
const captured = [];
function buildFakeClient() {
  const sendMessage = vi.fn(async () => ({
    text: 'done',
    functionCalls: [],
    candidates: [{ groundingMetadata: null, urlContextMetadata: null }],
  }));
  return {
    chats: {
      create: vi.fn(({ model, config, history }) => {
        captured.push({ model, config, history });
        return { sendMessage };
      }),
    },
  };
}
const fakeClient = buildFakeClient();

// ─── Patch gemini3-client so product-chat-v2 picks up the fake ─────────────
const gemini3Path = require.resolve('../../lib/gemini3-client');
try { require(gemini3Path); } catch (_) {}
require.cache[gemini3Path] = {
  id: gemini3Path,
  filename: gemini3Path,
  loaded: true,
  exports: {
    getGenAIClient: vi.fn(async () => fakeClient),
    generateProductContent: vi.fn(),
    gemini3GenerateJSON: vi.fn(),
    buildImprovePromptExtension: vi.fn(() => ''),
    identifyProductWithGrounding: vi.fn(),
    identifyProductFocused: vi.fn(),
    FULL_PRODUCT_SCHEMA: {},
    RECOGNITION_SCHEMA: {},
    CONTENT_SCHEMA: {},
    DEFAULT_MODEL: 'gemini-3-pro-preview',
  },
};

// ─── Stub side-effect-heavy dependencies (enrichment, ktype, browse, image) ─
function _patch(rel, exp) {
  try {
    const p = require.resolve(rel);
    try { require(p); } catch (_) {}
    require.cache[p] = { id: p, filename: p, loaded: true, exports: exp };
  } catch (_) { /* tolerate */ }
}
_patch('../../services/image-generation', { generateImagesForProduct: vi.fn() });
_patch('../../lib/image-search', { searchProductImages: vi.fn() });
_patch('../../services/enrichment', { applyEbayTaxonomy: vi.fn() });
_patch('../../lib/ktype-enrichment', { enrichKTypIfPossible: vi.fn(async () => {}) });
_patch('../../lib/ebay-browse-title-insights', {
  fetchCategoryTitleInsights: vi.fn(async () => ({ sampleTitles: [] })),
  fetchBrowsePriceSamples: vi.fn(async () => ({})),
});

const productChatV2 = require('../../services/product-chat-v2');

describe('product-chat-v2 tenantId threading', () => {
  beforeEach(() => {
    captured.length = 0;
    resolveScopeConfigMock.mockReset();
  });

  it('passes the supplied tenantId through to resolveScopeConfig', async () => {
    resolveScopeConfigMock.mockRejectedValue(new Error('no scope'));
    await productChatV2.runProductChatV2(
      { id: 'p1', details: { title: 'X', images: [] } },
      'hallo',
      { history: [], tenantId: 'tenant-xyz' },
    );
    expect(resolveScopeConfigMock).toHaveBeenCalledTimes(1);
    expect(resolveScopeConfigMock.mock.calls[0][0]).toBe('chat.product');
    expect(resolveScopeConfigMock.mock.calls[0][1]).toBe('tenant-xyz');
  });

  it('defaults tenantId to null when the option is absent (backwards-compat)', async () => {
    resolveScopeConfigMock.mockRejectedValue(new Error('no scope'));
    await productChatV2.runProductChatV2(
      { id: 'p2', details: { title: 'X', images: [] } },
      'hallo',
      { history: [] },
    );
    expect(resolveScopeConfigMock).toHaveBeenCalledTimes(1);
    expect(resolveScopeConfigMock.mock.calls[0][0]).toBe('chat.product');
    expect(resolveScopeConfigMock.mock.calls[0][1]).toBeNull();
  });
});
