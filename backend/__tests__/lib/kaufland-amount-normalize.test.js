'use strict';

/**
 * Regression (2026-07): German-formatted Kaufland booking amounts with a
 * thousands separator ("1.234,56") were converted via
 * `replace(/\s/g,'').replace(',','.')` → "1.234.56" → Number() = NaN → the
 * amount was silently dropped (payout under-count + lost refund).
 *
 * Fix: strip whitespace → remove thousands dots → convert decimal comma. Pure
 * integers (no comma) must survive unchanged.
 */

const { normalizeGermanAmount, toPriceCents } = require('../../lib/kaufland-api');

describe('normalizeGermanAmount', () => {
  it('recovers a thousands-separated German amount ("1.234,56" → 1234.56)', () => {
    expect(normalizeGermanAmount('1.234,56')).toBe('1234.56');
    expect(Number(normalizeGermanAmount('1.234,56'))).toBe(1234.56);
    expect(toPriceCents(normalizeGermanAmount('1.234,56'))).toBe(123456);
  });

  it('handles a plain decimal comma ("123,45" → 123.45)', () => {
    expect(normalizeGermanAmount('123,45')).toBe('123.45');
    expect(toPriceCents(normalizeGermanAmount('123,45'))).toBe(12345);
  });

  it('handles multiple thousands groups ("1.000.000,00")', () => {
    expect(normalizeGermanAmount(' 1.000.000,00 ')).toBe('1000000.00');
    expect(toPriceCents(normalizeGermanAmount('1.000.000,00'))).toBe(100000000);
  });

  it('leaves a pure integer amount intact ("12345")', () => {
    expect(normalizeGermanAmount('12345')).toBe('12345');
    expect(toPriceCents(normalizeGermanAmount('12345'))).toBe(1234500);
  });

  it('handles a negative German amount ("-1.234,56")', () => {
    expect(normalizeGermanAmount('-1.234,56')).toBe('-1234.56');
    expect(toPriceCents(normalizeGermanAmount('-1.234,56'))).toBe(-123456);
  });

  it('passes non-string (already numeric) values through unchanged', () => {
    expect(normalizeGermanAmount(1234.56)).toBe(1234.56);
    expect(toPriceCents(normalizeGermanAmount(1234.56))).toBe(123456);
  });

  it('the OLD conversion produced NaN for thousands amounts (bug demonstration)', () => {
    const oldPath = '1.234,56'.replace(/\s/g, '').replace(',', '.');
    expect(Number(oldPath)).toBeNaN();
    expect(toPriceCents(oldPath)).toBeNull();
    // New path recovers the value.
    expect(toPriceCents(normalizeGermanAmount('1.234,56'))).toBe(123456);
  });
});
