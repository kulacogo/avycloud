'use strict';

const { guardListingPrice, DEFAULT_BEST_OFFER_MARGIN } = require('../lib/best-offer-guard');

describe('guardListingPrice (never push BIN ≤ Best-Offer auto-decline threshold)', () => {
  it('is safe when the new price is comfortably above the auto-decline threshold', () => {
    const r = guardListingPrice({ newPrice: 20, autoDeclineThreshold: 10 });
    expect(r.safe).toBe(true);
  });

  it('is UNSAFE when the new price is at the threshold (the listing would jam)', () => {
    const r = guardListingPrice({ newPrice: 10, autoDeclineThreshold: 10 });
    expect(r.safe).toBe(false);
    expect(r.reason).toBe('price-at-or-below-auto-decline');
  });

  it('is UNSAFE when the new price is below the threshold', () => {
    const r = guardListingPrice({ newPrice: 8, autoDeclineThreshold: 10 });
    expect(r.safe).toBe(false);
  });

  it('exposes the minimum safe price (threshold + margin) so the caller may clamp', () => {
    const r = guardListingPrice({ newPrice: 8, autoDeclineThreshold: 10, margin: 1 });
    expect(r.minSafePrice).toBe(11); // 10 + margin 1
    expect(r.threshold).toBe(10);
  });

  it('uses the default margin when none is given', () => {
    const r = guardListingPrice({ newPrice: 10, autoDeclineThreshold: 10 });
    expect(r.minSafePrice).toBeCloseTo(10 + DEFAULT_BEST_OFFER_MARGIN, 5);
  });

  it('cannot guard when the threshold is unknown → treated as safe but flagged', () => {
    const r = guardListingPrice({ newPrice: 8, autoDeclineThreshold: null });
    expect(r.safe).toBe(true);
    expect(r.reason).toBe('no-threshold-known');
  });

  it('ignores a non-positive / invalid threshold (no Best Offer configured)', () => {
    expect(guardListingPrice({ newPrice: 8, autoDeclineThreshold: 0 }).safe).toBe(true);
    expect(guardListingPrice({ newPrice: 8, autoDeclineThreshold: NaN }).safe).toBe(true);
    expect(guardListingPrice({ newPrice: 8, autoDeclineThreshold: 'x' }).safe).toBe(true);
  });

  it('treats a missing/invalid newPrice as not-evaluable (safe, flagged) — never blocks blindly', () => {
    const r = guardListingPrice({ newPrice: null, autoDeclineThreshold: 10 });
    expect(r.safe).toBe(true);
    expect(r.reason).toBe('no-price');
  });

  it('echoes the inputs for telemetry/diff', () => {
    const r = guardListingPrice({ newPrice: 9, autoDeclineThreshold: 10 });
    expect(r.newPrice).toBe(9);
    expect(r.threshold).toBe(10);
    expect(r.safe).toBe(false);
  });
});
