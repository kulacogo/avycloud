const { sanitizeIdentityValue, computeProductIdentityKey, buildIdentityAliasSet } = require('../product-identity');

describe('sanitizeIdentityValue', () => {
  it('returns null for empty or falsy values', () => {
    expect(sanitizeIdentityValue('')).toBe(null);
    expect(sanitizeIdentityValue(null)).toBe(null);
    expect(sanitizeIdentityValue(undefined)).toBe(null);
  });

  it('normalizes and lowercases strings', () => {
    const result = sanitizeIdentityValue('  HELLO World  ');
    expect(result).toBe('hello world');
  });

  it('removes diacritics', () => {
    const result = sanitizeIdentityValue('café');
    expect(result).toBe('cafe');
  });

  it('replaces & with und', () => {
    const result = sanitizeIdentityValue('A&B');
    expect(result).toBe('a und b');
  });

  it('removes special characters', () => {
    const result = sanitizeIdentityValue('TEST@#$%');
    expect(result).toBe('test');
  });
});

describe('computeProductIdentityKey', () => {
  it('returns null for empty product', () => {
    expect(computeProductIdentityKey({})).toBe(null);
  });

  it('returns base: key when base_product_id exists', () => {
    const product = { ops: { base_product_id: 'ABC123' } };
    const key = computeProductIdentityKey(product);
    expect(key).toMatch(/^base:/);
  });

  it('returns identity: hash for products with name + brand', () => {
    const product = {
      identification: {
        name: 'Test Product',
        brand: 'TestBrand',
      },
    };
    const key = computeProductIdentityKey(product);
    expect(key).toMatch(/^identity:/);
  });

  it('returns consistent hash for same input', () => {
    const product = {
      identification: { name: 'Test', brand: 'Brand' },
    };
    const key1 = computeProductIdentityKey(product);
    const key2 = computeProductIdentityKey(product);
    expect(key1).toBe(key2);
  });
});

describe('buildIdentityAliasSet', () => {
  it('returns array for empty product', () => {
    const aliases = buildIdentityAliasSet({});
    expect(Array.isArray(aliases)).toBe(true);
  });

  it('includes product id in aliases', () => {
    const aliases = buildIdentityAliasSet({ id: 'test-123' });
    expect(aliases.some(a => a.includes('test'))).toBe(true);
  });

  it('respects limit option', () => {
    const product = {
      id: 'test',
      identification: { name: 'Very Long Product Name With Many Words', brand: 'TestBrand', sku: 'SKU-001' },
    };
    const aliases = buildIdentityAliasSet(product, { limit: 5 });
    expect(aliases.length).toBeLessThanOrEqual(5);
  });
});
