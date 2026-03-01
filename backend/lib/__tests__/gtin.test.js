const { normalizeDigits, computeCheckDigit, isValidGtin, getGtinType } = require('../gtin');

describe('normalizeDigits', () => {
  it('returns empty string for empty input', () => {
    expect(normalizeDigits('')).toBe('');
  });

  it('strips non-digit characters', () => {
    expect(normalizeDigits('123-456-789')).toBe('123456789');
    expect(normalizeDigits('EAN123ABC456')).toBe('123456');
    expect(normalizeDigits('123 456 789')).toBe('123456789');
  });

  it('returns digits unchanged', () => {
    expect(normalizeDigits('5901234123457')).toBe('5901234123457');
  });
});

describe('computeCheckDigit', () => {
  it('computes correct check digit for EAN-13', () => {
    // computeCheckDigit expects the full barcode, skips last digit in calculation
    expect(computeCheckDigit('5901234123457')).toBe(7);
  });

  it('computes correct check digit for EAN-8', () => {
    expect(computeCheckDigit('96385074')).toBe(4);
  });

  it('returns null for non-numeric input', () => {
    expect(computeCheckDigit('12a34')).toBe(null);
  });
});

describe('isValidGtin', () => {
  it('validates correct EAN-13', () => {
    expect(isValidGtin('5901234123457')).toBe(true);
  });

  it('validates correct EAN-8', () => {
    expect(isValidGtin('96385074')).toBe(true);
  });

  it('rejects invalid check digit', () => {
    expect(isValidGtin('5901234123458')).toBe(false);
  });

  it('rejects wrong length', () => {
    expect(isValidGtin('123456')).toBe(false);
  });

  it('rejects empty input', () => {
    expect(isValidGtin('')).toBe(false);
  });

  it('handles formatted input with dashes', () => {
    expect(isValidGtin('5901-2341-2345-7')).toBe(true);
  });
});

describe('getGtinType', () => {
  it('detects EAN-13', () => {
    expect(getGtinType('5901234123457')).toBe('ean13');
  });

  it('detects EAN-8', () => {
    expect(getGtinType('96385074')).toBe('ean8');
  });

  it('detects UPC-12', () => {
    expect(getGtinType('123456789012')).toBe('upc12');
  });

  it('detects GTIN-14', () => {
    expect(getGtinType('10012000067962')).toBe('gtin14');
  });

  it('returns null for invalid length', () => {
    expect(getGtinType('123456')).toBe(null);
    expect(getGtinType('')).toBe(null);
  });
});
