'use strict';

// Vitest CJS; globals enabled (describe/it/expect/vi/beforeEach).
//
// Phase F.1b — Helper-Layer scopeConfig augmentation.
// Verifies that gemini3-client, gemini-structured and gemini-client (vision)
// helpers accept an optional `scopeConfig` and merge generationConfig + model
// without breaking the legacy call-shape.

// ─── Patch ESM-only @google/genai BEFORE loading gemini3-client. ───────────────
// gemini3-client uses `await import('@google/genai')` only inside getGenAIClient.
// In these tests we replace module.exports.getGenAIClient on the loaded module,
// so the dynamic import is never executed.

// ─── Patch local module: lib/secret-values (needed by gemini-client) ──────────
const secretValuesPath = require.resolve('../../lib/secret-values');
try { require(secretValuesPath); } catch (_) {}
require.cache[secretValuesPath] = {
  id: secretValuesPath,
  filename: secretValuesPath,
  loaded: true,
  exports: { getSecretValue: vi.fn(async () => 'test-api-key') },
};

// ─── Patch local module: @google/generative-ai (CJS SDK used by gemini-client +
//     gemini-structured) — we need to stub GoogleGenerativeAI constructor and
//     HarmCategory / HarmBlockThreshold enums.
const gaiPath = require.resolve('@google/generative-ai');
try { require(gaiPath); } catch (_) {}
const _generateContentMock = vi.fn();
const _getGenerativeModelMock = vi.fn(() => ({ generateContent: _generateContentMock }));
require.cache[gaiPath] = {
  id: gaiPath,
  filename: gaiPath,
  loaded: true,
  exports: {
    GoogleGenerativeAI: function () { return { getGenerativeModel: _getGenerativeModelMock }; },
    HarmCategory: {
      HARM_CATEGORY_HARASSMENT: 'HARM_CATEGORY_HARASSMENT',
      HARM_CATEGORY_HATE_SPEECH: 'HARM_CATEGORY_HATE_SPEECH',
      HARM_CATEGORY_SEXUALLY_EXPLICIT: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      HARM_CATEGORY_DANGEROUS_CONTENT: 'HARM_CATEGORY_DANGEROUS_CONTENT',
    },
    HarmBlockThreshold: { BLOCK_NONE: 'BLOCK_NONE' },
  },
};

// ─── Patch lib/gemini-retry to be a passthrough (no real retry/backoff) ───────
const retryPath = require.resolve('../../lib/gemini-retry');
try { require(retryPath); } catch (_) {}
require.cache[retryPath] = {
  id: retryPath,
  filename: retryPath,
  loaded: true,
  exports: { callGeminiWithRetry: async (fn /* , opts */) => fn() },
};

// Now load the modules under test.
const gemini3 = require('../../lib/gemini3-client');
const geminiStructured = require('../../lib/gemini-structured');
const geminiClient = require('../../lib/gemini-client');

// Swap getGenAIClient on gemini3 module to avoid the real @google/genai import.
const _gemini3GenerateContentMock = vi.fn();
gemini3.getGenAIClient = vi.fn(async () => ({
  models: { generateContent: _gemini3GenerateContentMock },
}));

// gemini-client.callGeminiVision uses module.exports.getGeminiClient — we keep
// the real getGeminiClient (it lazily constructs the patched GoogleGenerativeAI
// stub above). But we can also swap if needed.

describe('Phase F.1b — gemini helper-layer scopeConfig augmentation', () => {
  beforeEach(() => {
    _gemini3GenerateContentMock.mockReset();
    _generateContentMock.mockReset();
    _getGenerativeModelMock.mockClear();
  });

  // ─── Pure helper unit-tests (the merge core) ──────────────────────────────
  describe('pure merge helpers', () => {
    it('__resolveScopeModel: caller > scope.model > null', () => {
      expect(gemini3.__resolveScopeModel('caller-model', { model: 'scope-model' })).toBe('caller-model');
      expect(gemini3.__resolveScopeModel(undefined, { model: 'scope-model' })).toBe('scope-model');
      expect(gemini3.__resolveScopeModel('', { model: 'scope-model' })).toBe('scope-model');
      expect(gemini3.__resolveScopeModel(undefined, null)).toBeNull();
      expect(gemini3.__resolveScopeModel(undefined, { model: '' })).toBeNull();
    });

    it('__pickScopeGenCfg returns null for missing / invalid input', () => {
      expect(gemini3.__pickScopeGenCfg(null)).toBeNull();
      expect(gemini3.__pickScopeGenCfg({})).toBeNull();
      expect(gemini3.__pickScopeGenCfg({ generationConfig: null })).toBeNull();
      expect(gemini3.__pickScopeGenCfg({ generationConfig: { temperature: 0.5 } })).toEqual({ temperature: 0.5 });
    });

    it('__mergeGenCfgLayers: caller > scope > defaults', () => {
      const out = gemini3.__mergeGenCfgLayers(
        { temperature: 0.1, maxOutputTokens: 1024, topK: 32 },
        { temperature: 0.5, topP: 0.9 },
        { temperature: 0.7 }
      );
      expect(out).toEqual({
        temperature: 0.7,
        maxOutputTokens: 1024,
        topK: 32,
        topP: 0.9,
      });
    });
  });

  // ─── gemini3-client integration ────────────────────────────────────────────
  describe('gemini3GenerateJSON', () => {
    it('without scopeConfig: behaves identically to before (defaults temperature=0.1, maxOutputTokens=1024)', async () => {
      _gemini3GenerateContentMock.mockResolvedValueOnce({ text: '{"ok":true}' });
      await gemini3.gemini3GenerateJSON({ prompt: 'p', schema: { type: 'object' } });
      expect(_gemini3GenerateContentMock).toHaveBeenCalledTimes(1);
      const call = _gemini3GenerateContentMock.mock.calls[0][0];
      expect(call.config.temperature).toBe(0.1);
      expect(call.config.maxOutputTokens).toBe(1024);
      expect(call.config.responseMimeType).toBe('application/json');
    });

    it('with scopeConfig.generationConfig: applies overrides', async () => {
      _gemini3GenerateContentMock.mockResolvedValueOnce({ text: '{"ok":true}' });
      await gemini3.gemini3GenerateJSON({
        prompt: 'p',
        schema: { type: 'object' },
        scopeConfig: { generationConfig: { temperature: 0.42, maxOutputTokens: 4242 } },
      });
      const call = _gemini3GenerateContentMock.mock.calls[0][0];
      expect(call.config.temperature).toBe(0.42);
      expect(call.config.maxOutputTokens).toBe(4242);
    });

    it('with scopeConfig.model: uses overridden model (caller arg wins when set)', async () => {
      _gemini3GenerateContentMock.mockResolvedValueOnce({ text: '{"ok":true}' });
      // Use an allowed model name so resolveModel does not fall back.
      await gemini3.gemini3GenerateJSON({
        prompt: 'p',
        schema: { type: 'object' },
        scopeConfig: { model: 'gemini-3-flash-preview' },
      });
      let call = _gemini3GenerateContentMock.mock.calls[0][0];
      expect(call.model).toBe('gemini-3-flash-preview');

      _gemini3GenerateContentMock.mockResolvedValueOnce({ text: '{"ok":true}' });
      await gemini3.gemini3GenerateJSON({
        prompt: 'p',
        schema: { type: 'object' },
        model: 'gemini-3.1-flash-lite',
        scopeConfig: { model: 'gemini-3-flash-preview' },
      });
      call = _gemini3GenerateContentMock.mock.calls[1][0];
      expect(call.model).toBe('gemini-3.1-flash-lite');
    });

    it('scopeConfig: callerOverrides (explicit temperature) win over scopeConfig.generationConfig', async () => {
      _gemini3GenerateContentMock.mockResolvedValueOnce({ text: '{"ok":true}' });
      await gemini3.gemini3GenerateJSON({
        prompt: 'p',
        schema: { type: 'object' },
        temperature: 0.9,
        scopeConfig: { generationConfig: { temperature: 0.1, maxOutputTokens: 9000 } },
      });
      const call = _gemini3GenerateContentMock.mock.calls[0][0];
      expect(call.config.temperature).toBe(0.9);
      // scopeConfig maxOutputTokens still applies since caller did not override it.
      expect(call.config.maxOutputTokens).toBe(9000);
    });
  });

  describe('gemini3GenerateText', () => {
    it('without scopeConfig keeps previous defaults (temperature=0.7, maxOutputTokens=2048)', async () => {
      _gemini3GenerateContentMock.mockResolvedValueOnce({ text: 'hello' });
      await gemini3.gemini3GenerateText({ prompt: 'p' });
      const call = _gemini3GenerateContentMock.mock.calls[0][0];
      expect(call.config.temperature).toBe(0.7);
      expect(call.config.maxOutputTokens).toBe(2048);
    });

    it('applies scopeConfig.generationConfig', async () => {
      _gemini3GenerateContentMock.mockResolvedValueOnce({ text: 'hello' });
      await gemini3.gemini3GenerateText({
        prompt: 'p',
        scopeConfig: { generationConfig: { temperature: 0.3, maxOutputTokens: 555 } },
      });
      const call = _gemini3GenerateContentMock.mock.calls[0][0];
      expect(call.config.temperature).toBe(0.3);
      expect(call.config.maxOutputTokens).toBe(555);
    });
  });

  // ─── gemini-structured integration ─────────────────────────────────────────
  describe('callGeminiStructured', () => {
    it('without scopeConfig: behaves identically (temperature=0.0, topP=0.8, topK=40)', async () => {
      _generateContentMock.mockResolvedValueOnce({
        response: {
          candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
          promptFeedback: null,
        },
      });
      await geminiStructured.callGeminiStructured({
        parts: [{ text: 'p' }],
        responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      });
      expect(_getGenerativeModelMock).toHaveBeenCalled();
      const callArg = _generateContentMock.mock.calls[0][0];
      expect(callArg.generationConfig.temperature).toBe(0.0);
      expect(callArg.generationConfig.topP).toBe(0.8);
      expect(callArg.generationConfig.topK).toBe(40);
      expect(callArg.generationConfig.maxOutputTokens).toBe(1024);
      expect(callArg.generationConfig.stopSequences).toEqual(['```']);
    });

    it('with scopeConfig: applies generationConfig + model overrides', async () => {
      _generateContentMock.mockResolvedValueOnce({
        response: {
          candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
          promptFeedback: null,
        },
      });
      await geminiStructured.callGeminiStructured({
        parts: [{ text: 'p' }],
        responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        scopeConfig: {
          model: 'gemini-3-flash-preview',
          generationConfig: { temperature: 0.5, topK: 99, maxOutputTokens: 2000 },
        },
      });
      const modelArg = _getGenerativeModelMock.mock.calls.pop()[0];
      expect(modelArg.model).toBe('gemini-3-flash-preview');

      const callArg = _generateContentMock.mock.calls[0][0];
      expect(callArg.generationConfig.temperature).toBe(0.5);
      expect(callArg.generationConfig.topK).toBe(99);
      expect(callArg.generationConfig.maxOutputTokens).toBe(2000);
      // unchanged values stay at helper-defaults
      expect(callArg.generationConfig.topP).toBe(0.8);
    });

    it('callerOverrides (explicit temperature) win over scopeConfig.generationConfig', async () => {
      _generateContentMock.mockResolvedValueOnce({
        response: {
          candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
          promptFeedback: null,
        },
      });
      await geminiStructured.callGeminiStructured({
        parts: [{ text: 'p' }],
        responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        temperature: 0.95,
        scopeConfig: { generationConfig: { temperature: 0.1, topP: 0.5 } },
      });
      const callArg = _generateContentMock.mock.calls[0][0];
      expect(callArg.generationConfig.temperature).toBe(0.95);
      // topP still comes from scopeConfig (caller did not override).
      expect(callArg.generationConfig.topP).toBe(0.5);
    });
  });

  // ─── gemini-client.callGeminiVision integration ────────────────────────────
  describe('callGeminiVision', () => {
    it('without scopeConfig keeps previous defaults (temperature=0.1, maxOutputTokens=2048)', async () => {
      _generateContentMock.mockResolvedValueOnce({
        response: { text: () => 'visible' },
      });
      await geminiClient.callGeminiVision('prompt', []);
      const callArg = _generateContentMock.mock.calls[0][0];
      expect(callArg.generationConfig.temperature).toBe(0.1);
      expect(callArg.generationConfig.maxOutputTokens).toBe(2048);
    });

    it('with scopeConfig: applies overrides correctly (generationConfig + model)', async () => {
      _generateContentMock.mockResolvedValueOnce({
        response: { text: () => 'visible' },
      });
      await geminiClient.callGeminiVision('prompt', [], {
        scopeConfig: {
          model: 'gemini-3-flash-preview',
          generationConfig: { temperature: 0.42, maxOutputTokens: 4242 },
        },
      });
      const modelArg = _getGenerativeModelMock.mock.calls.pop()[0];
      expect(modelArg.model).toBe('gemini-3-flash-preview');

      const callArg = _generateContentMock.mock.calls[0][0];
      expect(callArg.generationConfig.temperature).toBe(0.42);
      expect(callArg.generationConfig.maxOutputTokens).toBe(4242);
    });

    it('explicit options.temperature wins over scopeConfig.generationConfig', async () => {
      _generateContentMock.mockResolvedValueOnce({
        response: { text: () => 'visible' },
      });
      await geminiClient.callGeminiVision('prompt', [], {
        temperature: 0.66,
        scopeConfig: { generationConfig: { temperature: 0.11, maxOutputTokens: 3333 } },
      });
      const callArg = _generateContentMock.mock.calls[0][0];
      expect(callArg.generationConfig.temperature).toBe(0.66);
      // scope-provided maxOutputTokens still wins since caller did not override.
      expect(callArg.generationConfig.maxOutputTokens).toBe(3333);
    });
  });
});
