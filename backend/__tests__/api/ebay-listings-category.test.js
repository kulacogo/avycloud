/**
 * Test: resolveCategoryNameFromId — BUG-070 Fix.
 *
 * Pure-Function Lookup über lokales categories.json. Kein Firestore-/HTTP-Setup nötig.
 * Verifiziert dass die Listing-Mapper-Hilfsfunktion einen Breadcrumb statt der numerischen
 * ID liefert, wenn eBay GetMyeBaySelling den Namen nicht zurückgibt.
 */

const { resolveCategoryNameFromId } = require('../../lib/ebay-direct');
const { findEbayCategory } = require('../../lib/ebay-taxonomy');

describe('resolveCategoryNameFromId', () => {
  it('returns the breadcrumb for a known numeric id (string)', () => {
    const expected = findEbayCategory('1')?.breadcrumb;
    expect(expected).toBeTruthy();
    expect(resolveCategoryNameFromId('1')).toBe(expected);
  });

  it('accepts numeric input as well', () => {
    const expected = findEbayCategory(1)?.breadcrumb;
    expect(resolveCategoryNameFromId(1)).toBe(expected);
  });

  it('trims whitespace around numeric strings', () => {
    expect(resolveCategoryNameFromId('  1  ')).toBe(findEbayCategory('1')?.breadcrumb);
  });

  it('returns null for null/undefined/empty input', () => {
    expect(resolveCategoryNameFromId(null)).toBeNull();
    expect(resolveCategoryNameFromId(undefined)).toBeNull();
    expect(resolveCategoryNameFromId('')).toBeNull();
  });

  it('returns null for non-numeric strings (no name-based fuzzy lookup)', () => {
    expect(resolveCategoryNameFromId('Sammeln & Seltenes')).toBeNull();
    expect(resolveCategoryNameFromId('not-a-number')).toBeNull();
  });

  it('returns null for unknown numeric ids', () => {
    expect(resolveCategoryNameFromId('999999999')).toBeNull();
  });
});
