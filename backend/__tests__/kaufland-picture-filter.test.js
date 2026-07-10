'use strict';

/**
 * Bild-URL-Filter für Kaufland product-data (services/kaufland-product-data-repair.js).
 *
 * Hintergrund (Live-Incident 2026-07-10, EAN 4036231080920): details.images
 * enthielt eine HTML-Produktseite ("https://www.fritz-berger.de/artikel/...#thumbnail-modal").
 * buildKauflandProductDataAttributes submittete JEDE http(s)-URL als "picture" —
 * Kaufland DECLINED daraufhin alle picture-Werte mit media_not_ready_yet und
 * missing_attributes enthielt "Bild". isLikelyImageUrl filtert solche
 * Nicht-Bild-URLs jetzt am Build-Boundary raus.
 *
 * Vitest 4.x CJS-Pattern: require.cache-Patching statt vi.mock() (siehe
 * __tests__/services/kaufland-product-data-repair.test.js als Vorbild).
 */

// vitest globals: true — describe/it/expect/vi sind global.

function installModuleMock(modulePath, mockExports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: mockExports,
    children: [],
    paths: [],
  };
  return resolved;
}

// buildKauflandProductDataAttributes lazy-requiret die Manufacturer-Whitelist
// (Firestore-backed) — ohne Mock würde der Lookup einen echten Client hochziehen.
installModuleMock('../lib/kaufland-manufacturer-whitelist', {
  findManufacturerInWhitelist: vi.fn(async () => ({ found: false, source: 'test' })),
  getManufacturerAttributeId: vi.fn(async () => 21),
});

// ─── SUT ──────────────────────────────────────────────────────────────────
const repair = require('../services/kaufland-product-data-repair');

// Der Live-Beweis-Fall: HTML-Produktseite mit Tracking-Query + Fragment-Anchor.
const HTML_PAGE_URL =
  'https://www.fritz-berger.de/artikel/berger-frostaway-frostschutzmittel-5-liter-377522?srsltid=AfmBOooXyz#thumbnail-modal';

describe('isLikelyImageUrl', () => {
  it('accepts a GCS .png URL', () => {
    expect(
      repair.isLikelyImageUrl('https://storage.googleapis.com/avycloud-product-images/products/abc123/main.png')
    ).toBe(true);
  });

  it('accepts a tecalliance .jpg URL', () => {
    expect(
      repair.isLikelyImageUrl('https://digitalassets.tecalliance.services/images/400/12345678.jpg')
    ).toBe(true);
  });

  it('accepts a .webp URL', () => {
    expect(repair.isLikelyImageUrl('https://cdn.example.com/media/product.webp')).toBe(true);
  });

  it('rejects an HTML product page with srsltid query and #thumbnail-modal fragment (live incident)', () => {
    expect(repair.isLikelyImageUrl(HTML_PAGE_URL)).toBe(false);
  });

  it('accepts an extension-less URL when the entry carries an image/* mimeType', () => {
    expect(
      repair.isLikelyImageUrl({ url: 'https://images.example.com/proxy/abc123', mimeType: 'image/png' })
    ).toBe(true);
  });

  it('rejects base64 data URLs, empty values and objects without a URL', () => {
    expect(repair.isLikelyImageUrl('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==')).toBe(false);
    expect(repair.isLikelyImageUrl('')).toBe(false);
    expect(repair.isLikelyImageUrl(null)).toBe(false);
    expect(repair.isLikelyImageUrl(undefined)).toBe(false);
    expect(repair.isLikelyImageUrl({ mimeType: 'image/png' })).toBe(false);
    expect(repair.isLikelyImageUrl({ alt: 'kein Bild' })).toBe(false);
  });

  it('accepts an image URL with a query string after the extension', () => {
    expect(repair.isLikelyImageUrl('https://cdn.example.com/img/product.jpg?width=800&h=600')).toBe(true);
  });

  it('rejects non-parseable URLs defensively', () => {
    expect(repair.isLikelyImageUrl('not-a-url.jpg-but-relative')).toBe(false);
    expect(repair.isLikelyImageUrl('://broken')).toBe(false);
  });
});

describe('buildKauflandProductDataAttributes — picture filter', () => {
  it('submits only real image URLs as picture/Bild, dropping HTML page URLs', async () => {
    const realImage = 'https://storage.googleapis.com/avycloud-product-images/products/abc123/main.png';
    const attrs = await repair.buildKauflandProductDataAttributes({
      identification: { name: 'Berger FrostAway 5L', brand: 'Berger' },
      details: {
        short_description: 'Frostschutzmittel für Campingtoiletten.',
        images: [
          realImage,
          HTML_PAGE_URL,
          { url: 'https://www.example-shop.de/produkt/frostschutz-5l' },
        ],
      },
    });
    expect(attrs.picture).toEqual([realImage]);
    expect(attrs.Bild).toEqual([realImage]);
  });

  it('omits picture entirely when only non-image URLs are present', async () => {
    const attrs = await repair.buildKauflandProductDataAttributes({
      identification: { name: 'X', brand: 'Y' },
      details: {
        images: [HTML_PAGE_URL],
      },
    });
    expect(attrs.picture).toBeUndefined();
    expect(attrs.Bild).toBeUndefined();
  });
});
