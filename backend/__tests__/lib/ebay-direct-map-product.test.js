/**
 * Regression tests for `mapProductToEbayItem` in backend/lib/ebay-direct.js.
 *
 * Covers the publish-time data-path fixes for these production incidents:
 *
 *   1. "Das Feld EAN fehlt" even though Stammdaten clearly shows an EAN.
 *      Root cause: identifiers.ean was empty — the EAN only lived in
 *      `identification.barcodes`. Fix: fall back to barcodes (and attribute
 *      EAN/GTIN) when identifiers are empty.
 *
 *   2. Auto-parts with K-Typ fitment cannot be listed because the catalog
 *      reference (PLD EAN) conflicts with the seller's manual K-Typ list.
 *      Fix: auto-skip ProductListingDetails when a non-empty
 *      ItemCompatibilityList is present AND the seller has at least one own
 *      picture (so the listing keeps its image basis).
 *
 * Pure mapping — no Firestore or HTTP. Uses the GCP/local module patches to
 * load `ebay-direct.js` cheaply.
 */

require('../api/_patchGcp');
require('../api/_patchLocalModules');

const { mapProductToEbayItem } = require('../../lib/ebay-direct');

const baseProduct = () => ({
  id: 'p-test',
  identification: {
    name: 'Beurer BM 27 Oberarm-Blutdruckmessgerät',
    brand: 'Beurer',
    sku: 'SKU-TEST',
    barcodes: [],
  },
  details: {
    categoryId: '23816',
    images: [
      { url_or_base64: 'https://example.com/own-1.jpg' },
    ],
    pricing: { lowest_price: { amount: 21.6, currency: 'EUR' } },
    identifiers: {},
    attributes: {},
  },
  inventory: { quantity: 1 },
});

describe('mapProductToEbayItem — EAN fallback chain', () => {
  it('uses identifiers.ean when present (canonical path)', () => {
    const p = baseProduct();
    p.details.identifiers.ean = '4211125658182';
    const item = mapProductToEbayItem(p);
    expect(item.ean).toBe('4211125658182');
  });

  it('falls back to a valid barcode when identifiers.ean is empty (Beurer regression)', () => {
    const p = baseProduct();
    p.identification.barcodes = ['4211125658182'];
    const item = mapProductToEbayItem(p);
    expect(item.ean).toBe('4211125658182');
  });

  it('prefers a 13-digit EAN over other lengths in barcodes', () => {
    const p = baseProduct();
    // 14-digit GTIN + 13-digit EAN, both valid: prefer the 13-digit one for PLD.
    p.identification.barcodes = ['14006633314036', '4006633310222'];
    const item = mapProductToEbayItem(p);
    expect(item.ean).toBe('4006633310222');
  });

  it('falls back to attribute EAN when identifiers AND barcodes are empty', () => {
    const p = baseProduct();
    p.details.attributes = { EAN: '4211125658182' };
    const item = mapProductToEbayItem(p);
    expect(item.ean).toBe('4211125658182');
  });

  it('rejects invalid GTIN candidates from barcodes (no false positives)', () => {
    const p = baseProduct();
    p.identification.barcodes = ['1234567890123']; // wrong checkdigit
    const item = mapProductToEbayItem(p);
    expect(item.ean).toBeUndefined();
  });

  it('falls back to attribute MPN when identifiers.mpn is empty', () => {
    const p = baseProduct();
    p.details.attributes = { MPN: 'ABC-123' };
    const item = mapProductToEbayItem(p);
    expect(item.mpn).toBe('ABC-123');
  });
});

describe('mapProductToEbayItem — K-Typ catalog auto-skip', () => {
  it('auto-skips ProductListingDetails when K-Typ list is present and own pictures exist', () => {
    const p = baseProduct();
    p.identification.barcodes = ['4006633310222']; // valid EAN exists
    p.details.identifiers.ean = '4006633310222';
    p.details.attributes = { 'K-Typ': '12345|67890' };
    const item = mapProductToEbayItem(p);
    expect(item.skipProductListingDetails).toBe(true);
    expect(Array.isArray(item.itemCompatibilityList)).toBe(true);
    expect(item.itemCompatibilityList).toHaveLength(2);
    // EAN field stays populated for ItemSpecifics, but PLD will be skipped at XML build time.
    expect(item.ean).toBe('4006633310222');
  });

  it('does NOT auto-skip when no K-Typ list is present', () => {
    const p = baseProduct();
    p.details.identifiers.ean = '4211125658182';
    const item = mapProductToEbayItem(p);
    expect(item.skipProductListingDetails).toBe(false);
    expect(item.itemCompatibilityList).toBeNull();
  });

  it('respects explicit details.skipEbayCatalogLookup=true even without K-Typ', () => {
    const p = baseProduct();
    p.details.skipEbayCatalogLookup = true;
    const item = mapProductToEbayItem(p);
    expect(item.skipProductListingDetails).toBe(true);
  });

  it('does NOT auto-skip when only EPS-hosted (eBay-hosted) pictures are present', () => {
    const p = baseProduct();
    p.details.images = [
      { url_or_base64: 'https://i.ebayimg.com/images/foo.jpg' },
    ];
    p.details.attributes = { 'K-Typ': '12345' };
    const item = mapProductToEbayItem(p);
    // K-Typ extracted into compatibility list, but no own picture → keep PLD.
    expect(item.itemCompatibilityList).toEqual([{ ktype: '12345' }]);
    expect(item.skipProductListingDetails).toBe(false);
  });
});

describe('mapProductToEbayItem — K-Typ specific is moved to ItemCompatibilityList', () => {
  it('extracts numeric K-Typ values from canonical pipe-separated entries', () => {
    const p = baseProduct();
    p.details.attributes = { 'K-Typ': '11111,VW Golf|22222,VW Polo|33333' };
    const item = mapProductToEbayItem(p);
    expect(item.itemCompatibilityList).toEqual([
      { ktype: '11111' },
      { ktype: '22222' },
      { ktype: '33333' },
    ]);
    // K-Typ key removed from itemSpecifics (eBay 65-char limit).
    const keys = Object.keys(item.itemSpecifics).map((k) => k.toLowerCase());
    expect(keys).not.toContain('k-typ');
  });
});
