'use strict';

// Pure unit tests for backend/lib/confidence-scoring.js
// No GCP or LLM dependencies. Vitest globals via vitest.config.js.

const {
  scoreField,
  aggregateProductConfidence,
  isValidGtin,
  FIELD_THRESHOLDS,
  SOURCE_WEIGHTS,
} = require('../../lib/confidence-scoring');

describe('isValidGtin', () => {
  it('accepts a valid EAN-13', () => {
    // 4006381333931 is a well-known valid Faber-Castell EAN-13
    expect(isValidGtin('4006381333931')).toBe(true);
  });

  it('rejects an EAN-13 with a tampered check digit', () => {
    expect(isValidGtin('4006381333932')).toBe(false);
  });

  it('strips non-digits before checking', () => {
    expect(isValidGtin('4006-3813-33931')).toBe(true);
  });

  it('rejects short or wrong-length inputs', () => {
    expect(isValidGtin('12345')).toBe(false);
    expect(isValidGtin('')).toBe(false);
    expect(isValidGtin(null)).toBe(false);
  });
});

describe('scoreField — GTIN', () => {
  it('scores valid GTIN + 2 strong sources at or above 0.95', () => {
    const res = scoreField('gtin', '4006381333931', [
      { source: 'ebay_catalog', value: '4006381333931' },
      { source: 'gs1_verified', value: '4006381333931' },
    ]);
    expect(res.passes).toBe(true);
    expect(res.score).toBeGreaterThanOrEqual(0.95);
    expect(res.threshold).toBe(FIELD_THRESHOLDS.gtin);
    expect(res.sources.sort()).toEqual(['ebay_catalog', 'gs1_verified']);
  });

  it('fails when the GTIN has an invalid checksum even with strong sources', () => {
    const res = scoreField('gtin', '4006381333932', [
      { source: 'ebay_catalog', value: '4006381333932' },
      { source: 'gs1_verified', value: '4006381333932' },
    ]);
    expect(res.passes).toBe(false);
    expect(res.reasoning).toContain('invalid-gtin');
  });

  it('returns score 0 when evidence is empty', () => {
    const res = scoreField('gtin', '4006381333931', []);
    expect(res.score).toBe(0);
    expect(res.passes).toBe(false);
  });
});

describe('scoreField — brand', () => {
  it('passes for user_input with single strong source', () => {
    const res = scoreField('brand', 'Philips', [
      { source: 'user_input', value: 'Philips' },
    ]);
    expect(res.passes).toBe(true);
    expect(res.score).toBeGreaterThanOrEqual(SOURCE_WEIGHTS.user_input);
  });

  it('fails when only a single broad web search supports brand', () => {
    const res = scoreField('brand', 'Philips', [
      { source: 'web_search_broad', value: 'Philips' },
    ]);
    expect(res.passes).toBe(false);
    expect(res.score).toBe(SOURCE_WEIGHTS.web_search_broad);
  });
});

describe('scoreField — multi-source behaviour', () => {
  it('applies full +0.15 boost with 3+ matching sources (capped)', () => {
    const res = scoreField('mpn', 'ABC-123', [
      { source: 'web_search_broad', value: 'ABC-123' },
      { source: 'web_search_broad', value: 'ABC-123' },
      { source: 'web_search_broad', value: 'ABC-123' },
      { source: 'web_search_broad', value: 'ABC-123' },
    ]);
    // base 0.50 + boost 0.15 = 0.65
    expect(res.score).toBeCloseTo(0.65, 3);
  });

  it('caps multi-source boost at +0.05 for exactly 2 sources', () => {
    const res = scoreField('mpn', 'ABC-123', [
      { source: 'web_search_broad', value: 'ABC-123' },
      { source: 'web_search_broad', value: 'ABC-123' },
    ]);
    // base 0.50 + boost 0.05 = 0.55
    expect(res.score).toBeCloseTo(0.55, 3);
  });

  it('applies disagreement penalty when any source differs', () => {
    const res = scoreField('brand', 'Philips', [
      { source: 'ebay_catalog', value: 'Philips' },
      { source: 'manufacturer_website', value: 'Philips' },
      { source: 'web_search_broad', value: 'Phillips' }, // typo / wrong
    ]);
    // base 0.95 + boost 0.05 − penalty 0.10 = 0.90
    expect(res.score).toBeCloseTo(0.90, 3);
    expect(res.reasoning).toContain('disagreement');
  });
});

describe('scoreField — format bonuses', () => {
  it('adds a breadcrumb bonus to category strings', () => {
    const res = scoreField('category', 'Electronics > Audio > Headphones', [
      { source: 'ebay_catalog', value: 'Electronics > Audio > Headphones' },
    ]);
    // base 0.95 + format 0.05 = 1.0 (capped)
    expect(res.score).toBeCloseTo(1.0, 3);
    expect(res.reasoning).toContain('breadcrumb');
  });

  it('adds a GTIN-checksum bonus for valid GTINs', () => {
    const res = scoreField('ean', '4006381333931', [
      { source: 'ean_db', value: '4006381333931' },
    ]);
    // base 0.85 + checksum 0.05 = 0.90
    expect(res.score).toBeCloseTo(0.90, 3);
  });
});

describe('aggregateProductConfidence', () => {
  it('returns readyForPublish=true when all critical fields pass', () => {
    const fieldScores = {
      brand: { score: 0.95, passes: true },
      category: { score: 0.90, passes: true },
      title: { score: 0.80, passes: true },
      requiredAspects: { score: 0.85, passes: true },
      gpsr: { score: 0.80, passes: true },
      price: { score: 0.75, passes: true },
      description: { score: 0.70, passes: true },
    };
    const agg = aggregateProductConfidence(fieldScores);
    expect(agg.readyForPublish).toBe(true);
    expect(agg.missingCritical).toEqual([]);
    expect(agg.score).toBeGreaterThan(0);
    expect(agg.fieldsConsidered).toEqual(
      expect.arrayContaining(['brand', 'category', 'title', 'requiredAspects', 'gpsr', 'price', 'description']),
    );
  });

  it('reports missingCritical when at least one critical field fails', () => {
    const fieldScores = {
      brand: { score: 0.95, passes: true },
      category: { score: 0.60, passes: false },
      title: { score: 0.80, passes: true },
      requiredAspects: { score: 0.85, passes: true },
      gpsr: { score: 0.80, passes: true },
    };
    const agg = aggregateProductConfidence(fieldScores);
    expect(agg.readyForPublish).toBe(false);
    expect(agg.missingCritical).toEqual(['category']);
  });

  it('skips missing fields (does not count them as 0 in the weighted average)', () => {
    const fieldScores = {
      brand: { score: 0.9, passes: true },
      title: { score: 0.9, passes: true },
    };
    const agg = aggregateProductConfidence(fieldScores);
    // Only brand (0.15) and title (0.15) considered; weighted avg = 0.9
    expect(agg.score).toBeCloseTo(0.9, 3);
    expect(agg.fieldsConsidered.sort()).toEqual(['brand', 'title']);
    // gtin field missing → not in fieldsConsidered, still missingCritical detects absence
    expect(agg.missingCritical).toEqual(
      expect.arrayContaining(['category', 'requiredAspects', 'gpsr']),
    );
  });

  it('returns score 0 when no fields provided', () => {
    const agg = aggregateProductConfidence({});
    expect(agg.score).toBe(0);
    expect(agg.readyForPublish).toBe(false);
  });
});
