'use strict';
// Gemini-Grounding als Preis-Fallback (Owner-Anforderung 2026-08-02):
// SerpAPI und eBay-Browse liefern für viele Bestandsprodukte keine Preise —
// eine einfache Google-Suche findet sie sofort. Dieser Lookup läuft als
// LETZTER Fallback in ensurePriceCoverage (services/enrichment.js) und
// liefert Kandidaten im Format von pickBestPriceCandidate. Er setzt NUR den
// recherchierten Marktpreis (lowest_price), NIE sellPrice.
// Kill-Switch: PRICE_GEMINI_LOOKUP=off.

const { resolveModel } = require('./model-select');

const OFFER_SCHEMA = {
  type: 'object',
  properties: {
    offers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          price: { type: 'number' },
          currency: { type: 'string' },
          url: { type: 'string' },
          merchant: { type: 'string' },
          matched_by: { type: 'string' },
          product_title: { type: 'string' },
        },
        required: ['price', 'url'],
      },
    },
  },
  required: ['offers'],
};

function _enabled() {
  const raw = String(process.env.PRICE_GEMINI_LOOKUP || '').trim().toLowerCase();
  return !(raw === 'off' || raw === 'false' || raw === '0');
}

function _buildPrompt({ brand, name, mpn, barcode }) {
  return [
    'Finde AKTUELLE Verkaufspreise (Neuware) für dieses Produkt bei deutschen Online-Händlern.',
    'Nutze Google Search. Produkt:',
    `- Marke: ${brand || 'unbekannt'}`,
    `- Name: ${name || 'unbekannt'}`,
    mpn ? `- Herstellernummer (MPN): ${mpn}` : null,
    barcode ? `- EAN/Barcode: ${barcode}` : null,
    '',
    'REGELN:',
    '- 3 bis 6 Angebote, nur ECHTE Produktseiten-URLs (keine Suchseiten, keine Kategorieseiten).',
    '- Nur EXAKT dieses Modell. matched_by: "ean" | "mpn" | "name" je nachdem, worüber du das Angebot verifiziert hast.',
    '- price als Zahl in EUR (Endkundenpreis inkl. MwSt).',
    '- Wenn du KEINE Angebote findest: leere offers-Liste. NICHTS erfinden.',
    'Antworte AUSSCHLIESSLICH als JSON: {"offers":[{"price","currency","url","merchant","matched_by","product_title"}]}',
  ].filter(Boolean).join('\n');
}

/**
 * @param {object} product products_v2-Doc (identification + details)
 * @param {object} opts { ai?: injizierter GenAI-Client (Tests), timeoutMs?: number }
 * @returns {Promise<Array>} Preis-Kandidaten für pickBestPriceCandidate
 */
async function lookupPricesViaGemini(product, opts = {}) {
  if (!_enabled()) return [];

  const brand = String(product?.identification?.brand || '').trim();
  const name = String(product?.identification?.name || '').trim();
  const mpn = String(
    product?.details?.identifiers?.mpn || product?.details?.attributes?.Herstellernummer || ''
  ).trim();
  const barcode = []
    .concat(Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : [])
    .concat([product?.details?.identifiers?.ean, product?.details?.identifiers?.gtin])
    .map((v) => String(v || '').trim())
    .find((v) => v.length >= 8) || '';

  if (!name && !mpn && !barcode) return [];

  const gemini3 = require('./gemini3-client');
  const ai = opts.ai || (await gemini3.getGenAIClient());
  const modelName = resolveModel(null, 'PRICE_GEMINI_MODEL', 'gemini-2.5-flash');
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 45000;

  let parsed;
  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: [{ role: 'user', parts: [{ text: _buildPrompt({ brand, name, mpn, barcode }) }] }],
      config: {
        tools: [{ googleSearch: {} }],
        temperature: 0.2,
        maxOutputTokens: 4096,
        thinkingConfig: { thinkingBudget: 1024, includeThoughts: false },
        httpOptions: { timeout: timeoutMs },
      },
    });
    require('./grounding-usage').trackGroundingQueries(response, 'price.gemini_lookup');
    const rawText = (response.text || '').trim();
    if (!rawText) return [];
    parsed = await gemini3._parseGroundedJson({
      ai, modelName, responseText: rawText, schema: OFFER_SCHEMA,
      timeoutMs, maxOutputTokens: 2048, label: 'price-lookup',
    });
  } catch (err) {
    console.warn(`[gemini-price-lookup] fehlgeschlagen für ${product?.id || '?'}: ${err?.message || err}`);
    return [];
  }

  const offers = Array.isArray(parsed?.offers) ? parsed.offers : [];
  return offers
    .filter((o) =>
      typeof o?.price === 'number' && Number.isFinite(o.price) && o.price >= 1 && o.price <= 20000 &&
      typeof o?.url === 'string' && /^https?:\/\//i.test(o.url.trim())
    )
    .slice(0, 6)
    .map((o) => {
      const matchedBy = String(o.matched_by || '').toLowerCase();
      return {
        amount: o.price,
        currency: String(o.currency || 'EUR').toUpperCase().slice(0, 3),
        url: o.url.trim(),
        source: `Gemini: ${String(o.merchant || 'Web').slice(0, 40)}`,
        title: String(o.product_title || '').slice(0, 120),
        has_mpn: matchedBy === 'mpn',
        has_barcode: matchedBy === 'ean' || matchedBy === 'gtin' || matchedBy === 'barcode',
        has_brand: Boolean(brand),
        match_count: 2,
        match_tier: matchedBy === 'mpn' || matchedBy === 'ean' ? 'exact' : 'name',
      };
    });
}

module.exports = { lookupPricesViaGemini };
