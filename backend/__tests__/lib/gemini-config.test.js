// globals: true in vitest.config.js makes describe, it, expect, beforeEach, vi available globally
// Pure unit tests — no GCP patching needed, gemini-config only depends on model-select.
//
// Seit dem Owner-Entscheid 2026-08-26 loest die zentrale Modellpolitik
// (lib/model-select.js) ALLE Text-Modellnamen auf 'gemini-3.7-flash' auf.
// Die Konstanten DEFAULT_MODEL/FLASH_MODEL bleiben 'gemini-2.5-pro'/'gemini-2.5-flash'
// — sie sind nur noch FALLBACK-EINGABEN in resolveModel(), keine Ergebnisse.
// IMAGE_MODEL und resolveImageEnhanceModel sind von der Text-Politik AUSGENOMMEN.

const ORIGINAL_ENV = { ...process.env };

describe('gemini-config helpers', () => {
  beforeEach(() => {
    // Restore ENV before each test to avoid leakage
    delete process.env.CHAT_MODEL;
    delete process.env.IDENTIFY_MODEL;
    delete process.env.INTENT_MODEL;
    delete process.env.IDENTIFY_V4_MODEL;
    delete process.env.IDENTIFY_V4_IMAGE_MODEL;
    delete process.env.MODEL_POLICY;
    // Force re-require so process.env changes are re-read cleanly
    delete require.cache[require.resolve('../../lib/gemini-config')];
  });

  afterAll(() => {
    // Restore original ENV after the suite runs
    process.env = { ...ORIGINAL_ENV };
  });

  it('exports 2.5-named constants as pure fallback INPUTS (policy resolves them to 3.7)', () => {
    const cfg = require('../../lib/gemini-config');
    expect(cfg.DEFAULT_MODEL).toBe('gemini-2.5-pro');
    expect(cfg.FLASH_MODEL).toBe('gemini-2.5-flash');
    expect(cfg.IMAGE_MODEL).toBe('gemini-2.5-flash-image');
  });

  it('defaultThinkingConfig returns thinkingBudget syntax (no thinkingLevel — family-safe, live-verified on 3.7)', () => {
    const { defaultThinkingConfig } = require('../../lib/gemini-config');
    const out = defaultThinkingConfig();
    expect(out).toEqual({ thinkingBudget: 4096, includeThoughts: true });
    expect(out.thinkingLevel).toBeUndefined();
  });

  it('defaultThinkingConfig maps levels to budgets and honors includeThoughts', () => {
    const { defaultThinkingConfig } = require('../../lib/gemini-config');
    expect(defaultThinkingConfig({ includeThoughts: false, level: 'low' }))
      .toEqual({ thinkingBudget: 1024, includeThoughts: false });
    expect(defaultThinkingConfig({ level: 'medium' }))
      .toEqual({ thinkingBudget: 2048, includeThoughts: true });
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

  it('resolveChatModel defaults to gemini-3.7-flash when ENV unset (DEFAULT_MODEL is only the fallback input)', () => {
    const { resolveChatModel } = require('../../lib/gemini-config');
    expect(resolveChatModel()).toBe('gemini-3.7-flash');
  });

  it('resolveChatModel routes stale Gemini-3 CHAT_MODEL pins to gemini-3.7-flash', () => {
    process.env.CHAT_MODEL = 'gemini-3.1-pro-preview';
    const { resolveChatModel } = require('../../lib/gemini-config');
    expect(resolveChatModel()).toBe('gemini-3.7-flash');
  });

  it('resolveChatModel routes stale gemini-2.5 CHAT_MODEL pins to gemini-3.7-flash too', () => {
    process.env.CHAT_MODEL = 'gemini-2.5-pro';
    const { resolveChatModel } = require('../../lib/gemini-config');
    expect(resolveChatModel()).toBe('gemini-3.7-flash');
  });

  it('resolveIdentifyModel defaults to 3.7 and routes flash-lite pins there too', () => {
    const cfgA = require('../../lib/gemini-config');
    expect(cfgA.resolveIdentifyModel()).toBe('gemini-3.7-flash');

    process.env.IDENTIFY_MODEL = 'gemini-3.1-flash-lite';
    delete require.cache[require.resolve('../../lib/gemini-config')];
    const cfgB = require('../../lib/gemini-config');
    expect(cfgB.resolveIdentifyModel()).toBe('gemini-3.7-flash');
  });

  it('resolveIntentModel resolves to gemini-3.7-flash (FLASH_MODEL is only the fallback input)', () => {
    const { resolveIntentModel, FLASH_MODEL } = require('../../lib/gemini-config');
    expect(FLASH_MODEL).toBe('gemini-2.5-flash');
    expect(resolveIntentModel()).toBe('gemini-3.7-flash');
  });

  it('resolveIdentifyV4Model() defaults to gemini-3.7-flash', () => {
    const { resolveIdentifyV4Model } = require('../../lib/gemini-config');
    expect(resolveIdentifyV4Model()).toBe('gemini-3.7-flash');
  });

  it('resolveIdentifyV4Model() routes IDENTIFY_V4_MODEL Gemini-3 pins to 3.7', () => {
    process.env.IDENTIFY_V4_MODEL = 'gemini-3.1-flash-lite';
    delete require.cache[require.resolve('../../lib/gemini-config')];
    const { resolveIdentifyV4Model } = require('../../lib/gemini-config');
    expect(resolveIdentifyV4Model()).toBe('gemini-3.7-flash');
  });

  it('Notbremse MODEL_POLICY=gemini25 restores 2.5 resolutions for the text resolvers', () => {
    process.env.MODEL_POLICY = 'gemini25';
    const cfg = require('../../lib/gemini-config');
    expect(cfg.resolveChatModel()).toBe('gemini-2.5-pro');
    expect(cfg.resolveIntentModel()).toBe('gemini-2.5-flash');
    expect(cfg.resolveIdentifyV4Model()).toBe('gemini-2.5-pro');
  });

  it('resolveImageEnhanceModel() defaults to gemini-2.5-flash-image (image models exempt from text policy)', () => {
    const { resolveImageEnhanceModel } = require('../../lib/gemini-config');
    expect(resolveImageEnhanceModel()).toBe('gemini-2.5-flash-image');
  });

  it('resolveImageEnhanceModel() respects IDENTIFY_V4_IMAGE_MODEL env override verbatim', () => {
    process.env.IDENTIFY_V4_IMAGE_MODEL = 'gemini-3-pro-image-preview-experimental';
    delete require.cache[require.resolve('../../lib/gemini-config')];
    const { resolveImageEnhanceModel } = require('../../lib/gemini-config');
    expect(resolveImageEnhanceModel()).toBe('gemini-3-pro-image-preview-experimental');
  });
});
