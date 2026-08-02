/**
 * Gemini-Grounding als Preis-Fallback (Owner 2026-08-02): "jede einfache
 * Google-Suche wird da Preise ausspucken" — SerpAPI/eBay-Browse liefern für
 * 9/13 Bestandsprodukte nichts, die Gemini-Suche fehlt in der Kette komplett.
 */
const { lookupPricesViaGemini } = require('../../lib/gemini-price-lookup');

const PRODUCT = {
  id: 'p1',
  identification: {
    name: 'Ninja Foodi StaySharp Messerblock K32006EU',
    brand: 'Ninja',
    barcodes: ['0622356249713'],
  },
  details: { identifiers: { mpn: 'K32006EU' } },
};

function fakeAiReturning(text) {
  const calls = [];
  return {
    calls,
    models: {
      generateContent: async (req) => {
        calls.push(req);
        return { text };
      },
    },
  };
}

describe('lookupPricesViaGemini', () => {
  beforeEach(() => { delete process.env.PRICE_GEMINI_LOOKUP; });

  it('maps grounded offers into price candidates (candidate shape for pickBestPriceCandidate)', async () => {
    const ai = fakeAiReturning(JSON.stringify({
      offers: [
        { price: 129.99, currency: 'EUR', url: 'https://www.otto.de/p/ninja-k32006eu', merchant: 'OTTO', matched_by: 'mpn' },
        { price: 119.0, currency: 'EUR', url: 'https://www.mediamarkt.de/de/product/123', merchant: 'MediaMarkt', matched_by: 'ean' },
      ],
    }));
    const out = await lookupPricesViaGemini(PRODUCT, { ai });
    expect(out).toHaveLength(2);
    expect(out[0].amount).toBe(129.99);
    expect(out[0].currency).toBe('EUR');
    expect(out[0].url).toContain('otto.de');
    expect(out[0].source).toContain('OTTO');
    expect(out[0].has_mpn).toBe(true);
    expect(out[1].has_barcode).toBe(true);
    expect(out[1].has_brand).toBe(true);
  });

  it('filters micro prices, absurd prices and non-http URLs', async () => {
    const ai = fakeAiReturning(JSON.stringify({
      offers: [
        { price: 0.01, currency: 'EUR', url: 'https://x.de/a', merchant: 'A' },
        { price: 99999, currency: 'EUR', url: 'https://x.de/b', merchant: 'B' },
        { price: 50, currency: 'EUR', url: 'javascript:alert(1)', merchant: 'C' },
        { price: 89.9, currency: 'EUR', url: 'https://www.saturn.de/p/9', merchant: 'Saturn', matched_by: 'name' },
      ],
    }));
    const out = await lookupPricesViaGemini(PRODUCT, { ai });
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe(89.9);
  });

  it('returns [] without any API call when PRICE_GEMINI_LOOKUP=off', async () => {
    process.env.PRICE_GEMINI_LOOKUP = 'off';
    const ai = fakeAiReturning('{}');
    const out = await lookupPricesViaGemini(PRODUCT, { ai });
    expect(out).toEqual([]);
    expect(ai.calls).toHaveLength(0);
  });

  it('returns [] on unparseable responses instead of throwing', async () => {
    const ai = fakeAiReturning('keine daten gefunden, sorry');
    const out = await lookupPricesViaGemini(PRODUCT, { ai });
    expect(out).toEqual([]);
  });

  it('sends a grounded request (googleSearch tool, no forced JSON) with product identifiers in the prompt', async () => {
    const ai = fakeAiReturning(JSON.stringify({ offers: [] }));
    await lookupPricesViaGemini(PRODUCT, { ai });
    expect(ai.calls.length).toBeGreaterThanOrEqual(1);
    const req = ai.calls[0];
    expect(req.config.tools.some((t) => t.googleSearch)).toBe(true);
    expect(req.config.responseMimeType).toBeUndefined();
    const prompt = req.contents[0].parts.map((p) => p.text || '').join(' ');
    expect(prompt).toContain('K32006EU');
    expect(prompt).toContain('0622356249713');
  });
});
