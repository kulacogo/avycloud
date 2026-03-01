const { normalizeBrandDisplayCase } = require('../brand-normalize');

describe('normalizeBrandDisplayCase', () => {
  it('returns empty string for empty input', () => {
    expect(normalizeBrandDisplayCase('')).toBe('');
    expect(normalizeBrandDisplayCase('  ')).toBe('');
  });

  it('uppercases short vowel-less words (acronyms)', () => {
    expect(normalizeBrandDisplayCase('bmw')).toBe('BMW');
    expect(normalizeBrandDisplayCase('hp')).toBe('HP');
  });

  it('title-cases lowercase words with vowels', () => {
    expect(normalizeBrandDisplayCase('adidas')).toBe('Adidas');
    expect(normalizeBrandDisplayCase('apple')).toBe('Apple');
  });

  it('preserves already uppercase brands', () => {
    expect(normalizeBrandDisplayCase('BOSCH')).toBe('BOSCH');
  });

  it('preserves mixed-case stylized brands', () => {
    expect(normalizeBrandDisplayCase('iPhone')).toBe('iPhone');
    expect(normalizeBrandDisplayCase('eBay')).toBe('eBay');
  });

  it('uses title hint for casing when available', () => {
    const result = normalizeBrandDisplayCase('adidas', { titleHint: 'ADIDAS Sneakers' });
    expect(result).toBe('ADIDAS');
  });

  it('trims whitespace', () => {
    expect(normalizeBrandDisplayCase('   bmw   ')).toBe('BMW');
  });

  it('handles multi-word brands', () => {
    const result = normalizeBrandDisplayCase('new balance');
    expect(result).toBe('New Balance');
  });
});
