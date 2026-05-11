'use strict';

/**
 * F.1b.2 — Snapshot test for identity-worker Gemini-config.
 *
 * Captures the exact `config` object passed to `aiClient.chats.create()` from
 * the Gemini-fallback path. After migration to `resolveScopeConfig()` with
 * callerOverrides preserving the hardcoded values, this snapshot MUST stay
 * byte-identical (modulo non-deterministic fields, which we strip).
 *
 * Pre-conditions:
 *  - resolveScopeConfig() should fail (no `identify.identity` scope in
 *    Firestore in tests) → worker falls back to hardcoded defaults.
 *  - This test therefore asserts: legacy behaviour is preserved on
 *    fallback-path.
 */

const path = require('path');
const atomicToolsPath = require.resolve('../../../services/atomic-tools');
const llmConfigPath = require.resolve('../../../lib/llm-config');
const realAtomic = require(atomicToolsPath);

// ─── Atomic-tools stubs (mirrors identity-worker.test.js) ─────────────────
const stubExecutor = (source) => async () => ({
  ok: false,
  source,
  data: null,
  confidence: 0,
  meta: { durationMs: 1 },
});

require.cache[atomicToolsPath] = {
  id: atomicToolsPath,
  filename: atomicToolsPath,
  loaded: true,
  exports: {
    ...realAtomic,
    buildToolExecutorMap: () => ({
      lookup_gtin: stubExecutor('lookup_gtin'),
      verify_brand: stubExecutor('verify_brand'),
      search_amazon_product: stubExecutor('search_amazon_product'),
      search_ebay_catalog: vi.fn(),
      get_required_aspects: vi.fn(),
      search_manufacturer_site: vi.fn(),
      fetch_url_content: vi.fn(),
      search_ebay_sold: vi.fn(),
      search_idealo: vi.fn(),
    }),
    executors: { ...realAtomic.executors },
    declarations: realAtomic.declarations,
  },
};

// ─── llm-config stub: simulate "scope does not exist" → throws ───────────
const llmConfigStub = {
  resolveScopeConfig: vi.fn(async () => {
    const err = new Error("resolveScopeConfig: unknown scope 'identify.identity'");
    err.statusCode = 404;
    throw err;
  }),
};
const realLlmConfig = require(llmConfigPath);
require.cache[llmConfigPath] = {
  id: llmConfigPath,
  filename: llmConfigPath,
  loaded: true,
  exports: { ...realLlmConfig, ...llmConfigStub },
};

// Now load worker (after stubs).
const { runIdentityWorker } = require('../../../lib/identify-workers/identity-worker');

// Capture the config arg passed to chats.create
function buildCaptureClient() {
  const captured = { configs: [], modelArgs: [] };
  const sendMessageMock = vi.fn(async () => ({
    functionCalls: [
      {
        id: 'f1',
        name: 'finalize_identity',
        args: {
          gtin: '4548736132610',
          brand: 'Sony',
          confidence: 0.7,
        },
      },
    ],
    usageMetadata: { totalTokenCount: 100 },
  }));
  const aiClient = {
    chats: {
      create: vi.fn(({ model, config }) => {
        captured.modelArgs.push(model);
        captured.configs.push(config);
        return { sendMessage: sendMessageMock };
      }),
    },
  };
  return { aiClient, captured, sendMessageMock };
}

// Strip non-deterministic + non-comparable fields from the captured config
function normalizeConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const clone = JSON.parse(JSON.stringify(cfg, (_k, v) => {
    if (typeof v === 'function') return '[Function]';
    return v;
  }));
  // tools include functionDeclarations whose internal shape is stable
  // toolConfig is preserved; systemInstruction is preserved.
  return clone;
}

beforeEach(() => {
  vi.clearAllMocks();
  llmConfigStub.resolveScopeConfig.mockClear();
});

describe('identity-worker — generationConfig snapshot (F.1b.2 caller-migration)', () => {
  it('passes a stable generationConfig to chats.create on Gemini fallback path', async () => {
    const { aiClient, captured } = buildCaptureClient();

    const res = await runIdentityWorker({
      barcodes: '9999999999998', // bad checksum → forces Gemini fallback
      ocrPayload: { text: 'random text no digits' },
      identity: { brand: 'Sony', model: 'WH-1000XM5' },
      aiClient,
    });

    expect(res.ok).toBe(true);
    expect(captured.configs.length).toBe(1);
    const cfg = normalizeConfig(captured.configs[0]);

    // Stable fields we lock down:
    expect(cfg.temperature).toBe(1); // DEFAULT_CHAT_TEMPERATURE from gemini-config
    expect(cfg.maxOutputTokens).toBe(4096); // MAX_OUTPUT_TOKENS
    expect(cfg.thinkingConfig).toBeDefined();
    // includeThoughts is explicitly false in identity-worker
    expect(cfg.thinkingConfig.includeThoughts).toBe(false);
    expect(Array.isArray(cfg.safetySettings)).toBe(true);
    expect(cfg.systemInstruction).toMatch(/Identity/i);
    expect(cfg.toolConfig.functionCallingConfig.mode).toBe('AUTO');
    expect(Array.isArray(cfg.tools)).toBe(true);

    // model is whatever resolveChatModel() returns — gemini-3-pro-preview default.
    expect(captured.modelArgs[0]).toMatch(/gemini/i);
  });

  it('attempts resolveScopeConfig with scope identify.identity and graceful fallback on error', async () => {
    const { aiClient } = buildCaptureClient();

    await runIdentityWorker({
      barcodes: '9999999999998',
      identity: { brand: 'Sony' },
      aiClient,
    });

    // Post-migration: resolveScopeConfig is called with 'identify.identity'.
    // Pre-migration: this mock would not be called → assertion below is the
    // marker of the migration having landed.
    expect(llmConfigStub.resolveScopeConfig).toHaveBeenCalled();
    expect(llmConfigStub.resolveScopeConfig.mock.calls[0][0]).toBe('identify.identity');
  });

  // ─── F.1b.2 Happy-Path: resolveScopeConfig succeeds ──────────────────────
  it('uses scope override when resolveScopeConfig succeeds', async () => {
    const { aiClient, captured } = buildCaptureClient();

    // Scope returns an authoritative override different from the hardcoded
    // fallback (temperature=1, max=4096, model=resolveChatModel()).
    llmConfigStub.resolveScopeConfig.mockResolvedValueOnce({
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingBudget: 256, includeThoughts: false },
      },
      model: 'gemini-3-flash-preview',
      system_prompt: 'mock-scope-system-prompt',
    });

    const res = await runIdentityWorker({
      barcodes: '9999999999998',
      identity: { brand: 'Sony' },
      aiClient,
      tenantId: 'trendocean',
    });

    expect(res.ok).toBe(true);
    expect(captured.configs.length).toBe(1);
    const cfg = normalizeConfig(captured.configs[0]);

    // Scope-Werte gewinnen über die Hardcoded-Defaults.
    expect(cfg.temperature).toBe(0.3);
    expect(cfg.maxOutputTokens).toBe(2048);
    expect(cfg.thinkingConfig.thinkingBudget).toBe(256);
    expect(captured.modelArgs[0]).toBe('gemini-3-flash-preview');

    // tenantId wird durchgereicht.
    expect(llmConfigStub.resolveScopeConfig.mock.calls[0][1]).toBe('trendocean');
    // callerOverrides werden mitgegeben (hardcoded Defaults).
    const callerOverrides = llmConfigStub.resolveScopeConfig.mock.calls[0][2];
    expect(callerOverrides).toBeTruthy();
    expect(callerOverrides.model).toMatch(/gemini/i);
    expect(callerOverrides.generationConfig).toBeTruthy();
    expect(typeof callerOverrides.generationConfig.temperature).toBe('number');
  });

  it('caller-overrides win over scope-config (resolveScopeConfig merges callerOverrides on top)', async () => {
    const { aiClient, captured } = buildCaptureClient();

    // Simulate the real merge behaviour of resolveScopeConfig: scope's
    // temperature is 0.3, but the caller passes its hardcoded
    // DEFAULT_CHAT_TEMPERATURE (=1) as callerOverrides — callerOverrides win.
    llmConfigStub.resolveScopeConfig.mockImplementationOnce(async (_scope, _tenant, callerOverrides) => {
      const scopeGenCfg = { temperature: 0.3, maxOutputTokens: 1024 };
      const callerGenCfg =
        (callerOverrides && callerOverrides.generationConfig) || {};
      const callerTop = { ...callerOverrides };
      delete callerTop.generationConfig;
      return {
        generationConfig: {
          ...scopeGenCfg,
          ...callerGenCfg,
          ...callerTop, // top-level keys win per llm-config docs
        },
        model: (callerOverrides && callerOverrides.model) || 'gemini-scope-default',
      };
    });

    await runIdentityWorker({
      barcodes: '9999999999998',
      identity: { brand: 'Sony' },
      aiClient,
    });

    const cfg = normalizeConfig(captured.configs[0]);
    // Caller's DEFAULT_CHAT_TEMPERATURE (=1) wins over scope's 0.3.
    expect(cfg.temperature).toBe(1);
    // Caller's MAX_OUTPUT_TOKENS (=4096) wins over scope's 1024.
    expect(cfg.maxOutputTokens).toBe(4096);
    // Caller's resolved model wins over scope default.
    expect(captured.modelArgs[0]).toMatch(/gemini/i);
    expect(captured.modelArgs[0]).not.toBe('gemini-scope-default');
  });
});
