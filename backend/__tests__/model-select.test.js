/**
 * Modell-Politik seit 2026-08-01 (Owner-Entscheid: Kostenexplosion Gemini 3):
 * ALLES löst auf Gemini 2.5 auf. Gemini-3-Namen werden aktiv auf ihre
 * 2.5-Entsprechung umgeleitet — auch wenn sie noch in ENV-Vars, Firestore-
 * Scopes oder Code-Literalen stehen. Die frühere Alias-Falle (2.5 → 3.1)
 * ist entfernt und darf NICHT zurückkommen.
 */
const { resolveModel } = require('../lib/model-select');

describe('model policy: Gemini 2.5 everywhere (Owner-Entscheid 2026-08-01)', () => {
  it('passes gemini-2.5-pro through unchanged (no silent upgrade to 3.x)', () => {
    expect(resolveModel('gemini-2.5-pro', 'X_UNSET')).toBe('gemini-2.5-pro');
  });

  it('passes gemini-2.5-flash through unchanged', () => {
    expect(resolveModel('gemini-2.5-flash', 'X_UNSET')).toBe('gemini-2.5-flash');
  });

  it('redirects gemini-3-flash-preview to gemini-2.5-flash', () => {
    expect(resolveModel('gemini-3-flash-preview', 'X_UNSET')).toBe('gemini-2.5-flash');
  });

  it('redirects gemini-3-pro-preview to gemini-2.5-pro', () => {
    expect(resolveModel('gemini-3-pro-preview', 'X_UNSET')).toBe('gemini-2.5-pro');
  });

  it('redirects gemini-3.1-pro-preview-customtools to gemini-2.5-pro', () => {
    expect(resolveModel('gemini-3.1-pro-preview-customtools', 'X_UNSET')).toBe('gemini-2.5-pro');
  });

  it('redirects gemini-3.1-pro-preview and gemini-3.1-flash-lite', () => {
    expect(resolveModel('gemini-3.1-pro-preview', 'X_UNSET')).toBe('gemini-2.5-pro');
    expect(resolveModel('gemini-3.1-flash-lite', 'X_UNSET')).toBe('gemini-2.5-flash');
  });

  it('generic aliases resolve to 2.5 models', () => {
    expect(resolveModel('pro', 'X_UNSET')).toBe('gemini-2.5-pro');
    expect(resolveModel('flash', 'X_UNSET')).toBe('gemini-2.5-flash');
    expect(resolveModel('mini', 'X_UNSET')).toBe('gemini-2.5-flash');
    expect(resolveModel('thinking', 'X_UNSET')).toBe('gemini-2.5-pro');
  });

  it('absolute fallback is gemini-2.5-pro, never a Gemini-3 model', () => {
    expect(resolveModel(undefined, 'X_UNSET', undefined)).toBe('gemini-2.5-pro');
    expect(resolveModel('garbage-model-name', 'X_UNSET', 'also-garbage')).toBe('gemini-2.5-pro');
  });

  it('ENV values with Gemini-3 names are redirected too (stale Cloud-Run pins)', () => {
    process.env.MODEL_SELECT_TEST_ENV = 'gemini-3-flash-preview';
    try {
      expect(resolveModel(undefined, 'MODEL_SELECT_TEST_ENV')).toBe('gemini-2.5-flash');
    } finally {
      delete process.env.MODEL_SELECT_TEST_ENV;
    }
  });

  it('no input can resolve to a gemini-3 model at all', () => {
    const inputs = [
      'gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-3.1-pro-preview',
      'gemini-3.1-pro-preview-customtools', 'gemini-3.1-flash-lite', 'gemini-3-pro',
      'gemini-3-flash', 'default', 'auto', 'standard', 'pro', 'flash', '', null, undefined,
    ];
    for (const input of inputs) {
      expect(resolveModel(input, 'X_UNSET')).not.toMatch(/^gemini-3/);
    }
  });
});
