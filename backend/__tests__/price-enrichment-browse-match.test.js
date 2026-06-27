// backend/__tests__/price-enrichment-browse-match.test.js
//
// BUG-089 + BUG-093: findEbayBrowsePriceForProductV1 must only count eBay
// Browse samples that actually match the product (when no GTIN match exists)
// toward the median price AND toward the stored evidence sources. Without a
// product-match gate the unmatched Browse median can win the price waterfall
// and unrelated sample URLs get stored as "evidence sources".

// ─── Patch GCP before anything else ────────────────────────────────────────
require('./api/_patchGcp');

// ─── Stub the heavy top-level deps of price-enrichment.js ──────────────────
// price-enrichment.js requires these at module load. We replace them with inert
// stubs so requiring the module never touches the network / secrets.

function stubModule(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsObj,
    children: [],
    paths: [],
  };
}

stubModule('../lib/web-unlocker', {
  fetchWithUnlocker: vi.fn().mockResolvedValue({ success: false, error: 'stubbed' }),
});
stubModule('../lib/evidence-provider', {
  search: vi.fn().mockResolvedValue({ ok: false, results: [] }),
  searchSite: vi.fn().mockResolvedValue({ ok: false, results: [] }),
});
stubModule('../services/enrichment', {
  ensurePriceCoverage: vi.fn().mockResolvedValue(undefined),
});

// ─── Controllable stub for the lazily-required Browse samples source ───────
const mockFetchBrowsePriceSamples = vi.fn();
stubModule('../lib/ebay-browse-title-insights', {
  fetchBrowsePriceSamples: mockFetchBrowsePriceSamples,
});

// ─── Load the module under test (AFTER stubs are in require.cache) ─────────
const priceEnrichment = require('../lib/price-enrichment');
const { findEbayBrowsePriceForProductV1 } = priceEnrichment;

// A product with NO GTIN/EAN — forces the keyword-query (loose) path where the
// match gate matters most.
function noGtinProduct() {
  return {
    id: 'p-no-gtin',
    identification: { brand: 'Lego', name: 'Lego Star Wars Millennium Falcon 75257' },
    details: {
      categoryId: '19006',
      identifiers: { mpn: '75257' },
      attributes: { Produktart: 'Bauset' },
      pricing: {},
    },
  };
}

beforeEach(() => {
  mockFetchBrowsePriceSamples.mockReset();
});

describe('findEbayBrowsePriceForProductV1 — product-match gate (BUG-089/093)', () => {
  it('exists as an exported function', () => {
    expect(typeof findEbayBrowsePriceForProductV1).toBe('function');
  });

  it('includes only matching samples in the median and sources (drops different products)', async () => {
    // 3 samples clearly match (brand Lego + MPN 75257), priced ~800.
    // 4 samples are a DIFFERENT product (Playmobil pirate ship), priced ~30.
    // Without the gate, the median would be dragged down by the cheap unrelated
    // items and their URLs would be stored as evidence.
    const matching = [
      { title: 'Lego Star Wars 75257 Millennium Falcon NEU OVP', url: 'https://www.ebay.de/itm/m1', value: 790, currency: 'EUR' },
      { title: 'LEGO 75257 Star Wars Millennium Falcon versiegelt', url: 'https://www.ebay.de/itm/m2', value: 810, currency: 'EUR' },
      { title: 'Lego Millennium Falcon 75257 Star Wars Set neu', url: 'https://www.ebay.de/itm/m3', value: 800, currency: 'EUR' },
    ];
    const different = [
      { title: 'Playmobil Piratenschiff 70411 Komplettset', url: 'https://www.ebay.de/itm/x1', value: 28, currency: 'EUR' },
      { title: 'Playmobil Piraten Insel Spielset', url: 'https://www.ebay.de/itm/x2', value: 32, currency: 'EUR' },
      { title: 'Schleich Dinosaurier Figur T-Rex', url: 'https://www.ebay.de/itm/x3', value: 15, currency: 'EUR' },
      { title: 'Ravensburger Puzzle 1000 Teile Landschaft', url: 'https://www.ebay.de/itm/x4', value: 12, currency: 'EUR' },
    ];
    mockFetchBrowsePriceSamples.mockResolvedValue({ total: 7, samples: [...matching, ...different] });

    const res = await findEbayBrowsePriceForProductV1(noGtinProduct());

    expect(res.ok).toBe(true);
    // Median must come ONLY from the matching ~800€ samples, not the cheap noise.
    expect(res.amount).toBeGreaterThanOrEqual(700);
    expect(res.amount).toBeLessThanOrEqual(900);

    // Stored sources must point ONLY to the matching items.
    const sourceUrls = (res.sources || []).map((s) => s.url);
    expect(sourceUrls.length).toBeGreaterThan(0);
    for (const u of sourceUrls) {
      expect(['https://www.ebay.de/itm/m1', 'https://www.ebay.de/itm/m2', 'https://www.ebay.de/itm/m3']).toContain(u);
    }
    // No different-product URL leaked into evidence.
    for (const bad of ['https://www.ebay.de/itm/x1', 'https://www.ebay.de/itm/x2', 'https://www.ebay.de/itm/x3', 'https://www.ebay.de/itm/x4']) {
      expect(sourceUrls).not.toContain(bad);
    }
  });

  it('returns no price (not a misleading median) when NO sample matches the product', async () => {
    // All samples are unrelated products. Even though there are >=3 EUR samples
    // with valid http URLs, none matches brand+MPN/keywords → must NOT yield a
    // confident median backed by wrong-product evidence.
    mockFetchBrowsePriceSamples.mockResolvedValue({
      total: 5,
      samples: [
        { title: 'Playmobil Piratenschiff 70411 Komplettset', url: 'https://www.ebay.de/itm/x1', value: 28, currency: 'EUR' },
        { title: 'Playmobil Piraten Insel Spielset', url: 'https://www.ebay.de/itm/x2', value: 32, currency: 'EUR' },
        { title: 'Schleich Dinosaurier Figur T-Rex', url: 'https://www.ebay.de/itm/x3', value: 15, currency: 'EUR' },
        { title: 'Ravensburger Puzzle 1000 Teile', url: 'https://www.ebay.de/itm/x4', value: 12, currency: 'EUR' },
        { title: 'Carrera Bahn Rennstrecke', url: 'https://www.ebay.de/itm/x5', value: 45, currency: 'EUR' },
      ],
    });

    const res = await findEbayBrowsePriceForProductV1(noGtinProduct());

    // Either ok:false, or at minimum no amount + no evidence sources.
    expect(res.ok).toBe(false);
    expect(res.amount == null || res.amount === 0).toBe(true);
    expect(Array.isArray(res.sources) ? res.sources.length : 0).toBe(0);
  });

  it('preserves behavior when a GTIN match is available (no title gate applied)', async () => {
    // With a GTIN, fetchBrowsePriceSamples is called with that GTIN — eBay
    // already constrained the result set to the product, so titles need not be
    // re-gated. Samples whose titles don't textually contain the brand must
    // still count.
    const product = {
      id: 'p-gtin',
      identification: { brand: 'Lego', name: 'Lego Star Wars Millennium Falcon 75257', barcodes: ['5702016367492'] },
      details: { categoryId: '19006', identifiers: { mpn: '75257', ean: '5702016367492' }, attributes: {}, pricing: {} },
    };
    mockFetchBrowsePriceSamples.mockResolvedValue({
      total: 3,
      samples: [
        { title: 'Millennium Falcon Bauset 75257 NEU', url: 'https://www.ebay.de/itm/g1', value: 800, currency: 'EUR' },
        { title: 'Raumschiff Set versiegelt OVP', url: 'https://www.ebay.de/itm/g2', value: 820, currency: 'EUR' },
        { title: 'Faltbares Sammler Modell neu', url: 'https://www.ebay.de/itm/g3', value: 790, currency: 'EUR' },
      ],
    });

    const res = await findEbayBrowsePriceForProductV1(product);

    expect(res.ok).toBe(true);
    expect(res.amount).toBeGreaterThanOrEqual(700);
    // All 3 GTIN-constrained samples are eligible as sources.
    expect((res.sources || []).length).toBe(3);
    // Called with the GTIN, not a keyword query.
    const callArg = mockFetchBrowsePriceSamples.mock.calls[0][0];
    expect(callArg.gtin).toBe('5702016367492');
  });
});
