'use strict';

const {
  computeNextRetryAt,
  computeBackoffMs,
  MAX_BACKOFF_MS,
} = require('../lib/retry-backoff');

const NOW = Date.parse('2026-06-18T12:00:00.000Z');
const SEC = 1000;

describe('computeBackoffMs', () => {
  it('follows 60/120/240… exponential doubling', () => {
    expect(computeBackoffMs(1)).toBe(60 * SEC);
    expect(computeBackoffMs(2)).toBe(120 * SEC);
    expect(computeBackoffMs(3)).toBe(240 * SEC);
    expect(computeBackoffMs(4)).toBe(480 * SEC);
    expect(computeBackoffMs(5)).toBe(960 * SEC);
  });

  it('caps at 30 minutes', () => {
    expect(MAX_BACKOFF_MS).toBe(30 * 60 * SEC);
    expect(computeBackoffMs(6)).toBe(MAX_BACKOFF_MS); // 1920s → capped to 1800s
    expect(computeBackoffMs(20)).toBe(MAX_BACKOFF_MS);
  });

  it('treats attempts <= 0 as the first attempt (60s)', () => {
    expect(computeBackoffMs(0)).toBe(60 * SEC);
    expect(computeBackoffMs(-3)).toBe(60 * SEC);
  });
});

describe('computeNextRetryAt', () => {
  it('returns an ISO string now + backoff for a transient failure', () => {
    const out = computeNextRetryAt({ attempts: 1, now: NOW, classification: 'transient' });
    expect(out).toBe(new Date(NOW + 60 * SEC).toISOString());
  });

  it('uses the doubled backoff on later attempts', () => {
    expect(computeNextRetryAt({ attempts: 3, now: NOW, classification: 'transient' }))
      .toBe(new Date(NOW + 240 * SEC).toISOString());
  });

  it('caps the schedule at 30 minutes', () => {
    expect(computeNextRetryAt({ attempts: 10, now: NOW, classification: 'transient' }))
      .toBe(new Date(NOW + MAX_BACKOFF_MS).toISOString());
  });

  // ── rate_limited must never retry before the quota cooldown ends ─────
  it('for rate_limited, waits until quotaUntil when that is later than backoff', () => {
    const quotaUntil = NOW + 20 * 60 * SEC; // 20 min out, beyond a 60s backoff
    const out = computeNextRetryAt({ attempts: 1, now: NOW, classification: 'rate_limited', quotaUntil });
    expect(out).toBe(new Date(quotaUntil).toISOString());
  });

  it('for rate_limited, uses backoff when it is later than quotaUntil', () => {
    const quotaUntil = NOW + 10 * SEC; // sooner than the 240s backoff
    const out = computeNextRetryAt({ attempts: 3, now: NOW, classification: 'rate_limited', quotaUntil });
    expect(out).toBe(new Date(NOW + 240 * SEC).toISOString());
  });

  it('accepts quotaUntil as an ISO string too', () => {
    const quotaUntilIso = new Date(NOW + 15 * 60 * SEC).toISOString();
    const out = computeNextRetryAt({ attempts: 1, now: NOW, classification: 'rate_limited', quotaUntil: quotaUntilIso });
    expect(out).toBe(quotaUntilIso);
  });

  it('ignores quotaUntil for non-rate_limited classes', () => {
    const quotaUntil = NOW + 60 * 60 * SEC;
    const out = computeNextRetryAt({ attempts: 1, now: NOW, classification: 'transient', quotaUntil });
    expect(out).toBe(new Date(NOW + 60 * SEC).toISOString());
  });

  it('defaults now and tolerates a missing argument object', () => {
    expect(typeof computeNextRetryAt({ attempts: 1 })).toBe('string');
    expect(typeof computeNextRetryAt()).toBe('string');
  });
});
