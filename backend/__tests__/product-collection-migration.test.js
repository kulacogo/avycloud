/**
 * Verify PRODUCTS_COLLECTION switches based on USE_PRODUCTS_V2 env var.
 *
 * Since the constant is set at module load time, we must clear require.cache
 * and re-require firestore.js for each scenario.
 */

// ─── GCP mocks (must be loaded before firestore.js) ─────────────────────────
require('./api/_patchGcp');

const firestorePath = require.resolve('../lib/firestore');

function loadFirestoreModule(envValue) {
  // Set or clear the env var
  if (envValue !== undefined) {
    process.env.USE_PRODUCTS_V2 = envValue;
  } else {
    delete process.env.USE_PRODUCTS_V2;
  }

  // Clear cached module so it re-evaluates the constant
  delete require.cache[firestorePath];

  const mod = require(firestorePath);
  return mod;
}

describe('PRODUCTS_COLLECTION migration', () => {
  const originalEnv = process.env.USE_PRODUCTS_V2;

  afterAll(() => {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env.USE_PRODUCTS_V2 = originalEnv;
    } else {
      delete process.env.USE_PRODUCTS_V2;
    }
    // Reload with original env so other tests are unaffected
    delete require.cache[firestorePath];
  });

  it('uses products_v2 when USE_PRODUCTS_V2=true', () => {
    const { PRODUCTS_COLLECTION } = loadFirestoreModule('true');
    expect(PRODUCTS_COLLECTION).toBe('products_v2');
  });

  it('uses products when USE_PRODUCTS_V2 is not set', () => {
    const { PRODUCTS_COLLECTION } = loadFirestoreModule(undefined);
    expect(PRODUCTS_COLLECTION).toBe('products');
  });

  it('uses products when USE_PRODUCTS_V2=false', () => {
    const { PRODUCTS_COLLECTION } = loadFirestoreModule('false');
    expect(PRODUCTS_COLLECTION).toBe('products');
  });

  it('uses products_v2 when USE_PRODUCTS_V2=1', () => {
    const { PRODUCTS_COLLECTION } = loadFirestoreModule('1');
    expect(PRODUCTS_COLLECTION).toBe('products_v2');
  });

  it('uses products_v2 when USE_PRODUCTS_V2=yes', () => {
    const { PRODUCTS_COLLECTION } = loadFirestoreModule('yes');
    expect(PRODUCTS_COLLECTION).toBe('products_v2');
  });

  it('uses products_v2 when USE_PRODUCTS_V2=on', () => {
    const { PRODUCTS_COLLECTION } = loadFirestoreModule('on');
    expect(PRODUCTS_COLLECTION).toBe('products_v2');
  });

  it('exports PRODUCTS_COLLECTION', () => {
    const mod = loadFirestoreModule('true');
    expect(mod).toHaveProperty('PRODUCTS_COLLECTION');
  });
});
