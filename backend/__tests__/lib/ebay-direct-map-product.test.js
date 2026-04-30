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

describe('mapProductToEbayItem — catalog mode (identify-only) for K-Typ + legacy skip flag', () => {
  it('uses identify-only mode when K-Typ list is present and own pictures exist', () => {
    const p = baseProduct();
    p.identification.barcodes = ['4006633310222']; // valid EAN exists
    p.details.identifiers.ean = '4006633310222';
    p.details.attributes = { 'K-Typ': '12345|67890' };
    const item = mapProductToEbayItem(p);
    // identify-only: PLD is INCLUDED with EAN (so eBay does not respond with
    // "EAN fehlt") but IncludeeBayProductDetails=false suppresses catalog merge
    // (which would otherwise conflict with the seller's K-Typ list).
    expect(item.catalogMode).toBe('identify-only');
    expect(item.skipProductListingDetails).toBe(false);
    expect(Array.isArray(item.itemCompatibilityList)).toBe(true);
    expect(item.itemCompatibilityList).toHaveLength(2);
    expect(item.ean).toBe('4006633310222');
  });

  it('uses merge mode (default) when no K-Typ list and no legacy skip flag', () => {
    const p = baseProduct();
    p.details.identifiers.ean = '4211125658182';
    const item = mapProductToEbayItem(p);
    expect(item.catalogMode).toBe('merge');
    expect(item.skipProductListingDetails).toBe(false);
    expect(item.itemCompatibilityList).toBeNull();
  });

  it('uses identify-only mode (NOT omit) when details.skipEbayCatalogLookup=true (Beurer regression)', () => {
    // Regression for the Beurer BM 27 case: a previous image-conflict auto-fix
    // persisted skipEbayCatalogLookup=true on the product. Old behaviour skipped
    // the entire PLD block → no EAN in XML → eBay rejected with "EAN fehlt".
    // New behaviour: identify-only sends EAN inside PLD with
    // IncludeeBayProductDetails=false.
    const p = baseProduct();
    p.identification.barcodes = ['4211125658182'];
    p.details.skipEbayCatalogLookup = true;
    const item = mapProductToEbayItem(p);
    expect(item.catalogMode).toBe('identify-only');
    expect(item.skipProductListingDetails).toBe(false);
    expect(item.ean).toBe('4211125658182');
  });

  it('keeps merge mode when K-Typ exists but only EPS-hosted pictures are present', () => {
    const p = baseProduct();
    p.details.images = [
      { url_or_base64: 'https://i.ebayimg.com/images/foo.jpg' },
    ];
    p.details.attributes = { 'K-Typ': '12345' };
    const item = mapProductToEbayItem(p);
    // K-Typ extracted into compatibility list, but no own picture → catalog mode
    // stays merge so the listing keeps its image basis from the catalog.
    expect(item.itemCompatibilityList).toEqual([{ ktype: '12345' }]);
    expect(item.catalogMode).toBe('merge');
    expect(item.skipProductListingDetails).toBe(false);
  });
});

describe('mapProductToEbayItem — EAN bridge into ItemSpecifics', () => {
  it('adds EAN as ItemSpecific when not already present (German "EAN fehlt" guard)', () => {
    const p = baseProduct();
    p.details.identifiers.ean = '4211125658182';
    const item = mapProductToEbayItem(p);
    expect(item.itemSpecifics.EAN).toEqual(['4211125658182']);
  });

  it('does not duplicate EAN ItemSpecific when one is already present in attributes', () => {
    const p = baseProduct();
    p.details.identifiers.ean = '4211125658182';
    p.details.attributes = { EAN: '4211125658182' };
    const item = mapProductToEbayItem(p);
    // Original key (from attributes) wins; we don't overwrite or add a duplicate.
    const eanKeys = Object.keys(item.itemSpecifics).filter((k) =>
      ['ean', 'gtin', 'upc', 'isbn'].includes(k.toLowerCase()),
    );
    expect(eanKeys).toHaveLength(1);
  });

  it('bridges EAN even when only barcodes are populated (Beurer-style data)', () => {
    const p = baseProduct();
    p.identification.barcodes = ['4211125658182'];
    const item = mapProductToEbayItem(p);
    expect(item.itemSpecifics.EAN).toEqual(['4211125658182']);
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

describe('Trading XML — catalogMode rendering', () => {
  // Lightweight smoke test: builds the AddFixedPriceItem XML and verifies the
  // ProductListingDetails block is rendered correctly per catalogMode. We only
  // check the PLD/IncludeeBayProductDetails fragment so the test stays robust
  // against unrelated XML changes.
  const { buildAddFixedPriceItemXml } = require('../../lib/ebay-trading-api');

  const baseItem = () => ({
    title: 'Test',
    primaryCategoryId: '23816',
    description: 'desc',
    startPrice: 10,
    currency: 'EUR',
    quantity: 1,
    conditionId: '1000',
    pictureUrls: ['https://example.com/own.jpg'],
    ean: '4211125658182',
    brand: 'Beurer',
    itemSpecifics: { EAN: ['4211125658182'] },
    listingDuration: 'GTC',
    country: 'DE',
  });

  const fakeCfg = { userToken: 'TEST-TOKEN', compatibilityLevel: '1217' };

  it('catalogMode=merge sends IncludeeBayProductDetails=true (catalog adoption)', () => {
    const xml = buildAddFixedPriceItemXml(baseItem(), fakeCfg);
    expect(xml).toContain('<EAN>4211125658182</EAN>');
    expect(xml).toContain('<IncludeeBayProductDetails>true</IncludeeBayProductDetails>');
  });

  it('catalogMode=identify-only sends EAN with IncludeeBayProductDetails=false (no catalog merge)', () => {
    const item = { ...baseItem(), catalogMode: 'identify-only' };
    const xml = buildAddFixedPriceItemXml(item, fakeCfg);
    expect(xml).toContain('<EAN>4211125658182</EAN>');
    expect(xml).toContain('<IncludeeBayProductDetails>false</IncludeeBayProductDetails>');
    expect(xml).toContain('<IncludeStockPhotoURL>false</IncludeStockPhotoURL>');
    expect(xml).not.toContain('<IncludeeBayProductDetails>true</IncludeeBayProductDetails>');
  });

  it('catalogMode=omit (legacy) drops the PLD block entirely', () => {
    const item = { ...baseItem(), catalogMode: 'omit' };
    const xml = buildAddFixedPriceItemXml(item, fakeCfg);
    expect(xml).not.toContain('<ProductListingDetails>');
    expect(xml).not.toContain('<IncludeeBayProductDetails>');
  });

  it('legacy skipProductListingDetails=true is treated as catalogMode=omit', () => {
    const item = { ...baseItem(), skipProductListingDetails: true };
    const xml = buildAddFixedPriceItemXml(item, fakeCfg);
    expect(xml).not.toContain('<ProductListingDetails>');
  });
});
