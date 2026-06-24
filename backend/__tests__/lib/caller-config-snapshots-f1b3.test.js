'use strict';

/**
 * F.1b.3 — Caller-config snapshots for V3 + Chat pipelines.
 *
 * Verifies that each migrated caller:
 *  - invokes lib/llm-config.resolveScopeConfig with the correct scope name
 *    (and tenantId when threaded through),
 *  - falls back gracefully to the byte-identical hardcoded defaults when
 *    resolveScopeConfig throws (scope absent / Firestore unreachable),
 *  - merges scopeConfig.generationConfig into the final config so a deployed
 *    scope can override individual knobs without code changes.
 *
 * These snapshots lock the legacy generationConfig for production callers so
 * we cannot accidentally drift while wiring up F.2 scope content.
 */

// ─── Patch lib/llm-config (CJS via require.cache) ───────────────────────────
const llmConfigPath = require.resolve('../../lib/llm-config');
const realLlmConfig = require(llmConfigPath);
const resolveScopeConfigMock = vi.fn();
// Also stub getActiveLlmConfig so callers that touch Firestore in their
// preamble (e.g. product-chat-v2.js → getActiveLlmConfig('chat.product'))
// do not blow up the test runtime.
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

// ─── Patch lib/logger (so the .warn() fallback path is silent) ──────────────
let loggerPath;
try {
  loggerPath = require.resolve('../../lib/logger');
  require(loggerPath);
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
} catch (_) { /* logger optional in some test environments */ }

beforeEach(() => {
  vi.clearAllMocks();
  resolveScopeConfigMock.mockReset();
});

// ─── A) lib/identify-v3-stage3.js — runAspectRepair ─────────────────────────
describe('F.1b.3 snapshot: identify-v3-stage3 (aspect repair)', () => {
  // gemini3-client mock — captures the opts arg to gemini3GenerateJSON.
  const gemini3GenerateJSONMock = vi.fn();
  const geminiPath = require.resolve('../../lib/gemini3-client');
  require(geminiPath);
  require.cache[geminiPath] = {
    id: geminiPath,
    filename: geminiPath,
    loaded: true,
    exports: {
      generateProductContent: vi.fn(async () => ({
        title_ebay: 'X', title_kaufland: 'X',
        description_ebay: '<p>x</p>', description_kaufland: '<p>x</p>',
        key_features: ['A'], item_specifics: [], mobile_snippet: 'x',
      })),
      gemini3GenerateJSON: gemini3GenerateJSONMock,
      buildImprovePromptExtension: vi.fn(() => ''),
      getGenAIClient: vi.fn(),
      identifyProductWithGrounding: vi.fn(),
      identifyProductFocused: vi.fn(),
      FULL_PRODUCT_SCHEMA: {}, RECOGNITION_SCHEMA: {}, CONTENT_SCHEMA: {},
      DEFAULT_MODEL: 'gemini-3-pro-preview',
    },
  };

  // Stub the agentic module so we stay on the single-shot path.
  const agenticPath = require.resolve('../../lib/identify-v3-stage3-agentic');
  require.cache[agenticPath] = {
    id: agenticPath,
    filename: agenticPath,
    loaded: true,
    exports: {
      generateProductContentAgentic: vi.fn(),
      isAgenticEnabled: vi.fn(() => false),
      _internal: {},
    },
  };

  // Stub policy/sanitizer modules.
  const sanitizePath = require.resolve('../../lib/listing-sanitize');
  require(sanitizePath);
  require.cache[sanitizePath] = {
    id: sanitizePath, filename: sanitizePath, loaded: true,
    exports: {
      sanitizeDescriptionToHtml: vi.fn((html) => html),
      sanitizeDescriptionProse: vi.fn((html) => html),
      PRICE_SENTENCE_RE: /preis/i,
    },
  };

  const _stage3 = require('../../lib/identify-v3-stage3');

  // Driver — call internal runAspectRepair via the public path (with > 30 % unknown).
  async function _triggerRepair() {
    // Simulate Stage 3 yielding mostly "Unbekannt" item-specifics → repair kicks in.
    _stage3 && _stage3.runStage3ContentGeneration; // ensure module init
    // Direct internal access via require.cache (simpler than driving the whole stage).
    const mod = require(require.resolve('../../lib/identify-v3-stage3'));
    if (typeof mod.runAspectRepair === 'function') return mod;
    return mod;
  }

  it('passes scopeConfig=null (fallback) and keeps temperature=0.1 maxOutputTokens=1024', async () => {
    resolveScopeConfigMock.mockRejectedValueOnce(new Error('no scope'));
    gemini3GenerateJSONMock.mockResolvedValueOnce({ repaired: {}, confidence: {} });

    // Run full stage so the aspect-repair path triggers.
    const STAGE3_AGENTIC = process.env.STAGE3_AGENTIC;
    process.env.STAGE3_AGENTIC = 'false';
    const stage1 = {
      identity: { brand: 'Sony', model: 'X', mpn: '', variant: '', color: '', size: '', material: '', condition: '' },
      barcodes: { ean: '', gtin: '', upc: '' },
      imageParts: [],
    };
    const stage2 = {
      category: { ebayId: '1', ebayBreadcrumb: 'A > B' },
      requiredAspects: [
        { name: 'Marke', localizedName: 'Marke', values: [] },
        { name: 'Modell', localizedName: 'Modell', values: [] },
        { name: 'Farbe', localizedName: 'Farbe', values: [] },
        { name: 'Material', localizedName: 'Material', values: [] },
      ],
      aspectCatalog: null,
      pricing: { amount: 0, currency: 'EUR' },
      gpsr: { found: false },
      titleInsights: {},
    };

    // Generator returns "Unbekannt" for every required aspect → > 30 % triggers repair.
    require.cache[geminiPath].exports.generateProductContent = vi.fn(async () => ({
      title_ebay: 'X', title_kaufland: 'X',
      description_ebay: '<p>x</p>', description_kaufland: '<p>x</p>',
      key_features: ['A'],
      item_specifics: [
        { key: 'Marke', value: 'Unbekannt' },
        { key: 'Modell', value: 'Unbekannt' },
        { key: 'Farbe', value: 'Unbekannt' },
        { key: 'Material', value: 'Unbekannt' },
      ],
      mobile_snippet: 'x',
    }));

    const { runStage3ContentGeneration } = require('../../lib/identify-v3-stage3');
    await runStage3ContentGeneration(stage1, stage2);
    process.env.STAGE3_AGENTIC = STAGE3_AGENTIC;

    // Scope was queried.
    expect(resolveScopeConfigMock).toHaveBeenCalled();
    expect(resolveScopeConfigMock.mock.calls[0][0]).toBe('identify.v2');

    // Generation config snapshot.
    expect(gemini3GenerateJSONMock).toHaveBeenCalled();
    const opts = gemini3GenerateJSONMock.mock.calls[0][0];
    expect(opts.temperature).toBe(0.1);
    expect(opts.maxOutputTokens).toBe(1024);
    expect(opts.scopeConfig).toBeNull();
  });
});

// ─── B) services/product-chat-v3.js ─────────────────────────────────────────
describe('F.1b.3 snapshot: product-chat-v3 (chats.create config)', () => {
  // Stub atomic-tools (no real Gemini side-effects).
  const atomicToolsPath = require.resolve('../../services/atomic-tools');
  const realAtomic = require(atomicToolsPath);
  require.cache[atomicToolsPath] = {
    id: atomicToolsPath,
    filename: atomicToolsPath,
    loaded: true,
    exports: {
      ...realAtomic,
      buildToolList: () => [],
      buildToolExecutorMap: () => ({}),
    },
  };

  const { runProductChatV3 } = require('../../services/product-chat-v3');

  function buildFakeClient(captured) {
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

  it('forwards default temperature=1 maxOutputTokens=12000 when scope is absent', async () => {
    resolveScopeConfigMock.mockRejectedValueOnce(new Error('no scope'));
    const captured = [];
    const aiClient = buildFakeClient(captured);
    await runProductChatV3({
      product: { id: 'p1', details: { title: 'X' } },
      message: 'hi',
      aiClient,
    });
    expect(resolveScopeConfigMock).toHaveBeenCalledWith('chat.product', null, expect.objectContaining({
      temperature: 1,
      maxOutputTokens: 12000,
    }));
    expect(captured.length).toBe(1);
    const { config } = captured[0];
    expect(config.temperature).toBe(1);
    expect(config.maxOutputTokens).toBe(12000);
    expect(config.thinkingConfig).toBeDefined();
    expect(config.toolConfig.functionCallingConfig.mode).toBe('AUTO');
  });

  it('merges scopeConfig.generationConfig into the chats.create config', async () => {
    resolveScopeConfigMock.mockResolvedValueOnce({
      scopeId: 'chat.product',
      versionId: 'v-test',
      generationConfig: { temperature: 0.42, maxOutputTokens: 7777 },
      model: '',
    });
    const captured = [];
    const aiClient = buildFakeClient(captured);
    await runProductChatV3({
      product: { id: 'p1', details: { title: 'X' } },
      message: 'hi',
      aiClient,
      tenantId: 't1',
    });
    expect(resolveScopeConfigMock.mock.calls[0][1]).toBe('t1');
    const { config } = captured[0];
    expect(config.temperature).toBe(0.42);
    expect(config.maxOutputTokens).toBe(7777);
  });
});

// ─── C) services/product-chat-v2.js — behaviour assertion ──────────────────
describe('F.1b.3 snapshot: product-chat-v2 (chats.create config)', () => {
  // Capture chats.create args via the gemini3-client stub. product-chat-v2 has
  // no aiClient-DI param, so we shim getGenAIClient() to hand back our fake.
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

  // Pre-load + patch the modules product-chat-v2 needs at require-time.
  // Order matters: each patch must be installed BEFORE product-chat-v2 is
  // first `require()`d so the require.cache wins.
  const gemini3Path = require.resolve('../../lib/gemini3-client');
  try { require(gemini3Path); } catch (_) {}
  require.cache[gemini3Path] = {
    id: gemini3Path, filename: gemini3Path, loaded: true,
    exports: {
      getGenAIClient: vi.fn(async () => fakeClient),
      generateProductContent: vi.fn(),
      gemini3GenerateJSON: vi.fn(),
      buildImprovePromptExtension: vi.fn(() => ''),
      identifyProductWithGrounding: vi.fn(),
      identifyProductFocused: vi.fn(),
      FULL_PRODUCT_SCHEMA: {}, RECOGNITION_SCHEMA: {}, CONTENT_SCHEMA: {},
      DEFAULT_MODEL: 'gemini-3-pro-preview',
    },
  };

  // Stub side-effect-heavy dependencies (enrichment + ktype + browse insights +
  // image fetch). All return harmless empty data so runProductChatV2 stays on
  // the deterministic happy-path through chats.create.
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

  // Now load product-chat-v2 with all stubs in place.
  const productChatV2 = require('../../services/product-chat-v2');

  beforeEach(() => {
    captured.length = 0;
  });

  it('exports runProductChatV2 as an async function (sanity)', () => {
    expect(typeof productChatV2.runProductChatV2).toBe('function');
    expect(productChatV2.runProductChatV2.constructor.name).toBe('AsyncFunction');
  });

  it('forwards legacy temperature=1.0 maxOutputTokens=8192 when scope is absent and enhanced=true', async () => {
    // Force CHAT_V2_ENHANCED=true (legacy enhanced path → temperature=1.0, maxOutputTokens=8192).
    const prev = process.env.CHAT_V2_ENHANCED;
    process.env.CHAT_V2_ENHANCED = 'true';
    resolveScopeConfigMock.mockRejectedValue(new Error('no scope'));
    try {
      await productChatV2.runProductChatV2(
        { id: 'p1', details: { title: 'X', images: [] } },
        'hallo',
        { history: [] },
      );
    } finally {
      if (prev === undefined) delete process.env.CHAT_V2_ENHANCED;
      else process.env.CHAT_V2_ENHANCED = prev;
    }

    // Strong assertion: resolveScopeConfig was actually called with the
    // production scope-id + the legacy hardcoded callerOverrides. If anyone
    // deletes _tryResolveScopeConfigChatV2 or rewires the scope-name, this
    // assertion FAILS — unlike the old smoke check.
    expect(resolveScopeConfigMock).toHaveBeenCalledTimes(1);
    expect(resolveScopeConfigMock.mock.calls[0][0]).toBe('chat.product');
    expect(resolveScopeConfigMock.mock.calls[0][1]).toBeNull();
    expect(resolveScopeConfigMock.mock.calls[0][2]).toMatchObject({
      temperature: 1.0,
      maxOutputTokens: 8192,
    });
    // thinkingConfig is part of the enhanced overrides; assert its shape.
    expect(resolveScopeConfigMock.mock.calls[0][2].thinkingConfig).toMatchObject({
      thinkingLevel: 'high',
      includeThoughts: true,
    });

    // Behaviour: the resolved scopeConfig (null here) does not override, so
    // the final chats.create config carries the legacy knobs verbatim.
    expect(captured.length).toBe(1);
    const { config } = captured[0];
    expect(config.temperature).toBe(1.0);
    expect(config.maxOutputTokens).toBe(8192);
    expect(config.thinkingConfig).toMatchObject({ thinkingLevel: 'high', includeThoughts: true });
    // Tool wiring: googleSearch + urlContext + functionDeclarations.
    expect(Array.isArray(config.tools)).toBe(true);
    expect(config.tools.some((t) => t && t.googleSearch !== undefined)).toBe(true);
    expect(config.tools.some((t) => t && t.urlContext !== undefined)).toBe(true);
    expect(config.tools.some((t) => Array.isArray(t?.functionDeclarations))).toBe(true);
  });

  it('merges scopeConfig.generationConfig into the chats.create config', async () => {
    resolveScopeConfigMock.mockResolvedValueOnce({
      scopeId: 'chat.product',
      versionId: 'v-test',
      generationConfig: { temperature: 0.21, maxOutputTokens: 5555 },
      model: '',
    });
    await productChatV2.runProductChatV2(
      { id: 'p2', details: { title: 'X', images: [] } },
      'hallo',
      { history: [] },
    );
    expect(captured.length).toBe(1);
    const { config } = captured[0];
    // Scope override wins over the legacy hardcoded knobs.
    expect(config.temperature).toBe(0.21);
    expect(config.maxOutputTokens).toBe(5555);
  });
});

// ─── D) services/product-chat.js (legacy — detectIntent) ────────────────────
describe('F.1b.3 snapshot: product-chat.js legacy detectIntent', () => {
  it('attempts resolveScopeConfig with scope chat.product and falls back on error', async () => {
    resolveScopeConfigMock.mockRejectedValue(new Error('no scope'));

    // Stub the old SDK gemini-client used by detectIntent.
    const gcPath = require.resolve('../../lib/gemini-client');
    try { require(gcPath); } catch (_) {}
    const generateContentMock = vi.fn(async () => ({
      response: { text: () => 'change' },
    }));
    const getGenerativeModelMock = vi.fn(() => ({ generateContent: generateContentMock }));
    require.cache[gcPath] = {
      id: gcPath,
      filename: gcPath,
      loaded: true,
      exports: {
        getGeminiClient: () => ({ getGenerativeModel: getGenerativeModelMock }),
        getGeminiApiKey: vi.fn(async () => 'k'),
      },
    };

    // Reload the module fresh so the patched gemini-client is used.
    delete require.cache[require.resolve('../../services/product-chat')];
    const productChat = require('../../services/product-chat');
    const detectIntent = (productChat._testables && productChat._testables.detectIntent) || productChat.detectIntent;
    expect(typeof detectIntent).toBe('function');
    const out = await detectIntent('Bitte korrigiere den Titel');
    expect(['change', 'info', 'analysis']).toContain(out);
    expect(resolveScopeConfigMock).toHaveBeenCalledWith('chat.product', null, expect.objectContaining({
      temperature: 0,
      maxOutputTokens: 10,
    }));
    // getGenerativeModel called with temperature=0/maxOutputTokens=10 fallback.
    const args = getGenerativeModelMock.mock.calls[0][0];
    expect(args.generationConfig.temperature).toBe(0);
    expect(args.generationConfig.maxOutputTokens).toBe(10);
  });
});

// ─── E) lib/identify-v3-stage3-agentic.js — chats.create config ─────────────
describe('F.1b.3 snapshot: identify-v3-stage3-agentic (chats.create config)', () => {
  // The stage3 describe block above stubbed `identify-v3-stage3-agentic` in
  // require.cache with a no-op module. Drop that cache entry so this describe
  // sees the REAL agentic module.
  delete require.cache[require.resolve('../../lib/identify-v3-stage3-agentic')];

  // Stub @google/genai before the agentic module dynamically imports it.
  try {
    const genaiPath = require.resolve('@google/genai');
    require(genaiPath);
    require.cache[genaiPath] = {
      id: genaiPath,
      filename: genaiPath,
      loaded: true,
      exports: {
        GoogleGenAI: function () { return {}; },
        FunctionCallingConfigMode: { AUTO: 'AUTO', ANY: 'ANY', NONE: 'NONE' },
      },
    };
  } catch (_) { /* tolerate when SDK is not available in tests */ }

  // Stub atomic-tools.
  const atomicToolsPath = require.resolve('../../services/atomic-tools');
  const realAtomic = require(atomicToolsPath);
  require.cache[atomicToolsPath] = {
    id: atomicToolsPath,
    filename: atomicToolsPath,
    loaded: true,
    exports: {
      ...realAtomic,
      buildToolList: () => [],
      buildToolExecutorMap: () => ({}),
    },
  };

  const { generateProductContentAgentic } = require('../../lib/identify-v3-stage3-agentic');

  function buildFakeClient(captured) {
    const sendMessage = vi.fn(async () => ({
      text: 'done',
      functionCalls: [
        { id: 'f1', name: 'write_product_datasheet', args: { title_ebay: 'x', title_kaufland: 'x', description_ebay: '<p>x</p>', item_specifics: [{ key: 'Marke', value: 'X' }] } },
      ],
    }));
    return {
      chats: {
        create: vi.fn(({ model, config }) => {
          captured.push({ model, config });
          return { sendMessage };
        }),
      },
    };
  }

  it('uses hardcoded temperature/maxOutputTokens defaults when scope is absent', async () => {
    resolveScopeConfigMock.mockRejectedValue(new Error('no scope'));
    const captured = [];
    const aiClient = buildFakeClient(captured);

    // No try/catch — the stub-graph above is sufficient for the agentic
    // pipeline to reach chats.create AND complete (the fake sendMessage
    // returns a write_product_datasheet function-call in the first turn,
    // which triggers the `state.finalArgs ⇒ break` exit). If anything in
    // the migration hook regresses, this assertion FAILS hard.
    const result = await generateProductContentAgentic({
      identity: { brand: 'Sony', model: 'X' },
      enrichment: {},
      aiClient,
    });

    // Scope-config lookup happened first — both attempts (specific then fallback).
    expect(resolveScopeConfigMock).toHaveBeenCalled();
    expect(resolveScopeConfigMock.mock.calls[0][0]).toBe('identify.v2-agentic');
    expect(resolveScopeConfigMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(resolveScopeConfigMock.mock.calls[1][0]).toBe('identify.v2');

    // chats.create was actually invoked exactly once with the production
    // hardcoded generationConfig (no scope override since both lookups failed).
    expect(captured.length).toBe(1);
    const { config } = captured[0];
    expect(typeof config.temperature).toBe('number');
    expect(config.maxOutputTokens).toBe(12000);
    expect(config.thinkingConfig).toBeDefined();
    expect(config.thinkingConfig.thinkingLevel).toBe('high');
    // Tool wiring assertion (regression-guard for the agentic tool stack).
    expect(Array.isArray(config.tools)).toBe(true);
    expect(config.tools.some((t) => t && t.googleSearch !== undefined)).toBe(true);
    expect(config.tools.some((t) => t && t.urlContext !== undefined)).toBe(true);
    expect(config.tools.some((t) => Array.isArray(t?.functionDeclarations))).toBe(true);
    expect(config.toolConfig).toBeDefined();
    expect(config.toolConfig.functionCallingConfig.mode).toBe('AUTO');

    // The fake sendMessage emitted a write_product_datasheet call, so the
    // SUT returned the sanitised final args.
    expect(result).toBeDefined();
    expect(result.title_ebay).toBe('x');
    expect(result._agentic).toBeDefined();
    expect(result._agentic.sawWriteCall).toBe(true);
  });
});
