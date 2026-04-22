'use strict';

// Vitest globals (globals: true in vitest.config.js)
//
// Unit tests for backend/services/product-chat-v3.js
//
// Mocking strategy: require.cache patching (vi.mock() does not intercept CJS
// require() in Vitest 4.x for local modules). Pattern mirrors
// __tests__/services/atomic-tools.test.js.
//
// The agentic loop is exercised with an injected fake `aiClient` that simulates
// ai.chats.create() + chat.sendMessage() so no real Gemini calls happen.

const path = require('path');

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

// ---------------------------------------------------------------------------
// Patch atomic-tools dependencies so the tool-list builder stays deterministic
// and none of the real executors ever touch network / filesystem / firestore.
// ---------------------------------------------------------------------------

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

const realGtin = require('../../lib/gtin');
patchLocalModule('../../lib/gtin', realGtin);

patchLocalModule('../../lib/ebay-taxonomy-remote', {
  searchCatalogByGtin: vi.fn(),
  getCategorySuggestions: vi.fn(),
  _resetCaches: () => {},
});

patchLocalModule('../../lib/ebay-taxonomy', {
  getCategoryAspectCatalog: vi.fn(() => null),
  findEbayCategory: vi.fn(),
  getRequiredAspects: vi.fn(() => []),
  isKnownEbayCategoryId: vi.fn(() => true),
  buildRequiredAspectMeta: vi.fn(() => ({})),
  getRequiredAspectCatalogStats: vi.fn(() => ({})),
});

patchLocalModule('../../lib/gpsr-manufacturer-registry', {
  getManufacturerGpsrByName: vi.fn(),
});

patchLocalModule('../../services/toolkit', {
  executeSerpapiToolCall: vi.fn(),
  executeBrightdataSearchToolCall: vi.fn(),
  executeWebFetchToolCall: vi.fn(),
  serpapiToolDefinition: { name: 'serpapi' },
  brightdataSearchToolDefinition: { name: 'brightdata' },
  webFetchToolDefinition: { name: 'web_fetch' },
});

// Guard against the real gemini3-client trying to call into the network when
// the caller forgets to pass `aiClient`. We never want this path exercised in
// unit tests, so we hard-stub it to throw.
patchLocalModule('../../lib/gemini3-client', {
  getGenAIClient: vi.fn(async () => {
    throw new Error('getGenAIClient must not be called in unit tests — pass aiClient via opts');
  }),
});

// ---------------------------------------------------------------------------
// Load module under test (only after patches are in place).
// ---------------------------------------------------------------------------

const chatV3Path = path.resolve(__dirname, '../../services/product-chat-v3.js');
const chatV3 = require(chatV3Path);
const {
  runProductChatV3,
  chatV3Enabled,
  UPDATE_DATASHEET_DECLARATION,
  SUGGEST_IMAGES_DECLARATION,
  _testables,
} = chatV3;

// ---------------------------------------------------------------------------
// Helpers — build a fake GoogleGenAI client.
// ---------------------------------------------------------------------------

function mkProduct(overrides = {}) {
  return {
    id: 'prod_test_1',
    identification: {
      name: 'Sony WH-1000XM5',
      brand: 'Sony',
      category: 'Elektronik > Kopfhörer > Over-Ear',
      barcodes: ['4548736132610'],
    },
    details: {
      identifiers: { ean: '4548736132610', mpn: 'WH1000XM5B' },
      attributes: { Farbe: 'Schwarz', Typ: 'Over-Ear' },
      images: [],
      categoryId: '15052',
    },
    ...overrides,
  };
}

function mkFakeResponse({ functionCalls = [], text = '', thoughts = [], grounding = null } = {}) {
  const parts = [];
  for (const thought of thoughts) {
    parts.push({ thought: true, text: thought });
  }
  if (text) parts.push({ text });
  const candidate = { content: { parts } };
  if (grounding) candidate.groundingMetadata = grounding;
  return {
    text,
    functionCalls,
    candidates: [candidate],
  };
}

function mkFakeAiClient(scriptedResponses = []) {
  const calls = { sendMessage: [] };
  const queue = [...scriptedResponses];
  const chat = {
    sendMessage: vi.fn(async (args) => {
      calls.sendMessage.push(args);
      if (queue.length === 0) {
        return mkFakeResponse({ text: 'done.' });
      }
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  const client = {
    chats: {
      create: vi.fn(() => chat),
    },
    __chat: chat,
    __calls: calls,
  };
  return client;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('product-chat-v3 — module shape', () => {
  it('exports runProductChatV3 (async) + chatV3Enabled + writable declarations + _testables', () => {
    expect(typeof runProductChatV3).toBe('function');
    expect(runProductChatV3.constructor.name).toBe('AsyncFunction');
    expect(typeof chatV3Enabled).toBe('function');
    expect(UPDATE_DATASHEET_DECLARATION).toMatchObject({
      name: 'update_product_datasheet',
      parameters: { type: 'object' },
    });
    expect(SUGGEST_IMAGES_DECLARATION).toMatchObject({
      name: 'suggest_product_images',
      parameters: { type: 'object', required: ['query'] },
    });
    expect(_testables).toBeTypeOf('object');
    for (const key of ['buildSystemPromptV3', 'sanitizeDatasheetChangeV3', 'ownExecutor']) {
      expect(typeof _testables[key]).toBe('function');
    }
  });
});

describe('chatV3Enabled feature flag', () => {
  let original;
  beforeEach(() => {
    original = process.env.CHAT_V3;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CHAT_V3;
    else process.env.CHAT_V3 = original;
  });

  it('defaults to false when CHAT_V3 is unset', () => {
    delete process.env.CHAT_V3;
    expect(chatV3Enabled()).toBe(false);
  });

  it('returns true when CHAT_V3=true / 1 / yes / on', () => {
    for (const v of ['true', '1', 'yes', 'on', 'TRUE', 'On']) {
      process.env.CHAT_V3 = v;
      expect(chatV3Enabled()).toBe(true);
    }
  });

  it('returns false for arbitrary values', () => {
    for (const v of ['false', '0', 'no', 'off', '', 'maybe']) {
      process.env.CHAT_V3 = v;
      expect(chatV3Enabled()).toBe(false);
    }
  });
});

describe('buildSystemPromptV3', () => {
  it('includes product snapshot JSON and tool overview', () => {
    const product = mkProduct();
    const prompt = _testables.buildSystemPromptV3(product);
    expect(prompt).toContain('Produkt-Research-Agent');
    expect(prompt).toContain('VERFÜGBARE TOOLS');
    // Snapshot-specific values flow through JSON.stringify
    expect(prompt).toContain('Sony WH-1000XM5');
    expect(prompt).toContain('4548736132610');
    // Tool overview rendered from atomic-tools buildToolList
    expect(prompt).toContain('lookup_gtin');
    expect(prompt).toContain('search_ebay_catalog');
    expect(prompt).toContain('update_product_datasheet');
    expect(prompt).toContain('suggest_product_images');
    // googleSearch + urlContext must be advertised
    expect(prompt).toContain('googleSearch');
    expect(prompt).toContain('urlContext');
  });

  it('clamps snapshot to safe sizes (long names truncated)', () => {
    const longName = 'A'.repeat(500);
    const prompt = _testables.buildSystemPromptV3(mkProduct({
      identification: { name: longName, brand: 'X', category: 'Y', barcodes: [] },
    }));
    expect(prompt).toContain('A'.repeat(160));
    expect(prompt).not.toContain('A'.repeat(500));
  });
});

describe('sanitizeDatasheetChangeV3', () => {
  it('keeps only whitelisted top-level fields', () => {
    const out = _testables.sanitizeDatasheetChangeV3({
      summary: '  test summary  ',
      title: 'My title',
      random_field: 'should be dropped',
      __proto__: { evil: 'nope' },
      identity: { brand: 'Sony', name: 'X', evil: 'no' },
      attributes: [
        { key: 'Farbe', value: 'Schwarz', value_type: 'string', evil: 'no' },
        { key: '', value: 'no key — drop me' },
        { value: 'no key — drop me too' },
      ],
      confidence: 0.77,
      notes: { unsure: ['maybe'], warnings: ['check gtin'], evil: 'no' },
      pricing: { amount: '12,95', currency: 'EUR', source_url: 'https://x', evil: 'no' },
      gpsr: { manufacturer_name: 'Sony Europe BV', evil: 'no' },
      key_features: ['Feature 1', '', null, 'Feature 2'],
      short_description: '<p>Hello</p>',
    });

    expect(out.summary).toBe('test summary');
    expect(out.title).toBe('My title');
    expect(out.confidence).toBeCloseTo(0.77);
    expect(out).not.toHaveProperty('random_field');
    expect(out).not.toHaveProperty('evil');
    expect(out.identity).toEqual({ brand: 'Sony', name: 'X' });
    expect(out.identity).not.toHaveProperty('evil');
    expect(out.attributes).toHaveLength(1);
    expect(out.attributes[0]).toEqual({ key: 'Farbe', value: 'Schwarz', value_type: 'string' });
    expect(out.notes).toEqual({ unsure: ['maybe'], warnings: ['check gtin'] });
    expect(out.pricing.amount).toBeCloseTo(12.95);
    expect(out.pricing.currency).toBe('EUR');
    expect(out.gpsr).toEqual({ manufacturer_name: 'Sony Europe BV' });
    expect(out.key_features).toEqual(['Feature 1', 'Feature 2']);
    expect(out.short_description).toContain('Hello');
  });

  it('clamps confidence to 0..1 and returns empty for garbage input', () => {
    expect(_testables.sanitizeDatasheetChangeV3({ confidence: 5 }).confidence).toBe(1);
    expect(_testables.sanitizeDatasheetChangeV3({ confidence: -2 }).confidence).toBe(0);
    expect(_testables.sanitizeDatasheetChangeV3(null)).toEqual({});
    expect(_testables.sanitizeDatasheetChangeV3('not an object')).toEqual({});
  });
});

describe('ownExecutor', () => {
  it('handles update_product_datasheet and pushes sanitized change to state', () => {
    const state = { datasheetChanges: [], imageSuggestions: [] };
    const res = _testables.ownExecutor(
      'update_product_datasheet',
      { title: 'Test', summary: 'why', confidence: 0.9, badField: 'x' },
      state
    );
    expect(res.ok).toBe(true);
    expect(res.source).toBe('update_product_datasheet');
    expect(res.data.applied).toBe(true);
    expect(res.data.confidence).toBeCloseTo(0.9);
    expect(state.datasheetChanges).toHaveLength(1);
    expect(state.datasheetChanges[0].title).toBe('Test');
    expect(state.datasheetChanges[0]).not.toHaveProperty('badField');
  });

  it('handles suggest_product_images and queues query', () => {
    const state = { datasheetChanges: [], imageSuggestions: [] };
    const res = _testables.ownExecutor(
      'suggest_product_images',
      { query: 'Sony WH-1000XM5 schwarz', rationale: 'need packshot' },
      state
    );
    expect(res.ok).toBe(true);
    expect(state.imageSuggestions).toHaveLength(1);
    expect(state.imageSuggestions[0]).toEqual({
      query: 'Sony WH-1000XM5 schwarz',
      rationale: 'need packshot',
    });
  });

  it('returns failure for suggest_product_images without query', () => {
    const state = { datasheetChanges: [], imageSuggestions: [] };
    const res = _testables.ownExecutor('suggest_product_images', {}, state);
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('MISSING_QUERY');
  });

  it('returns null for unknown tool names so the map dispatch takes over', () => {
    const state = { datasheetChanges: [], imageSuggestions: [] };
    expect(_testables.ownExecutor('lookup_gtin', {}, state)).toBeNull();
  });
});

describe('runProductChatV3 — injected fake client', () => {
  it('returns the expected shape when no function calls are requested', async () => {
    const product = mkProduct();
    const aiClient = mkFakeAiClient([
      mkFakeResponse({
        text: 'Alles okay — keine Änderungen nötig.',
        thoughts: ['analysiere Produkt…'],
        grounding: {
          webSearchQueries: ['sony wh-1000xm5 specs'],
          groundingChunks: [{ web: { title: 'Sony', uri: 'https://sony.de/wh-1000xm5' } }],
        },
      }),
    ]);
    const progressEvents = [];
    const result = await runProductChatV3({
      product,
      message: 'Prüfe die Produktdaten bitte.',
      onProgress: (e) => progressEvents.push(e),
      aiClient,
    });

    expect(result).toMatchObject({
      _pipeline: 'v3-context-circulation',
      iterations: 0,
      datasheetChanges: [],
      imageSuggestions: [],
    });
    expect(typeof result.model).toBe('string');
    expect(result.model.length).toBeGreaterThan(0);
    expect(result.message).toContain('Alles okay');
    expect(result.trace.thoughts).toEqual(['analysiere Produkt…']);
    expect(result.trace.groundingChunks).toHaveLength(1);
    expect(result.trace.groundingChunks[0].queries).toEqual(['sony wh-1000xm5 specs']);
    expect(result.confidence).toHaveProperty('overall');
    expect(result.confidence).toHaveProperty('readyForPublish');
    expect(progressEvents.some((e) => e.type === 'start')).toBe(true);
    expect(progressEvents.some((e) => e.type === 'complete')).toBe(true);
    expect(aiClient.chats.create).toHaveBeenCalledTimes(1);
  });

  it('dispatches function_calls via the executor map and captures the datasheet change', async () => {
    const product = mkProduct();
    const aiClient = mkFakeAiClient([
      // Turn 1: model requests a tool call (custom + atomic mixed).
      mkFakeResponse({
        functionCalls: [
          {
            id: 'call_1',
            name: 'update_product_datasheet',
            args: {
              summary: 'Brand confirmed',
              title: 'Sony WH-1000XM5 Kabelloser Over-Ear Kopfhörer Schwarz',
              identity: { brand: 'Sony' },
              confidence: 0.88,
            },
          },
          {
            id: 'call_2',
            name: 'lookup_gtin',
            args: { gtin: '4548736132610', locale: 'de-DE' },
          },
        ],
        thoughts: ['need to confirm brand'],
      }),
      // Turn 2: model returns final answer.
      mkFakeResponse({ text: 'Fertig.' }),
    ]);

    const progressEvents = [];
    const result = await runProductChatV3({
      product,
      message: 'Aktualisiere die Produktdaten.',
      onProgress: (e) => progressEvents.push(e),
      aiClient,
    });

    expect(result.iterations).toBe(1);
    expect(result.datasheetChanges).toHaveLength(1);
    expect(result.datasheetChanges[0].title).toContain('Sony');
    expect(result.datasheetChanges[0].confidence).toBeCloseTo(0.88);
    expect(result.trace.toolCalls).toHaveLength(2);
    const names = result.trace.toolCalls.map((t) => t.name).sort();
    expect(names).toEqual(['lookup_gtin', 'update_product_datasheet']);

    // Second sendMessage must feed functionResponses back.
    // Per @google/genai SDK SendMessageParameters, `message` is a PartListUnion
    // (string | Part | Part[]) — NOT a Content object. Tool responses must be
    // passed as a flat Part[] array; wrapping in { role, parts } causes the
    // SDK to mis-serialize and the model never sees the results.
    expect(aiClient.__chat.sendMessage).toHaveBeenCalledTimes(2);
    const secondCall = aiClient.__chat.sendMessage.mock.calls[1][0];
    expect(secondCall).toHaveProperty('message');
    expect(Array.isArray(secondCall.message)).toBe(true);
    expect(secondCall.message).toHaveLength(2);
    expect(secondCall.message[0]).toHaveProperty('functionResponse');
    expect(secondCall.message[0].functionResponse.name).toBe('update_product_datasheet');

    // tool_start + tool_done events must flow to onProgress.
    const toolStarts = progressEvents.filter((e) => e.type === 'tool_start');
    const toolDones = progressEvents.filter((e) => e.type === 'tool_done');
    expect(toolStarts).toHaveLength(2);
    expect(toolDones).toHaveLength(2);
  });

  it('respects maxIterations and stops the agentic loop', async () => {
    const product = mkProduct();
    const loopResponse = () =>
      mkFakeResponse({
        functionCalls: [{ id: 'c', name: 'update_product_datasheet', args: { summary: 'x', title: 't' } }],
      });
    const aiClient = mkFakeAiClient([
      loopResponse(),
      loopResponse(),
      loopResponse(),
      loopResponse(),
      // Safety tail — if the loop is not broken we will hit this:
      mkFakeResponse({ text: 'tail' }),
    ]);

    const result = await runProductChatV3({
      product,
      message: 'run until limit',
      aiClient,
      maxIterations: 2,
    });
    expect(result.iterations).toBe(2);
    // initial + 2 iterations = 3 sendMessage calls.
    expect(aiClient.__chat.sendMessage).toHaveBeenCalledTimes(3);
  });

  it('throws with "chat-v3 failed" prefix when Gemini errors terminally', async () => {
    const product = mkProduct();
    // Non-transient error → no retry, surfaces immediately.
    const aiClient = mkFakeAiClient([new Error('hard failure, bad request')]);

    await expect(
      runProductChatV3({ product, message: 'please fail', aiClient })
    ).rejects.toThrowError(/^chat-v3 failed:/);
  });

  it('throws "chat-v3 failed" for missing product / message', async () => {
    await expect(runProductChatV3({ product: null, message: 'hi' })).rejects.toThrowError(
      /^chat-v3 failed: product is required/
    );
    await expect(runProductChatV3({ product: mkProduct(), message: '' })).rejects.toThrowError(
      /^chat-v3 failed: message is required/
    );
  });
});
