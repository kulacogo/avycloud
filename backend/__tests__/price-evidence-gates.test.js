/**
 * Incident 2026-07-11: Müll-Quellen-URLs (Such-URLs, gstatic-Thumbnails,
 * Nicht-URLs wie "ui") galten überall als "Preisbeleg":
 *   - lib/price-enrichment.js hasValidPriceEvidence — Skip-Gate: eine einmal
 *     gespeicherte Müll-Quelle blockierte jede künftige Re-Recherche.
 *   - lib/datasheet-quality.js getPriceStatus — Quality-Gate zeigte "belegt".
 *
 * Erwartung nach Fix: Beleg zählt nur noch, wenn mindestens eine Source-URL
 * classifyPriceSourceUrl(...).kind === 'candidate' ist.
 */

// ─── Patch GCP before anything else ────────────────────────────────────────
require('./api/_patchGcp');

// ─── Stub the heavy top-level deps of price-enrichment.js ──────────────────
// (mirrors __tests__/price-enrichment-browse-match.test.js)
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
const ensurePriceCoverageMock = vi.fn().mockResolvedValue(undefined);
stubModule('../services/enrichment', { ensurePriceCoverage: ensurePriceCoverageMock });
stubModule('../lib/ebay-browse-title-insights', {
  fetchBrowsePriceSamples: vi.fn().mockRejectedValue(new Error('stubbed')),
  fetchCategoryTitleInsights: vi.fn().mockResolvedValue(null),
});

const { hasValidPriceEvidence, enrichPriceParallel } = require('../lib/price-enrichment');
const { getPriceStatus, evaluateEbayReady } = require('../lib/datasheet-quality');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SEARCH_URL = 'https://www.ebay.de/sch/i.html?_nkw=Klemmmarkise+300x150';
const GSTATIC_URL = 'https://encrypted-tbn0.gstatic.com/shopping?q=tbn:xyz';
const IDEALO_SEARCH_URL = 'https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q=x';
const INVALID_URL = 'ui';
const EBAY_ITEM_URL = 'https://www.ebay.de/itm/1234567890';
const AMAZON_DP_URL = 'https://www.amazon.de/dp/B0C5351V75';

const GARBAGE_SOURCES = [
  { name: 'ebay-suche', url: SEARCH_URL, price: 89.99 },
  { name: 'thumbnail', url: GSTATIC_URL, price: 92.5 },
  { name: 'idealo-suche', url: IDEALO_SEARCH_URL, price: 90 },
  { name: 'kaputt', url: INVALID_URL, price: 91 },
];

describe('hasValidPriceEvidence — Müll-URLs zählen nicht (Skip-Gate)', () => {
  it('nur-Müll-Quellen sind KEIN Beleg (kein Skip mehr)', () => {
    expect(hasValidPriceEvidence({ amount: 91, sources: GARBAGE_SOURCES })).toBe(false);
  });

  it('eine candidate-URL (eBay-Angebot) zählt als Beleg', () => {
    expect(hasValidPriceEvidence({
      amount: 91,
      sources: [{ name: 'eBay', url: EBAY_ITEM_URL, price: 91 }],
    })).toBe(true);
  });

  it('candidate-URL zwischen Müll-Quellen zählt ebenfalls', () => {
    expect(hasValidPriceEvidence({
      amount: 91,
      sources: [...GARBAGE_SOURCES, { name: 'Amazon', url: AMAZON_DP_URL, price: 93 }],
    })).toBe(true);
  });

  it('amount < 1 ist auch mit candidate-URL kein Beleg', () => {
    expect(hasValidPriceEvidence({
      amount: 0.5,
      sources: [{ url: EBAY_ITEM_URL }],
    })).toBe(false);
  });

  it('ohne Quellen kein Beleg', () => {
    expect(hasValidPriceEvidence({ amount: 91, sources: [] })).toBe(false);
    expect(hasValidPriceEvidence(null)).toBe(false);
  });
});

describe('enrichPriceParallel — Skip-Gate-Verhalten', () => {
  function productWith(sources) {
    return {
      id: 'p-gate',
      identification: { name: 'Klemmmarkise 300x150', brand: 'Songmics' },
      details: {
        identifiers: { mpn: 'GSA300' },
        attributes: {},
        pricing: {
          lowest_price: { amount: 91, currency: 'EUR', sources },
          price_confidence: 0.8,
        },
      },
    };
  }

  it('Müll-Beleg blockiert die Re-Recherche NICHT mehr (kein Fake-Skip {ok:true, updated:false})', async () => {
    const result = await enrichPriceParallel(productWith(GARBAGE_SOURCES), { force: false });
    // Alle 3 Quellen sind gestubbt und liefern nichts → ehrliches no_price_found
    // statt des früheren Skip-Erfolgs auf Basis der Müll-Quelle.
    expect(result.ok).toBe(false);
    expect(result.updated).toBe(false);
    expect(result.error).toBe('no_price_found');
    // Die Recherche wurde tatsächlich versucht (SerpAPI-Pfad angestoßen)
    expect(ensurePriceCoverageMock).toHaveBeenCalled();
  });

  it('echter candidate-Beleg wird weiterhin übersprungen (Skip-Gate intakt)', async () => {
    const result = await enrichPriceParallel(
      productWith([{ name: 'eBay', url: EBAY_ITEM_URL, price: 91 }]),
      { force: false },
    );
    expect(result).toEqual({ ok: true, updated: false });
  });
});

describe('getPriceStatus / evaluateEbayReady — ehrliches price_evidence_missing', () => {
  const prevGate = process.env.QUALITY_GATE_ENABLED;
  beforeAll(() => {
    delete process.env.QUALITY_GATE_ENABLED; // Default: Gate AN
  });
  afterAll(() => {
    if (prevGate === undefined) delete process.env.QUALITY_GATE_ENABLED;
    else process.env.QUALITY_GATE_ENABLED = prevGate;
  });

  function productWithPriceSources(sources) {
    return {
      identification: { name: 'Testprodukt mit Preis' },
      details: { pricing: { lowest_price: { amount: 9, sources } } },
    };
  }

  it('nur-Müll-Quellen → hasEvidence=false, ok=false', () => {
    const status = getPriceStatus(productWithPriceSources(GARBAGE_SOURCES));
    expect(status.hasEvidence).toBe(false);
    expect(status.ok).toBe(false);
    expect(status.amount).toBe(9);
    expect(status.sourceCount).toBe(GARBAGE_SOURCES.length);
  });

  it('candidate-URL → hasEvidence=true, ok=true', () => {
    const status = getPriceStatus(
      productWithPriceSources([{ name: 'Amazon', url: AMAZON_DP_URL, price: 9 }]),
    );
    expect(status.hasEvidence).toBe(true);
    expect(status.ok).toBe(true);
  });

  it('evaluateEbayReady meldet price_evidence_missing bei nur-Müll-Quellen', () => {
    const result = evaluateEbayReady(productWithPriceSources(GARBAGE_SOURCES));
    expect(result.issues).toContain('price_evidence_missing');
  });

  it('evaluateEbayReady meldet KEIN Preis-Issue bei candidate-Beleg', () => {
    const result = evaluateEbayReady(
      productWithPriceSources([{ name: 'eBay', url: EBAY_ITEM_URL, price: 9 }]),
    );
    expect(result.issues).not.toContain('price_evidence_missing');
    expect(result.issues).not.toContain('price_missing');
  });
});
