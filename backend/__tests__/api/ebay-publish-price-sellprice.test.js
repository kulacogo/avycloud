/**
 * Regression (Incident 2026-07-10, SONAX eBay-Listing zu 14,38 € statt 18,95 €):
 * mapProductToEbayItem (AddFixedPriceItem — NEUE Listings) nahm den Preis aus
 * pricing.lowest_price (recherchierter MARKTPREIS) — pricing.sellPrice (DER
 * Verkaufspreis) fehlte in der Kette komplett. Revise/Sync und Kaufland nutzten
 * sellPrice längst → neue Listings gingen mit dem falschen (Markt-)Preis live.
 *
 * Pattern: require.cache patching (kein vi.mock für CJS).
 */

require('./_patchGcp');
require('./_patchLocalModules');
require('./_setupMocks');

const { mapProductToEbayItem, validatePublishReadiness } = require('../../lib/ebay-direct');

function baseProduct(pricing) {
  return {
    id: 'p1',
    identification: { name: 'SONAX AntiFrost & Klarsicht Konzentrat Citrus 5L', sku: 'SKU-9556732459' },
    details: {
      categoryId: '179489',
      pricing,
      identifiers: { sku: 'SKU-9556732459', ean: '4064700503410' },
      images: [{ url_or_base64: 'https://example-img.test/a.jpg' }],
    },
  };
}

describe('eBay Publish — Preis-Kette nutzt den VERKAUFSPREIS', () => {
  it('sellPrice gewinnt über lowest_price (Marktpreis)', () => {
    const item = mapProductToEbayItem(baseProduct({
      sellPrice: 18.95,
      lowest_price: { amount: 14.38, currency: 'EUR' },
    }));
    expect(item.startPrice).toBe(18.95);
  });

  it('ohne sellPrice fällt der Preis auf lowest_price zurück', () => {
    const item = mapProductToEbayItem(baseProduct({
      lowest_price: { amount: 14.38, currency: 'EUR' },
    }));
    expect(item.startPrice).toBe(14.38);
  });

  it('explizite overrides schlagen weiterhin alles', () => {
    const item = mapProductToEbayItem(
      baseProduct({ sellPrice: 18.95, lowest_price: { amount: 14.38, currency: 'EUR' } }),
      { startPrice: 21.5 },
    );
    expect(item.startPrice).toBe(21.5);
  });

  it('ungültiges sellPrice (0/NaN) blockiert den Fallback nicht', () => {
    const item = mapProductToEbayItem(baseProduct({
      sellPrice: 0,
      lowest_price: { amount: 14.38, currency: 'EUR' },
    }));
    expect(item.startPrice).toBe(14.38);
  });

  it('validatePublishReadiness akzeptiert Produkte, deren einziger Preis sellPrice ist', () => {
    const res = validatePublishReadiness(baseProduct({ sellPrice: 18.95 }));
    expect(res.blockers.some((b) => /Preis/i.test(b))).toBe(false);
  });
});
