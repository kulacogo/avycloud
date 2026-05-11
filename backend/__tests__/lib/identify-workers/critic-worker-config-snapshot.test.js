'use strict';

/**
 * F.1b.2 — Snapshot test for critic-worker Flash-call config.
 *
 * critic-worker uses `aiClient.models.generateContent({ model, contents, config })`
 * with hardcoded temperature: 0.1, responseMimeType: 'application/json'.
 *
 * Post-migration: the worker first asks `resolveScopeConfig('identify.critic', ...)`
 * with these hardcoded values as callerOverrides. If that scope doesn't exist
 * (typical in tests), it falls back to the hardcoded config → byte-identical.
 */

const path = require('path');
const datasheetQualityPath = require.resolve('../../../lib/datasheet-quality');
const ebayTaxonomyPath = require.resolve('../../../lib/ebay-taxonomy');
const llmConfigPath = require.resolve('../../../lib/llm-config');

const realLlm = require(llmConfigPath);
const llmConfigStub = {
  resolveScopeConfig: vi.fn(async () => {
    const err = new Error("resolveScopeConfig: unknown scope 'identify.critic'");
    err.statusCode = 404;
    throw err;
  }),
};
require.cache[llmConfigPath] = {
  id: llmConfigPath,
  filename: llmConfigPath,
  loaded: true,
  exports: { ...realLlm, ...llmConfigStub },
};

// Datasheet-quality stub (mirrors existing critic-worker.test.js).
let evaluateEbayReadyMock = () => ({ ok: true, issues: [], issuesDetailed: [], missingRequiredAspects: [] });
require.cache[datasheetQualityPath] = {
  id: datasheetQualityPath,
  filename: datasheetQualityPath,
  loaded: true,
  exports: { evaluateEbayReady: (...args) => evaluateEbayReadyMock(...args) },
};

require.cache[ebayTaxonomyPath] = {
  id: ebayTaxonomyPath,
  filename: ebayTaxonomyPath,
  loaded: true,
  exports: { getRequiredAspects: () => [] },
};

const { runCriticWorker } = require('../../../lib/identify-workers/critic-worker');

beforeEach(() => {
  vi.clearAllMocks();
  llmConfigStub.resolveScopeConfig.mockClear();
});

describe('critic-worker — generationConfig snapshot (F.1b.2 caller-migration)', () => {
  it('passes a stable generationConfig to models.generateContent for Flash hints', async () => {
    const captured = { configs: [], modelArgs: [] };
    const fakeClient = {
      models: {
        generateContent: vi.fn(async ({ model, config }) => {
          captured.modelArgs.push(model);
          captured.configs.push(config);
          return {
            text: JSON.stringify([{ worker: 'attributes', suggestion: 'fix things' }]),
          };
        }),
      },
    };

    // Force a non-empty issue list so maybeFlashFixHints runs.
    evaluateEbayReadyMock = () => ({
      ok: false,
      issues: ['title_missing'],
      issuesDetailed: [
        { code: 'title_missing', severity: 'error', field: 'title', message: 'Title missing' },
      ],
    });

    const res = await runCriticWorker({
      product: {
        identification: { name: 'Sony', category: 'Audio' },
        details: { categoryId: '15052', attributes: {} },
      },
      aiClient: fakeClient,
      requiredAspects: ['Marke'],
    });

    expect(res.ok).toBe(true);
    expect(captured.configs.length).toBe(1);
    const cfg = captured.configs[0];

    expect(cfg.temperature).toBe(0.1);
    expect(cfg.responseMimeType).toBe('application/json');
    // FLASH_MODEL is non-empty
    expect(typeof captured.modelArgs[0]).toBe('string');
    expect(captured.modelArgs[0].length).toBeGreaterThan(0);
  });

  it('calls resolveScopeConfig with identify.critic scope', async () => {
    const fakeClient = {
      models: {
        generateContent: async () => ({ text: '[]' }),
      },
    };
    evaluateEbayReadyMock = () => ({
      ok: false,
      issues: ['title_missing'],
      issuesDetailed: [
        { code: 'title_missing', severity: 'error', field: 'title', message: 'X' },
      ],
    });
    await runCriticWorker({
      product: { identification: { name: 'X' }, details: {} },
      aiClient: fakeClient,
      requiredAspects: ['Marke'],
    });
    expect(llmConfigStub.resolveScopeConfig).toHaveBeenCalled();
    expect(llmConfigStub.resolveScopeConfig.mock.calls[0][0]).toBe('identify.critic');
  });

  // ─── F.1b.2 Happy-Path: resolveScopeConfig succeeds ──────────────────────
  it('uses scope override when resolveScopeConfig succeeds', async () => {
    const captured = { configs: [], modelArgs: [] };
    const fakeClient = {
      models: {
        generateContent: vi.fn(async ({ model, config }) => {
          captured.modelArgs.push(model);
          captured.configs.push(config);
          return { text: JSON.stringify([{ worker: 'attributes', suggestion: 'x' }]) };
        }),
      },
    };

    llmConfigStub.resolveScopeConfig.mockResolvedValueOnce({
      generationConfig: {
        temperature: 0.3,
        responseMimeType: 'application/json',
      },
      model: 'gemini-3-flash-preview',
      system_prompt: 'mock-scope-system-prompt',
    });

    evaluateEbayReadyMock = () => ({
      ok: false,
      issues: ['title_missing'],
      issuesDetailed: [
        { code: 'title_missing', severity: 'error', field: 'title', message: 'Title missing' },
      ],
    });

    const res = await runCriticWorker({
      product: {
        identification: { name: 'Sony', category: 'Audio' },
        details: { categoryId: '15052', attributes: {} },
      },
      aiClient: fakeClient,
      requiredAspects: ['Marke'],
    });

    expect(res.ok).toBe(true);
    expect(captured.configs.length).toBe(1);
    const cfg = captured.configs[0];

    // Scope-Override gewinnt über Hardcoded-Fallback temperature=0.1.
    expect(cfg.temperature).toBe(0.3);
    expect(cfg.responseMimeType).toBe('application/json');
    // Scope-Modell gewinnt über FLASH_MODEL-Default.
    expect(captured.modelArgs[0]).toBe('gemini-3-flash-preview');

    // callerOverrides werden mit Hardcoded-Defaults mitgegeben.
    const callerOverrides = llmConfigStub.resolveScopeConfig.mock.calls[0][2];
    expect(callerOverrides).toBeTruthy();
    expect(callerOverrides.generationConfig).toBeTruthy();
    expect(callerOverrides.generationConfig.temperature).toBe(0.1);
    expect(typeof callerOverrides.model).toBe('string');
    expect(callerOverrides.model.length).toBeGreaterThan(0);
  });

  it('caller-overrides win over scope-config (top-level wins per llm-config contract)', async () => {
    const captured = { configs: [], modelArgs: [] };
    const fakeClient = {
      models: {
        generateContent: vi.fn(async ({ model, config }) => {
          captured.modelArgs.push(model);
          captured.configs.push(config);
          return { text: '[]' };
        }),
      },
    };

    // Simulate real resolveScopeConfig merge: scope says 0.5, caller passes
    // its hardcoded fallbackTemperature (=0.1) — caller wins per contract.
    llmConfigStub.resolveScopeConfig.mockImplementationOnce(async (_scope, _tenant, callerOverrides) => {
      const scopeGenCfg = { temperature: 0.5, responseMimeType: 'application/json' };
      const callerGenCfg = (callerOverrides && callerOverrides.generationConfig) || {};
      const callerTop = { ...callerOverrides };
      delete callerTop.generationConfig;
      return {
        generationConfig: { ...scopeGenCfg, ...callerGenCfg, ...callerTop },
        model: (callerOverrides && callerOverrides.model) || 'gemini-scope-default',
      };
    });

    evaluateEbayReadyMock = () => ({
      ok: false,
      issues: ['title_missing'],
      issuesDetailed: [
        { code: 'title_missing', severity: 'error', field: 'title', message: 'X' },
      ],
    });

    await runCriticWorker({
      product: { identification: { name: 'X' }, details: {} },
      aiClient: fakeClient,
      requiredAspects: ['Marke'],
    });

    const cfg = captured.configs[0];
    // Caller's fallbackTemperature (=0.1) wins over scope's 0.5.
    expect(cfg.temperature).toBe(0.1);
    expect(cfg.responseMimeType).toBe('application/json');
    // Caller's FLASH_MODEL wins over scope default.
    expect(captured.modelArgs[0]).not.toBe('gemini-scope-default');
    expect(typeof captured.modelArgs[0]).toBe('string');
    expect(captured.modelArgs[0].length).toBeGreaterThan(0);
  });
});
