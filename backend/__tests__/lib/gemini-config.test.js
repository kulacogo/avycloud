// globals: true in vitest.config.js makes describe, it, expect, beforeEach, vi available globally
// Pure unit tests — no GCP patching needed, gemini-config only depends on model-select.

const ORIGINAL_ENV = { ...process.env };

describe('gemini-config helpers', () => {
  beforeEach(() => {
    // Restore ENV before each test to avoid leakage
    delete process.env.CHAT_MODEL;
    delete process.env.IDENTIFY_MODEL;
    delete process.env.INTENT_MODEL;
    // Force re-require so process.env changes are re-read cleanly
    delete require.cache[require.resolve('../../lib/gemini-config')];
  });

  afterAll(() => {
    // Restore original ENV after the suite runs
    process.env = { ...ORIGINAL_ENV };
  });

  it('exports DEFAULT_MODEL as gemini-3.1-pro-preview-customtools', () => {
    const cfg = require('../../lib/gemini-config');
    expect(cfg.DEFAULT_MODEL).toBe('gemini-3.1-pro-preview-customtools');
    expect(cfg.FLASH_MODEL).toBe('gemini-3-flash-preview');
    expect(cfg.IMAGE_MODEL).toBe('gemini-3-pro-image-preview');
  });

  it('defaultThinkingConfig returns HIGH + includeThoughts by default', () => {
    const { defaultThinkingConfig } = require('../../lib/gemini-config');
    const out = defaultThinkingConfig();
    expect(out).toEqual({ thinkingLevel: 'high', includeThoughts: true });
  });

  it('defaultThinkingConfig honors overrides', () => {
    const { defaultThinkingConfig } = require('../../lib/gemini-config');
    const out = defaultThinkingConfig({ includeThoughts: false, level: 'low' });
    expect(out).toEqual({ thinkingLevel: 'low', includeThoughts: false });
  });

  it('defaultSafetySettings returns 4 harm categories with MEDIUM threshold', () => {
    const { defaultSafetySettings } = require('../../lib/gemini-config');
    const out = defaultSafetySettings();
    expect(out).toHaveLength(4);
    const categories = out.map((s) => s.category).sort();
    expect(categories).toEqual([
      'HARM_CATEGORY_DANGEROUS_CONTENT',
      'HARM_CATEGORY_HARASSMENT',
      'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    ]);
    for (const s of out) {
      expect(s.threshold).toBe('BLOCK_MEDIUM_AND_ABOVE');
    }
  });

  it('defaultSafetySettings returns a fresh array each call (no shared reference)', () => {
    const { defaultSafetySettings } = require('../../lib/gemini-config');
    const a = defaultSafetySettings();
    const b = defaultSafetySettings();
    expect(a).not.toBe(b);
    a[0].threshold = 'MUTATED';
    expect(b[0].threshold).toBe('BLOCK_MEDIUM_AND_ABOVE');
  });

  it('MEDIA_RESOLUTION exposes the expected tiers and is frozen', () => {
    const { MEDIA_RESOLUTION } = require('../../lib/gemini-config');
    expect(MEDIA_RESOLUTION).toEqual({
      LOW: 'LOW',
      MEDIUM: 'MEDIUM',
      HIGH: 'HIGH',
      ULTRA_HIGH: 'ULTRA_HIGH',
    });
    expect(Object.isFrozen(MEDIA_RESOLUTION)).toBe(true);
  });

  it('buildGenerationConfig uses temperature 1.0 and 8192 maxOutputTokens by default', () => {
    const { buildGenerationConfig, DEFAULT_CHAT_TEMPERATURE } = require('../../lib/gemini-config');
    expect(DEFAULT_CHAT_TEMPERATURE).toBe(1.0);
    const cfg = buildGenerationConfig();
    expect(cfg).toEqual({ temperature: 1.0, maxOutputTokens: 8192 });
  });

  it('buildGenerationConfig allows overrides (including structured-output temperature)', () => {
    const { buildGenerationConfig, DEFAULT_STRUCTURED_TEMPERATURE } = require('../../lib/gemini-config');
    expect(DEFAULT_STRUCTURED_TEMPERATURE).toBe(0.4);
    const cfg = buildGenerationConfig({
      temperature: DEFAULT_STRUCTURED_TEMPERATURE,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
    });
    expect(cfg).toEqual({
      temperature: 0.4,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
    });
  });

  it('resolveChatModel defaults to gemini-3.1-pro-preview-customtools when ENV unset', () => {
    const { resolveChatModel } = require('../../lib/gemini-config');
    expect(resolveChatModel()).toBe('gemini-3.1-pro-preview-customtools');
  });

  it('resolveChatModel honors CHAT_MODEL env override with an allowed model', () => {
    process.env.CHAT_MODEL = 'gemini-3.1-pro-preview';
    const { resolveChatModel } = require('../../lib/gemini-config');
    expect(resolveChatModel()).toBe('gemini-3.1-pro-preview');
  });

  it('resolveChatModel reroutes legacy gemini-3-pro-preview ENV to customtools', () => {
    process.env.CHAT_MODEL = 'gemini-3-pro-preview';
    const { resolveChatModel } = require('../../lib/gemini-config');
    expect(resolveChatModel()).toBe('gemini-3.1-pro-preview-customtools');
  });

  it('resolveIdentifyModel defaults to customtools and honors IDENTIFY_MODEL ENV', () => {
    const cfgA = require('../../lib/gemini-config');
    expect(cfgA.resolveIdentifyModel()).toBe('gemini-3.1-pro-preview-customtools');

    process.env.IDENTIFY_MODEL = 'gemini-3.1-flash-lite';
    delete require.cache[require.resolve('../../lib/gemini-config')];
    const cfgB = require('../../lib/gemini-config');
    expect(cfgB.resolveIdentifyModel()).toBe('gemini-3.1-flash-lite');
  });

  it('resolveIntentModel defaults to FLASH_MODEL (gemini-3-flash-preview)', () => {
    const { resolveIntentModel, FLASH_MODEL } = require('../../lib/gemini-config');
    expect(resolveIntentModel()).toBe(FLASH_MODEL);
    expect(resolveIntentModel()).toBe('gemini-3-flash-preview');
  });
});
