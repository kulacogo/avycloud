'use strict';

/**
 * gemini3-client.js — Central Gemini 3 client using @google/genai SDK.
 *
 * The new SDK properly supports thinking models (gemini-3-pro-preview, gemini-2.5-flash)
 * with reliable JSON structured output. The old @google/generative-ai SDK (0.24.x)
 * cannot handle thinking model responses correctly.
 *
 * Usage:
 *   const { gemini3GenerateJSON } = require('./gemini3-client');
 *   const result = await gemini3GenerateJSON({
 *     prompt: 'Estimate the weight of this product...',
 *     schema: { type: 'OBJECT', properties: { weightKg: { type: 'NUMBER' } }, required: ['weightKg'] },
 *   });
 *   // result is already parsed JSON
 */

const { getGeminiApiKey } = require('./gemini-client');
const { resolveModel } = require('./model-select');

const DEFAULT_MODEL = 'gemini-3-pro-preview';

let _clientPromise = null;

/**
 * Lazy-load the ESM-only @google/genai SDK via dynamic import.
 * Returns a GoogleGenAI instance.
 */
function getGenAIClient() {
  if (!_clientPromise) {
    _clientPromise = (async () => {
      const apiKey = await getGeminiApiKey();
      const { GoogleGenAI } = await import('@google/genai');
      return new GoogleGenAI({ apiKey });
    })();
  }
  return _clientPromise;
}

/**
 * Generate structured JSON output from Gemini.
 *
 * @param {{
 *   prompt: string,
 *   schema: object,
 *   model?: string,
 *   temperature?: number,
 *   maxOutputTokens?: number,
 * }} opts
 * @returns {Promise<object>} Parsed JSON response
 */
async function gemini3GenerateJSON({
  prompt,
  schema,
  model,
  temperature = 0.1,
  maxOutputTokens = 1024,
}) {
  const ai = await getGenAIClient();
  const modelName = resolveModel(model, 'GEMINI_MODEL', DEFAULT_MODEL);

  const response = await ai.models.generateContent({
    model: modelName,
    contents: prompt,
    config: {
      temperature,
      maxOutputTokens,
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
    },
  });

  let text = (response.text || '').trim();
  if (!text) {
    throw new Error(`Gemini (${modelName}) returned empty response`);
  }

  // Safety: strip markdown fences if model wraps output
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  const jsonStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  const start = jsonStart >= 0 && (arrStart < 0 || jsonStart < arrStart) ? jsonStart : arrStart;
  if (start > 0) text = text.slice(start);

  return JSON.parse(text);
}

/**
 * Generate free-text content from Gemini.
 *
 * @param {{
 *   prompt: string,
 *   model?: string,
 *   temperature?: number,
 *   maxOutputTokens?: number,
 * }} opts
 * @returns {Promise<string>}
 */
async function gemini3GenerateText({
  prompt,
  model,
  temperature = 0.7,
  maxOutputTokens = 2048,
}) {
  const ai = await getGenAIClient();
  const modelName = resolveModel(model, 'GEMINI_MODEL', DEFAULT_MODEL);

  const response = await ai.models.generateContent({
    model: modelName,
    contents: prompt,
    config: {
      temperature,
      maxOutputTokens,
    },
  });

  return (response.text || '').trim();
}

// ─── PERF-001: Full Product Schema for Google Search Grounding ───

const FULL_PRODUCT_SCHEMA = {
  type: 'object',
  properties: {
    brand: { type: 'string', description: 'Markenname des Herstellers' },
    model: { type: 'string', description: 'Modellbezeichnung/Modellnummer' },
    sku: { type: 'string', description: 'SKU wenn erkennbar' },
    variant: { type: 'string', description: 'Variante (Farbe, Größe etc.)' },
    gtin: { type: 'string', description: 'GTIN-14 (14 Ziffern) wenn verifiziert' },
    ean: { type: 'string', description: 'EAN-13 (13 Ziffern) wenn verifiziert' },
    upc: { type: 'string', description: 'UPC-12 wenn verifiziert' },
    mpn: { type: 'string', description: 'Herstellerteilenummer (MPN)' },
    color: { type: 'string', description: 'Hauptfarbe' },
    size: { type: 'string', description: 'Groesse/Abmessung' },
    material: { type: 'string', description: 'Hauptmaterial' },
    condition: { type: 'string', description: 'Zustand: Neu oder Gebraucht' },
    weight_grams: { type: 'integer', description: 'Gewicht in Gramm (ganzzahlig, nie 0)' },
    internalCategory: { type: 'string', description: 'Kategorie-Pfad z.B. Elektronik > Kopfhoerer' },
    title_ebay: { type: 'string', description: 'eBay Titel, 70-80 Zeichen, SEO-optimiert' },
    title_kaufland: { type: 'string', description: 'Kaufland Titel, bis 100 Zeichen' },
    description_ebay: { type: 'string', description: 'eBay Beschreibung in HTML, 180-240 Woerter' },
    description_kaufland: { type: 'string', description: 'Kaufland Beschreibung in HTML' },
    key_features: {
      type: 'array',
      items: { type: 'string' },
      description: '5-7 Bulletpoints, je 70-120 Zeichen, Format: Nutzen - Eigenschaft',
    },
    item_specifics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['key', 'value'],
      },
      description: 'Mind. 10 technische Attribute als key-value Paare',
    },
    price_eur: { type: 'number', description: 'Aktueller Marktpreis in EUR (0 wenn nicht findbar)' },
    price_source_url: { type: 'string', description: 'URL der Preisquelle' },
    price_source_name: { type: 'string', description: 'Name der Preisquelle' },
    web_image_urls: {
      type: 'array',
      items: { type: 'string' },
      description: 'Bis zu 3 hochwertige Produktbild-URLs von Hersteller/Shop-Seiten',
    },
    gpsr_manufacturer_name: { type: 'string', description: 'GPSR Hersteller-Name' },
    gpsr_manufacturer_address: { type: 'string', description: 'GPSR Hersteller-Adresse' },
    gpsr_manufacturer_email: { type: 'string', description: 'GPSR Hersteller-E-Mail' },
    gpsr_manufacturer_phone: { type: 'string', description: 'GPSR Hersteller-Telefon' },
    gpsr_manufacturer_country: { type: 'string', description: 'GPSR Hersteller-Land (ISO 2-letter)' },
    notes: { type: 'string', description: 'Hinweise zu Unsicherheiten oder fehlenden Daten' },
  },
  required: [
    'brand', 'model', 'internalCategory',
    'title_ebay', 'title_kaufland',
    'description_ebay', 'description_kaufland',
    'item_specifics',
  ],
};

/**
 * PERF-001: Single-call product identification with Google Search Grounding.
 *
 * Replaces the multi-step pipeline (generateStructuredProductRecord +
 * prefetchWebEvidence + runDatasheetReview × 2 + enrichPrice + fetchMarketingImages)
 * with ONE Gemini call that sees images + searches the web + returns structured JSON.
 *
 * Uses @google/genai SDK (v1.44+) which supports:
 *   - googleSearch tool (built-in Google Search Grounding)
 *   - responseMimeType: 'application/json' + responseJsonSchema (structured output)
 *   - Inline image data (multimodal)
 *
 * @param {{
 *   imageParts: Array<{data: string, mimeType: string}>,
 *   ocrText: string,
 *   barcodes: string[],
 *   locale: string,
 *   hint: string|null,
 * }} opts
 * @returns {Promise<object>} Full product record (parsed JSON) + _grounding metadata
 */
async function identifyProductWithGrounding({
  imageParts = [],
  ocrText = '',
  barcodes = [],
  locale = 'de-DE',
  hint = null,
} = {}) {
  const ai = await getGenAIClient();
  const modelName = resolveModel(null, 'IDENTIFY_MODEL', DEFAULT_MODEL);

  const parts = [];

  // Inline images (already compressed, base64)
  for (const img of imageParts) {
    if (!img?.data) continue;
    parts.push({
      inlineData: {
        mimeType: img.mimeType || 'image/jpeg',
        data: img.data,
      },
    });
  }

  // Build prompt
  const hintBlock = hint
    ? `PRODUKTHINWEIS: Fokussiere dich NUR auf: ${hint}\nIgnoriere alle anderen Produkte auf dem Bild.\n\n`
    : '';

  const barcodeBlock = barcodes.length
    ? `BARCODES (vom Scanner/OCR): ${barcodes.join(', ')}`
    : 'BARCODES: keine vorhanden';

  const ocrBlock = ocrText.trim()
    ? `OCR-TEXT (vom Label/Verpackung):\n${ocrText.trim().slice(0, 2000)}`
    : 'OCR-TEXT: nicht verfuegbar';

  parts.push({
    text: `${hintBlock}Du bist ein professioneller Produktdaten-Kurator fuer eBay.de und Kaufland.de.

DEINE AUFGABE:
Identifiziere das Produkt anhand der Bilder, OCR-Daten und Barcodes.
Nutze Google Search um fehlende Informationen zu recherchieren (Hersteller-Specs, Preise, GPSR-Daten, Produktbilder-URLs).

${barcodeBlock}

${ocrBlock}

RECHERCHE-STRATEGIE:
1. Wenn EAN/GTIN vorhanden: Suche zuerst danach (hoechste Treffergenauigkeit)
2. Wenn Marke+Modell erkennbar: Suche nach "[Marke] [Modell] Datenblatt" oder "[Marke] [Modell] specifications"
3. Fuer Preise: Suche nach dem Produkt auf idealo.de, geizhals.de oder direkt im Shop
4. Fuer GPSR: Suche nach Hersteller-Impressum oder Produktsicherheitsdaten
5. Fuer Bilder: Suche nach hochwertigen Produktfotos vom Hersteller

QUALITAETSANFORDERUNGEN:
- Titel: 70-80 Zeichen, suchmaschinenoptimiert, Marke + Produkttyp + Kernmerkmal zuerst. Keine Marketingfloskeln.
- Beschreibung: 180-240 Woerter, HTML (<p>, <ul>, <li>, <strong>), faktenbasiert, keine Wiederholungen
- Highlights (key_features): 5-7 Bulletpoints, Format "[Nutzen] - [Eigenschaft]", je 70-120 Zeichen
- Attribute (item_specifics): mindestens 10, technisch/granular, keine Dubletten, deutsche Schluessel
- Gewicht: In Gramm, ganzzahlig. Aus Bild/OCR/Web extrahieren. Bei Unsicherheit schaetzen. Nie 0.
- Preis: Aktueller Marktpreis in EUR. price_eur=0 wenn nicht findbar.
- Web-Bilder: Bis zu 3 hochwertige Produktbild-URLs von Hersteller/Shop-Seiten
- GPSR: Hersteller-Kontaktdaten wenn im Web findbar
- Zustand: "Neu" als Default, nur "Gebraucht" wenn eindeutige Gebrauchsspuren sichtbar
- EAN/GTIN: Nur wenn korrekte Checkdigit. Sonst leer lassen.

WICHTIG:
- Nur belegbare Fakten. Nichts erfinden.
- Wenn Information nicht findbar: Feld leer lassen.
- Antwort ausschliesslich als JSON gemaess Schema.`
  });

  const response = await ai.models.generateContent({
    model: modelName,
    contents: [{ role: 'user', parts }],
    config: {
      tools: [{ googleSearch: {} }],
      temperature: 0.1,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
      responseJsonSchema: FULL_PRODUCT_SCHEMA,
    },
  });

  let text = (response.text || '').trim();
  if (!text) {
    throw new Error(`Gemini (${modelName}) returned empty response for identify-with-grounding`);
  }

  // Strip markdown fences if present
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  const jsonStart = text.indexOf('{');
  if (jsonStart > 0 && jsonStart < 200) text = text.slice(jsonStart);

  const record = JSON.parse(text);

  // Attach grounding metadata for traceability
  const candidates = response.candidates || [];
  const groundingMeta = candidates[0]?.groundingMetadata || {};
  record._grounding = {
    model: modelName,
    searchQueries: groundingMeta.webSearchQueries || [],
    sources: (groundingMeta.groundingChunks || [])
      .map((c) => ({ title: c?.web?.title, url: c?.web?.uri }))
      .filter((s) => s.url)
      .slice(0, 10),
  };

  return record;
}

module.exports = {
  getGenAIClient,
  gemini3GenerateJSON,
  gemini3GenerateText,
  identifyProductWithGrounding,
  FULL_PRODUCT_SCHEMA,
  DEFAULT_MODEL,
};
