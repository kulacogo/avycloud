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

  it('v3-pipeline flag does not alter quality evaluation — sparse v3 product still fails', () => {
    // Task 13 from identify-v3 plan: verify evaluateEbayReady treats v3-labeled
    // products with the same rigor as v2-labeled (no special bypass).
    const { evaluateEbayReady } = loadModule(undefined);
    const v3Sparse = evaluateEbayReady({
      identification: { name: 'Unvollständiges V3-Produkt' },
      details: {},
      ops: { identify_pipeline: 'v3' },
    });
    expect(v3Sparse.ok).toBe(false);
    expect(v3Sparse.issues.length).toBeGreaterThan(0);
  });

  it('v3-pipeline flag does not bypass title-policy when short', () => {
    const { evaluateEbayReady } = loadModule(undefined);
    const result = evaluateEbayReady({
      identification: {
        name: 'Kurztitel',
        brand: 'X',
        category: 'A > B',
      },
      details: {
        categoryId: '14969',
        short_description: 'x'.repeat(300),
        key_features: ['a', 'b', 'c', 'd', 'e'],
        images: [{ url_or_base64: 'https://example.com/x.jpg', source: 'upload', variant: 'reference' }],
        pricing: { sellPrice: 10, currency: 'EUR', lowest_price: { amount: 9, sources: ['https://a', 'https://b'] } },
        attributes: { Marke: 'X', Modell: 'Y', Farbe: 'Z', Material: 'M', Größe: 'L' },
      },
      ops: { identify_pipeline: 'v3' },
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContain('title_too_short');
  });
});
