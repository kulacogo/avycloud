/**
 * Tests: backend/services/ebay-auto-fix.js
 *
 * Verifiziert die zentralen Auto-Fix-Strategien:
 *  - Aspect-Extraktion aus eBay-Fehlertexten (DE + EN Patterns)
 *  - Kategorie-Mismatch Strip
 *  - Pflicht-Aspect-Auffüllung via Gemini-Mock
 *  - Skip wenn nichts fixbar
 *
 * Pure Functions, keine Firestore- oder HTTP-Calls — Gemini wird per
 * `opts.generateText` injected.
 */

const { autoFixEbayProduct, extractMissingAspectNames } = require('../../services/ebay-auto-fix');

describe('extractMissingAspectNames', () => {
  it('parses english "is required" pattern', () => {
    const out = extractMissingAspectNames([
      "Item Specifics 'Brand' is required for this category.",
    ]);
    expect(out).toContain('Brand');
  });

  it('parses german "Es fehlt das Merkmal" pattern', () => {
    const out = extractMissingAspectNames([
      "Es fehlt das Merkmal 'Marke'.",
    ]);
    expect(out).toContain('Marke');
  });

  it('parses german "Pflichtangabe X fehlt" pattern', () => {
    const out = extractMissingAspectNames([
      "Pflichtangabe 'Farbe' fehlt im Listing.",
    ]);
    expect(out).toContain('Farbe');
  });

  it('parses german "Das Merkmal X ist erforderlich" pattern', () => {
    const out = extractMissingAspectNames([
      'Das Merkmal Hersteller ist erforderlich.',
    ]);
    expect(out).toContain('Hersteller');
  });

  it('returns empty array for non-matching messages', () => {
    expect(extractMissingAspectNames(['Some unrelated error'])).toEqual([]);
    expect(extractMissingAspectNames([])).toEqual([]);
  });

  it('dedupes across multiple messages', () => {
    const out = extractMissingAspectNames([
      "Item Specifics 'Marke' is required",
      "Es fehlt das Merkmal 'Marke'",
    ]);
    expect(out).toEqual(['Marke']);
  });
});

describe('autoFixEbayProduct', () => {
  const baseProduct = {
    id: 'p-1',
    identification: { name: 'Sony WH-1000XM5 Kopfhörer', brand: 'Sony' },
    details: { categoryId: '15052', identifiers: { ean: '4548736134034' }, attributes: {} },
  };

  it('returns skip when no error and no missing aspects', async () => {
    const fakeGemini = async () => '{}';
    const out = await autoFixEbayProduct(baseProduct, { generateText: fakeGemini });
    expect(out.skip).toBe(true);
    expect(out.fixes).toEqual([]);
  });

  it('does NOT mutate categoryId on category-mismatch error (handled by addFixedPriceItem retry)', async () => {
    // Regression: previously this helper set product.details.categoryId = null, which was
    // persisted and then caused "Produkt hat keine eBay-Kategorie" on subsequent runs
    // because buildListingFromProduct requires a categoryId. eBay's own retry layer
    // (inside addFixedPriceItem) already re-sends without <PrimaryCategory>, so this
    // strategy is not needed here.
    const lastError = new Error('eBay rejected');
    lastError.details = {
      errors: [
        { errorCode: '21916582', longMessage: 'The item cannot be listed in the supplied category.' },
      ],
    };
    const originalCategoryId = baseProduct.details.categoryId;
    const fakeGemini = async () => '{}';
    const out = await autoFixEbayProduct(baseProduct, { lastError, generateText: fakeGemini });
    expect(out.fixes.some((f) => /Kategorie entfernt/i.test(f))).toBe(false);
    expect(out.product.details.categoryId).toBe(originalCategoryId);
  });

  it('fills missing aspects from Gemini response', async () => {
    const lastError = new Error('eBay rejected');
    lastError.details = {
      errors: [
        { longMessage: "Item Specifics 'Marke' is required for this category." },
      ],
    };
    const fakeGemini = async () => '```json\n{"Marke":"Sony"}\n```';
    const out = await autoFixEbayProduct(baseProduct, { lastError, generateText: fakeGemini });
    expect(out.skip).toBe(false);
    expect(out.product.details.attributes.Marke).toBe('Sony');
    expect(out.fixes.some((f) => /Pflicht-Merkmale/i.test(f))).toBe(true);
  });

  it('returns skip when Gemini cannot help and no other fixes apply', async () => {
    const lastError = new Error('eBay rejected');
    lastError.details = {
      errors: [{ longMessage: "Item Specifics 'Unbekanntes' is required" }],
    };
    const fakeGemini = async () => '{}';
    const out = await autoFixEbayProduct(baseProduct, { lastError, generateText: fakeGemini });
    expect(out.skip).toBe(true);
  });

  it('does not overwrite existing attribute values', async () => {
    const product = {
      ...baseProduct,
      details: { ...baseProduct.details, attributes: { Marke: 'Sony' } },
    };
    const lastError = new Error('eBay rejected');
    lastError.details = {
      errors: [{ longMessage: "Item Specifics 'Marke' is required" }],
    };
    const fakeGemini = async () => '{"Marke":"WrongValue"}';
    const out = await autoFixEbayProduct(product, { lastError, generateText: fakeGemini });
    // Marke war schon gesetzt, also nicht in stillMissing → Gemini wird gar nicht gefragt → skip
    expect(out.product.details.attributes.Marke).toBe('Sony');
  });

  it('handles Gemini timeout gracefully', async () => {
    const lastError = new Error('eBay rejected');
    lastError.details = {
      errors: [{ longMessage: "Item Specifics 'Marke' is required" }],
    };
    const slowGemini = () => new Promise(() => { /* never resolves */ });
    const out = await autoFixEbayProduct(baseProduct, { lastError, generateText: slowGemini });
    // Sollte ohne throw zurückkehren — und da kein anderer Fix greift, skip:true
    expect(out.skip).toBe(true);
  });

  it('handles missing product gracefully', async () => {
    const out = await autoFixEbayProduct(null);
    expect(out.skip).toBe(true);
  });

  it('Strategy 4 — aspects cap exceeded error trims to 45 entries', async () => {
    const manyAttrs = {};
    for (let i = 1; i <= 55; i += 1) manyAttrs[`Attribut_${i}`] = `Wert ${i}`;
    const product = {
      id: 'p-cap',
      identification: { name: 'Generic Product', brand: 'X' },
      details: {
        categoryId: '99999', // unknown — falls back to insertion order
        identifiers: { ean: '0' },
        attributes: manyAttrs,
      },
    };
    const lastError = new Error('eBay rejected');
    lastError.details = {
      errors: [{ longMessage: 'Dieses Angebot enthält zu viele Artikelmerkmale. Reduzieren Sie die Anzahl auf 45 oder weniger.' }],
    };
    const out = await autoFixEbayProduct(product, { lastError, generateText: async () => '{}' });
    expect(out.skip).toBe(false);
    expect(out.fixes.some((f) => /auf 45 reduziert/i.test(f))).toBe(true);
    expect(Object.keys(out.product.details.attributes).length).toBe(45);
  });

  it('Strategy 3 — image conflict error sets skipEbayCatalogLookup when own images exist', async () => {
    const product = {
      id: 'p-img',
      identification: { name: 'Some Item', brand: 'X' },
      details: {
        categoryId: '99999',
        identifiers: { ean: '4000000000001' },
        attributes: {},
        images: [{ url_or_base64: 'https://example.com/real.jpg', source: 'upload', variant: 'reference' }],
      },
    };
    const lastError = new Error('eBay rejected');
    lastError.details = {
      errors: [{ longMessage: 'EPS-Bilder und selbstverwaltete Bilder können nicht kombiniert werden.' }],
    };
    const out = await autoFixEbayProduct(product, { lastError, generateText: async () => '{}' });
    expect(out.skip).toBe(false);
    expect(out.product.details.skipEbayCatalogLookup).toBe(true);
    expect(out.fixes.some((f) => /Katalog-Verkn/i.test(f))).toBe(true);
  });

  it('Strategy 3 — skips when image conflict error but no own images (safety)', async () => {
    // Without own images, dropping catalog would yield an image-less listing,
    // which eBay rejects. Auto-fix must refuse to apply this strategy.
    const product = {
      id: 'p-img-none',
      identification: { name: 'Some Item', brand: 'X' },
      details: { categoryId: '99999', identifiers: { ean: '4000000000001' }, attributes: {}, images: [] },
    };
    const lastError = new Error('eBay rejected');
    lastError.details = {
      errors: [{ longMessage: 'EPS-Bilder und selbstverwaltete Bilder können nicht kombiniert werden.' }],
    };
    const out = await autoFixEbayProduct(product, { lastError, generateText: async () => '{}' });
    expect(out.skip).toBe(true);
    expect(out.product.details.skipEbayCatalogLookup).toBeUndefined();
  });
});
