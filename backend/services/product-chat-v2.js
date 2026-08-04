'use strict';

/**
 * product-chat-v2.js — Grounding-first product chat using @google/genai SDK.
 *
 * Replaces the legacy chat pipeline (BrightData + SerpAPI + web_fetch + complex
 * fallback loops) with a clean architecture:
 *
 *   1. Google Search Grounding for web research (native Gemini capability)
 *   2. Function Calling for product mutations only (update_product_datasheet,
 *      suggest_product_images, generate_ai_images)
 *   3. Natural conversation — no rigid intent detection, no forced evidence passes
 *
 * The user's UI provides "Übernehmen" (apply) buttons for proposed changes.
 * Gemini decides autonomously when to search and when to propose changes.
 *
 * ENV: CHAT_GROUNDING=true (default) activates this pipeline.
 *      Falls back to legacy product-chat.js on error.
 */

const { getGenAIClient } = require('../lib/gemini3-client');
const { resolveModel } = require('../lib/model-select');
const { generateImagesForProduct } = require('./image-generation');
const { searchProductImages } = require('../lib/image-search');
const { normalizeDigits, isValidGtin } = require('../lib/gtin');
const { coerceTitleToPolicy } = require('../lib/title-policy');
const { buildCommonPolicyText } = require('../lib/llm-policy-pack');
const { getActiveLlmConfig, resolveScopeConfig } = require('../lib/llm-config');

// Phase F.1b.3 — best-effort scope-config (additive, never throws).
async function _tryResolveScopeConfigChatV2(scopeName, tenantId, callerOverrides) {
  try {
    return await resolveScopeConfig(scopeName, tenantId || null, callerOverrides || {});
  } catch (err) {
    let logger = null;
    try { logger = require('../lib/logger'); } catch (_) { /* logger optional in tests */ }
    if (logger && typeof logger.warn === 'function') {
      logger.warn(
        { scopeId: scopeName, tenantId: tenantId || null, reason: err?.message || String(err) },
        '[chat-v2] resolveScopeConfig failed, using hardcoded defaults'
      );
    }
    return null;
  }
}
const { sanitizeListingText, sanitizeDescriptionToHtml, sanitizeDescriptionProse, sanitizeHighlights } = require('../lib/listing-sanitize');
const { normalizeHighlightsStrict } = require('../lib/highlights-policy');
const {
  canonicalizeAttributeKey,
  canonicalizeAttributesStrict,
  coerceAttributeValueToPolicy,
  isBlockedAttributeKey,
} = require('../lib/attribute-policy');
const {
  getRequiredAspects,
  getCategoryAspectCatalog,
  buildRequiredAspectMeta,
  getRequiredAspectCatalogStats,
} = require('../lib/ebay-taxonomy');
const { getVehicleFitmentMode } = require('../lib/vehicle-fitment');
const { getRulebookConfigCached } = require('../lib/rulebook-config');
const { fetchCategoryTitleInsights } = require('../lib/ebay-browse-title-insights');
const { decodeHtmlEntitiesDeep } = require('../lib/html-entities');

const MAX_CHAT_ITERATIONS = 12;
const MAX_PRODUCT_IMAGE_PARTS = 4;
const PRODUCT_IMAGE_TIMEOUT_MS = parseInt(process.env.CHAT_IMAGE_TIMEOUT_MS || '8000', 10);

// Feature flag: CHAT_V2_ENHANCED enables Gemini 3 enhancements (urlContext tool,
// temperature 1.0, thinkingConfig, higher token budget, 2x retry on 5xx).
// Default: true. Set to 'false' to revert to original V2 behavior (temp 0.3,
// 4096 tokens, no urlContext) if a production regression appears.
function isChatV2Enhanced() {
  const raw = (process.env.CHAT_V2_ENHANCED == null ? 'true' : String(process.env.CHAT_V2_ENHANCED))
    .trim()
    .toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'no' && raw !== 'off';
}

// Exponential backoff helper for transient (5xx / network) Gemini failures.
// Tuned for Gemini API overload bursts: 4 attempts (initial + 3 retries) with
// exponential backoff up to 8s. Each attempt has a HARD per-attempt timeout
// (default 30s) — without it, the @google/genai SDK can hang ~90s on TLS-level
// socket-stalls before its implicit timeout fires (observed 2026-05-11 during
// Gemini regional outage). Per-attempt timeout converts hangs into fast
// fail-and-retry cycles.
//
// Worst-case wall-time: 4 × 30s + (1+3+8) = 132s. Without per-attempt timeout:
// 4 × 90s = 360s+, which exceeds frontend abort and shows "no response".
const GEMINI_RETRY_PER_ATTEMPT_TIMEOUT_MS = parseInt(
  process.env.GEMINI_RETRY_PER_ATTEMPT_TIMEOUT_MS || '30000',
  10,
);
// Phase-A-Recherche (Split-Modus): gegroundete Long-Calls brauchen 30-60s —
// eigenes Budget analog IDENTIFY_GROUNDING_TIMEOUT_MS (Prod-Vorfall 2026-08-04:
// 30s-Default → 3x abgewürgt, 2min Retries, dann Legacy-Fallback).
const RESEARCH_PER_ATTEMPT_TIMEOUT_MS = parseInt(
  process.env.CHAT_V2_RESEARCH_TIMEOUT_MS || '90000',
  10,
);
async function withGeminiRetry(operation, { label = 'gemini', perAttemptTimeoutMs = GEMINI_RETRY_PER_ATTEMPT_TIMEOUT_MS, maxAttempts = 4 } = {}) {
  // maxAttempts kappt die Versuche (default 4 = bisheriges Verhalten). Für
  // teure Long-Calls (Phase-A-Recherche, 90s-Budget) wären 4 Versuche bis zu
  // ~6min Wartezeit — dort gilt 2.
  const delays = [1000, 3000, 8000].slice(0, Math.max(0, (Number(maxAttempts) || 4) - 1));
  let lastErr = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const opPromise = Promise.resolve().then(() => operation());
      // Suppress unhandled-rejection if operation eventually settles AFTER the
      // timeout fires.
      opPromise.catch(() => {});
      return await Promise.race([
        opPromise,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`${label} per-attempt timeout after ${perAttemptTimeoutMs}ms`)),
            perAttemptTimeoutMs,
          ),
        ),
      ]);
    } catch (err) {
      lastErr = err;
      const status = err?.status ?? err?.code ?? err?.response?.status ?? null;
      const transient =
        (typeof status === 'number' && status >= 500 && status < 600) ||
        /\btimeout\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|per-attempt timeout/i.test(
          err?.message || ''
        );
      if (!transient || attempt === delays.length) {
        throw err;
      }
      const delay = delays[attempt];
      console.warn(`[chat-v2] ${label} transient failure (status=${status}, attempt=${attempt + 1}), retrying in ${delay}ms: ${err?.message || err}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Helpers (shared with legacy, inlined here to keep the file self-contained)
// ---------------------------------------------------------------------------

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeSpaces(value = '') {
  return safeString(value).replace(/\s+/g, ' ').trim();
}

function decodePlainText(value) {
  return decodeHtmlEntitiesDeep(value).replace(/\s+/g, ' ').trim();
}

function normalizeImageKey(url = '') {
  const s = safeString(url);
  if (!s || s.length < 10) return '';
  if (s.startsWith('data:')) {
    const marker = s.slice(0, 80);
    return marker;
  }
  try {
    const u = new URL(s);
    return `${u.hostname}${u.pathname}`.toLowerCase();
  } catch {
    return s.slice(0, 120).toLowerCase();
  }
}

function toAttributesObject(attributes = []) {
  if (!attributes) return {};
  if (Array.isArray(attributes)) {
    return attributes.reduce((acc, entry) => {
      if (!entry?.key) return acc;
      const key = decodePlainText(entry.key);
      if (!key) return acc;
      const value = typeof entry.value === 'string' ? decodePlainText(entry.value) : entry.value ?? '';
      acc[key] = value;
      return acc;
    }, {});
  }
  if (typeof attributes === 'object') {
    return Object.entries(attributes).reduce((acc, [key, value]) => {
      const cleanedKey = decodePlainText(key);
      if (!cleanedKey) return acc;
      acc[cleanedKey] = typeof value === 'string' ? decodePlainText(value) : value;
      return acc;
    }, {});
  }
  return {};
}

// ---------------------------------------------------------------------------
// Tool Definitions (for Gemini function calling — @google/genai format)
// ---------------------------------------------------------------------------

const UPDATE_DATASHEET_DECLARATION = {
  name: 'update_product_datasheet',
  description: 'Propose structured changes to the product datasheet. The user confirms in the UI — never ask for confirmation.',
  parameters: {
    type: 'OBJECT',
    properties: {
      summary: { type: 'STRING', description: 'Short explanation of what changed and why.' },
      title: { type: 'STRING', description: 'New product title (70-80 chars, search-optimized).' },
      identity: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          brand: { type: 'STRING' },
          category: { type: 'STRING' },
          sku: { type: 'STRING' },
          barcodes: { type: 'ARRAY', items: { type: 'STRING' } },
          ean: { type: 'STRING' },
          gtin: { type: 'STRING' },
          upc: { type: 'STRING' },
          clear: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'List of identity fields to explicitly clear (e.g. ["barcodes", "ean", "gtin", "upc"]). Use only when the user explicitly asks to delete these values (e.g. resolving an eBay catalog vs K-Typ conflict).',
          },
        },
      },
      short_description: { type: 'STRING', description: 'HTML product description (180-240 words).' },
      key_features: { type: 'ARRAY', items: { type: 'STRING' }, description: '5-7 bullet points.' },
      gpsr: {
        type: 'OBJECT',
        description: 'GPSR compliance data — manufacturer contact info. MUST go here, NOT in attributes.',
        properties: {
          entity_country: { type: 'STRING' },
          country_code: { type: 'STRING' },
          manufacturer_name: { type: 'STRING' },
          manufacturer_address: { type: 'STRING' },
          manufacturer_city: { type: 'STRING' },
          manufacturer_postalcode: { type: 'STRING' },
          manufacturer_state_province: { type: 'STRING' },
          email: { type: 'STRING' },
          manufacturer_phone: { type: 'STRING' },
          url: { type: 'STRING' },
        },
      },
      attributes: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            key: { type: 'STRING' },
            value: { type: 'STRING' },
            value_type: { type: 'STRING' },
          },
          required: ['key', 'value'],
        },
        description: 'Product attributes/item specifics.',
      },
      pricing: {
        type: 'OBJECT',
        properties: {
          sellPrice: {
            type: 'NUMBER',
            description:
              'Der VERKAUFSPREIS des Angebots in EUR (das Feld, das eBay/Kaufland syncen). ' +
              'IMMER setzen, wenn der User einen Preis festlegen oder eine Preisempfehlung übernehmen will. ' +
              'lowest_price ist NUR Markt-Recherche-Doku und ändert den Angebotspreis NICHT.',
          },
          lowest_price: {
            type: 'OBJECT',
            properties: {
              amount: { type: 'NUMBER' },
              currency: { type: 'STRING' },
              sources: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    name: { type: 'STRING' },
                    url: { type: 'STRING' },
                    price: { type: 'NUMBER' },
                    shipping: { type: 'NUMBER' },
                    checked_at: { type: 'STRING' },
                  },
                },
              },
              last_checked_iso: { type: 'STRING' },
            },
          },
          price_confidence: { type: 'NUMBER' },
        },
      },
      notes: {
        type: 'OBJECT',
        properties: {
          unsure: { type: 'ARRAY', items: { type: 'STRING' } },
          warnings: { type: 'ARRAY', items: { type: 'STRING' } },
        },
      },
    },
  },
};

const SUGGEST_IMAGES_DECLARATION = {
  name: 'suggest_product_images',
  description: 'Search for real product images on the web using Google/Bing Image Search. Provide a precise search query — the system will find actual, verified image URLs via SerpAPI. Do NOT invent or guess image URLs yourself.',
  parameters: {
    type: 'OBJECT',
    properties: {
      query: {
        type: 'STRING',
        description: 'Search query for product images, e.g. "Anker PowerCore 20000mAh Powerbank" or "0194644170721" (EAN). Be specific: include brand, model, and key identifiers.',
      },
      rationale: {
        type: 'STRING',
        description: 'Short explanation why these images are being searched.',
      },
    },
    required: ['query'],
  },
};

const GENERATE_AI_IMAGES_DECLARATION = {
  name: 'generate_ai_images',
  description: 'Generate photorealistic product packshots using AI. Only call when user EXPLICITLY requests AI-generated images.',
  parameters: {
    type: 'OBJECT',
    properties: {
      reference_image_url: { type: 'STRING' },
      reference_variant: { type: 'STRING' },
      rationale: { type: 'STRING' },
    },
  },
};

// ---------------------------------------------------------------------------
// System Prompt — conversational, clear, not a rules dump
// ---------------------------------------------------------------------------

function buildSystemPromptV2(locale = 'de-DE') {
  const baseRules = buildCommonPolicyText({ locale, allowWebEvidence: true });

  return `Du bist der AvyCloud Produkt-CoPilot — ein erfahrener E-Commerce-Experte für eBay.de und Kaufland.de.

DEIN VERHALTEN:
- Antworte natürlich und hilfreich wie ein Kollege der Produktdaten kennt.
- Recherchiere SELBSTSTÄNDIG im Web (du hast Google Search) — frag nie "Soll ich suchen?".
- Wenn der User Änderungen will: recherchiere zuerst, dann rufe update_product_datasheet auf.
- Frag NICHT nach Bestätigung ("Soll ich aktualisieren?") — der User hat eine "Übernehmen"-UI.
- Halte Antworten kurz und direkt (max ~1000 Zeichen), außer der User will Details.
- Du kannst auch einfache Fragen beantworten, Tipps geben, Analysen machen — du bist kein reiner Dateneditor.

SCHRITT 1 — PRODUKT VERIFIZIEREN (IMMER zuerst, bevor du irgendetwas optimierst):
Die bestehenden Produktdaten im Kontext können FALSCH sein (falsche Kategorie, falscher Name, falsche Marke).
Prüfe IMMER anhand der Produktbilder, EAN/GTIN und Markenname, ob die bestehenden Daten plausibel sind.
- Suche im Web nach der EAN/GTIN oder "[Marke] [Modellnummer]" um das Produkt eindeutig zu identifizieren.
- Wenn die Kategorie offensichtlich falsch ist (z.B. "Bootsport > Anker" für eine Anker Powerbank), korrigiere sie SOFORT.
- Wenn der Titel unsinnige Wörter enthält (z.B. "Boot", "Kette" bei einer Powerbank), erstelle einen komplett neuen Titel.
- Vertraue NIE blind den bestehenden Daten — verifiziere sie gegen Web-Recherche und Produktbilder.

SCHRITT 2 — RECHERCHIEREN:
- Suche im Web nach dem korrekt identifizierten Produkt.
- Nutze Google Search für: Herstellerseite, Datenblatt, technische Specs, Preisvergleich, GPSR.
- Suche nach "[Marke] [Modell] Datenblatt" oder "[EAN]" für präzise Ergebnisse.

SCHRITT 3 — ÄNDERUNGEN VORSCHLAGEN:
- Rufe update_product_datasheet auf mit ALLEN korrigierten/verbesserten Feldern.

TOOLS:
- Google Search: Steht dir automatisch zur Verfügung. Nutze es für Datenblätter, Preise, GPSR, Spezifikationen, Bilder.
- update_product_datasheet: PFLICHT wenn du Produktdaten ändern willst. IMMER aufrufen — beschreibe Änderungen NIE nur im Text ohne Tool-Call. IMMER mit Begründung (summary). Ohne Tool-Call werden Änderungen NICHT gespeichert.
- suggest_product_images: Sucht ECHTE Produktbilder per Google/Bing Image Search. Gib einen präzisen Suchbegriff an (Marke + Modell + ggf. EAN). Erfinde KEINE Bild-URLs selbst — das System findet reale, verifizierte URLs.
- generate_ai_images: NUR wenn der User explizit KI-Bilder will.

KRITISCH: Wenn du Verbesserungen vorschlägst, MUSST du update_product_datasheet aufrufen. Text allein reicht nicht — der User kann nur Tool-Ergebnisse über "Übernehmen" anwenden. Ohne Tool-Call = keine Übernahme möglich.

QUALITÄT:
- Titel: 70–80 Zeichen, käufergerecht für eBay/Kaufland. Orientiere dich an echten Top-Seller-Titeln auf ebay.de für dieses Produkt (suche ebay.de zuerst!). Nur wahre, kaufrelevante Fakten. Größen (XS, S, M, L, XL, XXL) immer GROSSBUCHSTABEN. Keine Marketing-Floskeln, keine EAN/GTIN/SKU, keine irrelevanten Specs. KEINE Wörter aus falschen Kategorien.
- Beschreibung: HTML (<p>, <ul>, <li>, <strong>), 180–240 Wörter, faktenbasiert. Basierend auf Web-Recherche, nicht auf falschen Bestandsdaten.
- Highlights: 5–7 Bulletpoints, je 70–120 Zeichen, "[Nutzen] - [Eigenschaft]".
- Attribute: Nur belegbare Fakten. Deutsche Schlüssel. ≤60 Zeichen pro Wert. Verwende die ebay.allowed_aspects als Referenz, aber wenn die Kategorie falsch ist, ignoriere die alten Aspects und korrigiere zuerst die Kategorie.
- GPSR: Unter gpsr-Objekt, NIE als Attribute.
- Preis: Aktueller Marktpreis in EUR wenn findbar.
- PREIS-QUELLEN (STRENG): In pricing.lowest_price.sources dürfen NUR URLs stehen, die du in DIESER Recherche tatsächlich in den Suchergebnissen gesehen hast — kopiere sie EXAKT, konstruiere oder rate NIEMALS eine URL. Jede Quelle muss eine konkrete ANGEBOTSSEITE genau dieses Produkts sein: gleiche Marke, gleiches Modell UND gleiche Variante (Größe/Maße/Farbe wie im Datenblatt). Such-/Ergebnisseiten (ebay.de/sch, amazon.de/s, idealo-Suche, Google) sind VERBOTEN. Der price-Wert der Quelle muss der Preis sein, der auf GENAU dieser Seite für GENAU diese Variante steht — bei mehreren Größen/Varianten NIE den Preis der kleinsten Variante nehmen. Findest du keine solche Quelle: sources leer lassen, price_confidence auf höchstens 0.3 setzen und dem User EHRLICH sagen, dass kein belastbarer Beleg gefunden wurde. Das System prüft jede Quelle automatisch nach — erfundene Quellen werden erkannt und verworfen.
- Preisempfehlung ÜBERNEHMEN: Wenn der User einen Verkaufspreis festlegen oder deine Empfehlung übernehmen will, schreibe ihn in pricing.sellPrice (Zahl, EUR). pricing.lowest_price ist nur die Recherche-Dokumentation — sie ändert den Angebotspreis NICHT. Sage nie "aktualisiert", wenn du sellPrice nicht gesetzt hast.
- Encoding: Echte Umlaute (ä, ö, ü, ß), kein HTML-Encoding.
- Titel-Konsistenz: Nie widersprüchliche Token mischen (z.B. Damen+Herren, verschiedene Marken, Kategorie-Wörter die nicht zum Produkt passen).
- Kategorie: Wenn die bestehende Kategorie falsch ist, gib die korrekte Kategorie im identity-Objekt an.

SCOPE-REGEL: Wenn ein SCOPE angegeben ist, ändere NUR Felder innerhalb dieses Scopes. AUSNAHME: Wenn die Kategorie offensichtlich falsch ist, korrigiere sie IMMER mit, auch wenn sie nicht im Scope ist.

IDENTIFIER KORRIGIEREN (EAN/UPC/GTIN):
- Ein Produkt hat je Typ GENAU EINEN Code: EAN (13 oder 8 Stellen), UPC (12 Stellen), GTIN (14 Stellen). Es kann NICHT mehrere EANs geben.
- Wenn der User eine EAN/UPC/GTIN korrigiert: liefere in \`identity.barcodes\` die VOLLSTÄNDIGE korrekte Liste (also nur die tatsächlich gültigen Codes) — die alten falschen Codes werden dadurch ERSETZT, nicht ergänzt. Beispiel: User sagt "die korrekte EAN ist 0791137689823" → \`identity: { barcodes: ["0791137689823"] }\` (alle anderen fallen weg).
- Alternativ das Einzelfeld setzen: \`identity: { ean: "0791137689823" }\`. Nenne dann ggf. zu entfernende Typen in \`identity.clear\`.

IDENTIFIER LÖSCHEN (EAN/GTIN/UPC/Barcodes):
- Wenn der User explizit verlangt EAN/GTIN/Barcodes zu LÖSCHEN (z.B. eBay-Konflikt zwischen Katalog und K-Typ-Liste bei Auto-Teilen), verwende das Feld \`identity.clear\` im update_product_datasheet-Tool.
- Beispiel: \`identity: { clear: ["barcodes", "ean", "gtin", "upc"] }\` löscht ALLE Identifier-Felder.
- WICHTIG: Ein leeres \`barcodes: []\` Array reicht NICHT aus — der Sanitizer ignoriert leere Arrays. NUR \`identity.clear\` löscht wirklich.
- Behaupte NIE im Text dass Felder gelöscht wurden, ohne den korrekten Tool-Call zu machen — das verwirrt den User.
- Hinweis: Bei Auto-Teilen mit K-Typ-Liste ist das Löschen der EAN oft NICHT mehr nötig, da das System die Katalog-Verknüpfung automatisch überspringt wenn K-Typ vorhanden ist. Frag den User vorher, ob er die EAN-Daten wirklich aus dem Stammdatensatz löschen will.

SPRACHE: ${locale}

${baseRules}`;
}

// ---------------------------------------------------------------------------
// Product Context Builder (simplified from legacy)
// ---------------------------------------------------------------------------

function buildProductContextV2(product, { attachments = [], titleInsights = null } = {}) {
  const attributes = toAttributesObject(product?.details?.attributes);
  const categoryIdRaw = resolveProductCategoryId(product, attributes);
  const requiredMeta = buildRequiredAspectMeta(categoryIdRaw, product?.details?.attributes || {});
  const aspectCatalog = categoryIdRaw ? getCategoryAspectCatalog(categoryIdRaw) : null;
  const vehicleFitmentMode = categoryIdRaw ? getVehicleFitmentMode(categoryIdRaw) : null;

  return {
    _hinweis: 'ACHTUNG: Die bestehenden Daten (Titel, Kategorie, Attribute) können FALSCH sein. Verifiziere sie immer gegen Web-Recherche und Produktbilder bevor du sie übernimmst oder darauf aufbaust.',
    identity: {
      id: product?.id || null,
      title_aktuell: product?.identification?.name || null,
      brand: product?.identification?.brand || null,
      category_aktuell: product?.identification?.category || null,
      _kategorie_hinweis: 'Diese Kategorie kann komplett falsch sein (z.B. "Anker" = Marke, NICHT Bootsport-Anker). Prüfe gegen EAN/Bilder.',
      categoryId: categoryIdRaw,
      sku: product?.identification?.sku || product?.details?.identifiers?.sku || null,
      barcodes: Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : [],
    },
    ebay: {
      categoryId_aktuell: categoryIdRaw,
      _hinweis: 'allowed_aspects und title_insights basieren auf der AKTUELLEN Kategorie. Wenn die Kategorie falsch ist, ignoriere diese Daten und korrigiere zuerst die Kategorie.',
      allowed_aspects: aspectCatalog && Array.isArray(aspectCatalog.allAspects) ? aspectCatalog.allAspects : [],
      required_aspects_meta: {
        missing_required_aspects: Array.isArray(requiredMeta?.missingAspects) ? requiredMeta.missingAspects : [],
        provided_required_aspects: Array.isArray(requiredMeta?.providedRequiredAspects) ? requiredMeta.providedRequiredAspects : [],
      },
      vehicle_fitment_mode: vehicleFitmentMode,
      title_insights: {
        _hinweis: 'Diese Tokens/Titel stammen aus der AKTUELLEN eBay-Kategorie. Wenn die Kategorie falsch ist, verwende diese Daten NICHT für den Titel.',
        top_tokens: Array.isArray(titleInsights?.topTokens) ? titleInsights.topTokens : [],
        sampled_titles: Array.isArray(titleInsights?.sampledTitles) ? titleInsights.sampledTitles : [],
      },
    },
    copy: {
      short_description: product?.details?.short_description || '',
      key_features: Array.isArray(product?.details?.key_features) ? product.details.key_features : [],
    },
    attributes,
    identifiers: {
      ean: product?.details?.identifiers?.ean || null,
      gtin: product?.details?.identifiers?.gtin || null,
      mpn: product?.details?.identifiers?.mpn || null,
    },
    pricing: product?.details?.pricing || null,
    images: (product?.details?.images || []).slice(0, 8).map((img, i) => ({
      index: i,
      variant: img?.variant || 'other',
      source: img?.source || 'unknown',
      has_url: Boolean(img?.url_or_base64),
    })),
    gpsr: product?.details?.gpsr || null,
    notes: product?.notes || { unsure: [], warnings: [] },
    weight_grams: product?.details?.weight_grams || product?.ops?.weight_grams || null,
    condition: product?.details?.condition || 'Neu',
    attachments: attachments.length ? attachments : undefined,
  };
}

function resolveProductCategoryId(product, attributes = null) {
  const attrs = attributes && typeof attributes === 'object' ? attributes : toAttributesObject(product?.details?.attributes);
  return (
    [
      product?.details?.categoryId,
      product?.details?.ebayCategoryId,
      product?.classification?.ebayCategoryId,
      product?.marketplace?.ebay?.categoryId,
      attrs?.ebay_category_id,
      attrs?.ebayCategoryId,
    ]
      .map((value) => safeString(value))
      .find((value) => /^\d+$/.test(value)) || null
  );
}

// ---------------------------------------------------------------------------
// Title Insights (reused from legacy)
// ---------------------------------------------------------------------------

function extractTitleInsightTokens(insights, { maxTokens = 8 } = {}) {
  const raw = Array.isArray(insights?.topTokens) ? insights.topTokens : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const candidate = typeof item === 'string' ? item : item?.token || item?.value || '';
    const normalized = safeString(candidate);
    if (!normalized || normalized.length < 2 || normalized.length > 24) continue;
    if (/^(ean|gtin|upc|isbn)$/i.test(normalized)) continue;
    if (/^\d{8,14}$/.test(normalized)) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= maxTokens) break;
  }
  return out;
}

async function loadTitleInsights(product, { limit = 80, maxTokens = 8 } = {}) {
  const categoryId = resolveProductCategoryId(product);
  const output = { categoryId, topTokens: [], sampledTitles: [], error: null };
  if (!categoryId) return output;
  try {
    const insights = await fetchCategoryTitleInsights({ categoryId, limit });
    output.topTokens = extractTitleInsightTokens(insights, { maxTokens });
    output.sampledTitles = Array.isArray(insights?.sampleTitles)
      ? insights.sampleTitles.map(safeString).filter(Boolean).slice(0, 5)
      : [];
  } catch (e) {
    output.error = safeString(e?.message) || 'unavailable';
  }
  return output;
}

// ---------------------------------------------------------------------------
// Attachment handling
// ---------------------------------------------------------------------------

function normalizeChatAttachments(attachments = []) {
  if (!Array.isArray(attachments) || !attachments.length) {
    return { summary: [], imageParts: [] };
  }
  const TEXT_LIKE_MIME = new Set(['text/plain', 'text/csv', 'application/json', 'text/json']);
  const summary = [];
  const imageParts = [];
  attachments.forEach((attachment, idx) => {
    if (!attachment?.buffer) return;
    const mimetype = attachment.mimetype || 'application/octet-stream';
    const entry = {
      name: attachment.originalname || `attachment_${idx + 1}`,
      mimetype,
      size: attachment.size || attachment.buffer.length || 0,
    };
    if (mimetype.startsWith('image/')) {
      imageParts.push({
        inlineData: {
          data: attachment.buffer.toString('base64'),
          mimeType: mimetype,
        },
      });
      entry.inline_reference = `image_${imageParts.length}`;
    } else if (TEXT_LIKE_MIME.has(mimetype)) {
      entry.text_preview = attachment.buffer.toString('utf8').slice(0, 6000);
    }
    summary.push(entry);
  });
  return { summary, imageParts };
}

// ---------------------------------------------------------------------------
// Fetch product images as inline parts for Gemini vision
// ---------------------------------------------------------------------------

async function fetchProductImageParts(product) {
  const images = Array.isArray(product?.details?.images) ? product.details.images : [];
  const candidates = images
    .filter((img) => typeof img?.url_or_base64 === 'string' && img.url_or_base64.startsWith('http'))
    .slice(0, MAX_PRODUCT_IMAGE_PARTS);
  if (!candidates.length) return [];

  const results = await Promise.all(
    candidates.map(async (img) => {
      const url = img.url_or_base64;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PRODUCT_IMAGE_TIMEOUT_MS);
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { Accept: 'image/*,*/*;q=0.8' },
        });
        clearTimeout(timer);
        if (!res.ok) return null;
        const contentType = res.headers.get('content-type') || 'image/jpeg';
        if (!contentType.startsWith('image/')) return null;
        const arrayBuf = await res.arrayBuffer();
        const buf = Buffer.from(arrayBuf);
        if (buf.length < 500 || buf.length > 10_000_000) return null;
        return {
          inlineData: {
            data: buf.toString('base64'),
            mimeType: contentType.split(';')[0].trim(),
          },
        };
      } catch (err) {
        console.warn(`[chat-v2] Failed to fetch product image ${url}: ${err.message}`);
        return null;
      }
    })
  );
  return results.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Sanitization (reused from legacy — simplified)
// ---------------------------------------------------------------------------

function sanitizeDatasheetChangeV2(entry, product, { scope = null, titleHintTokens = [] } = {}) {
  if (!entry || typeof entry !== 'object') return { change: {}, policyIssues: [] };

  const change = {};
  const issues = [];

  // Summary
  if (typeof entry.summary === 'string' && entry.summary.trim()) {
    change.summary = entry.summary.trim().slice(0, 500);
  }

  // Title — coerce against a preview product that includes proposed attribute/identity
  // changes from this same LLM turn, so color/category corrections are reflected.
  let titleCandidate = safeString(entry.title || entry?.identity?.name || entry?.identity?.title);
  if (titleCandidate) {
    const preview = JSON.parse(JSON.stringify(product));
    // Detect category change — if Gemini proposes a different category, the old
    // titleHintTokens are from the WRONG category and must be discarded.
    const proposedCategory = safeString(entry?.identity?.category);
    const currentCategory = safeString(product?.identification?.category);
    const categoryChanged = proposedCategory && proposedCategory !== currentCategory;

    // Apply proposed identity changes (category, brand)
    if (entry.identity) {
      preview.identification = preview.identification || {};
      if (entry.identity.category) preview.identification.category = safeString(entry.identity.category);
      if (entry.identity.brand) preview.identification.brand = safeString(entry.identity.brand);
    }
    // Set preview name to the PROPOSED title so coerceTitleToPolicy uses it as
    // the primary hint instead of the old (possibly wrong) name.
    preview.identification = preview.identification || {};
    preview.identification.name = titleCandidate;

    // Apply proposed attribute changes (Farbe, Größe, Material, etc.)
    // When category changed, START with empty attributes — old attributes belong
    // to the wrong category and pollute the title with irrelevant tokens.
    if (categoryChanged) {
      preview.details = preview.details || {};
      preview.details.attributes = {};
      preview.details.short_description = '';
    }
    if (Array.isArray(entry.attributes) && entry.attributes.length) {
      preview.details = preview.details || {};
      preview.details.attributes = preview.details.attributes || {};
      entry.attributes.forEach((attr) => {
        if (!attr?.key) return;
        const key = safeString(attr.key);
        const value = safeString(typeof attr.value === 'string' ? attr.value : String(attr.value ?? ''));
        if (key && value) preview.details.attributes[key] = value;
      });
    }

    // When the category changed, do NOT inject old category title hints — they pollute
    // the title with words from the wrong category (e.g. "Boot", "Kette" for a Powerbank).
    const effectiveHintTokens = categoryChanged ? [] : titleHintTokens;

    const coerced = coerceTitleToPolicy(preview, titleCandidate, {
      minLen: 0,
      maxLen: 80,
      softMaxLen: 80,
      extraHintTokens: effectiveHintTokens,
      forcePolicy: false,
    });
    change.title = coerced || titleCandidate.slice(0, 80);
  }

  // Identity
  if (entry.identity && typeof entry.identity === 'object') {
    const id = {};
    if (change.title) id.name = change.title;
    if (entry.identity.brand) id.brand = safeString(entry.identity.brand);
    if (entry.identity.category) {
      // Normalize to the canonical eBay breadcrumb when the local taxonomy
      // recognises it; otherwise KEEP the raw proposal so the post-consolidation
      // resolver (resolveProposedCategoryForChanges) can map an approximate/LLM
      // breadcrumb (e.g. "… > Figuren > Action-Figuren" vs the real
      // "… > Figuren & Statuen") to a real categoryId. categoryId is intentionally
      // NOT set here: consolidateChanges() strips top-level fields, so the
      // authoritative attach happens after consolidation.
      const rawCategory = safeString(entry.identity.category);
      const { findEbayCategory } = require('../lib/ebay-taxonomy');
      const resolved = findEbayCategory(rawCategory);
      id.category = (resolved && resolved.breadcrumb) || rawCategory;
    }
    if (entry.identity.sku) id.sku = safeString(entry.identity.sku);

    // Barcodes
    const barcodeCandidates = []
      .concat(Array.isArray(entry.identity.barcodes) ? entry.identity.barcodes : [])
      .concat([entry.identity.ean, entry.identity.gtin, entry.identity.upc])
      .map(safeString)
      .filter(Boolean)
      .map(normalizeDigits)
      .filter(isValidGtin);
    if (barcodeCandidates.length) id.barcodes = [...new Set(barcodeCandidates)];

    // Explicit clear directive: AI can request deletion of identifier fields when
    // the user explicitly asks to remove them (e.g. resolving an eBay catalog
    // vs K-Typ fitment conflict). The frontend honours `_clear` as a list of
    // dotted paths to wipe.
    const clearList = Array.isArray(entry.identity.clear) ? entry.identity.clear : [];
    if (clearList.length) {
      const allowed = new Set(['barcodes', 'ean', 'gtin', 'upc']);
      const requestedClear = Array.from(
        new Set(clearList.map((v) => safeString(v).toLowerCase()).filter((v) => allowed.has(v))),
      );
      if (requestedClear.length) {
        id._clear = requestedClear;
        // If the user wants barcodes cleared, do not reintroduce them via candidates.
        if (requestedClear.includes('barcodes')) {
          delete id.barcodes;
        }
      }
    }

    if (Object.keys(id).length) change.identity = id;
  }

  // Description — Fließtext, nie Bullets (Invariante: Bullets nur in key_features).
  if (typeof entry.short_description === 'string' && entry.short_description.trim()) {
    change.short_description = sanitizeDescriptionProse(entry.short_description);
  }

  // Key features
  if (Array.isArray(entry.key_features) && entry.key_features.length) {
    change.key_features = entry.key_features
      .map(safeString)
      .filter(Boolean)
      .slice(0, 10);
  }

  // Attributes
  if (Array.isArray(entry.attributes) && entry.attributes.length) {
    const cleaned = {};
    entry.attributes.forEach((attr) => {
      if (!attr?.key) return;
      const key = safeString(attr.key);
      if (!key || isBlockedAttributeKey(key)) return;
      const value = safeString(typeof attr.value === 'string' ? attr.value : String(attr.value ?? ''));
      if (!value) return;
      cleaned[canonicalizeAttributeKey(key)] = value.slice(0, 65);
    });
    if (Object.keys(cleaned).length) change.attributes = cleaned;
  }

  // GPSR
  if (entry.gpsr && typeof entry.gpsr === 'object') {
    const gpsr = {};
    const gpsrFields = ['entity_country', 'country_code', 'manufacturer_name', 'manufacturer_address',
      'manufacturer_city', 'manufacturer_postalcode', 'manufacturer_state_province', 'email',
      'manufacturer_phone', 'url'];
    gpsrFields.forEach((f) => {
      if (typeof entry.gpsr[f] === 'string' && entry.gpsr[f].trim()) {
        gpsr[f] = entry.gpsr[f].trim();
      }
    });
    if (Object.keys(gpsr).length) change.gpsr = gpsr;
  }

  // Pricing
  if (entry.pricing && typeof entry.pricing === 'object') {
    change.pricing = entry.pricing;
  }

  // Notes
  if (entry.notes && typeof entry.notes === 'object') {
    const notes = {};
    if (Array.isArray(entry.notes.unsure)) notes.unsure = entry.notes.unsure.map(safeString).filter(Boolean);
    if (Array.isArray(entry.notes.warnings)) notes.warnings = entry.notes.warnings.map(safeString).filter(Boolean);
    if ((notes.unsure?.length || 0) + (notes.warnings?.length || 0) > 0) change.notes = notes;
  }

  return { change, policyIssues: issues };
}

function consolidateChanges(changes = []) {
  if (!changes.length) return null;
  const merged = {};
  let summary = '';
  changes.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    if (entry.summary) summary = entry.summary;
    if (entry.title) merged.title = entry.title;
    if (entry.short_description) merged.short_description = entry.short_description;
    if (Array.isArray(entry.key_features)) merged.key_features = entry.key_features;
    if (entry.attributes && typeof entry.attributes === 'object' && !Array.isArray(entry.attributes)) {
      merged.attributes = { ...(merged.attributes || {}), ...entry.attributes };
    }
    if (entry.pricing) merged.pricing = entry.pricing;
    if (entry.gpsr) merged.gpsr = { ...(merged.gpsr || {}), ...entry.gpsr };
    if (entry.identity) {
      const prev = merged.identity || {};
      merged.identity = { ...prev, ...entry.identity };
      // Merge barcodes
      if (Array.isArray(entry.identity.barcodes)) {
        merged.identity.barcodes = [...new Set([...(prev.barcodes || []), ...entry.identity.barcodes])];
      }
      // Union explicit clear directives across multiple proposed edits.
      if (Array.isArray(entry.identity._clear) || Array.isArray(prev._clear)) {
        merged.identity._clear = Array.from(
          new Set([
            ...(Array.isArray(prev._clear) ? prev._clear : []),
            ...(Array.isArray(entry.identity._clear) ? entry.identity._clear : []),
          ]),
        );
        // If barcodes are slated for clearing, drop the merged barcode list.
        if (merged.identity._clear.includes('barcodes')) {
          delete merged.identity.barcodes;
        }
      }
    }
    if (entry.notes) {
      const prev = merged.notes || {};
      merged.notes = {
        unsure: [...new Set([...(prev.unsure || []), ...(entry.notes.unsure || [])])],
        warnings: [...new Set([...(prev.warnings || []), ...(entry.notes.warnings || [])])],
      };
    }
  });

  // Sync title ↔ identity.name
  if (merged.title && !merged.identity?.name) {
    merged.identity = { ...(merged.identity || {}), name: merged.title };
  }
  if (!merged.title && merged.identity?.name) {
    merged.title = merged.identity.name;
  }

  const meaningfulKeys = Object.keys(merged).filter((k) => k !== 'summary');
  if (!meaningfulKeys.length) return null;
  merged.summary = summary || 'Änderung aus Chat';
  return merged;
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

function sanitizeImageSuggestions(entry) {
  if (!Array.isArray(entry?.images)) return [];
  return entry.images
    .filter((img) => typeof img.url === 'string' && img.url.startsWith('http'))
    .map((img) => ({
      url_or_base64: img.url,
      source: img.source || 'web',
      variant: img.variant || 'other',
      notes: img.notes || 'Vorschlag aus Chat',
    }));
}

function selectReferenceImage(product, args = {}) {
  const images = Array.isArray(product?.details?.images) ? product.details.images : [];
  if (!images.length) return null;
  if (args.reference_image_url) {
    const targetKey = normalizeImageKey(args.reference_image_url);
    if (targetKey) {
      const match = images.find((img) => normalizeImageKey(img?.url_or_base64) === targetKey);
      if (match) return match;
    }
  }
  if (args.reference_variant) {
    const match = images.find((img) => (img?.variant || 'other') === args.reference_variant);
    if (match) return match;
  }
  return images[0];
}

// ---------------------------------------------------------------------------
// eBay readiness evaluation
// ---------------------------------------------------------------------------

function evaluateReadiness(product, datasheetChanges) {
  try {
    const { evaluateEbayReady } = require('../lib/datasheet-quality');
    const before = evaluateEbayReady(product, { force: true });
    const preview = JSON.parse(JSON.stringify(product));
    datasheetChanges.forEach((c) => applyChangeToPreview(preview, c));
    const after = evaluateEbayReady(preview, { force: true });
    return {
      before: { ok: Boolean(before?.ok), issues: (before?.issues || []).slice(0, 40), snapshot: before?.snapshot || null },
      after: { ok: Boolean(after?.ok), issues: (after?.issues || []).slice(0, 40), snapshot: after?.snapshot || null },
    };
  } catch {
    return null;
  }
}

function applyChangeToPreview(product, change) {
  if (!product || !change) return;
  product.identification = product.identification || {};
  product.details = product.details || {};
  if (change.title) product.identification.name = change.title;
  if (change.identity?.brand) product.identification.brand = change.identity.brand;
  if (change.identity?.category) product.identification.category = change.identity.category;
  if (change.short_description) product.details.short_description = change.short_description;
  if (Array.isArray(change.key_features)) product.details.key_features = change.key_features;
  if (change.attributes && typeof change.attributes === 'object' && !Array.isArray(change.attributes)) {
    product.details.attributes = { ...(product.details.attributes || {}), ...change.attributes };
  }
  if (change.pricing) product.details.pricing = { ...(product.details.pricing || {}), ...change.pricing };
  if (change.gpsr) product.details.gpsr = { ...(product.details.gpsr || {}), ...change.gpsr };
}

// ---------------------------------------------------------------------------
// Main Chat Function
// ---------------------------------------------------------------------------

/**
 * @param {object} product — Full product document from Firestore
 * @param {string} userMessage — The user's chat message
 * @param {{
 *   modelOverride?: string,
 *   attachments?: Array,
 *   scope?: string,
 *   history?: Array,
 *   onProgress?: Function,
 * }} opts
 */
async function runProductChatV2(product, userMessage, {
  modelOverride = null,
  attachments = [],
  scope = null,
  history = [],
  onProgress = null,
  tenantId = null,
} = {}) {
  const ai = await getGenAIClient();
  const enhanced = isChatV2Enhanced();
  // Default target: Gemini 3.1 Pro customtools variant. resolveModel() will
  // also normalize legacy aliases (gemini-3-pro-preview → customtools).
  const modelName = resolveModel(modelOverride, 'CHAT_MODEL', 'gemini-2.5-pro');
  const locale = 'de-DE';

  // Enrich: eBay taxonomy + K-Typ (non-blocking)
  try {
    const { applyEbayTaxonomy } = require('./enrichment');
    applyEbayTaxonomy(product);
    const { enrichKTypIfPossible } = require('../lib/ktype-enrichment');
    await enrichKTypIfPossible(product, { reason: 'chat-v2' });
  } catch (e) {
    // Never block chat
  }

  // Title insights + product image download (parallel)
  const [titleInsights, productImageParts] = await Promise.all([
    loadTitleInsights(product, {
      limit: Number(process.env.CHAT_TITLE_INSIGHTS_LIMIT) || 80,
      maxTokens: Number(process.env.CHAT_TITLE_INSIGHTS_MAX_TOKENS) || 8,
    }),
    fetchProductImageParts(product),
  ]);
  const titleHintTokens = titleInsights?.topTokens || [];

  // Attachments
  const attachmentPayload = normalizeChatAttachments(attachments);

  // Build product context
  const productContext = buildProductContextV2(product, {
    attachments: attachmentPayload.summary,
    titleInsights,
  });

  // Build system prompt
  const baseSystemPrompt = buildSystemPromptV2(locale);
  const llmConfig = await getActiveLlmConfig('chat.product');
  const promptOverride = typeof llmConfig?.promptText === 'string' ? llmConfig.promptText : '';
  const systemPromptText = promptOverride && llmConfig?.promptMode === 'replace'
    ? promptOverride
    : [baseSystemPrompt, promptOverride].filter(Boolean).join('\n\n');

  // Build Gemini tools: Google Search Grounding (+ URL Context when enhanced) + Function Declarations.
  // Since Gemini 3 Pro (Mar 2026) the three tool families can coexist in one request ("Context Circulation").
  // urlContext: Gemini autonomously fetches URLs it recognizes in the conversation (up to 20 URLs/request).
  //
  // ZWEI-REQUEST-MODUS (Incident 2026-08-04): Nicht-customtools-Modelle (2.5)
  // lehnen die Kombination aus googleSearch und functionDeclarations mit 400
  // "Tool call context circulation is not enabled" ab. Statt V2 komplett zu
  // überspringen (= Chat verliert jede Google-Recherche und fällt auf die
  // evidence-blinde Legacy-Pipeline), wird gesplittet:
  //   Phase A (Recherche): googleSearch(+urlContext), KEINE Custom-Functions.
  //   Phase B (Änderungen): Custom-Functions, KEIN googleSearch — bekommt die
  //   Recherche-Ergebnisse aus Phase A als Kontext mitgereicht.
  const supportsCirculation = modelName.includes('customtools');
  const splitMode = !supportsCirculation && chatV2SplitGroundingEnabled();
  const functionDeclarationsTool = {
    functionDeclarations: [
      UPDATE_DATASHEET_DECLARATION,
      SUGGEST_IMAGES_DECLARATION,
      GENERATE_AI_IMAGES_DECLARATION,
    ],
  };
  const tools = splitMode
    ? [functionDeclarationsTool]
    : [
      { googleSearch: {} },
      ...(enhanced ? [{ urlContext: {} }] : []),
      functionDeclarationsTool,
    ];

  // Combine product images + user-uploaded attachments
  const allImageParts = [...productImageParts, ...attachmentPayload.imageParts];

  // Build conversation history for the chat
  // Product context + product images as first turn, then previous conversation
  const chatHistory = [
    {
      role: 'user',
      parts: [
        { text: `Produktkontext:\n${JSON.stringify(productContext, null, 2)}` },
        ...(allImageParts.length ? [{ text: `\n\nProduktbilder (${allImageParts.length} Stück) — nutze diese für Farbe, Material, Design und andere visuelle Merkmale:` }, ...allImageParts] : []),
      ],
    },
    {
      role: 'model',
      parts: [{ text: allImageParts.length
        ? `Verstanden. Ich habe den Produktkontext und ${allImageParts.length} Produktbild(er) analysiert.`
        : 'Verstanden. Ich habe den kompletten Produktkontext und kann loslegen.' }],
    },
    // Previous conversation turns
    ...(Array.isArray(history) ? history : []),
  ];

  // Create chat session
  // toolConfig.includeServerSideToolInvocations is REQUIRED when combining
  // built-in tools (googleSearch) with custom functionDeclarations.
  //
  // Gemini 3 Pro tuning (March 2026 guidance):
  //   - temperature: 1.0   (lower values trigger looping/degenerate reasoning)
  //   - maxOutputTokens: 8192 (thinking + tool calls + answer must all fit)
  //   - thinkingConfig.thinkingLevel: 'high'  (deliberate multi-step reasoning)
  //   - thinkingConfig.includeThoughts: true  (surface thought summaries to the client)
  //
  // NOTE: mediaResolution intentionally omitted — v1beta API rejects it with
  // 'Invalid value at generation_config.media_resolution' even for documented
  // enum values like 'HIGH'. Revisit when Gemini 3 Pro GA (non-preview) lands.
  // Per-Part mediaResolution on Content.Part still works if needed later.
  //
  // Phase F.1b.3 — load scope-config best-effort. callerOverrides preserve the
  // legacy enhanced/non-enhanced values so a missing scope keeps byte-identical
  // generationConfig. tenantId is not available in the chat-v2 signature today;
  // F.2 may thread it through if per-tenant tuning is required.
  const _legacyTemperatureV2 = enhanced ? 1.0 : 0.3;
  const _legacyMaxOutputTokensV2 = enhanced ? 8192 : 4096;
  const _legacyThinkingV2 = enhanced
    ? { thinkingBudget: 4096, includeThoughts: true }
    : undefined;
  const scopeConfigV2 = await _tryResolveScopeConfigChatV2('chat.product', tenantId, {
    temperature: _legacyTemperatureV2,
    maxOutputTokens: _legacyMaxOutputTokensV2,
    ...(_legacyThinkingV2 ? { thinkingConfig: _legacyThinkingV2 } : {}),
  });
  const _scopeGenCfgV2 =
    scopeConfigV2 && scopeConfigV2.generationConfig && typeof scopeConfigV2.generationConfig === 'object'
      ? scopeConfigV2.generationConfig
      : {};

  // Split-Modus: Phase B hat KEINEN Web-Zugriff — der System-Prompt verspricht
  // aber Google Search. Ohne diesen Zusatz erfindet das Modell "recherchierte"
  // Fakten statt die mitgelieferten Phase-A-Ergebnisse zu nutzen.
  const splitAddendum = splitMode
    ? [
      'WICHTIG (Zwei-Phasen-Modus): In dieser Phase hast du KEINEN Web-Zugriff.',
      'Die Web-Recherche ist bereits gelaufen — ihre Ergebnisse stehen in der Nutzer-Nachricht unter "RECHERCHE-ERGEBNISSE".',
      'Nutze AUSSCHLIESSLICH diese Ergebnisse und den Produktkontext. Erfinde nichts darüber hinaus.',
      'Übernimm Quell-URLs aus den Recherche-Ergebnissen in deine update_product_datasheet-Vorschläge (pricing.sources, gpsr.url).',
    ].join('\n')
    : '';

  const chatConfig = {
    tools,
    toolConfig: {
      includeServerSideToolInvocations: true,
    },
    systemInstruction: splitAddendum ? `${systemPromptText}\n\n${splitAddendum}` : systemPromptText,
    temperature: _legacyTemperatureV2,
    maxOutputTokens: _legacyMaxOutputTokensV2,
  };
  if (enhanced) {
    chatConfig.thinkingConfig = _legacyThinkingV2;
  }
  // Apply scopeConfig.generationConfig last (scope overrides legacy knobs).
  Object.assign(chatConfig, _scopeGenCfgV2);

  const chat = ai.chats.create({
    model: modelName,
    config: chatConfig,
    history: chatHistory,
  });

  // Build user message with scope if applicable
  let messageText = userMessage;
  if (scope && String(scope).trim()) {
    messageText += `\n\nSCOPE=${String(scope).trim()} — Ändere NUR Felder innerhalb dieses Scopes.`;
  }

  // State tracking
  const datasheetChanges = [];
  const imageSuggestions = [];
  const groundingTrace = [];
  const thoughts = [];
  const existingImageKeys = new Set(
    (product?.details?.images || [])
      .map((img) => normalizeImageKey(img?.url_or_base64 || img?.url))
      .filter(Boolean)
  );

  try {
    onProgress?.({ type: 'start', text: 'Starte Analyse…' });

    // Diagnostic: log chat setup before first API call
    console.log(`[chat-v2] model=${modelName}, split=${splitMode}, historyLen=${chatHistory.length}, toolsCount=${tools.length}, productImages=${productImageParts.length}, userAttachments=${attachmentPayload.imageParts.length}, scopeLen=${(messageText || '').length}`);

    // ── Phase A (nur Split-Modus): Google-Recherche ohne Custom-Functions ──
    let researchText = '';
    if (splitMode) {
      onProgress?.({ type: 'tool_start', tool: 'google_research' });
      const researchSystemPrompt = [
        'Du bist ein Produkt-Rechercheur für einen Marktplatz-Katalog (eBay.de/Kaufland.de).',
        'Beantworte die Nutzer-Anfrage durch ECHTE Web-Recherche (Google Search). Erfinde nichts.',
        'Nenne zu JEDER zentralen Angabe die konkrete Quell-URL (Produktseite/Hersteller-Seite, keine Suchseiten).',
        'Für Herstellerangaben (GPSR): vollständiger Firmenname, Anschrift, E-Mail UND die Impressum-/Kontakt-URL des Herstellers.',
        'Für Preise: aktuelle Marktpreise in EUR mit den Produktseiten-URLs.',
        'Schlage KEINE Datenblatt-Änderungen vor — liste nur belegte Fakten und ihre Quellen sauber auf.',
      ].join('\n');
      const runResearch = async (withUrlContext) => {
        // Latenz-Budget (Prod 2026-08-04 01:29Z): Grounding + Produktbilder
        // brauchen 30-60s — das 30s-Default-Timeout würgte JEDEN Versuch ab
        // (3 Retries, 2min verbrannt, dann doch Legacy). Deshalb: 90s wie
        // IDENTIFY_GROUNDING_TIMEOUT_MS, max 2 Versuche, KEIN thinkingConfig
        // (Grounding liefert die Fakten, Thinking kostet hier nur Zeit) und
        // maxOutputTokens 4096 (Recherche-Notizen, keine Langform).
        const researchChat = ai.chats.create({
          model: modelName,
          config: {
            tools: [{ googleSearch: {} }, ...(withUrlContext ? [{ urlContext: {} }] : [])],
            systemInstruction: researchSystemPrompt,
            temperature: chatConfig.temperature,
            maxOutputTokens: Math.min(4096, Number(chatConfig.maxOutputTokens) || 4096),
          },
          history: chatHistory,
        });
        return withGeminiRetry(
          () => researchChat.sendMessage({ message: messageText }),
          { label: 'sendMessage-research', perAttemptTimeoutMs: RESEARCH_PER_ATTEMPT_TIMEOUT_MS, maxAttempts: 2 }
        );
      };
      let researchResponse;
      try {
        researchResponse = await runResearch(enhanced);
      } catch (researchError) {
        const msg = String(researchError?.message || '');
        const status = researchError?.status ?? researchError?.code ?? null;
        // urlContext-Kombination kann auf manchen Modellen abgelehnt werden —
        // dann googleSearch-only. Alles andere wirft (Route fällt auf Legacy).
        if (enhanced && (status === 400 || /INVALID_ARGUMENT|not supported|not enabled/i.test(msg))) {
          console.warn(`[chat-v2] research with urlContext rejected (${msg.slice(0, 120)}) — retrying googleSearch-only`);
          researchResponse = await runResearch(false);
        } else {
          const wrapped = new Error(`chat-v2 research request failed: ${msg}`);
          wrapped.cause = researchError;
          wrapped.status = status;
          throw wrapped;
        }
      }
      extractThoughtParts(researchResponse, thoughts, onProgress);
      extractGroundingMetadata(researchResponse, groundingTrace);
      researchText = extractAnswerText(researchResponse) || researchResponse.text || '';
      const groundingSources = groundingTrace
        .filter((t) => t && t.type === 'google_search_grounding')
        .flatMap((t) => (Array.isArray(t.sources) ? t.sources : []))
        .map((s) => s && s.url)
        .filter(Boolean)
        .slice(0, 10);
      if (researchText) {
        messageText += [
          '\n\nRECHERCHE-ERGEBNISSE (aus Google-Suche, mit Quellen — nutze AUSSCHLIESSLICH diese Fakten):',
          researchText,
          ...(groundingSources.length ? [`Grounding-Quellen: ${groundingSources.join(' ')}`] : []),
        ].join('\n');
      }
      onProgress?.({ type: 'tool_done', tool: 'google_research' });
      console.log(`[chat-v2] research done: textLen=${researchText.length}, sources=${groundingSources.length}`);
    }

    // Send initial message (with exponential backoff on transient 5xx/timeouts)
    let response;
    try {
      response = await withGeminiRetry(
        () => chat.sendMessage({ message: messageText }),
        { label: 'sendMessage-initial' }
      );
    } catch (sendError) {
      console.error(`[chat-v2] sendMessage FAILED:`, sendError?.message || sendError);
      console.error(`[chat-v2] sendMessage status:`, sendError?.status, 'code:', sendError?.code);
      if (sendError?.response) {
        try { console.error(`[chat-v2] API response body:`, JSON.stringify(sendError.response).slice(0, 1000)); } catch {}
      }
      // Re-throw with a clear message so route.js can fall back to legacy chat.
      const wrapped = new Error(`chat-v2 Gemini request failed: ${sendError?.message || String(sendError)}`);
      wrapped.cause = sendError;
      wrapped.status = sendError?.status ?? sendError?.code ?? null;
      throw wrapped;
    }
    let responseText = response.text || '';
    let functionCalls = response.functionCalls;

    console.log(`[chat-v2] initial response: textLen=${responseText.length}, functionCalls=${functionCalls?.length || 0}, candidates=${response?.candidates?.length || 0}`);

    // Extract thought-parts (if Gemini 3 thinking is enabled) and grounding metadata
    extractThoughtParts(response, thoughts, onProgress);
    extractGroundingMetadata(response, groundingTrace);

    // Function calling loop
    let iterations = 0;
    while (functionCalls && functionCalls.length > 0 && iterations < MAX_CHAT_ITERATIONS) {
      iterations++;

      const functionResponseParts = [];

      for (const call of functionCalls) {
        const { name, args } = call;
        let toolResult = {};

        if (name === 'update_product_datasheet') {
          onProgress?.({ type: 'tool_start', tool: 'update_product_datasheet' });
          const sanitized = sanitizeDatasheetChangeV2(args || {}, product, { scope, titleHintTokens });
          const nextChange = sanitized.change;
          if (Object.keys(nextChange).length) {
            datasheetChanges.push(nextChange);
            onProgress?.({ type: 'tool_done', tool: 'update_product_datasheet', fields: Object.keys(nextChange).length });
          }
          toolResult = {
            acknowledged: true,
            applied_fields: Object.keys(nextChange),
            policy_issues: sanitized.policyIssues.slice(0, 10),
          };
        } else if (name === 'suggest_product_images') {
          const searchQuery = (args?.query || '').trim();
          onProgress?.({ type: 'tool_start', tool: 'suggest_product_images', query: searchQuery });
          let chatImages = [];
          if (searchQuery) {
            try {
              console.log(`[chat-v2] SerpAPI image search: "${searchQuery}"`);
              const serpResults = await searchProductImages(product, {
                query: searchQuery,
                limit: 6,
                minWidth: 400,
                minHeight: 400,
              });
              console.log(`[chat-v2] SerpAPI returned ${serpResults.length} images`);
              chatImages = serpResults
                .map((img) => ({
                  url_or_base64: img.url,
                  source: img.source || 'web_search',
                  variant: 'gallery',
                  notes: img.title || 'Web-Produktbild',
                }))
                .filter((img) => {
                  const key = normalizeImageKey(img.url_or_base64);
                  if (!key || existingImageKeys.has(key)) return false;
                  existingImageKeys.add(key);
                  return true;
                });
            } catch (searchErr) {
              console.error(`[chat-v2] SerpAPI image search failed:`, searchErr.message);
              toolResult = { success: false, error: 'Image search failed: ' + searchErr.message, count: 0 };
            }
          }
          if (!toolResult?.error) {
            imageSuggestions.push({ rationale: args?.rationale || searchQuery, images: chatImages });
            toolResult = { acknowledged: true, count: chatImages.length, query: searchQuery };
          }
          onProgress?.({ type: 'tool_done', tool: 'suggest_product_images', count: chatImages.length });
        } else if (name === 'generate_ai_images') {
          onProgress?.({ type: 'tool_start', tool: 'generate_ai_images' });
          const referenceImage = selectReferenceImage(product, args || {});
          if (!referenceImage) {
            toolResult = { success: false, error: 'No reference image found' };
          } else {
            try {
              const generation = await generateImagesForProduct(product, { referenceImage });
              const aiImages = (generation.images || []).filter((img) => {
                const key = normalizeImageKey(img.url_or_base64);
                if (!key || existingImageKeys.has(key)) return false;
                existingImageKeys.add(key);
                return true;
              });
              imageSuggestions.push({ rationale: args?.rationale || 'AI Render', images: aiImages });
              toolResult = { success: true, count: aiImages.length };
            } catch (e) {
              toolResult = { success: false, error: e.message };
            }
          }
          onProgress?.({ type: 'tool_done', tool: 'generate_ai_images' });
        } else {
          // Unknown tool — acknowledge and continue
          toolResult = { error: `Unknown tool: ${name}` };
        }

        // Build function response part — must match @google/genai SDK format
        functionResponseParts.push({
          functionResponse: {
            name: name,
            response: toolResult,
          },
        });
      }

      // Send function responses back to model — SDK requires Content object with role.
      // Wrap in retry so transient 5xx mid-loop doesn't fail the entire request.
      try {
        response = await withGeminiRetry(
          () => chat.sendMessage({
            message: {
              role: 'user',
              parts: functionResponseParts,
            },
          }),
          { label: `sendMessage-iter-${iterations}` }
        );
      } catch (loopError) {
        console.error(`[chat-v2] sendMessage iter=${iterations} FAILED:`, loopError?.message || loopError);
        const wrapped = new Error(`chat-v2 Gemini request failed (iter ${iterations}): ${loopError?.message || String(loopError)}`);
        wrapped.cause = loopError;
        wrapped.status = loopError?.status ?? loopError?.code ?? null;
        throw wrapped;
      }
      responseText = response.text || '';
      functionCalls = response.functionCalls;

      // Extract thought-parts + grounding from follow-up response
      extractThoughtParts(response, thoughts, onProgress);
      extractGroundingMetadata(response, groundingTrace);
    }

    // Build final result
    const consolidatedChange = consolidateChanges(datasheetChanges);
    const finalDatasheetChanges = consolidatedChange ? [consolidatedChange] : [];

    // Resolve any assistant-proposed category to a REAL eBay categoryId before
    // the change reaches the client. Without this the "Kategorie-Korrektur" never
    // lands: findEbayCategory() can't match approximate LLM breadcrumbs and
    // consolidateChanges() drops top-level categoryId. See
    // services/category-resolver.js#resolveProposedCategoryForChanges.
    try {
      const { resolveProposedCategoryForChanges } = require('./category-resolver');
      await resolveProposedCategoryForChanges(finalDatasheetChanges, product, { reason: 'chat_v2' });
    } catch (catErr) {
      console.warn(`[chat-v2] category resolution skipped: ${catErr?.message || catErr}`);
    }

    console.log(`[chat-v2] done: iterations=${iterations}, datasheetChanges=${datasheetChanges.length}, consolidated=${finalDatasheetChanges.length}, images=${imageSuggestions.length}, textLen=${responseText.length}`);
    if (!finalDatasheetChanges.length && responseText.length > 200) {
      console.warn('[chat-v2] WARNING: Long response text but NO datasheet changes — Gemini may have skipped update_product_datasheet tool call');
    }

    // eBay readiness check
    const ebayReadiness = evaluateReadiness(product, finalDatasheetChanges);

    onProgress?.({ type: 'tool_done', tool: 'chat_complete' });

    // Sanitize responseText: some SDK versions include thought text in `.text`.
    // Strip any leading thought prefix if a plain answer part exists.
    // Split-Modus: Die RECHERCHE-Antwort (Phase A) ist die inhaltlich
    // wertvolle Nutzer-Antwort — Phase B liefert meist nur "Änderungen
    // vorgeschlagen". Ohne diese Bevorzugung sähe der User wieder nichts von
    // den recherchierten Fakten (Incident 2026-08-04: "Antwort generiert.").
    const phaseBMessage = extractAnswerText(response) || responseText || '';
    const cleanMessage = (splitMode && researchText)
      ? researchText
      : (phaseBMessage || 'Antwort generiert.');

    return {
      message: cleanMessage,
      datasheetChanges: finalDatasheetChanges,
      imageSuggestions,
      serpTrace: groundingTrace,
      ebayReadiness,
      modelUsed: modelName,
      intent: finalDatasheetChanges.length ? 'change' : 'info',
      trace: { thoughts },
      // Wahrhaftiger Zähler (wie V3): dem Modell wurden echte Produktbilder
      // gesendet — das GPSR-Gate nutzt das für den Etikett-Vertrauenspfad.
      productImagesSent: productImageParts.length,
      _pipeline: 'v2-grounding',
      _enhanced: enhanced,
      _split: splitMode,
    };

  } catch (error) {
    console.error('[chat-v2] Gemini Chat Error:', error?.message || error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Grounding metadata extraction
// ---------------------------------------------------------------------------

function extractGroundingMetadata(response, trace) {
  try {
    const candidates = response?.candidates || [];
    const meta = candidates[0]?.groundingMetadata;
    if (!meta) return;

    const queries = meta.webSearchQueries || [];
    const sources = (meta.groundingChunks || [])
      .map((c) => ({ title: c?.web?.title, url: c?.web?.uri }))
      .filter((s) => s.url)
      .slice(0, 10);

    if (queries.length || sources.length) {
      trace.push({
        type: 'google_search_grounding',
        queries,
        sources,
      });
    }

    // urlContext metadata: Gemini 3 reports which URLs it opened via the URL Context tool.
    const urlMeta = candidates[0]?.urlContextMetadata;
    if (urlMeta && Array.isArray(urlMeta.urlMetadata) && urlMeta.urlMetadata.length) {
      const urls = urlMeta.urlMetadata
        .map((u) => ({ url: u?.retrievedUrl || u?.url, status: u?.urlRetrievalStatus || u?.status || '' }))
        .filter((u) => u.url)
        .slice(0, 20);
      if (urls.length) {
        trace.push({ type: 'url_context', urls });
      }
    }
  } catch {
    // Non-critical
  }
}

/**
 * Extract thought-part text from a Gemini response and push it onto the `thoughts`
 * array. If a `onProgress` streaming callback is provided, also emit each thought
 * as a `{ type: 'thinking', text }` event so clients can show live reasoning.
 *
 * Thought parts are identified by `part.thought === true` (Gemini 3 SDK contract).
 */
function extractThoughtParts(response, thoughts, onProgress) {
  try {
    const candidates = response?.candidates || [];
    for (const cand of candidates) {
      const parts = cand?.content?.parts || [];
      for (const part of parts) {
        if (part && part.thought === true && typeof part.text === 'string' && part.text.trim()) {
          const text = part.text.trim();
          thoughts.push(text);
          if (typeof onProgress === 'function') {
            try {
              onProgress({ type: 'thinking', text });
            } catch {
              // Streaming callback must never break the loop.
            }
          }
        }
      }
    }
  } catch {
    // Non-critical
  }
}

/**
 * Return only the non-thought answer text from a Gemini response.
 * Falls back to `response.text` when no explicit thought flags are present.
 */
function extractAnswerText(response) {
  try {
    const candidates = response?.candidates || [];
    const parts = candidates[0]?.content?.parts || [];
    const answerParts = parts
      .filter((p) => p && p.thought !== true && typeof p.text === 'string')
      .map((p) => p.text);
    if (answerParts.length) {
      return answerParts.join('').trim();
    }
  } catch {
    // ignore
  }
  return typeof response?.text === 'string' ? response.text : '';
}

// Zwei-Request-Modus (Incident 2026-08-04): auf Nicht-customtools-Modellen
// splittet runProductChatV2 in Recherche-Request (googleSearch) + Function-
// Request. Kill-Switch CHAT_V2_SPLIT_GROUNDING=off → altes Verhalten (V2 nur
// auf customtools, Kaskade startet auf 2.5 direkt bei Legacy).
function chatV2SplitGroundingEnabled() {
  return String(process.env.CHAT_V2_SPLIT_GROUNDING || 'on').toLowerCase() !== 'off';
}

// V2 kombiniert googleSearch/urlContext + functionDeclarations in EINEM
// Request (Context Circulation) — das existiert nur auf -customtools-Modellen.
// Auf Gemini 2.5 lehnt die API mit 400 "Tool call context circulation is not
// enabled" ab (Prod 2026-08-02). Seit 2026-08-04 ist V2 dort trotzdem nutzbar:
// der Zwei-Request-Modus trennt Grounding und Function-Calls, die Google-
// Recherche bleibt dem Chat damit auch unter der 2.5-Kostenpolitik erhalten.
function chatV2ModelSupported() {
  const { resolveChatModel } = require('../lib/gemini-config');
  if (resolveChatModel().includes('customtools')) return true;
  return chatV2SplitGroundingEnabled();
}

module.exports = {
  runProductChatV2,
  chatV2ModelSupported,
  chatV2SplitGroundingEnabled,
};
