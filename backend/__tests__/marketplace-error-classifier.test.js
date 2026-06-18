'use strict';

const {
  classifyMarketplaceError,
  MARKETPLACE_ERROR_CLASSES,
} = require('../lib/marketplace-error-classifier');

describe('classifyMarketplaceError', () => {
  // ── invariant: closed set of classes, NONE destructive ──────────────
  it('exposes exactly 5 classes, none of them destructive', () => {
    expect(MARKETPLACE_ERROR_CLASSES).toEqual(
      expect.arrayContaining(['rate_limited', 'transient', 'listing_config', 'auth', 'unknown'])
    );
    expect(MARKETPLACE_ERROR_CLASSES).toHaveLength(5);
    for (const cls of MARKETPLACE_ERROR_CLASSES) {
      expect(['end', 'delete', 'remove', 'end_listing']).not.toContain(cls);
    }
  });

  // ── rate-limit / quota ──────────────────────────────────────────────
  it.each([
    'exceeded usage limit',
    'Call limit exceeded',
    'Too Many Requests',
    'HTTP 429',
    'eBay daily quota reached',
  ])('classifies %p as rate_limited', (msg) => {
    expect(classifyMarketplaceError(msg).class).toBe('rate_limited');
  });

  // ── listing config (incl. the Best-Offer incident) ──────────────────
  it.each([
    'The auto-decline amount must be less than the Buy It Now price',
    'Best Offer auto-decline price is greater than the listing price',
    'Missing required item aspect: Brand',
    'Invalid category for this item',
  ])('classifies listing/config error %p as listing_config', (msg) => {
    expect(classifyMarketplaceError(msg).class).toBe('listing_config');
  });

  it('maps the Best-Offer auto-decline incident to listing_config and NOT retryable', () => {
    const res = classifyMarketplaceError('auto-decline amount must be less than the Buy It Now price');
    expect(res.class).toBe('listing_config');
    expect(res.retryable).toBe(false);
  });

  // ── transient ───────────────────────────────────────────────────────
  it.each([
    'ETIMEDOUT',
    'socket hang up',
    'ECONNRESET',
    '503 Service Unavailable',
    'Gateway Timeout (504)',
    'temporarily unavailable, please try again',
  ])('classifies %p as transient', (msg) => {
    expect(classifyMarketplaceError(msg).class).toBe('transient');
  });

  // ── auth ────────────────────────────────────────────────────────────
  it.each([
    'Invalid IAF token',
    'Auth token is hard expired',
    '401 Unauthorized',
    'invalid_grant',
  ])('classifies %p as auth', (msg) => {
    expect(classifyMarketplaceError(msg).class).toBe('auth');
  });

  // ── unknown fallback ────────────────────────────────────────────────
  it('falls back to unknown for unrecognised errors', () => {
    expect(classifyMarketplaceError('something nobody has seen before').class).toBe('unknown');
  });

  // ── input shapes ────────────────────────────────────────────────────
  it('accepts an object {message} as well as a raw string', () => {
    expect(classifyMarketplaceError({ message: 'exceeded usage limit' }).class).toBe('rate_limited');
    expect(classifyMarketplaceError({ error: 'ETIMEDOUT' }).class).toBe('transient');
  });

  it('uses httpStatus when no message keyword matches (429→rate_limited, 503→transient)', () => {
    expect(classifyMarketplaceError({ message: '', httpStatus: 429 }).class).toBe('rate_limited');
    expect(classifyMarketplaceError({ message: '', httpStatus: 503 }).class).toBe('transient');
    expect(classifyMarketplaceError({ message: '', httpStatus: 401 }).class).toBe('auth');
  });

  it('never throws and returns unknown for null/undefined/empty', () => {
    expect(classifyMarketplaceError(null).class).toBe('unknown');
    expect(classifyMarketplaceError(undefined).class).toBe('unknown');
    expect(classifyMarketplaceError('').class).toBe('unknown');
    expect(classifyMarketplaceError({}).class).toBe('unknown');
  });

  // ── the core safety property ────────────────────────────────────────
  it('NEVER returns a destructive class or action — even for scary inputs', () => {
    const scary = [
      'item was ended',
      'EndFixedPriceItem failed',
      'listing deleted',
      'remove this listing now',
      'exceeded usage limit',
      'auto-decline amount must be less than the Buy It Now price',
      'totally unrecognised garbage',
      null,
      { message: 'delete everything', httpStatus: 500 },
    ];
    for (const input of scary) {
      const res = classifyMarketplaceError(input);
      expect(MARKETPLACE_ERROR_CLASSES).toContain(res.class);
      expect(res.destructive).toBe(false);
      expect(['end', 'delete', 'remove', 'end_listing']).not.toContain(res.class);
    }
  });
});
