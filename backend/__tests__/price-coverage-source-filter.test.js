/**
 * Incident 2026-07-11: ensurePriceCoverage schrieb Such-URLs (ebay.de/sch?_nkw=…),
 * gstatic-Thumbnails und leere/kaputte URLs als "Preisquellen" in
 * details.pricing.lowest_price.sources (Bestandsaudit: 513 Such-URLs + ~320
 * gstatic-Thumbnails).
 *
 * Erwartung nach Fix:
 *   - Nur classifyPriceSourceUrl(url).kind === 'candidate' wird als Quelle
 *     persistiert. Search/Image/Invalid-URLs fließen weiter als PREIS-Datenpunkt
 *     in die Berechnung ein (amount), landen aber NIE in sources.
 *   - Bleibt nach Filterung keine Quelle übrig: price_confidence <= 0.3.
 *   - Bereits gespeicherte Müll-Quellen (baseSources) werden beim Rewrite
 *     ebenfalls verworfen.
 *
 * Setup wie __tests__/weight-extraction.test.js: GCP patchen + Heavy-Deps von
 * services/enrichment.js stubben, dann ensurePriceCoverage direkt testen.
 */

// ─── Patch GCP so enrichment.js can load ────────────────────────────────────
require('./api/_patchGcp');

function stubModule(modPath, exports) {
  try {
    const resolved = require.resolve(modPath);
    require.cache[resolved] = {
      id: resolved, filename: resolved, loaded: true,
      exports, children: [], paths: [],
    };
  } catch { /* not found — skip */ }
}

// Minimal stubs for enrichment.js imports (mirrors weight-extraction.test.js)
stubModule('../lib/firestore', {
  getProduct: vi.fn(), findProductByStrictIdentifier: vi.fn(),
  adjustPendingIntakeQuantity: vi.fn(), firestore: {},
});
stubModule('../lib/product-store', { saveProductV2: vi.fn() });
stubModule('../lib/product-identity', {
  buildIdentityAliasSet: vi.fn(() => []),
  computeProductIdentityKey: vi.fn(() => ''),
  sanitizeIdentityValue: vi.fn((v) => v),
});
stubModule('../lib/secret-values', { getSecretValue: vi.fn().mockResolvedValue('') });
stubModule('../lib/ebay-taxonomy', {
  findEbayCategory: vi.fn(), getEbayRequiredAspects: vi.fn(() => []),
  getCategoryAspectCatalog: vi.fn(), getEbayCategoryAspectCatalog: vi.fn(),
  getEbayCategories: vi.fn(() => ({})),
});
stubModule('../lib/ebay-category-governance', { isBannedEbayBreadcrumb: vi.fn(() => false) });
stubModule('../lib/price-enrichment', { enrichPriceForProductBestEffort: vi.fn() });
stubModule('../lib/web-unlocker', { fetchWithUnlocker: vi.fn() });
stubModule('../lib/gpsr-manufacturer-registry', {
  getManufacturerGpsrByName: vi.fn(), upsertManufacturerGpsr: vi.fn(),
  mergePreferMoreComplete: vi.fn(), normalizeGpsrObject: vi.fn((v) => v),
  normalizeCountryCode: vi.fn((v) => v), normalizeGpsrPhone: vi.fn((v) => v),
});
stubModule('../lib/storage', { uploadBase64Image: vi.fn(), deleteProductImages: vi.fn() });
stubModule('../lib/html-entities', { decodeHtmlEntitiesDeep: vi.fn((v) => v) });
stubModule('../lib/title-policy', { coerceTitleToPolicy: vi.fn((v) => v) });
stubModule('../lib/brand-normalize', { normalizeBrandDisplayCase: vi.fn((v) => v) });
stubModule('../lib/vehicle-fitment', { getVehicleFitmentMode: vi.fn(() => null) });
stubModule('../lib/gtin', { isValidGtin: vi.fn(() => false), normalizeDigits: vi.fn((v) => v) });
stubModule('../lib/sku', { generateSku: vi.fn(() => 'TST-001') });

const { ensurePriceCoverage } = require('../services/enrichment');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const EAN = '4006381333931';
const SEARCH_URL = 'https://www.ebay.de/sch/i.html?_nkw=Klemmmarkise+300x150';
const GSTATIC_URL = 'https://encrypted-tbn0.gstatic.com/shopping?q=tbn:xyz';
const IDEALO_SEARCH_URL = 'https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q=x';
const INVALID_URL = 'ui';
const EBAY_ITEM_URL = 'https://www.ebay.de/itm/1234567890';
const AMAZON_DP_URL = 'https://www.amazon.de/dp/B0C5351V75';

function makeProduct(overrides = {}) {
  return {
    id: 'p-price-filter',
    identification: {
      name: 'Klemmmarkise 300x150 Balkonmarkise',
      brand: 'Songmics',
      barcodes: [EAN],
    },
    details: {
      identifiers: { ean: EAN, gtin: '', upc: '', mpn: 'GSA300' },
      attributes: {},
      pricing: {},
      ...overrides.details,
    },
    ...overrides.root,
  };
}

// Item-Titel enthält Marke + MPN + EAN → hasStrongId → okExact in
// collectPriceCandidates, unabhängig von Query-Relevanz.
function serpItem(url, price) {
  return {
    title: `SONGMICS GSA300 Klemmmarkise 300x150 EAN ${EAN}`,
    price,
    url,
    source: 'test-shop',
    snippet: '',
  };
}

function serpEntry(items) {
  return {
    engine: 'google_shopping',
    query: 'Songmics GSA300',
    summary: items,
    params: {},
    error: null,
  };
}

const prevSerpEnabled = process.env.SERPAPI_ENABLED;
beforeAll(() => {
  delete process.env.SERPAPI_ENABLED; // keine echten SerpAPI-Calls im Test
});
afterAll(() => {
  if (prevSerpEnabled === undefined) delete process.env.SERPAPI_ENABLED;
  else process.env.SERPAPI_ENABLED = prevSerpEnabled;
});

describe('ensurePriceCoverage — Quellen-Filter (Incident 2026-07-11)', () => {
  it('persistiert nur candidate-URLs als Quelle; Search-/gstatic-URLs fliegen raus', async () => {
    const product = makeProduct();
    const serpTrace = [serpEntry([
      serpItem(SEARCH_URL, '89,99 €'),
      serpItem(GSTATIC_URL, '92,50 €'),
      serpItem(EBAY_ITEM_URL, '91,00 €'),
    ])];

    await ensurePriceCoverage([product], serpTrace, {});

    const lp = product.details.pricing.lowest_price;
    expect(lp).toBeTruthy();
    // Preis-Datenpunkt gesetzt (Median-nächster Kandidat)
    expect(lp.amount).toBe(91);
    // Nur die Angebots-URL bleibt als Quelle
    const urls = (lp.sources || []).map((s) => s.url);
    expect(urls).toEqual([EBAY_ITEM_URL]);
    const serialized = JSON.stringify(lp.sources);
    expect(serialized).not.toContain('sch/i.html');
    expect(serialized).not.toContain('gstatic');
    // Mit tauglicher Quelle keine künstliche Confidence-Deckelung
    expect(product.details.pricing.price_confidence).toBeGreaterThan(0.3);
  });

  it('schreibt bei nur-Müll-URLs KEINE Quelle und deckelt price_confidence auf max 0.3', async () => {
    const product = makeProduct();
    const serpTrace = [serpEntry([
      serpItem(SEARCH_URL, '89,99 €'),
      serpItem(GSTATIC_URL, '92,50 €'),
      serpItem(INVALID_URL, '91,00 €'),
    ])];

    await ensurePriceCoverage([product], serpTrace, {});

    const pricing = product.details.pricing;
    // Preis-DATENPUNKT fließt weiterhin ein …
    expect(pricing.lowest_price.amount).toBe(91);
    // … aber keine Müll-URL wird als Quelle persistiert
    expect(pricing.lowest_price.sources).toEqual([]);
    // Ohne Quelle ist der Preis unbelegt → Confidence hart gedeckelt
    expect(pricing.price_confidence).toBeLessThanOrEqual(0.3);
  });

  it('filtert beim Rewrite auch bereits gespeicherte Müll-baseSources raus', async () => {
    const product = makeProduct({
      details: {
        identifiers: { ean: EAN, gtin: '', upc: '', mpn: 'GSA300' },
        attributes: {},
        pricing: {
          lowest_price: {
            amount: 80,
            currency: 'EUR',
            sources: [
              { name: 'idealo', url: IDEALO_SEARCH_URL, price: 80 },
              { name: 'amazon', url: AMAZON_DP_URL, price: 82 },
            ],
            last_checked_iso: '2026-01-01T00:00:00.000Z',
          },
          price_confidence: 0.9,
        },
      },
    });
    const serpTrace = [serpEntry([serpItem(EBAY_ITEM_URL, '91,00 €')])];

    await ensurePriceCoverage([product], serpTrace, { force: true });

    const urls = product.details.pricing.lowest_price.sources.map((s) => s.url);
    // Neue Angebots-URL + strukturell taugliche Alt-Quelle bleiben …
    expect(urls).toEqual([EBAY_ITEM_URL, AMAZON_DP_URL]);
    // … die Idealo-Such-URL ist raus
    expect(urls).not.toContain(IDEALO_SEARCH_URL);
    // Mind. eine taugliche Quelle vorhanden → bestehende Confidence bleibt
    expect(product.details.pricing.price_confidence).toBe(0.9);
  });
});
