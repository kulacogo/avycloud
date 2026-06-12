'use strict';

/**
 * Regression: marketplace tracking-push must NOT loop forever.
 *
 * Incident 2026-06-12: shipped orders whose tracking-push kept failing
 * (Kaufland "Validation Failed" permanently, eBay "exceeded usage limit"
 * transiently) were re-pushed dozens of times/hour across the in-memory timer +
 * ensure + catch-up triggers. That drained the shared eBay Trading-API quota,
 * which in turn blocked GetOrders (order intake) AND CompleteSale (tracking) —
 * "nothing syncs". The retry MUST be capped, permanent errors abandoned, and
 * rate-limit errors deferred (not retried immediately).
 */

const {
  deriveMarketplacePushStatus,
  isRateLimitedError,
  isPermanentPushError,
  MAX_PUSH_ATTEMPTS,
} = require('../services/marketplace-tracking');

describe('marketplace-tracking retry cap', () => {
  it('ok result → success, attempts unchanged', () => {
    const r = deriveMarketplacePushStatus({ ok: true, prevAttempts: 2 });
    expect(r.status).toBe('success');
    expect(r.attempts).toBe(2);
    expect(r.rateLimited).toBe(false);
  });

  it('permanent error (Kaufland "Validation Failed") → abandoned immediately', () => {
    const r = deriveMarketplacePushStatus({ ok: false, error: 'Validation Failed', prevAttempts: 0 });
    expect(r.status).toBe('abandoned');
    expect(r.permanent).toBe(true);
  });

  it('rate-limited error → failed + rateLimited flag so the caller defers (no immediate retry)', () => {
    const r = deriveMarketplacePushStatus({
      ok: false,
      error: 'Your application has exceeded usage limit on this call, please make call to GetAPIAccessRules',
      prevAttempts: 1,
    });
    expect(r.status).toBe('failed');
    expect(r.rateLimited).toBe(true);
    expect(r.attempts).toBe(2);
  });

  it('transient error under cap → failed, retry allowed', () => {
    const r = deriveMarketplacePushStatus({ ok: false, error: 'socket hang up', prevAttempts: 1 });
    expect(r.status).toBe('failed');
    expect(r.rateLimited).toBe(false);
    expect(r.permanent).toBe(false);
    expect(r.attempts).toBe(2);
  });

  it('reaching MAX_PUSH_ATTEMPTS → abandoned (breaks the infinite loop)', () => {
    const r = deriveMarketplacePushStatus({ ok: false, error: 'socket hang up', prevAttempts: MAX_PUSH_ATTEMPTS - 1 });
    expect(r.status).toBe('abandoned');
    expect(r.attempts).toBe(MAX_PUSH_ATTEMPTS);
  });

  it('detects the production error signatures', () => {
    expect(isRateLimitedError('exceeded usage limit on this call')).toBe(true);
    expect(isRateLimitedError('429 Too Many Requests')).toBe(true);
    expect(isRateLimitedError('some other error')).toBe(false);
    expect(isPermanentPushError('Validation Failed')).toBe(true);
    expect(isPermanentPushError('No eBay order ID')).toBe(true);
    expect(isPermanentPushError('transient timeout')).toBe(false);
  });
});
