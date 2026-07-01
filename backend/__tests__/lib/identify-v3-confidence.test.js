'use strict';

const { resolveIdentificationConfidence } = require('../../lib/identify-v3-confidence');

describe('resolveIdentificationConfidence', () => {
  it('reflects the real Stage-4 overallScore for a normal recognition', () => {
    expect(resolveIdentificationConfidence({ overallScore: 0.87 }, { _meta: {} })).toBe(0.87);
  });

  it('caps confidence low when Stage-3 used the content fallback (failed recognition)', () => {
    // Even if the composite score were somehow high, a placeholder must never be "sicher".
    const c = resolveIdentificationConfidence({ overallScore: 0.9 }, { _meta: { fallbackUsed: true } });
    expect(c).toBeLessThanOrEqual(0.3);
  });

  it('a failed recognition never reaches the 0.8 "Sicher" badge threshold', () => {
    const c = resolveIdentificationConfidence({ overallScore: 0.15 }, { _meta: { fallbackUsed: true } });
    expect(c).toBeLessThan(0.8);
  });

  it('does not inflate a genuinely low score for a non-fallback recognition', () => {
    expect(resolveIdentificationConfidence({ overallScore: 0.22 }, { _meta: {} })).toBe(0.22);
  });

  it('defaults to 0 when overallScore is missing', () => {
    expect(resolveIdentificationConfidence({}, {})).toBe(0);
    expect(resolveIdentificationConfidence(undefined, undefined)).toBe(0);
  });

  it('clamps the result into [0,1]', () => {
    expect(resolveIdentificationConfidence({ overallScore: 1.4 }, { _meta: {} })).toBe(1);
    expect(resolveIdentificationConfidence({ overallScore: -0.2 }, { _meta: {} })).toBe(0);
  });
});
