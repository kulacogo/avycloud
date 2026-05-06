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
const {
  defaultThinkingConfig,
  defaultSafetySettings,
  DEFAULT_STRUCTURED_TEMPERATURE,
} = require('./gemini-config');

/**
 * Centralized helpers for the identify pipeline.
 *
 * Background: Until 2026-04-30 the identify-pipeline (Stage 1 / Stage 3 /
 * outer grounding) ran Gemini 3 with Temperature 0.05–0.15, no thinkingConfig,
 * no urlContext and small token budgets. The chat assistant in the same
 * codebase ran the same model with thinking high, Temperature 1.0, urlContext
 * and atomic tools — and produced markedly better results. This module now
 * pulls the identify calls onto the chat-grade configuration. Each knob is
 * tunable via ENV so we can roll back instantly if needed.
 *
 *   IDENTIFY_THINKING_LEVEL      'high' (default) | 'medium' | 'low' | 'off'
 *   IDENTIFY_URL_CONTEXT         'true' (default) | 'false'
 *   IDENTIFY_TEMP_RECOGNITION    default 0.4   (Stage 1, focused JSON)
 *   IDENTIFY_TEMP_GROUNDING      default 0.6   (outer grounding)
 *   IDENTIFY_TEMP_CONTENT        default 0.7   (Stage 3, content gen)
 *   IDENTIFY_MAX_TOKENS_RECOG    default 4096
 *   IDENTIFY_MAX_TOKENS_GROUND   default 8192
 *   IDENTIFY_MAX_TOKENS_CONTENT  default 8192
 */

function _identifyThinkingLevel() {
  const raw = String(process.env.IDENTIFY_THINKING_LEVEL || 'high').trim().toLowerCase();
  if (raw === 'off' || raw === 'false' || raw === '0' || raw === 'none') return null;
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  return 'high';
}

function _identifyThinkingConfig() {
  const level = _identifyThinkingLevel();
  if (!level) return null;
  // includeThoughts:false because identify is a JSON producer — we don't ship
  // the thoughts to the user; the reasoning still happens server-side.
  return defaultThinkingConfig({ level, includeThoughts: false });
}

function _identifyUrlContextEnabled() {
  const raw = String(process.env.IDENTIFY_URL_CONTEXT || 'true').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function _identifyTools(extraTools = []) {
  const tools = [{ googleSearch: {} }];
  if (_identifyUrlContextEnabled()) {
    tools.push({ urlContext: {} });
  }
  for (const t of extraTools) {
    if (t) tools.push(t);
  }
  return tools;
}

function _envFloat(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 2 ? n : fallback;
}

function _envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Attempt to repair truncated JSON from Gemini.
 * Gemini frequently returns valid JSON that is cut off mid-string or mid-object.
 * This function tries to close open braces/brackets/strings to salvage the data.
 */
function repairTruncatedJson(text) {
  if (!text || typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch {}

  // Strip trailing garbage after last meaningful char
  let cleaned = text.replace(/,\s*$/, '').trim();

  // Close unclosed strings
  const quoteCount = (cleaned.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) cleaned += '"';

  // Close open braces/brackets from the inside out
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }

  // Remove trailing commas before closing
  cleaned = cleaned.replace(/,\s*$/, '');
  // Append closers
  while (stack.length) cleaned += stack.pop();

  try { return JSON.parse(cleaned); } catch {}

  // Last attempt: find the largest valid JSON object prefix
  for (let end = cleaned.length; end > 10; end--) {
    const slice = cleaned.slice(0, end);
    const closers = [];
    let inStr = false;
    let esc = false;
    for (let i = 0; i < slice.length; i++) {
      const c = slice[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') closers.push('}');
      else if (c === '[') closers.push(']');
      else if (c === '}' || c === ']') closers.pop();
    }
    let candidate = slice.replace(/,\s*$/, '');
    if (inStr) candidate += '"';
    candidate = candidate.replace(/,\s*$/, '');
    while (closers.length) candidate += closers.pop();
    try { return JSON.parse(candidate); } catch {}
  }
  return null;
}

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
  timeoutMs,
}) {
  const ai = await getGenAIClient();
  const modelName = resolveModel(model, 'GEMINI_MODEL', DEFAULT_MODEL);
  // SDK-level safety net so a hanging connection cannot live longer than the
  // wall-clock budget. Without this, the @google/genai HTTP transport keeps
  // sockets alive in the background even when callers gave up via Promise.race
  // — that has been linked to Cloud-Run concurrency starvation during the
  // identify cascade. Default 30s; override via timeoutMs arg or
  // GEMINI_GENERIC_TIMEOUT_MS env. Identify-specific timeouts (Stage 1/3 etc.)
  // are still applied at their dedicated call sites.
  const resolvedTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.floor(timeoutMs)
      : parseInt(process.env.GEMINI_GENERIC_TIMEOUT_MS || '30000', 10);

  const response = await ai.models.generateContent({
    model: modelName,
    contents: prompt,
    config: {
      temperature,
      maxOutputTokens,
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
      httpOptions: { timeout: resolvedTimeoutMs },
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

  const parsed = repairTruncatedJson(text);
  if (!parsed) throw new Error('Failed to parse Gemini JSON (even after repair attempt)');
  return parsed;
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
  timeoutMs,
}) {
  const ai = await getGenAIClient();
  const modelName = resolveModel(model, 'GEMINI_MODEL', DEFAULT_MODEL);
  // See gemini3GenerateJSON for rationale.
  const resolvedTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.floor(timeoutMs)
      : parseInt(process.env.GEMINI_GENERIC_TIMEOUT_MS || '30000', 10);

  const response = await ai.models.generateContent({
    model: modelName,
    contents: prompt,
    config: {
      temperature,
      maxOutputTokens,
      httpOptions: { timeout: resolvedTimeoutMs },
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
    title_ebay: { type: 'string', description: 'eBay Titel, 70-80 Zeichen, kaeufergerecht. Nur wahre kaufrelevante Fakten. Groessen (XS,S,M,L,XL,XXL) GROSSBUCHSTABEN' },
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
    mobile_snippet: { type: 'string', description: 'Compact product summary for mobile eBay view, max 800 chars, plain text, no HTML' },
  },
  required: [
    'brand', 'model', 'internalCategory',
    'title_ebay', 'title_kaufland',
    'description_ebay', 'description_kaufland',
    'item_specifics',
  ],
};

// ─── Improve Context: Cassini-optimized prompt extension ───

function buildImprovePromptExtension(ctx) {
  const lines = [];

  // Existing product data as context
  if (ctx.existingProduct) {
    const p = ctx.existingProduct;
    lines.push('BESTEHENDE PRODUKTDATEN (verbessere diese, erfinde nichts Neues):');
    if (p.identification?.name) lines.push(`- Aktueller Titel: ${p.identification.name}`);
    if (p.identification?.brand) lines.push(`- Marke: ${p.identification.brand}`);
    if (p.details?.categoryPath) lines.push(`- Kategorie: ${p.details.categoryPath}`);
    if (p.details?.identifiers?.ean) lines.push(`- EAN: ${p.details.identifiers.ean}`);
    if (p.details?.identifiers?.mpn) lines.push(`- MPN: ${p.details.identifiers.mpn}`);
    lines.push('');
  }

  // Competitor titles as reference
  if (ctx.titleInsights?.sampleTitles?.length) {
    lines.push('WETTBEWERBER-TITEL AUF EBAY (nutze als Referenz fuer Stil und Keywords):');
    ctx.titleInsights.sampleTitles.forEach(t => lines.push(`- ${t}`));
    lines.push('');
  }

  // Top keywords of the category
  if (ctx.titleInsights?.topTokens?.length) {
    lines.push(`TOP-KEYWORDS DIESER KATEGORIE AUF EBAY: ${ctx.titleInsights.topTokens.join(', ')}`);
    lines.push('Integriere relevante Keywords natuerlich in Titel und Beschreibung.');
    lines.push('');
  }

  // Cassini optimization instructions
  lines.push('CASSINI-OPTIMIERUNG (eBay Best-Match Algorithmus):');
  lines.push('- TITEL: Erste 3-5 Woerter sind CTR-kritisch (mobile Ansicht). Struktur: Marke + Produkttyp + Kernmerkmal.');
  lines.push('- TITEL: Nutze alle 80 Zeichen. Integriere Long-Tail-Keywords (z.B. "hoehenverstellbar elektrisch" statt nur "Schreibtisch").');
  lines.push('- TITEL: Studiere die Wettbewerber-Titel oben und uebernimm erfolgreiche Muster.');
  lines.push('- SYNONYME: Ergaenze in der Beschreibung Synonyme und semantische Variationen. Beispiel: "Schreibtisch" → auch "Arbeitstisch", "Buerotisch" erwaehnen.');
  lines.push('- KEYWORD-DICHTE: Verteile die wichtigsten 2-3 Suchbegriffe und ihre Synonyme so, dass sie insgesamt 10-14 Mal in der Beschreibung vorkommen (bei ~200 Woertern = 5-7% Dichte). Natuerlich einweben, KEIN Stuffing.');
  lines.push('- BESCHREIBUNG: ~200 Woerter. HTML: 1x <p> Einleitung (emotionaler Hook) + <ul> mit 5-7 Benefits + 1x <p> technische Details. Professionell und verkaufspsychologisch.');
  lines.push('- HIGHLIGHTS: Mindestens 50% der Bulletpoints im Benefits-Format: "[Kundennutzen] – [technische Spec]". SCHLECHT: "512GB SSD". GUT: "512GB SSD – genug Platz fuer Ihre gesamte Mediathek".');
  lines.push('- ITEM SPECIFICS: Alle Pflicht-UND-empfohlene Artikelmerkmale befuellen. Cassini macht Produkte in Filtern UNSICHTBAR wenn Merkmale fehlen.');
  lines.push('');

  // Mobile snippet instruction
  lines.push('MOBILE SNIPPET (NEUES FELD — mobile_snippet):');
  lines.push('- Erstelle eine kompakte Kurzbeschreibung (max 800 Zeichen, plain text ohne HTML).');
  lines.push('- Diese wird als Schema.org itemprop="description" fuer die mobile eBay-Ansicht genutzt.');
  lines.push('- Muss die wichtigsten Kaufargumente und Keywords enthalten.');
  lines.push('- Kein Duplicate der Hauptbeschreibung, sondern eine eigenstaendige Zusammenfassung.');
  lines.push('');

  return lines.join('\n');
}

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
 *   improveContext: {existingProduct: object, titleInsights: object, categoryTemplate: string|null}|null,
 * }} opts
 * @returns {Promise<object>} Full product record (parsed JSON) + _grounding metadata
 */
async function identifyProductWithGrounding({
  imageParts = [],
  ocrText = '',
  barcodes = [],
  locale = 'de-DE',
  hint = null,
  improveContext = null,
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
1. Identifiziere das Produkt PRAEZISE anhand der Bilder, OCR-Daten und Barcodes.
2. Nutze Google Search um das Produkt eindeutig zu verifizieren und vollstaendige Daten zu recherchieren.
3. Erstelle ein vollstaendiges, marketplace-ready Produktdatenblatt.

KRITISCHE REGEL — PRODUKT KORREKT IDENTIFIZIEREN:
- Erkenne ZUERST was das Produkt tatsaechlich ist (Bilder haben hoechste Prioritaet).
- Marken wie "Anker" (Elektronik), "Apple" (Tech), "Puma" (Sport) sind MARKEN, keine Produktkategorien.
- Ordne das Produkt in die KORREKTE Kategorie ein. Beispiel: "Anker Powerbank" = Elektronik/Ladegeraete, NICHT Bootsport.
- Wenn OCR-Text oder Barcodes widersprüchlich sind, vertraue den BILDERN.

${barcodeBlock}

${ocrBlock}

RECHERCHE-STRATEGIE:
1. Wenn EAN/GTIN vorhanden: Suche ZUERST danach (hoechste Treffergenauigkeit). Beispiel: Suche "0194644170721" um das exakte Produkt zu finden.
2. Wenn Marke+Modell erkennbar: Suche nach "[Marke] [Modell] Datenblatt" oder "[Marke] [Modell] specifications"
3. Fuer Preise: Suche auf idealo.de, geizhals.de, amazon.de oder direkt beim Hersteller
4. Fuer GPSR: Suche nach Hersteller-Impressum oder Produktsicherheitsdaten
5. Fuer Bilder: Suche nach hochwertigen Produktfotos vom Hersteller

QUALITAETSANFORDERUNGEN:
- Titel: 70-80 Zeichen, kaeufergerecht fuer eBay/Kaufland. Orientiere dich an echten Top-Seller-Titeln auf ebay.de fuer dieses Produkt. Nur wahre, kaufrelevante Fakten. Groessenangaben (XS, S, M, L, XL, XXL) immer GROSSBUCHSTABEN. Keine Marketingfloskeln, keine irrelevanten Specs, KEINE Woerter aus falschen Kategorien.
- Kategorie (internalCategory): MUSS das Produkt korrekt beschreiben. Basierend auf Web-Recherche, nicht auf Vermutungen.
- Beschreibung: 180-240 Woerter, HTML (<p>, <ul>, <li>, <strong>), faktenbasiert aus Web-Recherche. Keine Wiederholungen.
- Highlights (key_features): 5-7 Bulletpoints, Format "[Nutzen] - [Eigenschaft]", je 70-120 Zeichen
- Attribute (item_specifics): mindestens 10, technisch/granular, keine Dubletten, deutsche Schluessel. Aus Hersteller-Datenblatt.
- Gewicht: In Gramm, ganzzahlig. Aus Bild/OCR/Web extrahieren. Bei Unsicherheit schaetzen. Nie 0.
- Preis: Aktueller Marktpreis in EUR. price_eur=0 wenn nicht findbar.
- Web-Bilder: Bis zu 3 hochwertige Produktbild-URLs von Hersteller/Shop-Seiten (KEINE Thumbnails, KEINE Platzhalter)
- GPSR: Hersteller-Kontaktdaten wenn im Web findbar
- Zustand: "Neu" als Default, nur "Gebraucht" wenn eindeutige Gebrauchsspuren sichtbar
- EAN/GTIN: Nur wenn korrekte Checkdigit. Sonst leer lassen.

${improveContext ? buildImprovePromptExtension(improveContext) : ''}WICHTIG:
- Nur belegbare Fakten. Nichts erfinden.
- Wenn Information nicht findbar: Feld leer lassen.
- Antwort ausschliesslich als JSON gemaess Schema.`
  });

  const GROUNDING_TIMEOUT_MS = parseInt(process.env.IDENTIFY_GROUNDING_TIMEOUT_MS || '90000', 10);
  const groundingConfig = {
    tools: _identifyTools(),
    temperature: _envFloat('IDENTIFY_TEMP_GROUNDING', 0.6),
    maxOutputTokens: _envInt('IDENTIFY_MAX_TOKENS_GROUND', 8192),
    responseMimeType: 'application/json',
    responseJsonSchema: FULL_PRODUCT_SCHEMA,
    safetySettings: defaultSafetySettings(),
    httpOptions: { timeout: GROUNDING_TIMEOUT_MS },
  };
  const groundingThinking = _identifyThinkingConfig();
  if (groundingThinking) groundingConfig.thinkingConfig = groundingThinking;

  const response = await ai.models.generateContent({
    model: modelName,
    contents: [{ role: 'user', parts }],
    config: groundingConfig,
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

  const record = repairTruncatedJson(text);
  if (!record) throw new Error('Failed to parse grounding JSON (even after repair)');

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

// ─── IDENTIFY V3: Narrow Recognition Schema ───

const RECOGNITION_SCHEMA = {
  type: 'object',
  properties: {
    brand: { type: 'string', description: 'Markenname des Herstellers' },
    model: { type: 'string', description: 'Modellbezeichnung/Modellnummer' },
    mpn: { type: 'string', description: 'Herstellerteilenummer (MPN)' },
    variant: { type: 'string', description: 'Variante (Farbe, Groesse etc.)' },
    ean: { type: 'string', description: 'EAN-13 (13 Ziffern) nur wenn verifiziert' },
    gtin: { type: 'string', description: 'GTIN-14 (14 Ziffern) nur wenn verifiziert' },
    upc: { type: 'string', description: 'UPC-12 nur wenn verifiziert' },
    condition: { type: 'string', description: 'Zustand: Neu oder Gebraucht' },
    internalCategory: { type: 'string', description: 'Kategorie-Pfad z.B. Elektronik > Kopfhoerer > Over-Ear' },
    weight_grams: { type: 'integer', description: 'Gewicht in Gramm (ganzzahlig, nie 0)' },
    color: { type: 'string', description: 'Hauptfarbe' },
    size: { type: 'string', description: 'Groesse/Abmessung' },
    material: { type: 'string', description: 'Hauptmaterial' },
    notes: { type: 'string', description: 'Hinweise zu Unsicherheiten' },
  },
  required: ['brand', 'model', 'internalCategory'],
};

/**
 * V3 Stage 1: Focused product recognition — identity only, no content generation.
 */
async function identifyProductFocused({ imageParts = [], ocrText = '', barcodes = [], locale = 'de-DE', hint = null } = {}) {
  const ai = await getGenAIClient();
  const modelName = resolveModel(null, 'IDENTIFY_MODEL', DEFAULT_MODEL);

  const parts = [];
  for (const img of imageParts) {
    if (!img?.data) continue;
    parts.push({ inlineData: { mimeType: img.mimeType || 'image/jpeg', data: img.data } });
  }

  const hintBlock = hint ? `PRODUKTHINWEIS: Fokussiere dich NUR auf: ${hint}\n\n` : '';
  const barcodeBlock = barcodes.length ? `BARCODES: ${barcodes.join(', ')}` : 'BARCODES: keine';
  const ocrBlock = ocrText.trim() ? `OCR-TEXT:\n${ocrText.trim().slice(0, 2000)}` : 'OCR-TEXT: nicht verfuegbar';

  parts.push({
    text: `${hintBlock}Du bist ein Produkterkenner. Deine EINZIGE Aufgabe: Identifiziere das Produkt.

${barcodeBlock}
${ocrBlock}

REGELN:
- Erkenne Marke, Modell, MPN aus Bildern und OCR
- Nutze Google Search um Barcodes zu verifizieren und das exakte Produkt zu finden
- Ordne das Produkt in die KORREKTE eBay.de-Kategorie ein (Pfad mit >)
- EAN/GTIN nur eintragen wenn die Pruefsumme stimmt
- KEINE Titel, KEINE Beschreibungen, KEINE Preise generieren
- Nur Identifikationsdaten. Nichts erfinden.`
  });

  const recognitionConfig = {
    tools: _identifyTools(),
    temperature: _envFloat('IDENTIFY_TEMP_RECOGNITION', DEFAULT_STRUCTURED_TEMPERATURE),
    maxOutputTokens: _envInt('IDENTIFY_MAX_TOKENS_RECOG', 4096),
    responseMimeType: 'application/json',
    responseJsonSchema: RECOGNITION_SCHEMA,
    safetySettings: defaultSafetySettings(),
    httpOptions: { timeout: parseInt(process.env.IDENTIFY_RECOGNITION_TIMEOUT_MS || '45000', 10) },
  };
  const recognitionThinking = _identifyThinkingConfig();
  if (recognitionThinking) recognitionConfig.thinkingConfig = recognitionThinking;

  const response = await ai.models.generateContent({
    model: modelName,
    contents: [{ role: 'user', parts }],
    config: recognitionConfig,
  });

  let text = (response.text || '').trim();
  if (!text) throw new Error('Gemini returned empty response for focused recognition');
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  const jsonStart = text.indexOf('{');
  if (jsonStart > 0 && jsonStart < 200) text = text.slice(jsonStart);

  const record = repairTruncatedJson(text);
  if (!record) throw new Error('Failed to parse focused grounding JSON (even after repair)');

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

// ─── IDENTIFY V3: Content Generation Schema ───

const CONTENT_SCHEMA = {
  type: 'object',
  properties: {
    title_ebay: { type: 'string', description: 'eBay Titel, 70-80 Zeichen' },
    title_kaufland: { type: 'string', description: 'Kaufland Titel, bis 100 Zeichen' },
    description_ebay: { type: 'string', description: 'eBay Beschreibung in HTML, 180-240 Woerter' },
    description_kaufland: { type: 'string', description: 'Kaufland Beschreibung in HTML' },
    key_features: { type: 'array', items: { type: 'string' }, description: '5-7 Bulletpoints' },
    item_specifics: {
      type: 'array',
      items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] },
      description: 'Alle Pflicht-Artikelmerkmale + mind. 10 weitere',
    },
    mobile_snippet: { type: 'string', description: 'Kompakte Kurzbeschreibung max 800 Zeichen, plain text' },
    gpsr_manufacturer_name: { type: 'string' },
    gpsr_manufacturer_address: { type: 'string' },
    gpsr_manufacturer_email: { type: 'string' },
    gpsr_manufacturer_phone: { type: 'string' },
    gpsr_manufacturer_country: { type: 'string' },
  },
  required: ['title_ebay', 'title_kaufland', 'description_ebay', 'item_specifics'],
};

/**
 * V3 Stage 3: Context-rich content generation with all enrichment data.
 *
 * Receives the full Stage 1 + Stage 2 output (OCR text, EAN-DB lookup, GPSR
 * web fallback, image search results, weight fallback, all uploaded images).
 * Previously Stage 3 saw only 2 images and the bare identity-block — Gemini
 * was effectively asked to write a marketplace-ready datasheet blind. The new
 * input surface mirrors what the chat assistant has access to, plus the
 * verified ground-truth from the upstream stages.
 */
async function generateProductContent({
  identity,
  enrichment,
  imageParts = [],
  locale = 'de-DE',
  ocrSnippets = [],
  eanLookup = null,
  webImages = [],
  weightFallback = null,
  gpsrWebFallback = null,
  barcodeConfirmation = null,
} = {}) {
  const ai = await getGenAIClient();
  const modelName = resolveModel(null, 'IDENTIFY_MODEL', DEFAULT_MODEL);

  const maxImages = _envInt('STAGE3_MAX_IMAGES', 4);
  const parts = [];
  for (const img of (imageParts || []).slice(0, maxImages)) {
    if (!img?.data) continue;
    parts.push({ inlineData: { mimeType: img.mimeType || 'image/jpeg', data: img.data } });
  }

  const sections = [];

  // Identity (verified, do not change)
  sections.push('VERIFIZIERTE IDENTITAET (nicht aendern):');
  sections.push(`- Marke: ${identity.brand || 'unbekannt'}`);
  sections.push(`- Modell: ${identity.model || 'unbekannt'}`);
  if (identity.mpn) sections.push(`- MPN: ${identity.mpn}`);
  if (identity.ean) sections.push(`- EAN: ${identity.ean}`);
  if (identity.variant) sections.push(`- Variante: ${identity.variant}`);
  if (identity.color) sections.push(`- Farbe: ${identity.color}`);
  if (identity.size) sections.push(`- Groesse: ${identity.size}`);
  if (identity.material) sections.push(`- Material: ${identity.material}`);
  sections.push('');

  // OCR snippets — most valuable signal for warehouse-style packaging photos.
  // Cap aggregate length so token budget stays sane; trim each snippet to 300 chars.
  if (Array.isArray(ocrSnippets) && ocrSnippets.length) {
    const cleaned = ocrSnippets
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter(Boolean)
      .map((s) => s.slice(0, 300))
      .slice(0, 12);
    if (cleaned.length) {
      sections.push('OCR-TEXT (vom Verpackungs-Label, hochwertige Quelle fuer Aspekte):');
      cleaned.forEach((s, i) => sections.push(`[${i + 1}] ${s}`));
      sections.push('');
    }
  }

  // External EAN-DB hit (when available — strong signal: brand, product name, category)
  if (eanLookup && typeof eanLookup === 'object') {
    const lines = [];
    if (eanLookup.brand) lines.push(`- Marke (DB): ${eanLookup.brand}`);
    if (eanLookup.productName) lines.push(`- Produkt (DB): ${eanLookup.productName}`);
    if (eanLookup.category) lines.push(`- Kategorie (DB): ${eanLookup.category}`);
    if (lines.length) {
      sections.push('EAN-DATENBANK-TREFFER (verifiziert):');
      sections.push(...lines);
      sections.push('');
    }
  }

  // Web-confirmed barcode evidence
  if (barcodeConfirmation && Array.isArray(barcodeConfirmation.evidence) && barcodeConfirmation.evidence.length) {
    sections.push('BARCODE-WEB-BESTAETIGUNG (Top-Treffer):');
    barcodeConfirmation.evidence.slice(0, 5).forEach((e) => {
      const t = (e?.title || '').slice(0, 140);
      const u = e?.url || '';
      if (t || u) sections.push(`- ${t}${u ? ` (${u})` : ''}`);
    });
    sections.push('');
  }

  // Required aspects
  if (enrichment.requiredAspects?.length) {
    sections.push('PFLICHT-ARTIKELMERKMALE (ALLE ausfuellen, KEIN "Unbekannt" wenn vermeidbar):');
    enrichment.requiredAspects.forEach((a) => sections.push(`- ${a}`));
    sections.push('');
  }

  // Competitor titles
  if (enrichment.titleInsights?.sampleTitles?.length) {
    sections.push('WETTBEWERBER-TITEL AUF EBAY (nutze als Referenz):');
    enrichment.titleInsights.sampleTitles.slice(0, 8).forEach((t) => sections.push(`- ${t}`));
    sections.push('');
  }

  // Top keywords
  if (enrichment.titleInsights?.topTokens?.length) {
    sections.push(`TOP-KEYWORDS: ${enrichment.titleInsights.topTokens.join(', ')}`);
    sections.push('');
  }

  // Price data
  if (enrichment.pricing?.amount > 0) {
    sections.push(`VERIFIZIERTER PREIS: ${enrichment.pricing.amount} ${enrichment.pricing.currency || 'EUR'}`);
    if (enrichment.pricing.sources?.length) {
      sections.push(`Quellen: ${enrichment.pricing.sources.map((s) => s.url || s.name).filter(Boolean).join(', ')}`);
    }
    sections.push('');
  }

  // Weight fallback — when Stage 1 OCR didn't catch a weight, Stage 2 Web search did.
  if (weightFallback && typeof weightFallback === 'object' && weightFallback.weight_grams) {
    sections.push(`WEB-RECHERCHIERTES GEWICHT: ${weightFallback.weight_grams} g`);
    if (Array.isArray(weightFallback.sources) && weightFallback.sources.length) {
      sections.push(`Quellen: ${weightFallback.sources.slice(0, 3).map((s) => s.url || s).filter(Boolean).join(', ')}`);
    }
    sections.push('');
  }

  // GPSR data — registry first, then web fallback
  if (enrichment.gpsr?.found) {
    sections.push('GPSR-DATEN AUS REGISTRY (verifiziert, NICHT aendern):');
    const g = enrichment.gpsr.data || {};
    if (g.manufacturer_name) sections.push(`- Name: ${g.manufacturer_name}`);
    if (g.manufacturer_address) sections.push(`- Adresse: ${g.manufacturer_address}`);
    if (g.email) sections.push(`- E-Mail: ${g.email}`);
    if (g.manufacturer_phone) sections.push(`- Telefon: ${g.manufacturer_phone}`);
    if (g.entity_country) sections.push(`- Land: ${g.entity_country}`);
    sections.push('');
  } else if (gpsrWebFallback && typeof gpsrWebFallback === 'object') {
    const g = gpsrWebFallback;
    const lines = [];
    if (g.manufacturer_name) lines.push(`- Name: ${g.manufacturer_name}`);
    if (g.manufacturer_address) lines.push(`- Adresse: ${g.manufacturer_address}`);
    if (g.email) lines.push(`- E-Mail: ${g.email}`);
    if (g.manufacturer_phone) lines.push(`- Telefon: ${g.manufacturer_phone}`);
    if (g.entity_country) lines.push(`- Land: ${g.entity_country}`);
    if (lines.length) {
      sections.push('GPSR-DATEN AUS WEB-RECHERCHE (Hersteller-Impressum, bevorzugt nutzen wenn Registry leer):');
      sections.push(...lines);
      sections.push('Wenn diese Werte plausibel zur Marke passen, uebernehmen.');
      sections.push('');
    }
  }

  // Web images already collected (extra context for description)
  if (Array.isArray(webImages) && webImages.length) {
    const titles = webImages.map((i) => i?.title).filter(Boolean).slice(0, 6);
    if (titles.length) {
      sections.push('WEB-BILD-TITEL (Kontext fuer Produkt-Variante):');
      titles.forEach((t) => sections.push(`- ${t.slice(0, 120)}`));
      sections.push('');
    }
  }

  // Category context
  if (enrichment.category?.ebayBreadcrumb) {
    sections.push(`EBAY-KATEGORIE: ${enrichment.category.ebayBreadcrumb}`);
    sections.push('');
  }

  sections.push(buildImprovePromptExtension({
    existingProduct: null,
    titleInsights: enrichment.titleInsights || {},
  }));

  parts.push({
    text: `Du bist ein professioneller Produktdaten-Kurator fuer eBay.de und Kaufland.de.

${sections.join('\n')}

AUFGABE: Erstelle ein VOLLSTAENDIGES Produktdatenblatt basierend auf den obigen verifizierten Daten und den Bildern.
- Titel, Beschreibungen, Highlights, Artikelmerkmale, GPSR
- Nutze die OCR-Snippets als primaere Quelle fuer Pflicht-Artikelmerkmale (Material, Farbe, Groesse, Modell-Variante etc.)
- Wenn Du Daten aus dem Web brauchst (Specs, Hersteller, Preise, Vergleichsprodukte): nutze googleSearch UND urlContext (nicht nur Snippets — folge Links zu Hersteller-Seiten und vollstaendige Datenblaetter).
- Cross-Reference mindestens 2 unabhaengige Quellen wenn Du etwas aus dem Web uebernimmst.
- Pflicht-Aspekte VOLLSTAENDIG ausfuellen — "Unbekannt" nur als allerletztes Mittel; recherchiere zuerst.
- Item-Specifics: alle Pflicht-UND-empfohlene Aspekte; deutsche Schluessel; Werte praezise (max 60 Zeichen).
- Beschreibung: 180-240 Woerter, HTML, faktenbasiert.
- Nichts erfinden. Nur belegbare Fakten.`
  });

  const contentConfig = {
    tools: _identifyTools(),
    temperature: _envFloat('IDENTIFY_TEMP_CONTENT', 0.7),
    maxOutputTokens: _envInt('IDENTIFY_MAX_TOKENS_CONTENT', 8192),
    responseMimeType: 'application/json',
    responseJsonSchema: CONTENT_SCHEMA,
    safetySettings: defaultSafetySettings(),
    httpOptions: { timeout: parseInt(process.env.STAGE3_GEMINI_TIMEOUT_MS || '60000', 10) },
  };
  const contentThinking = _identifyThinkingConfig();
  if (contentThinking) contentConfig.thinkingConfig = contentThinking;

  const response = await ai.models.generateContent({
    model: modelName,
    contents: [{ role: 'user', parts }],
    config: contentConfig,
  });

  let text = (response.text || '').trim();
  if (!text) throw new Error('Gemini returned empty response for content generation');
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  const jsonStart = text.indexOf('{');
  if (jsonStart > 0 && jsonStart < 200) text = text.slice(jsonStart);

  const parsed = repairTruncatedJson(text);
  if (!parsed) throw new Error('Failed to parse Gemini JSON (even after repair attempt)');
  return parsed;
}

module.exports = {
  getGenAIClient,
  gemini3GenerateJSON,
  gemini3GenerateText,
  identifyProductWithGrounding,
  buildImprovePromptExtension,
  identifyProductFocused,
  generateProductContent,
  FULL_PRODUCT_SCHEMA,
  RECOGNITION_SCHEMA,
  CONTENT_SCHEMA,
  DEFAULT_MODEL,
};
