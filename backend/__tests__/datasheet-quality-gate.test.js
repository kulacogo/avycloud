/**
 * Tests for Quality Gate default activation (evaluateEbayReady).
 *
 * Setup: Patch GCP deps, then require datasheet-quality.js.
 */

require('./api/_patchGcp');

const qualityPath = require.resolve('../lib/datasheet-quality');

function loadModule(envValue) {
  if (envValue !== undefined) {
    process.env.QUALITY_GATE_ENABLED = envValue;
  } else {
    delete process.env.QUALITY_GATE_ENABLED;
  }
  delete require.cache[qualityPath];
  return require(qualityPath);
}

describe('evaluateEbayReady — Quality Gate default ON', () => {
  const originalEnv = process.env.QUALITY_GATE_ENABLED;

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.QUALITY_GATE_ENABLED = originalEnv;
    } else {
      delete process.env.QUALITY_GATE_ENABLED;
    }
    delete require.cache[qualityPath];
  });

  it('gate is active by default (no env set)', () => {
    const { evaluateEbayReady } = loadModule(undefined);
    // Product with missing title — should fail when gate is active
    const result = evaluateEbayReady({ identification: {}, details: {} });
    expect(result.ok).toBe(false);
  });

  it('gate is active when QUALITY_GATE_ENABLED=true', () => {
    const { evaluateEbayReady } = loadModule('true');
    const result = evaluateEbayReady({ identification: {}, details: {} });
    expect(result.ok).toBe(false);
  });

  it('gate is bypassed when QUALITY_GATE_ENABLED=false', () => {
    const { evaluateEbayReady } = loadModule('false');
    const result = evaluateEbayReady({ identification: {}, details: {} });
    expect(result.ok).toBe(true);
  });

  it('gate is bypassed when QUALITY_GATE_ENABLED=0', () => {
    const { evaluateEbayReady } = loadModule('0');
    const result = evaluateEbayReady({ identification: {}, details: {} });
    expect(result.ok).toBe(true);
  });

  it('product without title fails when gate active', () => {
    const { evaluateEbayReady } = loadModule(undefined);
    const result = evaluateEbayReady({
      identification: { name: '' },
      details: { short_description: 'A valid description with enough content.' },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('force=true overrides disabled gate', () => {
    const { evaluateEbayReady } = loadModule('false');
    const result = evaluateEbayReady(
      { identification: {}, details: {} },
      { force: true }
    );
    expect(result.ok).toBe(false);
  });
});
