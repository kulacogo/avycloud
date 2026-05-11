'use strict';

/**
 * F.1b.2 — Snapshot test for attributes-worker Gemini-config.
 *
 * Same approach as identity-worker-config-snapshot.test.js: capture the
 * `config` argument passed to `aiClient.chats.create()` on the Gemini-
 * finalization path. After F.1b.2 migration the worker must still emit a
 * byte-identical config when `resolveScopeConfig()` falls back (no scope in
 * Firestore).
 */

const path = require('path');
const llmConfigPath = require.resolve('../../../lib/llm-config');
const atomicToolsPath = require.resolve('../../../services/atomic-tools');

const realAtomic = require(atomicToolsPath);

// Patch atomic-tools with silent executors.
const silentExec = (source) => async () => ({
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
      search_ebay_catalog: silentExec('search_ebay_catalog'),
      search_amazon_product: silentExec('search_amazon_product'),
      search_manufacturer_site: silentExec('search_manufacturer_site'),
      get_required_aspects: silentExec('get_required_aspects'),
      lookup_gtin: silentExec('lookup_gtin'),
      verify_brand: silentExec('verify_brand'),
      fetch_url_content: silentExec('fetch_url_content'),
      search_ebay_sold: silentExec('search_ebay_sold'),
      search_idealo: silentExec('search_idealo'),
    }),
    executors: {
      ...realAtomic.executors,
      executeSearchEbayCatalog: silentExec('search_ebay_catalog'),
      executeSearchAmazonProduct: silentExec('search_amazon_product'),
      executeSearchManufacturerSite: silentExec('search_manufacturer_site'),
      executeGetRequiredAspects: silentExec('get_required_aspects'),
    },
  },
};

// Patch llm-config so resolveScopeConfig throws (= scope not present).
const llmConfigStub = {
  resolveScopeConfig: vi.fn(async () => {
    const err = new Error("resolveScopeConfig: unknown scope 'identify.attributes'");
    err.statusCode = 404;
    throw err;
  }),
};
const realLlm = require(llmConfigPath);
require.cache[llmConfigPath] = {
  id: llmConfigPath,
  filename: llmConfigPath,
  loaded: true,
  exports: { ...realLlm, ...llmConfigStub },
};

const { runAttributesWorker } = require('../../../lib/identify-workers/attributes-worker');

function buildCaptureClient() {
  const captured = { configs: [], modelArgs: [] };
  const sendMessageMock = vi.fn(async () => ({
    functionCalls: [
      {
        id: 'fa1',
        name: 'finalize_attributes',
        args: { aspects: [{ key: 'Marke', value: 'Sony', confidence: 0.9, sources: ['x'] }] },
      },
    ],
    usageMetadata: { totalTokenCount: 80 },
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

beforeEach(() => {
  vi.clearAllMocks();
  llmConfigStub.resolveScopeConfig.mockClear();
});

describe('attributes-worker — generationConfig snapshot (F.1b.2 caller-migration)', () => {
  it('passes a stable generationConfig to chats.create on Gemini finalization', async () => {
    const { aiClient, captured } = buildCaptureClient();

    const res = await runAttributesWorker({
      product: { identification: { name: 'Sony WH-1000XM5' } },
      workerResults: {
        category: {
          resolved: {
            requiredAspects: ['Marke', 'Modell'],
            recommendedAspects: ['Farbe'],
          },
        },
      },
      aiClient,
    });

    expect(res.ok).toBe(true);
    expect(captured.configs.length).toBe(1);
    const cfg = captured.configs[0];

    expect(cfg.temperature).toBe(1); // DEFAULT_CHAT_TEMPERATURE
    expect(cfg.maxOutputTokens).toBe(4096); // MAX_OUTPUT_TOKENS
    expect(cfg.thinkingConfig).toBeDefined();
    expect(cfg.thinkingConfig.includeThoughts).toBe(false);
    expect(Array.isArray(cfg.safetySettings)).toBe(true);
    expect(cfg.systemInstruction).toMatch(/Item-Specifics|Aspect|Specifics/i);
    // mode=ANY forced finalization
    expect(cfg.toolConfig.functionCallingConfig.mode).toBe('ANY');
    expect(cfg.toolConfig.functionCallingConfig.allowedFunctionNames).toEqual(['finalize_attributes']);
    expect(Array.isArray(cfg.tools)).toBe(true);
    expect(captured.modelArgs[0]).toMatch(/gemini/i);
  });

  it('calls resolveScopeConfig with identify.attributes scope', async () => {
    const { aiClient } = buildCaptureClient();
    await runAttributesWorker({
      product: { identification: { name: 'Sony WH-1000XM5' } },
      workerResults: {
        category: {
          resolved: { requiredAspects: ['Marke'], recommendedAspects: [] },
        },
      },
      aiClient,
    });
    expect(llmConfigStub.resolveScopeConfig).toHaveBeenCalled();
    expect(llmConfigStub.resolveScopeConfig.mock.calls[0][0]).toBe('identify.attributes');
  });

  // ─── F.1b.2 Happy-Path: resolveScopeConfig succeeds ──────────────────────
  it('uses scope override when resolveScopeConfig succeeds', async () => {
    const { aiClient, captured } = buildCaptureClient();

    llmConfigStub.resolveScopeConfig.mockResolvedValueOnce({
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingBudget: 128, includeThoughts: false },
      },
      model: 'gemini-3-flash-preview',
      system_prompt: 'mock-scope-system-prompt',
    });

    const res = await runAttributesWorker({
      product: { identification: { name: 'Sony WH-1000XM5' } },
      workerResults: {
        category: {
          resolved: { requiredAspects: ['Marke', 'Modell'], recommendedAspects: ['Farbe'] },
        },
      },
      aiClient,
      tenantId: 'trendocean',
    });

    expect(res.ok).toBe(true);
    expect(captured.configs.length).toBe(1);
    const cfg = captured.configs[0];

    expect(cfg.temperature).toBe(0.3); // scope-Wert
    expect(cfg.maxOutputTokens).toBe(2048); // scope-Wert
    expect(cfg.thinkingConfig.thinkingBudget).toBe(128);
    expect(captured.modelArgs[0]).toBe('gemini-3-flash-preview');

    // Scope-Args durchgereicht.
    expect(llmConfigStub.resolveScopeConfig.mock.calls[0][1]).toBe('trendocean');
    const callerOverrides = llmConfigStub.resolveScopeConfig.mock.calls[0][2];
    expect(callerOverrides).toBeTruthy();
    expect(callerOverrides.generationConfig).toBeTruthy();
    expect(typeof callerOverrides.generationConfig.temperature).toBe('number');
  });

  it('caller-overrides win over scope-config (top-level wins per llm-config contract)', async () => {
    const { aiClient, captured } = buildCaptureClient();

    // Simulate real resolveScopeConfig merge: scope says 0.3, caller passes 1
    // (hardcoded DEFAULT_CHAT_TEMPERATURE) as callerOverrides — caller wins.
    llmConfigStub.resolveScopeConfig.mockImplementationOnce(async (_scope, _tenant, callerOverrides) => {
      const scopeGenCfg = { temperature: 0.3, maxOutputTokens: 1024 };
      const callerGenCfg = (callerOverrides && callerOverrides.generationConfig) || {};
      const callerTop = { ...callerOverrides };
      delete callerTop.generationConfig;
      return {
        generationConfig: { ...scopeGenCfg, ...callerGenCfg, ...callerTop },
        model: (callerOverrides && callerOverrides.model) || 'gemini-scope-default',
      };
    });

    await runAttributesWorker({
      product: { identification: { name: 'Sony WH-1000XM5' } },
      workerResults: {
        category: {
          resolved: { requiredAspects: ['Marke'], recommendedAspects: [] },
        },
      },
      aiClient,
    });

    const cfg = captured.configs[0];
    // DEFAULT_CHAT_TEMPERATURE (=1) wins over scope's 0.3.
    expect(cfg.temperature).toBe(1);
    // Caller MAX_OUTPUT_TOKENS (=4096) wins over scope's 1024.
    expect(cfg.maxOutputTokens).toBe(4096);
    // Caller model wins over scope default.
    expect(captured.modelArgs[0]).not.toBe('gemini-scope-default');
    expect(captured.modelArgs[0]).toMatch(/gemini/i);
  });
});
