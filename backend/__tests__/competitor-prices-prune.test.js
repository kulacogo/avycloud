'use strict';

// Regression for the prod crash loop observed 2026-06-29:
//   [competitor-prices] storeCompetitorPricesToProduct failed: Cannot use
//   "undefined" as a Firestore value (found in field
//   "details.pricing.competitorPrices.0.seller")
// The competitor refresh runner re-fired this failing write every ~2s, burning
// the request-instance event loop + Firestore quota. Root fix is a deep prune of
// undefined at the Firestore write boundary (defense in depth).

const { pruneUndefinedDeep } = require('../lib/competitor-prices');

describe('pruneUndefinedDeep', () => {
  it('removes undefined object properties at all depths', () => {
    const input = { a: 1, b: undefined, c: { d: undefined, e: 2 } };
    expect(pruneUndefinedDeep(input)).toEqual({ a: 1, c: { e: 2 } });
  });

  it('strips undefined inside array items (the exact Firestore rejection)', () => {
    const input = [
      { seller: undefined, price: 9.99 },
      { seller: 'shop', price: undefined },
    ];
    expect(pruneUndefinedDeep(input)).toEqual([{ price: 9.99 }, { seller: 'shop' }]);
  });

  it('preserves null, 0, empty string and false (only undefined is dropped)', () => {
    const input = { a: null, b: 0, c: '', d: false, e: undefined };
    expect(pruneUndefinedDeep(input)).toEqual({ a: null, b: 0, c: '', d: false });
  });

  it('returns primitives untouched', () => {
    expect(pruneUndefinedDeep('x')).toBe('x');
    expect(pruneUndefinedDeep(7)).toBe(7);
    expect(pruneUndefinedDeep(null)).toBe(null);
  });
});
