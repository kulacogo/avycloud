/**
 * Tests for getStructuredModelName() — guards against the
 * "deprecated model + no retry" failure mode that caused the
 * AI image grouping to fall back to the 30 % heuristic on every
 * transient error (Incident 2026-04-30).
 *
 * The exported helper resolves the multimodal model lazily (per call)
 * via lib/model-select.js, so deprecated aliases are auto-mapped to
 * the supported preview model.
 */
const { getStructuredModelName } = require('../lib/gemini-structured');

describe('getStructuredModelName', () => {
  beforeEach(() => {
    delete process.env.GEMINI_MULTIMODAL_MODEL;
    delete process.env.GEMINI_STRUCTURED_MODEL;
  });

  afterEach(() => {
    delete process.env.GEMINI_MULTIMODAL_MODEL;
    delete process.env.GEMINI_STRUCTURED_MODEL;
  });

  it('returns the supported preview model when no env override is set', () => {
    expect(getStructuredModelName()).toBe('gemini-2.5-pro');
  });

  it('redirects gemini-3-pro-preview to gemini-2.5-pro (cost policy)', () => {
    process.env.GEMINI_MULTIMODAL_MODEL = 'gemini-3-pro-preview';
    expect(getStructuredModelName()).toBe('gemini-2.5-pro');
  });

  it('redirects gemini-3-flash-preview to gemini-2.5-flash (cost policy)', () => {
    process.env.GEMINI_MULTIMODAL_MODEL = 'gemini-3-flash-preview';
    expect(getStructuredModelName()).toBe('gemini-2.5-flash');
  });

  it('falls back to the supported preview model when the override is unknown', () => {
    process.env.GEMINI_MULTIMODAL_MODEL = 'unknown-model-xyz';
    expect(getStructuredModelName()).toBe('gemini-2.5-pro');
  });

  it('honours GEMINI_STRUCTURED_MODEL when GEMINI_MULTIMODAL_MODEL is unset', () => {
    process.env.GEMINI_STRUCTURED_MODEL = 'gemini-3-flash-preview';
    expect(getStructuredModelName()).toBe('gemini-2.5-flash');
  });
});
