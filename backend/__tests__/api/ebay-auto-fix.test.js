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

  it('strips category on category-mismatch error', async () => {
    const lastError = new Error('eBay rejected');
    lastError.details = {
      errors: [
        { errorCode: '21916582', longMessage: 'The item cannot be listed in the supplied category.' },
      ],
    };
    const fakeGemini = async () => '{}';
    const out = await autoFixEbayProduct(baseProduct, { lastError, generateText: fakeGemini });
    expect(out.fixes.some((f) => /Kategorie entfernt/i.test(f))).toBe(true);
    expect(out.product.details.categoryId).toBeNull();
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
});
