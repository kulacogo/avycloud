'use strict';

// Pure unit tests for backend/lib/cross-reference.js
// Vitest globals via vitest.config.js.

const {
  resolveConsensus,
  normalizeForCompare,
  crossReferenceProduct,
} = require('../../lib/cross-reference');

describe('normalizeForCompare', () => {
  it('lowercases and strips corp suffixes for brand', () => {
    expect(normalizeForCompare('brand', 'Philips GmbH')).toBe('philips');
    expect(normalizeForCompare('brand', 'PHILIPS')).toBe('philips');
    expect(normalizeForCompare('brand', 'Philips Inc.')).toBe('philips');
    expect(normalizeForCompare('brand', 'Acme Corp')).toBe('acme');
  });

  it('keeps GTIN digits only', () => {
    expect(normalizeForCompare('gtin', '4038-7881-23456')).toBe('4038788123456');
    expect(normalizeForCompare('ean', ' 4038 7881 23456 ')).toBe('4038788123456');
  });

  it('normalizes category breadcrumbs', () => {
    expect(normalizeForCompare('category', 'Electronics > Audio >  Headphones'))
      .toBe('electronics > audio > headphones');
  });

  it('returns empty string for nullish input', () => {
    expect(normalizeForCompare('brand', null)).toBe('');
    expect(normalizeForCompare('brand', undefined)).toBe('');
  });
});

describe('resolveConsensus', () => {
  it('picks the value with the most agreeing sources', () => {
    const out = resolveConsensus('brand', [
      { source: 'ebay_catalog', value: 'Philips' },
      { source: 'manufacturer_website', value: 'Philips' },
      { source: 'ean_db', value: 'Philips' },
    ]);
    expect(out.value).toBe('Philips');
    expect(out.support.sort()).toEqual(['ean_db', 'ebay_catalog', 'manufacturer_website']);
    expect(out.conflict).toBe(false);
    expect(out.alternatives).toEqual([]);
  });

  it('treats a one-off typo as a lower-rank alternative without a conflict', () => {
    const out = resolveConsensus('brand', [
      { source: 'ebay_catalog', value: 'Philips' },
      { source: 'manufacturer_website', value: 'Philips' },
      { source: 'web_search_broad', value: 'Phillips' },
    ]);
    expect(out.value).toBe('Philips');
    expect(out.conflict).toBe(false);
    expect(out.alternatives).toHaveLength(1);
    expect(out.alternatives[0].value).toBe('Phillips');
  });

  it('flags a conflict when two groups have comparable support', () => {
    const out = resolveConsensus('brand', [
      { source: 'ebay_catalog', value: 'Philips' },
      { source: 'manufacturer_website', value: 'Philips' },
      { source: 'icecat', value: 'Bosch' },
      { source: 'ean_db', value: 'Bosch' },
    ]);
    expect(out.conflict).toBe(true);
    expect(out.alternatives).toHaveLength(1);
    // Winner is whichever group has the highest support; conflict signals uncertainty.
    const groups = [out.value, out.alternatives[0].value].sort();
    expect(groups).toEqual(['Bosch', 'Philips']);
  });

  it('groups differently-cased brand values together after normalization', () => {
    const out = resolveConsensus('brand', [
      { source: 'ebay_catalog', value: 'Philips GmbH' },
      { source: 'manufacturer_website', value: 'PHILIPS' },
      { source: 'ean_db', value: 'philips' },
    ]);
    expect(out.support).toHaveLength(3);
    expect(out.alternatives).toEqual([]);
  });

  it('groups GTINs that only differ in separators', () => {
    const out = resolveConsensus('gtin', [
      { source: 'ebay_catalog', value: '4038788123456' },
      { source: 'ean_db', value: '4038-7881-23456' },
      { source: 'gs1_verified', value: '4038 7881 23456' },
    ]);
    expect(out.support).toHaveLength(3);
    expect(out.conflict).toBe(false);
  });

  it('returns null value when no candidates provided', () => {
    const out = resolveConsensus('brand', []);
    expect(out.value).toBeNull();
    expect(out.support).toEqual([]);
    expect(out.alternatives).toEqual([]);
  });
});

describe('crossReferenceProduct', () => {
  it('resolves a product draft end-to-end with structured output', () => {
    const draft = {
      brand: 'Philips',
      gtin: '4006381333931',
      title: 'Philips SHB3075 Headphones',
    };
    const sourceResults = [
      { field: 'brand', source: 'ebay_catalog', value: 'Philips' },
      { field: 'brand', source: 'manufacturer_website', value: 'Philips' },
      { field: 'gtin', source: 'ebay_catalog', value: '4006381333931' },
      { field: 'gtin', source: 'gs1_verified', value: '4006381333931' },
      { field: 'category', source: 'ebay_catalog', value: 'Electronics > Audio > Headphones' },
    ];
    const out = crossReferenceProduct(draft, sourceResults);

    expect(out.resolved.brand).toBe('Philips');
    expect(out.resolved.gtin).toBe('4006381333931');
    expect(out.resolved.category).toBe('Electronics > Audio > Headphones');

    expect(out.confidence.brand.passes).toBe(true);
    expect(out.confidence.gtin.passes).toBe(true);
    expect(out.conflicts).toEqual([]);
  });

  it('reports conflicts in the conflicts array', () => {
    const draft = { brand: 'Philips' };
    const sourceResults = [
      { field: 'brand', source: 'ebay_catalog', value: 'Philips' },
      { field: 'brand', source: 'manufacturer_website', value: 'Philips' },
      { field: 'brand', source: 'icecat', value: 'Bosch' },
      { field: 'brand', source: 'ean_db', value: 'Bosch' },
    ];
    const out = crossReferenceProduct(draft, sourceResults);
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0].field).toBe('brand');
    expect(out.conflicts[0].alternatives.length).toBeGreaterThanOrEqual(2);
  });

  it('scores draft-only values as user_input when no evidence supplied', () => {
    const draft = { brand: 'Philips' };
    const out = crossReferenceProduct(draft, []);
    expect(out.resolved.brand).toBe('Philips');
    expect(out.confidence.brand.passes).toBe(true);
    expect(out.confidence.brand.sources).toContain('user_input');
  });
});
