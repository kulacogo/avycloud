// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// REGRESSION GUARD — Incident 2026-07-21 (SKU-4561422647, itemId 800323719797).
//
// Der Revise-Pfad hardcodete <IncludeeBayProductDetails>true</> sobald
// EAN/MPN vorhanden waren — bei K-Typ-Listings re-bekräftigte damit JEDER
// Revise die Katalog-Adoption, und eBay verwarf die mitgesendete
// ItemCompatibilityList still (Ack=Warning): 4 Revises mit compat=60,
// null Kompatibilität live. Der Publish-Pfad machte es längst richtig
// (catalogMode='identify-only' → false) — der Revise muss ihn spiegeln.

const { buildReviseItemRequestXml } = require('../lib/ebay-trading-api');

const CFG = { userToken: 'test-token', compatibilityLevel: 1193 };

describe('buildReviseItemRequestXml — identify-only-Spiegel bei K-Typ (Incident 2026-07-21)', () => {
  it('K-Typ-Listing: IncludeeBayProductDetails=false + Kompatibilitätsliste im XML', () => {
    const xml = buildReviseItemRequestXml('ReviseFixedPriceItem', {
      itemId: '800323719797',
      ean: '4006633144780',
      mpn: '24.0128-0145.1',
      brand: 'ATE',
      itemCompatibilityList: [{ ktype: '208' }, { ktype: '715' }, { ktype: '2150' }],
    }, CFG);

    expect(xml).toContain('<IncludeeBayProductDetails>false</IncludeeBayProductDetails>');
    expect(xml).toContain('<IncludeStockPhotoURL>false</IncludeStockPhotoURL>');
    expect(xml).toContain('<ItemCompatibilityList>');
    expect(xml).toContain('<Name>KType</Name><Value>208</Value>');
    expect(xml).not.toContain('<IncludeeBayProductDetails>true</IncludeeBayProductDetails>');
  });

  it('explizites catalogMode=identify-only wirkt auch ohne Kompatibilitätsliste', () => {
    const xml = buildReviseItemRequestXml('ReviseFixedPriceItem', {
      itemId: '1',
      ean: '4006633144780',
      catalogMode: 'identify-only',
    }, CFG);

    expect(xml).toContain('<IncludeeBayProductDetails>false</IncludeeBayProductDetails>');
  });

  it('Nicht-K-Typ-Listing: Katalog-Adoption bleibt wie bisher (true) — kein Verhaltensbruch', () => {
    const xml = buildReviseItemRequestXml('ReviseFixedPriceItem', {
      itemId: '2',
      ean: '4006633144780',
    }, CFG);

    expect(xml).toContain('<IncludeeBayProductDetails>true</IncludeeBayProductDetails>');
    expect(xml).not.toContain('<ItemCompatibilityList>');
  });
});
