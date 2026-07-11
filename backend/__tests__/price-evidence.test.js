/**
 * Unit-Tests für lib/price-evidence.js — Beleg-Validierung für Preis-Quellen.
 *
 * Incident 2026-07-11: Chat-Pipelines schrieben Modell-ERFUNDENE Quell-URLs
 * (404-Herstellerseite mit falschem Varianten-Preis 61,99 statt 105,99) und
 * die SerpAPI-Pfade schrieben Such-/Thumbnail-URLs als "Quellen".
 *
 * Alle URL-Beispiele hier sind echte Müll-Muster aus dem Bestandsaudit.
 * PURE-API — kein Netz, fetchPage wird überall injiziert.
 */

const {
  classifyPriceSourceUrl,
  filterStructurallySound,
  evaluatePageEvidence,
  priceTextVariants,
  verifyPriceSources,
  validatePricingProposal,
} = require('../lib/price-evidence');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PRODUCT = {
  identification: {
    name: 'HOMEDEMO Klemmmarkise 300x150cm Anthrazit Balkonmarkise',
    brand: 'HOMEDEMO',
  },
  details: { identifiers: { mpn: '65858' } },
};

// Neutrales Padding OHNE Ziffern, Produkt-Tokens oder Preis-Varianten,
// damit Seiten die 200-Zeichen-Mindestlänge erreichen, ohne Treffer zu faken.
const PADDING = 'Lorem ipsum dolor sit amet, consetetur sadipscing elitr, sed diam nonumy eirmod tempor invidunt ut labore et dolore magna aliquyam erat, sed diam voluptua. At vero eos et accusam et justo duo dolores et ea rebum. '.repeat(2);

const PAGE_WITH_BRAND_AND_PRICE =
  `HOMEDEMO Klemmmarkise 300x150 cm Anthrazit — Balkonmarkise ohne Bohren. Preis: 105,99 € inkl. MwSt. ${PADDING}`;

// Der Incident-Fall: Seite existiert und ist zum Produkt, zeigt aber 105,99 —
// das Modell behauptete 61,99 (Preis einer anderen Variante).
const PAGE_WRONG_PRICE = PAGE_WITH_BRAND_AND_PRICE;

const PAGE_OFF_TOPIC_WITH_PRICE =
  `Silikon Schutzhülle kompatibel zum Smartphone, stoßfest, transparent. Jetzt reduziert: 61,99 € statt regulär. ${PADDING}`;

// ─── classifyPriceSourceUrl ──────────────────────────────────────────────────

describe('classifyPriceSourceUrl', () => {
  it.each([
    ['https://www.ebay.de/sch/i.html?_nkw=Klemmmarkise+300x150+anthrazit', 'search'],
    ['https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q=X', 'search'],
    ['https://www.kaufland.de/item/search/?search_value=X', 'search'],
    ['https://homedemo.de/collections/xyz', 'search'],
  ])('Such-/Kategorie-URL %s → search', (url, expected) => {
    expect(classifyPriceSourceUrl(url).kind).toBe(expected);
  });

  it('gstatic-Shopping-Thumbnail → image (image_cdn)', () => {
    const res = classifyPriceSourceUrl('https://encrypted-tbn0.gstatic.com/shopping?q=tbn:abc');
    expect(res.kind).toBe('image');
    expect(res.reason).toBe('image_cdn');
  });

  it('direkte Bild-Datei → image (image_file)', () => {
    expect(classifyPriceSourceUrl('https://cdn.shopify.com/files/produktfoto.jpg?v=1').kind).toBe('image');
  });

  it.each([
    ['ui', 'not_a_url'],
    ['', 'empty'],
  ])('Nicht-URL %j → invalid (%s)', (url, reason) => {
    const res = classifyPriceSourceUrl(url);
    expect(res.kind).toBe('invalid');
    expect(res.reason).toBe(reason);
  });

  it('nicht-http(s)-Protokoll → invalid (non_http)', () => {
    expect(classifyPriceSourceUrl('ftp://example.com/pricelist').reason).toBe('non_http');
  });

  it('Host ohne Punkt (localhost) → invalid (invalid_host)', () => {
    expect(classifyPriceSourceUrl('https://localhost/products/x').kind).toBe('invalid');
  });

  it.each([
    ['https://www.ebay.de/itm/234567890123'],
    ['https://www.amazon.de/dp/B0C5351V75'],
    ['https://homedemo.de/products/homedemo-klemmmarkise-mit-einstellbare-handkurbel-balkonmarkise-ohne-bohren'],
    ['https://www.idealo.de/preisvergleich/OffersOfProduct/12345.html'],
  ])('echte Angebotsseite %s → candidate', (url) => {
    const res = classifyPriceSourceUrl(url);
    expect(res.kind).toBe('candidate');
    expect(res.reason).toBe('ok');
  });
});

// ─── filterStructurallySound ─────────────────────────────────────────────────

describe('filterStructurallySound', () => {
  it('trennt Kandidaten von Ausschuss und behält die Original-Einträge', () => {
    const sources = [
      { name: 'eBay Angebot', url: 'https://www.ebay.de/itm/234567890123', price: 105.99 },
      { name: 'eBay Suche', url: 'https://www.ebay.de/sch/i.html?_nkw=test', price: 59.79 },
      { name: 'Thumbnail', url: 'https://encrypted-tbn0.gstatic.com/shopping?q=tbn:abc' },
      { name: 'Kaputt', url: 'ui' },
    ];
    const { candidates, dropped } = filterStructurallySound(sources);
    expect(candidates).toEqual([sources[0]]);
    expect(dropped).toHaveLength(3);
    expect(dropped.map((d) => d.kind)).toEqual(['search', 'image', 'invalid']);
    expect(dropped[0].source).toBe(sources[1]);
  });

  it('nicht-Array → leere Ergebnisse', () => {
    expect(filterStructurallySound(null)).toEqual({ candidates: [], dropped: [] });
  });
});

// ─── priceTextVariants ───────────────────────────────────────────────────────

describe('priceTextVariants', () => {
  it('105.99 → deutsche und englische Schreibweise', () => {
    expect(priceTextVariants(105.99)).toEqual(['105,99', '105.99']);
  });

  it('1234.56 → enthält Tausender-gruppierte Variante 1.234,56', () => {
    expect(priceTextVariants(1234.56)).toContain('1.234,56');
  });

  it('20 → enthält "20,00" und den glatten Betrag "20"', () => {
    const variants = priceTextVariants(20);
    expect(variants).toContain('20,00');
    expect(variants).toContain('20');
  });

  it.each([[0], [-5], [NaN], ['keine zahl'], [null]])('ungültiger Betrag %j → []', (amount) => {
    expect(priceTextVariants(amount)).toEqual([]);
  });
});

// ─── evaluatePageEvidence ────────────────────────────────────────────────────

describe('evaluatePageEvidence', () => {
  it('(a) Seite mit Marke + behauptetem Preis → ok', () => {
    const res = evaluatePageEvidence({
      text: PAGE_WITH_BRAND_AND_PRICE,
      product: PRODUCT,
      claimedPrice: 105.99,
    });
    expect(res).toEqual({ ok: true, reason: 'verified' });
  });

  it('(b) Incident-Fall: behauptet 61,99, Seite zeigt 105,99 → claimed_price_not_on_page', () => {
    const res = evaluatePageEvidence({
      text: PAGE_WRONG_PRICE,
      product: PRODUCT,
      claimedPrice: 61.99,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('claimed_price_not_on_page');
  });

  it('(c) themenfremde Seite trotz passendem Preis → page_not_about_product', () => {
    const res = evaluatePageEvidence({
      text: PAGE_OFF_TOPIC_WITH_PRICE,
      product: PRODUCT,
      claimedPrice: 61.99,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('page_not_about_product');
  });

  it('(d) leerer Seitentext → page_empty', () => {
    expect(evaluatePageEvidence({ text: '', product: PRODUCT, claimedPrice: 105.99 }).reason).toBe('page_empty');
  });

  it('zu kurzer Seitentext (<200 Zeichen) → page_empty', () => {
    expect(
      evaluatePageEvidence({ text: 'HOMEDEMO 105,99', product: PRODUCT, claimedPrice: 105.99 }).reason
    ).toBe('page_empty');
  });

  it('MPN-Treffer reicht als Produkt-Bezug (ohne Marke im Text)', () => {
    const res = evaluatePageEvidence({
      text: `Ersatzteil für Markise, Artikelnummer 65858, sofort lieferbar. Preis: 105,99 €. ${PADDING}`,
      product: PRODUCT,
      claimedPrice: 105.99,
    });
    expect(res.ok).toBe(true);
  });

  it('Preis nur im Roh-HTML (og:price bei JS-Shops) zählt ebenfalls', () => {
    const res = evaluatePageEvidence({
      text: `HOMEDEMO Klemmmarkise Anthrazit — Produktseite. ${PADDING}`,
      html: '<meta property="og:price:amount" content="105.99">',
      product: PRODUCT,
      claimedPrice: 105.99,
    });
    expect(res.ok).toBe(true);
  });

  it('kein behaupteter Preis → no_claimed_price', () => {
    const res = evaluatePageEvidence({
      text: PAGE_WITH_BRAND_AND_PRICE,
      product: PRODUCT,
      claimedPrice: 0,
    });
    expect(res.reason).toBe('no_claimed_price');
  });
});

// ─── verifyPriceSources (fetchPage injiziert) ────────────────────────────────

describe('verifyPriceSources', () => {
  const GOOD_URL = 'https://homedemo.de/products/homedemo-klemmmarkise-echt';
  const DEAD_URL = 'https://homedemo.de/products/tote-seite';
  const OFFTOPIC_URL = 'https://beispielshop.de/products/handyhuelle';

  const fetchPage = vi.fn(async (url) => {
    if (url === GOOD_URL) return { ok: true, status: 200, text: PAGE_WITH_BRAND_AND_PRICE };
    if (url === OFFTOPIC_URL) return { ok: true, status: 200, text: PAGE_OFF_TOPIC_WITH_PRICE };
    return { ok: false, status: 404, text: '' };
  });

  beforeEach(() => {
    fetchPage.mockClear();
  });

  it('verifiziert erreichbare Seiten mit Beleg, failed erfasst 404 und Themenfremdes', async () => {
    const sources = [
      { url: GOOD_URL, price: 105.99 },
      { url: DEAD_URL, price: 105.99 },
      { url: OFFTOPIC_URL, price: 61.99 },
    ];
    const { verified, failed } = await verifyPriceSources({ sources, product: PRODUCT, fetchPage });

    expect(verified).toHaveLength(1);
    expect(verified[0].url).toBe(GOOD_URL);
    expect(verified[0].verified).toBe(true);
    expect(verified[0].verified_at).toEqual(expect.any(String));

    const reasonsByUrl = Object.fromEntries(failed.map((f) => [f.source.url, f.reason]));
    expect(reasonsByUrl[DEAD_URL]).toBe('fetch_failed_404');
    expect(reasonsByUrl[OFFTOPIC_URL]).toBe('page_not_about_product');
  });

  it('nutzt fallbackAmount, wenn die Quelle keinen eigenen Preis trägt', async () => {
    const { verified } = await verifyPriceSources({
      sources: [{ url: GOOD_URL }],
      product: PRODUCT,
      fallbackAmount: 105.99,
      fetchPage,
    });
    expect(verified).toHaveLength(1);
  });

  it('Kappe maxPages: überzählige Quellen → not_checked_cap, kein Fetch dafür', async () => {
    const sources = [
      { url: `${DEAD_URL}-1`, price: 1.99 },
      { url: `${DEAD_URL}-2`, price: 1.99 },
      { url: `${DEAD_URL}-3`, price: 1.99 },
      { url: `${DEAD_URL}-4`, price: 1.99 },
    ];
    const { verified, failed } = await verifyPriceSources({
      sources,
      product: PRODUCT,
      fetchPage,
      maxPages: 2,
    });

    expect(verified).toHaveLength(0);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    const capped = failed.filter((f) => f.reason === 'not_checked_cap');
    expect(capped).toHaveLength(2);
    expect(capped.map((f) => f.source.url)).toEqual([`${DEAD_URL}-3`, `${DEAD_URL}-4`]);
  });

  it('werfender fetchPage → fetch_error:<message>, kein Throw nach außen', async () => {
    const throwing = vi.fn(async () => { throw new Error('kaputt'); });
    const { verified, failed } = await verifyPriceSources({
      sources: [{ url: GOOD_URL, price: 105.99 }],
      product: PRODUCT,
      fetchPage: throwing,
    });
    expect(verified).toHaveLength(0);
    expect(failed[0].reason).toBe('fetch_error:kaputt');
  });
});

// ─── validatePricingProposal ─────────────────────────────────────────────────

describe('validatePricingProposal', () => {
  it('(1) V2-Shape: Such-URL + gefakte Kandidaten-URL (404) → sources leer, confidence 0.3, UNBELEGT-Note', async () => {
    const pricing = {
      lowest_price: {
        amount: 61.99,
        currency: 'EUR',
        sources: [
          { name: 'eBay Suche', url: 'https://www.ebay.de/sch/i.html?_nkw=Klemmmarkise+300x150', price: 59.79 },
          { name: 'HOMEDEMO Official Shop', url: 'https://homedemo.de/products/fake-klemmmarkise', price: 61.99 },
        ],
      },
      price_confidence: 0.9,
    };
    const fetchPage = vi.fn(async () => ({ ok: false, status: 404, text: '' }));

    const res = await validatePricingProposal({ pricing, product: PRODUCT, fetchPage });

    expect(res.pricing.lowest_price.sources).toEqual([]);
    expect(res.pricing.price_confidence).toBe(0.3);
    expect(res.note).toContain('UNBELEGT');
    expect(res.verifiedCount).toBe(0);
    expect(res.droppedCount).toBe(2);

    const check = res.pricing.lowest_price.evidence_check;
    expect(check.verified).toBe(0);
    expect(check.dropped).toBe(2);
    expect(check.dropped_reasons).toContain('search:search_or_category_page');
    expect(check.dropped_reasons).toContain('fetch_failed_404');

    // amount bleibt UNANGETASTET, nur die Belege fliegen raus.
    expect(res.pricing.lowest_price.amount).toBe(61.99);
    // Nur die Kandidaten-URL wird überhaupt geladen — Such-URLs nie.
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage.mock.calls[0][0]).toBe('https://homedemo.de/products/fake-klemmmarkise');
    // Eingabe-Objekt wird nicht mutiert (Deep-Copy).
    expect(pricing.lowest_price.sources).toHaveLength(2);
    expect(pricing.price_confidence).toBe(0.9);
  });

  it('(2) verifizierte Kandidaten-URL bleibt mit verified:true, evidence_check.verified=1', async () => {
    const pricing = {
      lowest_price: {
        amount: 105.99,
        currency: 'EUR',
        sources: [
          { name: 'eBay Suche', url: 'https://www.ebay.de/sch/i.html?_nkw=Klemmmarkise', price: 59.79 },
          { name: 'HOMEDEMO Shop', url: 'https://homedemo.de/products/homedemo-klemmmarkise', price: 105.99 },
        ],
      },
      price_confidence: 0.9,
    };
    const fetchPage = vi.fn(async () => ({ ok: true, status: 200, text: PAGE_WITH_BRAND_AND_PRICE }));

    const res = await validatePricingProposal({ pricing, product: PRODUCT, fetchPage });

    expect(res.verifiedCount).toBe(1);
    expect(res.pricing.lowest_price.sources).toHaveLength(1);
    expect(res.pricing.lowest_price.sources[0].url).toBe('https://homedemo.de/products/homedemo-klemmmarkise');
    expect(res.pricing.lowest_price.sources[0].verified).toBe(true);
    expect(res.pricing.lowest_price.evidence_check.verified).toBe(1);
    // Confidence bleibt unangetastet, aber die verworfene Such-URL wird ehrlich vermerkt.
    expect(res.pricing.price_confidence).toBe(0.9);
    expect(res.note).toContain('1 von 2');
  });

  it('(3) V3-flach {amount, source_url} mit 404 → source_url ENTFERNT, confidence gedeckelt', async () => {
    const pricing = {
      amount: 61.99,
      currency: 'EUR',
      source_url: 'https://homedemo.de/products/klemmmarkise-ohne-bohren',
    };
    const fetchPage = vi.fn(async () => ({ ok: false, status: 404, text: '' }));

    const res = await validatePricingProposal({ pricing, product: PRODUCT, fetchPage });

    expect(res.pricing.source_url).toBeUndefined();
    expect(res.pricing.lowest_price.sources).toEqual([]);
    expect(res.pricing.price_confidence).toBeLessThanOrEqual(0.3);
    expect(res.note).toContain('UNBELEGT');
    // amount bleibt unangetastet (top-level UND gehoben).
    expect(res.pricing.amount).toBe(61.99);
    expect(res.pricing.lowest_price.amount).toBe(61.99);
  });

  it('V3-flach mit VERIFIZIERTER Quelle → source_url bleibt, Quelle verified:true', async () => {
    const pricing = {
      amount: 105.99,
      currency: 'EUR',
      source_url: 'https://homedemo.de/products/homedemo-klemmmarkise-echt',
    };
    const fetchPage = vi.fn(async () => ({ ok: true, status: 200, text: PAGE_WITH_BRAND_AND_PRICE }));

    const res = await validatePricingProposal({ pricing, product: PRODUCT, fetchPage });

    expect(res.verifiedCount).toBe(1);
    expect(res.pricing.source_url).toBe('https://homedemo.de/products/homedemo-klemmmarkise-echt');
    expect(res.pricing.lowest_price.sources[0].verified).toBe(true);
  });

  it('pricing ohne Quellen-Anspruch → Confidence trotzdem auf 0.3 gedeckelt, keine Note', async () => {
    const res = await validatePricingProposal({
      pricing: { lowest_price: { amount: 10, currency: 'EUR', sources: [] }, price_confidence: 0.9 },
      product: PRODUCT,
      fetchPage: vi.fn(),
    });
    expect(res.pricing.price_confidence).toBe(0.3);
    expect(res.note).toBeNull();
    expect(res.verifiedCount).toBe(0);
  });

  it('pricing null/undefined → unverändert durchgereicht (fail-safe)', async () => {
    const res = await validatePricingProposal({ pricing: null, product: PRODUCT, fetchPage: vi.fn() });
    expect(res.pricing).toBeNull();
    expect(res.note).toBeNull();
  });
});
