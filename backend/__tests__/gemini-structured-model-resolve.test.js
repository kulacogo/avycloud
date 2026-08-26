/**
 * Tests for getStructuredModelName() — guards against the
 * "deprecated model + no retry" failure mode that caused the
 * AI image grouping to fall back to the 30 % heuristic on every
 * transient error (Incident 2026-04-30).
 *
 * The exported helper resolves the multimodal model lazily (per call)
 * via lib/model-select.js. Seit dem Owner-Entscheid 2026-08-26 loest die
 * zentrale Politik ALLE Text-Modellnamen (2.5-Pins wie Gemini-3-Namen)
 * auf 'gemini-3.7-flash' auf; die Notbremse MODEL_POLICY='gemini25'
 * stellt die alte 2.5-Politik wieder her.
 */
const { getStructuredModelName } = require('../lib/gemini-structured');

describe('getStructuredModelName', () => {
  beforeEach(() => {
    delete process.env.GEMINI_MULTIMODAL_MODEL;
    delete process.env.GEMINI_STRUCTURED_MODEL;
    delete process.env.MODEL_POLICY;
  });

  afterEach(() => {
    delete process.env.GEMINI_MULTIMODAL_MODEL;
    delete process.env.GEMINI_STRUCTURED_MODEL;
    delete process.env.MODEL_POLICY;
  });

  it('returns the policy model when no env override is set', () => {
    expect(getStructuredModelName()).toBe('gemini-3.7-flash');
  });

  it('redirects gemini-3-pro-preview to gemini-3.7-flash (model policy 2026-08-26)', () => {
    process.env.GEMINI_MULTIMODAL_MODEL = 'gemini-3-pro-preview';
    expect(getStructuredModelName()).toBe('gemini-3.7-flash');
  });

  it('redirects gemini-3-flash-preview to gemini-3.7-flash (model policy 2026-08-26)', () => {
    process.env.GEMINI_MULTIMODAL_MODEL = 'gemini-3-flash-preview';
    expect(getStructuredModelName()).toBe('gemini-3.7-flash');
  });

  it('redirects stale gemini-2.5 pins to gemini-3.7-flash too', () => {
    process.env.GEMINI_MULTIMODAL_MODEL = 'gemini-2.5-pro';
    expect(getStructuredModelName()).toBe('gemini-3.7-flash');

    process.env.GEMINI_MULTIMODAL_MODEL = 'gemini-2.5-flash';
    expect(getStructuredModelName()).toBe('gemini-3.7-flash');
  });

  it('falls back to the policy model when the override is unknown', () => {
    process.env.GEMINI_MULTIMODAL_MODEL = 'unknown-model-xyz';
    expect(getStructuredModelName()).toBe('gemini-3.7-flash');
  });

  it('honours GEMINI_STRUCTURED_MODEL when GEMINI_MULTIMODAL_MODEL is unset', () => {
    process.env.GEMINI_STRUCTURED_MODEL = 'gemini-3-flash-preview';
    expect(getStructuredModelName()).toBe('gemini-3.7-flash');
  });

  it('Notbremse MODEL_POLICY=gemini25 restores the 2.5 policy at this chokepoint', () => {
    process.env.MODEL_POLICY = 'gemini25';
    expect(getStructuredModelName()).toBe('gemini-2.5-pro');

    process.env.GEMINI_MULTIMODAL_MODEL = 'gemini-3-flash-preview';
    expect(getStructuredModelName()).toBe('gemini-2.5-flash');
  });
});
