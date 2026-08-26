'use strict';

/**
 * product-chat-v3.js — One-shot-smart chat orchestrator using Gemini 3
 * "Context Circulation": googleSearch + urlContext + custom function
 * declarations + structured output in a single session.
 *
 * Architecture (high level):
 *
 *   user message
 *        │
 *        ▼
 *   runProductChatV3()
 *        ├── buildSystemPromptV3() → product snapshot + tool overview
 *        ├── ai.chats.create({ tools: [googleSearch, urlContext, fnDecls] })
 *        ├── agentic loop (≤ maxIterations)
 *        │     ├─ emit thinking thoughts (onProgress 'thinking')
 *        │     ├─ collect grounding chunks (onProgress 'grounding')
 *        │     ├─ dispatch function_calls → atomic-tools executors
 *        │     │    (lookup_gtin, search_ebay_catalog, verify_brand, …)
 *        │     ├─ own executor: update_product_datasheet, suggest_product_images
 *        │     └─ feed functionResponses back into chat
 *        └── post-processing
 *              ├─ crossReferenceProduct() → resolved draft + conflicts
 *              ├─ aggregateProductConfidence() → overall readiness
 *              └─ emit 'needs_human' when readyForPublish === false
 *
 *  V3 is additive and gated behind CHAT_V3 (default false). V2 + legacy chat
 *  remain the production defaults; integration into routes/identify.js is a
 *  separate task.
 */

const atomicTools = require('./atomic-tools');
// EINE Quelle für die Feldliste der Änderungskarte (Vorfall 2026-08-10).
const CONTRACT = require('../lib/chat-datasheet-contract');
// Modul-Referenz (nicht destrukturiert), damit Tests searchProductImages patchen können.
const imageSearch = require('../lib/image-search');
const { getCassiniCategoryBucket, getCategoryPattern } = require('../lib/cassini-category-map');
const { coerceTitleToPolicy } = require('../lib/title-policy');
const { scoreField, aggregateProductConfidence } = require('../lib/confidence-scoring');
const { crossReferenceProduct } = require('../lib/cross-reference');
const { normalizeLiteralEscapes, hasListMarkup, sanitizeDescriptionProse } = require('../lib/listing-sanitize');
const {
  resolveChatModel,
  defaultThinkingConfig,
  defaultSafetySettings,
  DEFAULT_CHAT_TEMPERATURE,
} = require('../lib/gemini-config');

// Phase F.1b.3 — best-effort scope-config loader (additive, never throws).
async function _tryResolveScopeConfig(scopeName, tenantId, callerOverrides) {
  try {
    const { resolveScopeConfig } = require('../lib/llm-config');
    return await resolveScopeConfig(scopeName, tenantId || null, callerOverrides || {});
  } catch (err) {
    let logger = null;
    try { logger = require('../lib/logger'); } catch (_) { /* logger optional in tests */ }
    if (logger && typeof logger.warn === 'function') {
      logger.warn(
        { scopeId: scopeName, tenantId: tenantId || null, reason: err?.message || String(err) },
        '[chat-v3] resolveScopeConfig failed, using hardcoded defaults'
      );
    }
    return null;
  }
}

// FunctionCallingConfigMode: 'AUTO' | 'ANY' | 'NONE' | 'VALIDATED'.
// We use ANY + allowedFunctionNames=['update_product_datasheet'] to force
// Gemini to finalize each turn with a write-call (prevents the research-
// attractor loop where the model keeps doing google_search / url_context /
// atomic-tool calls and never emits the structured datasheet update).
// Fallback literal `'ANY'` keeps us safe if the SDK ever trims the enum.
let FunctionCallingConfigMode;
try {
  // eslint-disable-next-line global-require
  ({ FunctionCallingConfigMode } = require('@google/genai'));
} catch (err) {
  FunctionCallingConfigMode = { AUTO: 'AUTO', ANY: 'ANY', NONE: 'NONE' };
}
if (!FunctionCallingConfigMode || !FunctionCallingConfigMode.ANY) {
  FunctionCallingConfigMode = { AUTO: 'AUTO', ANY: 'ANY', NONE: 'NONE' };
}

const WRITE_TOOL = 'update_product_datasheet';
const IMAGE_TOOL = 'suggest_product_images';
const SOFT_RESEARCH_LIMIT = 3;

// Ein "reiner Bild-Turn": das Modell hat NUR die Bildsuche benutzt — kein
// Datenblatt-Write und kein datenblatt-relevantes Recherche-Tool. Solche Turns
// dürfen NICHT in einen Datenblatt-Write gezwungen werden (softForce /
// atLastIter / Ultimate-Fallback), sonst fabriziert das Modell eine sinnlose
// "Übernehmen"-Karte für eine Anfrage, die das Datenblatt gar nicht ändern soll
// (Symptom: "Ich habe eine Bildsuche durchgeführt … 0 Bilder" als Änderungskarte).
// Die gefundenen Bilder fließen unabhängig davon über state.imageSuggestions.
function computeImageOnlyTurn(trace) {
  if (!trace || typeof trace !== 'object') return false;
  return Boolean(trace.sawImageSearch) && !trace.sawNonImageTool && !trace.sawWriteCall;
}

const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_MAX_OUTPUT_TOKENS = 12000;
const RETRY_DELAYS_MS = [1000, 3000, 8000];

// Eigene Produktbilder ans Modell schicken (Incident 2026-07-17): V3 war blind
// für die gespeicherten Fotos — Hersteller-/GPSR-/Maß-Angaben auf dem Etikett
// wurden nie gelesen, das Modell riet. Gleiche Konstanten/ENV wie V2.
const MAX_PRODUCT_IMAGE_PARTS = 4;
const PRODUCT_IMAGE_TIMEOUT_MS = parseInt(process.env.CHAT_IMAGE_TIMEOUT_MS || '8000', 10);

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

/**
 * Returns whether the CHAT_V3 path should be used.
 *
 * Default: ON. Routing in `routes/identify.js` already cascades V3 → V2 →
 * legacy on any error, so flipping the default cannot break a chat request
 * path. Set `CHAT_V3=false` to opt out (or `?pipeline=v2|legacy` per call).
 */
function chatV3Enabled() {
  const raw = process.env.CHAT_V3;
  if (raw != null) {
    const v = String(raw).trim().toLowerCase();
    if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  }
  // V3 (Context Circulation: googleSearch + urlContext + custom functions in
  // EINEM Request) braucht ein Modell, das Server-Tools mit Custom-Functions
  // kombinieren kann. Das entscheidet ZENTRAL supportsToolContextCirculation()
  // (model-select.js): auf gemini-3.7-flash (Politik seit 2026-08-26, live
  // gegen die echte API verifiziert) wahr, unter der Notbremse
  // MODEL_POLICY='gemini25' automatisch falsch → Kaskade startet bei V2-Split,
  // statt pro Nachricht einen garantiert scheiternden Call zu bezahlen.
  const { resolveChatModel } = require('../lib/gemini-config');
  const { supportsToolContextCirculation } = require('../lib/model-select');
  return supportsToolContextCirculation(resolveChatModel());
}

// ---------------------------------------------------------------------------
// Writable function declarations — mirror the shape of v2 so that the route
// layer can treat v2 + v3 outputs uniformly. These are defined locally (not
// re-exported from v2) so that v3 can evolve its schema independently.
// ---------------------------------------------------------------------------

const UPDATE_DATASHEET_DECLARATION = {
  name: 'update_product_datasheet',
  description:
    'Propose structured changes to the product datasheet. The UI shows each ' +
    'change as an "Übernehmen" button — never ask for confirmation. Include a ' +
    'confidence field (0-1) when you are unsure.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      title: { type: 'string' },
      confidence: { type: 'number' },
      identity: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          brand: { type: 'string' },
          category: { type: 'string' },
          sku: { type: 'string' },
          barcodes: { type: 'array', items: { type: 'string' } },
          ean: { type: 'string' },
          gtin: { type: 'string' },
          upc: { type: 'string' },
          mpn: { type: 'string' },
          clear: {
            type: 'array',
            items: { type: 'string' },
            description: 'Identity fields to delete (allowed: barcodes, ean, gtin, upc). Use only when the user explicitly asks to remove these values.',
          },
        },
      },
      short_description: { type: 'string' },
      key_features: { type: 'array', items: { type: 'string' } },
      attributes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            value: { type: 'string' },
            value_type: { type: 'string' },
          },
          required: ['key', 'value'],
        },
      },
      gpsr: {
        type: 'object',
        properties: {
          manufacturer_name: { type: 'string' },
          manufacturer_address: { type: 'string' },
          manufacturer_city: { type: 'string' },
          manufacturer_postalcode: { type: 'string' },
          manufacturer_state_province: { type: 'string' },
          email: { type: 'string' },
          manufacturer_phone: { type: 'string' },
          url: { type: 'string' },
          country_code: { type: 'string' },
          entity_country: { type: 'string' },
          source: {
            type: 'string',
            description:
              'Setze NUR auf "product_image", wenn Hersteller-/EU-Verantwortlichen-Angaben direkt vom sichtbaren Etikett/Karton auf dem Produktfoto abgelesen wurden. Sonst weglassen.',
          },
          eu_responsible_name: { type: 'string' },
          eu_responsible_address: { type: 'string' },
          eu_responsible_city: { type: 'string' },
          eu_responsible_postalcode: { type: 'string' },
          eu_responsible_state_province: { type: 'string' },
          eu_responsible_country: { type: 'string' },
          eu_responsible_country_code: { type: 'string' },
          eu_responsible_email: { type: 'string' },
          eu_responsible_phone: { type: 'string' },
        },
      },
      pricing: {
        type: 'object',
        properties: {
          amount: { type: 'number', description: 'Recherchierter Marktpreis (Doku, → lowest_price).' },
          sellPrice: { type: 'number', description: 'Vorgeschlagener Verkaufspreis in EUR. NUR setzen, wenn bisher kein Verkaufspreis existiert oder er 0 ist.' },
          currency: { type: 'string' },
          source_url: { type: 'string' },
        },
      },
      notes: {
        type: 'object',
        properties: {
          unsure: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

const SUGGEST_IMAGES_DECLARATION = {
  name: 'suggest_product_images',
  description:
    'Provide a precise search query for real product images (brand + model + ' +
    'EAN). The system resolves image URLs — do NOT invent or guess URLs.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      rationale: { type: 'string' },
    },
    required: ['query'],
  },
};

// ---------------------------------------------------------------------------
// Whitelist-based sanitizer for update_product_datasheet arguments.
// ---------------------------------------------------------------------------

const DATASHEET_TOP_LEVEL_FIELDS = [
  'summary',
  'title',
  'confidence',
  'identity',
  'short_description',
  // 'description' ist ein Modell-Alias für short_description (Incident 2026-07-16:
  // Write-Call sanitizte zu LEER, Karte verschwand komplett) — wird im Sanitizer
  // auf short_description gefaltet, short_description gewinnt bei Konflikt.
  'description',
  'key_features',
  'attributes',
  'gpsr',
  'pricing',
  'notes',
];

// Feldlisten kommen aus dem Kontrakt (lib/chat-datasheet-contract.js).
// Vorher standen sie hier als eigene Kopie — eine von ~17. Genau dieses
// Kopieren ließ V2/Legacy beim Nachrüsten der eu_responsible_*-Felder
// zurückfallen und verursachte den Vorfall 2026-08-10.
const IDENTITY_FIELDS = [...CONTRACT.IDENTITY_FIELDS];
const GPSR_FIELDS = [...CONTRACT.GPSR_FIELDS];
const NOTES_FIELDS = ['unsure', 'warnings'];
const PRICING_FIELDS = ['amount', 'currency', 'source_url', 'last_checked_iso'];

function sanitizeString(value, max = 500) {
  if (value == null) return '';
  // De-literalize escape sequences (e.g. a model over-escaping "\n" inside its
  // JSON function-call argument) before trimming — otherwise a literal
  // backslash-n leaks into the stored datasheet. Incident 2026-06-29.
  const s = typeof value === 'string' ? value : String(value);
  return normalizeLiteralEscapes(s).trim().slice(0, max);
}

function sanitizeStringArray(value, { maxLen = 160, max = 20 } = {}) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => sanitizeString(v, maxLen))
    .filter(Boolean)
    .slice(0, max);
}

function sanitizeDatasheetChangeV3(entry) {
  if (!entry || typeof entry !== 'object') return {};
  const out = {};

  for (const field of DATASHEET_TOP_LEVEL_FIELDS) {
    if (!(field in entry)) continue;
    const raw = entry[field];
    if (raw == null) continue;

    switch (field) {
      case 'summary':
        out.summary = sanitizeString(raw, 500);
        if (!out.summary) delete out.summary;
        break;
      case 'title': {
        const t = sanitizeString(raw, 120);
        if (t) out.title = t;
        break;
      }
      case 'confidence': {
        const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
        if (Number.isFinite(n)) out.confidence = Math.max(0, Math.min(1, n));
        break;
      }
      case 'short_description':
      case 'description': {
        // Beschreibung = Fließtext-Invariante: enthält der Vorschlag Listen
        // (HTML-<ul> oder Klartext-Bullets), sofort zu Prosa flatten — so ist
        // schon die Vorschlags-Karte + das Übernehmen-Preview korrekt, nicht
        // erst der Save-Boundary-Guard. Bullets gehören nur in key_features.
        // 'description' ist ein häufiger Modell-Alias; short_description gewinnt.
        if (field === 'description' && out.short_description) break;
        const d = sanitizeString(raw, 8000);
        if (d) out.short_description = hasListMarkup(d) ? sanitizeDescriptionProse(d) : d;
        break;
      }
      case 'key_features':
        {
          const arr = sanitizeStringArray(raw, { maxLen: 240, max: 12 });
          if (arr.length) out.key_features = arr;
        }
        break;
      case 'identity':
        if (raw && typeof raw === 'object') {
          const id = {};
          for (const key of IDENTITY_FIELDS) {
            if (!(key in raw)) continue;
            if (key === 'barcodes') {
              id.barcodes = sanitizeStringArray(raw.barcodes, { maxLen: 24, max: 6 });
              if (!id.barcodes.length) delete id.barcodes;
            } else {
              const v = sanitizeString(raw[key], 120);
              if (v) id[key] = v;
            }
          }
          // Explicit clear directive — see product-chat-v2.js for rationale.
          if (Array.isArray(raw.clear)) {
            const allowed = new Set(['barcodes', 'ean', 'gtin', 'upc']);
            const requestedClear = Array.from(
              new Set(
                raw.clear
                  .map((v) => sanitizeString(v, 16).toLowerCase())
                  .filter((v) => allowed.has(v)),
              ),
            );
            if (requestedClear.length) {
              id._clear = requestedClear;
              if (requestedClear.includes('barcodes')) delete id.barcodes;
            }
          }
          if (Object.keys(id).length) out.identity = id;
        }
        break;
      case 'attributes': {
        // Deklariert ist ein Array [{key,value}], Modelle liefern aber auch
        // Map-Shape { "Farbe": "Rot" } — früher wurde das STILL VERWORFEN
        // (Incident 2026-07-16: Write-Call sanitizte zu leer, keine Karte).
        const rawList = Array.isArray(raw)
          ? raw
          : raw && typeof raw === 'object'
            ? Object.entries(raw).map(([k, v]) => ({ key: k, value: v }))
            : [];
        const cleaned = [];
        const { isKTypSynonymKey, isPlausibleKTypValue } = require('../lib/ktype-key-normalize');
        for (const attr of rawList) {
          if (!attr || typeof attr !== 'object') continue;
          const key = sanitizeString(attr.key ?? attr.name, 60);
          const value = sanitizeString(attr.value, 240);
          if (!key || !value) continue;
          // K-Typ ist LLM-tabu: nur numerische TecDoc-IDs sind zulässig, und die
          // kommen ausschließlich aus der automatischen Anreicherung — erfundene
          // Text-Platzhalter fliegen schon aus der Vorschlags-Karte (2026-07-16).
          if (isKTypSynonymKey(key) && !isPlausibleKTypValue(value)) continue;
          const item = { key, value };
          if (typeof attr.value_type === 'string' && attr.value_type.trim()) {
            item.value_type = sanitizeString(attr.value_type, 30);
          }
          cleaned.push(item);
          if (cleaned.length >= 40) break;
        }
        if (cleaned.length) out.attributes = cleaned;
        break;
      }
      case 'gpsr':
        if (raw && typeof raw === 'object') {
          const gpsr = {};
          for (const key of GPSR_FIELDS) {
            const v = sanitizeString(raw[key], 240);
            if (v) gpsr[key] = v;
          }
          if (Object.keys(gpsr).length) {
            // Provenienz-Marker (Meta, kein Wertfeld): NUR 'product_image' zulassen.
            // Der GPSR-Guard vertraut damit vom Etikett abgelesenen Daten, die
            // sonst mangels Web-URL als "unbelegt" verworfen würden.
            if (sanitizeString(raw.source, 40) === 'product_image') gpsr.source = 'product_image';
            out.gpsr = gpsr;
          }
        }
        break;
      case 'pricing':
        if (raw && typeof raw === 'object') {
          const pricing = {};
          const toNum = (v) => {
            if (typeof v === 'number' && Number.isFinite(v)) return v;
            if (typeof v === 'string') { const n = parseFloat(v.replace(',', '.')); return Number.isFinite(n) ? n : null; }
            return null;
          };
          const amt = toNum(raw.amount);
          if (amt != null) pricing.amount = amt;
          const sell = toNum(raw.sellPrice);
          if (sell != null && sell >= 0) pricing.sellPrice = sell;
          for (const key of PRICING_FIELDS) {
            if (key === 'amount') continue;
            const v = sanitizeString(raw[key], 240);
            if (v) pricing[key] = v;
          }
          if (Object.keys(pricing).length) out.pricing = pricing;
        }
        break;
      case 'notes':
        if (raw && typeof raw === 'object') {
          const notes = {};
          for (const key of NOTES_FIELDS) {
            const arr = sanitizeStringArray(raw[key], { maxLen: 240, max: 10 });
            if (arr.length) notes[key] = arr;
          }
          if (Object.keys(notes).length) out.notes = notes;
        }
        break;
      default:
        break;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// System prompt + product context
// ---------------------------------------------------------------------------

function truncate(str, max) {
  if (typeof str !== 'string') return str;
  if (str.length <= max) return str;
  return `${str.slice(0, max)}…`;
}

function summarizeProduct(product) {
  const p = product || {};
  const ident = p.identification || {};
  const details = p.details || {};
  const identifiers = details.identifiers || {};
  const attributesRaw = details.attributes || {};
  const attrList = Array.isArray(attributesRaw)
    ? attributesRaw
    : Object.entries(attributesRaw).map(([key, value]) => ({ key, value }));
  const images = Array.isArray(details.images) ? details.images : [];

  return {
    id: p.id || null,
    identification: {
      name: truncate(ident.name || '', 160),
      brand: ident.brand || null,
      category: ident.category || null,
      barcodes: Array.isArray(ident.barcodes) ? ident.barcodes.slice(0, 4) : [],
    },
    identifiers: {
      ean: identifiers.ean || null,
      gtin: identifiers.gtin || null,
      upc: identifiers.upc || null,
      mpn: identifiers.mpn || null,
      sku: identifiers.sku || null,
    },
    attributes: attrList.slice(0, 20).map((entry) => ({
      key: truncate(String(entry?.key || ''), 40),
      value: truncate(String(entry?.value ?? ''), 120),
    })),
    categoryId: details.categoryId || details.ebayCategoryId || null,
    imageCount: images.length,
    hasImages: images.length > 0,
  };
}

/**
 * Lädt die eigenen Produktbilder als inlineData-Parts, damit das Modell
 * Hersteller-/GPSR-/Maß-Angaben direkt vom Etikett ablesen kann. Portiert aus
 * product-chat-v2.js (Incident 2026-07-17: V3 war hier blind). Wirft nie —
 * jeder fehlgeschlagene Abruf wird pro Bild verworfen.
 */
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
        console.warn(`[chat-v3] Failed to fetch product image ${url}: ${err.message}`);
        return null;
      }
    })
  );
  return results.filter(Boolean);
}

// Kategorie-bewusster SEO-Regel-Block (Cassini-Leitfaden). Der V3-Prompt hatte
// bisher KEINE Titel-/Beschreibungs-/Preis-Regeln — „Alles optimieren" lieferte
// deshalb regelwidrige Titel (z.B. Fahrzeugmodelle im Motors-Titel) und dünne
// 2-Satz-Beschreibungen. Diese Regeln machen die deterministischen Vorgaben aus
// dem Leitfaden (lib/cassini-category-map, lib/seo-title-builder) verbindlich.
function buildSeoRulesBlock(product) {
  const details = product?.details || {};
  const ident = product?.identification || {};
  const catId = details.categoryId || details.ebayCategoryId || null;
  const breadcrumb = details.categoryPath || ident.category || details.category || null;
  const bucket = getCassiniCategoryBucket(catId, breadcrumb);
  const pattern = getCategoryPattern(bucket);

  const lines = [
    'SEO-TITEL (eBay Cassini — VERBINDLICH, max 80 Zeichen):',
    `- KATEGORIE dieses Produkts: ${bucket}. Titel-Muster für diese Kategorie: ${pattern}`,
    '- Harte Obergrenze 80 Zeichen. Nutze den Platz voll aus für Long-Tail-Keywords — aber KEINE Füllwörter (der/die/das/für/mit) und keine Selbstverständlichkeiten.',
    '- Die ERSTEN 3–5 Wörter sind CTR-entscheidend (mobile Ansicht): Marke + Produkttyp/Modell zuerst.',
    '- SONDERZEICHEN-VERBOT: kein &, !, _, keine Klammern (), kein „WOW"/„L@@K". Ein einfacher Bindestrich zur Trennung ist das Maximum. Keine EAN/GTIN/SKU im Titel.',
    '- Haupt-Keyword max. 1×; nutze Long-Tail-Variationen statt Wiederholung.',
  ];
  if (bucket === 'motors') {
    lines.push('- MOTORS-SONDERREGEL (kritisch): Führe im Titel KEINE Fahrzeugmodelle/Marken auf (z.B. NICHT „für Dodge RAM 1500", NICHT „VW Golf"). Der Titel enthält [Hersteller] [Teilename] [Einbauposition/Maß] [OEM-/OE-Referenznummer]. Die kompatiblen Fahrzeuge gehören AUSSCHLIESSLICH in die Fahrzeugverwendungsliste (K-Types), nie in den Titel. Beispiel: „Mopar Bremsscheibe Hinterachse 375mm 68237065AA".');
  }
  lines.push(
    '',
    'SEO-BESCHREIBUNG (short_description — VERBINDLICH):',
    '- Reiner FLIESSTEXT (keine Bullet-Points, keine Listen, kein HTML). Bullet-Points gehören ausschließlich in key_features/Highlights.',
    '- Umfang ~180–240 Wörter sichtbarer Text (NICHT 2–3 Sätze). Einzigartig formuliert (kein Lieferanten-Copy-Paste → Duplicate-Content-Strafe).',
    '- Keyword-Dichte 5–7 %: die wichtigsten Such-Keywords + deren Synonyme natürlich einweben (z.B. „Bremsscheibe" ergänzt um „Bremsscheiben", „Scheibenbremse"). Keywords, die nicht in den 80-Zeichen-Titel passten, hier verweben.',
    '- Nutzen statt reiner Merkmale („Benefits statt Features"): erkläre den konkreten Käufer-Vorteil. Präzise, professionell, keine erfundenen Specs.',
    '',
    'PREIS (VERBINDLICH wenn Verkaufspreis fehlt/0):',
    '- Wenn der aktuelle Verkaufspreis (pricing.sellPrice) fehlt oder 0 ist, MUSST du einen belegten Marktpreis recherchieren und ihn als pricing.sellPrice (Zahl, EUR) VORSCHLAGEN — nicht nur als lowest_price dokumentieren. pricing.lowest_price ist reine Recherche und ändert den Angebotspreis nicht.',
    '- Orientiere dich am Median vergleichbarer verkaufter Artikel (Cassini bestraft Ausreißer nach oben UND unten). Sage nie „Preis aktualisiert", wenn du sellPrice nicht gesetzt hast.',
  );
  return lines.join('\n');
}

// Deterministische Durchsetzung der SEO-Policies NACH der Konsolidierung — damit
// „einfache Regeln" garantiert greifen, egal was das Modell liefert:
//  1) Titel: coerceTitleToPolicy (harte 80-Zeichen-Grenze + Emoji/Markdown/SKU/
//     Sonderzeichen-Cleanup). Passthrough-Modus rewritet NICHT, kürzt/säubert nur.
//  2) Preis-Gap: hat das Modell einen belegten Marktpreis recherchiert, aber
//     keinen sellPrice gesetzt, und hat das Produkt bisher KEINEN Verkaufspreis,
//     wird der Marktpreis als sellPrice-Vorschlag abgeleitet (füllt nur Lücken,
//     überschreibt NIE einen bestehenden Verkaufspreis).
function enforceSeoPoliciesV3(changes, product) {
  if (!Array.isArray(changes)) return changes;
  const existingSell = Number(product?.details?.pricing?.sellPrice) || 0;
  for (const change of changes) {
    if (!change || typeof change !== 'object') continue;
    if (typeof change.title === 'string' && change.title.trim()) {
      try {
        const coerced = coerceTitleToPolicy(product, change.title, { maxLen: 80 });
        if (coerced && coerced.trim()) change.title = coerced.trim();
      } catch { /* Titel unverändert lassen bei Fehler */ }
    }
    const p = change.pricing;
    if (p && typeof p === 'object') {
      const proposedSell = Number(p.sellPrice) || 0;
      const market = Number(p.sellPrice) || Number(p.amount)
        || Number(p.lowest_price && p.lowest_price.amount) || 0;
      if (!proposedSell && !existingSell && market >= 1) {
        p.sellPrice = market;
      }
    }
  }
  return changes;
}

function buildSystemPromptV3(product, { locale = 'de-DE' } = {}) {
  const snapshot = summarizeProduct(product);
  const toolList = atomicTools
    .buildToolList({ includeAmazon: true, includeManufacturer: true })
    .map((decl) => `- ${decl.name}: ${decl.description}`)
    .join('\n');

  return [
    'Du bist ein Produkt-Research-Agent für AvyCloud.',
    'Deine Aufgabe: präzise, belegbare, eBay-ready Produktdaten ermitteln und vorschlagen.',
    '',
    'PRODUKT-KONTEXT (JSON):',
    JSON.stringify(snapshot, null, 2),
    '',
    'VERFÜGBARE TOOLS:',
    '- googleSearch (native): breite Web-Recherche, Grounding Queries.',
    '- urlContext (native): konkrete URL tief lesen (bis zu 20 URLs pro Request).',
    toolList,
    '- update_product_datasheet: PFLICHT-Finalisierung jedes Turns (siehe ARBEITSFLOW).',
    '- suggest_product_images: führt SOFORT eine echte Bildsuche aus und liefert die gefundenen Bilder im selben Zug zurück (Feld count/found im Ergebnis). Es ist KEINE asynchrone/"laufende" Suche — sage NIE "die Suche läuft". Melde stattdessen, wie viele Bilder gefunden wurden (count). Erfinde keine URLs.',
    '',
    'ARBEITSFLOW (IMMER IN DIESER REIHENFOLGE):',
    '0. BILD-PHASE (ZUERST): Die angehängten Produktbilder sind Fotos des ECHTEN Artikels/der Verpackung. Lies Angaben — Marke, Modell/Typnummer, Maße, Material, Leistungsdaten UND besonders Hersteller-/EU-Verantwortlichen-/GPSR-Angaben — DIREKT vom Etikett/Karton ab, BEVOR du das Web bemühst. Das Etikett ist die autoritativste Quelle.',
    '1. RECHERCHE-PHASE: Nutze googleSearch, urlContext und die atomaren Tools (lookup_gtin, search_ebay_catalog, verify_brand, search_amazon_product, search_manufacturer_site, fetch_url_content, get_required_aspects) um Fakten über das Produkt zu sammeln und Quellen zu cross-referenzieren.',
    '2. WRITE-PHASE (PFLICHT): Am Ende JEDES Turns MUSST du genau einmal update_product_datasheet aufrufen mit den konsolidierten Änderungsvorschlägen.',
    '',
    'REGELN (nicht verhandelbar):',
    '- update_product_datasheet ist die FINALE Aktion jedes Turns. Ohne diesen Call sieht der Nutzer keinen "Übernehmen"-Button — also muss er IMMER kommen.',
    '- Auch wenn du keine eindeutigen neuen Fakten gefunden hast: Rufe update_product_datasheet mit leeren arrays auf und erkläre im `summary`-Feld warum (z.B. "Keine verlässlichen Quellen gefunden, bitte manuell prüfen").',
    '- Gib KEINE finalen Produktdaten nur als Text aus — sie MÜSSEN über update_product_datasheet strukturiert zurückkommen.',
    '- Jeder datasheetChanges-Eintrag sollte source/evidence-URL enthalten wenn möglich — aber NUR URLs, die du in diesem Turn tatsächlich über Tools/Suche gesehen hast. NIEMALS eine URL konstruieren oder raten; lieber Feld weglassen.',
    '- Das Attribut "K-Typ" NIEMALS selbst setzen, schätzen oder mit Text/Platzhaltern füllen — es enthält ausschließlich numerische TecDoc-IDs und wird automatisch aus der eBay-Fahrzeugliste angereichert. Ist es leer: sag ehrlich, dass keine belegbare Zuordnung gefunden wurde, und ergänze stattdessen belegte HSN/TSN- oder OE-Nummern (die helfen der Automatik).',
    '- PREIS-QUELLEN (STRENG): pricing.source_url muss eine konkrete Angebotsseite GENAU dieses Produkts sein (gleiche Marke, gleiches Modell, gleiche Variante/Größe/Farbe) und den angegebenen amount tatsächlich zeigen. Such-/Ergebnisseiten (ebay.de/sch, amazon.de/s, idealo-Suche, Google) sind als Quelle VERBOTEN. Bei mehreren Größen/Varianten NIE den Preis der kleinsten Variante nehmen. Kein belastbarer Beleg gefunden → source_url weglassen, confidence ≤ 0.3, und dem Nutzer ehrlich sagen, dass der Preis unbelegt ist. Das System prüft jede Quelle automatisch nach.',
    '- Research-Tools liefern structured outputs — Temperature ist 1.0 by design, aber sei konservativ bei confidence-Scores.',
    '- Cross-Referenziere mindestens 2 unabhängige Quellen bevor Du eine Behauptung übernimmst.',
    '',
    'GPSR (EU-Produktsicherheitsverordnung):',
    '- ETIKETT ZUERST + Rollen exakt zuordnen: Lies die Angaben vom Verpackungsfoto/Karton und setze gpsr.source = "product_image", wenn du sie dort abliest. Zuordnung strikt nach Beschriftung:',
    '  · Zeile "Manufacturer:"/"Hersteller:" → manufacturer_name + manufacturer_address (auch wenn China/CN). Das ist der ECHTE Hersteller, NICHT automatisch die Marke.',
    '  · Zeile "EC REP"/"EU-Bevollmächtigter"/"EU-Verantwortlicher" → eu_responsible_name + eu_responsible_address + eu_responsible_email + eu_responsible_phone.',
    '  · Zeile "UK/AR"/"UK Responsible Person"/"Company" mit UK-Adresse → das ist der UK-Bevollmächtigte, NICHT der EU-Verantwortliche und NICHT der Hersteller — NICHT in eu_responsible_* oder manufacturer_* schreiben.',
    '- NIEMALS einen EU-Verantwortlichen, Hersteller oder eine Adresse ERFINDEN, die nicht auf dem Etikett/in einer belegten Quelle steht (kein eVatmaster o. Ä. raten). Feld leer lassen ist besser als geraten.',
    '- Vermische NIE die Adressen/Telefone verschiedener Rollen (Hersteller-Telefon gehört zum Hersteller, EU-REP-Telefon zum EU-REP).',
    '- Nach dem Ablesen darfst du optional mit googleSearch eine bestätigende Hersteller-/Impressum-URL in gpsr.url ergänzen. Die vom Etikett gelesenen Angaben werden auch OHNE Web-Beleg übernommen (source="product_image"); eine nicht-bestätigende Web-Seite verwirft sie NICHT.',
    '- Hersteller-Felder (manufacturer_*, entity_country, email, manufacturer_phone): NUR der tatsächliche Hersteller — auch wenn außerhalb der EU (z.B. China).',
    '- EU-Verantwortlicher (eu_responsible_*): PFLICHT wenn entity_country/country_code NICHT in der EU liegt. Separate Felder nutzen, NIEMALS EU-Adresse in Hersteller-Felder schreiben.',
    '- WICHTIG — Rolle erkennen, nicht am Land festmachen: Eine Firma mit Zusatz wie "(für <Marke>)", "im Auftrag von …", "i.A." ODER ein bekannter EU-Bevollmächtigter (z.B. Apex CE Specialists, eVatmaster, "… CE Specialists", "Authorized Representative") ist der EU-VERANTWORTLICHE, NICHT der Hersteller — auch wenn die Adresse in Deutschland liegt. Solche Daten gehören in eu_responsible_*, und der echte Hersteller ist die Marke aus dem "(für <Marke>)"-Zusatz (gehört in manufacturer_name).',
    '- NIEMALS EU-Verantwortlichen-Kontakt (z.B. eVatmaster, +49…) in manufacturer email/phone mischen — nur in eu_responsible_email / eu_responsible_phone.',
    '',
    buildSeoRulesBlock(product),
    '',
    'OUTPUT-FORMAT:',
    '- Datenblatt-Änderung → function_call update_product_datasheet (inkl. confidence 0-1 und summary).',
    '- Info-Antworten → zuerst Text auf Deutsch, DANN trotzdem update_product_datasheet mit summary=Antwort aufrufen (leere Felder erlaubt).',
    '- Zitate inline als [Quelle: URL] mitgeben.',
    '',
    `SPRACHE: ${locale}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Retry helpers (Gemini 5xx / network flakes)
// ---------------------------------------------------------------------------

const PER_ATTEMPT_TIMEOUT_MS_V3 = parseInt(
  process.env.GEMINI_RETRY_PER_ATTEMPT_TIMEOUT_MS || '30000',
  10,
);
async function withGeminiRetryV3(operation, { label = 'gemini-v3', perAttemptTimeoutMs = PER_ATTEMPT_TIMEOUT_MS_V3 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const opPromise = Promise.resolve().then(() => operation());
      opPromise.catch(() => {});
      // eslint-disable-next-line no-await-in-loop
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
      if (!transient || attempt === RETRY_DELAYS_MS.length) throw err;
      const delay = RETRY_DELAYS_MS[attempt];
      console.warn(
        `[chat-v3] ${label} transient failure (status=${status}, attempt=${attempt + 1}) — retry in ${delay}ms: ${err?.message || err}`
      );
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Response helpers — thoughts + grounding metadata
// ---------------------------------------------------------------------------

function emitThoughts(response, trace, onProgress) {
  try {
    const candidates = response?.candidates || [];
    for (const cand of candidates) {
      const parts = cand?.content?.parts || [];
      for (const part of parts) {
        if (part && part.thought === true && typeof part.text === 'string' && part.text.trim()) {
          const text = part.text.trim();
          trace.thoughts.push(text);
          if (typeof onProgress === 'function') {
            try { onProgress({ type: 'thinking', text }); } catch { /* never break */ }
          }
        }
      }
    }
  } catch { /* non-critical */ }
}

function collectGrounding(response, trace, onProgress) {
  try {
    // Freikontingent-Zaehler (3er-Familie rechnet pro Such-Query ab)
    require('../lib/grounding-usage').trackGroundingQueries(response, 'chat.v3');
    const candidates = response?.candidates || [];
    const meta = candidates[0]?.groundingMetadata;
    if (meta) {
      const queries = Array.isArray(meta.webSearchQueries) ? meta.webSearchQueries : [];
      const chunks = Array.isArray(meta.groundingChunks) ? meta.groundingChunks : [];
      const sources = chunks
        .map((c) => ({ title: c?.web?.title || '', url: c?.web?.uri || '' }))
        .filter((s) => s.url);
      if (queries.length || sources.length) {
        trace.groundingChunks.push({ queries, sources });
        if (typeof onProgress === 'function') {
          try { onProgress({ type: 'grounding', queries, sources: sources.slice(0, 10) }); } catch {}
        }
      }
    }
    const urlMeta = candidates[0]?.urlContextMetadata;
    if (urlMeta && Array.isArray(urlMeta.urlMetadata) && urlMeta.urlMetadata.length) {
      for (const u of urlMeta.urlMetadata) {
        const url = u?.retrievedUrl || u?.url;
        if (!url) continue;
        trace.urls.push({ url, status: u?.urlRetrievalStatus || u?.status || 'unknown' });
      }
    }
  } catch { /* non-critical */ }
}

function collectAnswerText(response) {
  try {
    const candidates = response?.candidates || [];
    const parts = candidates[0]?.content?.parts || [];
    const answers = parts
      .filter((p) => p && p.thought !== true && typeof p.text === 'string')
      .map((p) => p.text);
    if (answers.length) return answers.join('').trim();
  } catch { /* ignore */ }
  return typeof response?.text === 'string' ? response.text : '';
}

// Meta-/Steuer-Text-Erkennung: gemini-3.1-pro beantwortet reine functionResponse-
// Inputs in agentic Settings oft mit englischem Task-Abschluss-Gerede statt einer
// User-Antwort ("have successfully completed the task. No further tool calls are
// required."). Solcher Text darf NIE als Chat-Antwort durchschlagen (Incident
// 2026-07-16). Nur kurze Texte werden klassifiziert — echte Antworten sind länger
// und deutsch, das verhindert False-Positives.
const META_ANSWER_PATTERNS = [
  /\b(successfully|now)?\s*(completed|finished)\s+(the\s+)?task\b/i,
  /\bno further (tool|function|action)s? (calls?|required|needed)\b/i,
  /\btask (is )?(now )?complete\b/i,
  /\bupdate_product_datasheet\b/i,
  /\b(function|tool) call(s)?\b/i,
  /\bi (will|have|am going to) (now )?(call|use|invoke)\b/i,
];

function isMetaEchoAnswer(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return true;
  if (t.length > 600) return false;
  return META_ANSWER_PATTERNS.some((re) => re.test(t));
}

function synthesizeAnswerFromChanges(datasheetChanges) {
  const summaries = (Array.isArray(datasheetChanges) ? datasheetChanges : [])
    .map((c) => (c && typeof c.summary === 'string' ? c.summary.trim() : ''))
    .filter(Boolean);
  if (!summaries.length) return '';
  if (summaries.length === 1) return summaries[0];
  return `Ich habe folgende Änderungen vorbereitet:\n- ${summaries.join('\n- ')}`;
}

// ---------------------------------------------------------------------------
// Own executors — writable tool handling
// ---------------------------------------------------------------------------

// Karten ohne summary zeigten im FE nur "Änderung aus Chat" ohne jeden
// konkreten Wert (Incident 2026-07-16) — hier wird aus den Feldern eine
// konkrete deutsche Zusammenfassung gebaut, damit der Operator sieht, WAS
// er übernimmt.
function summarizeChangeForCard(change) {
  const parts = [];
  if (change.title) parts.push(`Titel: ${String(change.title).slice(0, 60)}`);
  const id = change.identity || {};
  if (id.brand) parts.push(`Marke: ${id.brand}`);
  if (id.category) parts.push(`Kategorie: ${String(id.category).slice(0, 60)}`);
  if (id.mpn) parts.push(`MPN: ${id.mpn}`);
  const barcode = id.ean || id.gtin || id.upc;
  if (barcode) parts.push(`Barcode: ${barcode}`);
  if (change.pricing && change.pricing.amount != null) {
    parts.push(`Preis: ${change.pricing.amount} ${change.pricing.currency || 'EUR'}`);
  }
  if (change.short_description) parts.push('Kurzbeschreibung aktualisiert');
  if (Array.isArray(change.key_features) && change.key_features.length) {
    parts.push(`${change.key_features.length} Highlights`);
  }
  const attrs = change.attributes;
  const attrCount = Array.isArray(attrs)
    ? attrs.length
    : attrs && typeof attrs === 'object'
      ? Object.keys(attrs).length
      : 0;
  if (attrCount) parts.push(`${attrCount} Attribute`);
  if (change.gpsr && typeof change.gpsr === 'object') parts.push('GPSR-Herstellerdaten');
  return parts.length ? `Vorgeschlagen — ${parts.join(' · ')}`.slice(0, 300) : '';
}

// Mehrere update_product_datasheet-Calls in EINEM Turn erzeugten überlappende
// Karten (z. B. zweimal Marke/Kategorie/Preis — Incident 2026-07-16): für den
// Operator unaufgeräumt und beim Übernehmen reihenfolge-abhängig. Konsolidierung
// auf EINE Karte pro Turn, last-wins pro Feld (identisch zur draft-Aggregation
// im Post-Processing), Attribute last-wins pro normalisiertem Key, Summaries
// werden zusammengeführt, Confidence konservativ (Minimum).
function consolidateDatasheetChangesV3(changes) {
  const list = (Array.isArray(changes) ? changes : []).filter((c) => c && typeof c === 'object');
  if (list.length <= 1) return list;

  const normKey = (k) => String(k || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  const merged = {};
  const summaries = [];
  const attrByNorm = new Map(); // norm(key) -> { key, value, value_type? }
  let minConfidence = null;

  for (const change of list) {
    for (const [field, value] of Object.entries(change)) {
      if (value == null) continue;
      switch (field) {
        case 'summary': {
          const s = String(value).trim();
          if (s && !summaries.includes(s)) summaries.push(s);
          break;
        }
        case 'confidence': {
          const n = Number(value);
          if (Number.isFinite(n)) minConfidence = minConfidence == null ? n : Math.min(minConfidence, n);
          break;
        }
        case 'identity':
          merged.identity = { ...(merged.identity || {}), ...value };
          break;
        case 'gpsr':
          merged.gpsr = { ...(merged.gpsr || {}), ...value };
          break;
        case 'notes': {
          const prev = merged.notes || {};
          const next = {};
          for (const key of ['unsure', 'warnings']) {
            const combined = Array.from(
              new Set([...(prev[key] || []), ...(Array.isArray(value[key]) ? value[key] : [])])
            );
            if (combined.length) next[key] = combined;
          }
          if (Object.keys(next).length) merged.notes = next;
          break;
        }
        case 'attributes': {
          const entries = Array.isArray(value)
            ? value.filter((it) => it && typeof it === 'object')
            : Object.entries(value).map(([k, v]) => ({ key: k, value: v }));
          for (const it of entries) {
            const norm = normKey(it.key || it.name);
            if (!norm) continue;
            attrByNorm.set(norm, it);
          }
          break;
        }
        case 'short_description': {
          // NICHT last-wins: Der erzwungene Abschluss-Write liefert oft nur einen
          // mageren 2-Satz-Recap und überschrieb die reiche Erstfassung
          // (Incident 2026-07-16, "Alles optimieren" → 198-Zeichen-Beschreibung).
          // Die AUSFÜHRLICHERE Beschreibung gewinnt.
          const prevLen = String(merged.short_description || '').length;
          if (String(value).length >= prevLen) merged.short_description = value;
          break;
        }
        case 'key_features': {
          const prevArr = Array.isArray(merged.key_features) ? merged.key_features : [];
          const nextArr = Array.isArray(value) ? value : [];
          if (nextArr.length >= prevArr.length) merged.key_features = value;
          break;
        }
        default:
          // last-wins: title, short_description, key_features, pricing,
          // categoryId/categoryPath (falls ein früherer Schritt sie setzte) …
          merged[field] = value;
          break;
      }
    }
  }

  if (attrByNorm.size) merged.attributes = Array.from(attrByNorm.values());
  if (minConfidence != null) merged.confidence = minConfidence;
  const joined = summaries.join('\n').slice(0, 500).trim();
  merged.summary = joined || summarizeChangeForCard(merged) || undefined;
  if (!merged.summary) delete merged.summary;
  return [merged];
}

// Normalisierter Bild-Schlüssel (Host+Pfad) für Dedup — spiegelt V2.
function normalizeImageKeyV3(url = '') {
  const s = String(url || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    return `${u.hostname}${u.pathname}`.toLowerCase();
  } catch {
    return s.toLowerCase().replace(/\s+/g, '');
  }
}

// Vorhandene Produktbild-Schlüssel, damit die Web-Suche keine Duplikate vorschlägt.
function existingImageKeysFor(product) {
  const imgs = Array.isArray(product?.details?.images) ? product.details.images : [];
  return imgs
    .map((im) => normalizeImageKeyV3(im?.url_or_base64))
    .filter(Boolean);
}

async function ownExecutor(name, args, state) {
  if (name === 'update_product_datasheet') {
    const started = Date.now();
    const change = sanitizeDatasheetChangeV3(args || {});
    const hasContent = Object.keys(change).filter((k) => k !== 'summary').length > 0;
    if (!hasContent) {
      // Der Executor meldete hier früher ok:true — das Modell glaubte, die
      // Änderung sei angekommen ("Aufgabe erfolgreich abgeschlossen!"), obwohl
      // die Bereinigung ALLES verworfen hatte → keine Übernehmen-Karte
      // (Incident 2026-07-16, changes=0 bei sawWrite=true). Jetzt: ehrlicher
      // Fehler mit Schema-Hinweis, damit das Modell im Loop korrekt neu schreibt.
      const rawKeys = Object.keys(args || {}).slice(0, 15);
      console.warn(
        '[chat-v3] update_product_datasheet sanitized to EMPTY — raw keys: %s',
        rawKeys.join(',') || '(none)'
      );
      return {
        ok: false,
        source: 'update_product_datasheet',
        data: null,
        confidence: 0,
        error: {
          code: 'EMPTY_AFTER_SANITIZE',
          message:
            'Keines der übergebenen Felder entsprach dem Schema — es wurde NICHTS gespeichert. ' +
            'Rufe update_product_datasheet erneut auf mit exakt diesen Feldern: summary, title, ' +
            'identity{name,brand,category,sku,ean,gtin,upc,mpn,barcodes[]}, short_description (Fließtext), ' +
            'key_features[Strings], attributes als ARRAY von {key,value}, gpsr{manufacturer_name,...}, ' +
            'pricing{amount,currency,source_url}, notes{unsure[],warnings[]}.',
        },
        meta: { durationMs: Date.now() - started },
      };
    }
    if (!change.summary) {
      const synthesized = summarizeChangeForCard(change);
      if (synthesized) change.summary = synthesized;
    }
    state.datasheetChanges.push(change);
    return {
      ok: true,
      source: 'update_product_datasheet',
      data: {
        applied: hasContent,
        fields: Object.keys(change).filter((k) => k !== 'summary'),
        confidence: typeof change.confidence === 'number' ? change.confidence : null,
      },
      confidence: typeof change.confidence === 'number' ? change.confidence : 0.8,
      meta: { durationMs: Date.now() - started },
    };
  }

  if (name === 'suggest_product_images') {
    const started = Date.now();
    const query = sanitizeString(args?.query, 200);
    const rationale = sanitizeString(args?.rationale, 500);
    if (!query) {
      return {
        ok: false,
        source: 'suggest_product_images',
        data: null,
        confidence: 0,
        meta: { durationMs: Date.now() - started },
        error: { code: 'MISSING_QUERY', message: 'query is required' },
      };
    }
    // Incident 2026-07-18: der V3-Executor hat die Bildsuche NIE ausgeführt —
    // er legte nur den Suchbegriff ab (queued:true), das Modell meldete deshalb
    // "Bildersuche läuft" ohne je Bilder zu liefern. Jetzt wird — wie in V2 —
    // die echte SerpAPI-Bildsuche ausgeführt und die aufgelösten URLs geliefert.
    let images = [];
    let searchError = null;
    try {
      const results = await imageSearch.searchProductImages(state.product || {}, {
        query, limit: 6, minWidth: 400, minHeight: 400,
      });
      const seen = new Set(existingImageKeysFor(state.product));
      images = (Array.isArray(results) ? results : [])
        .map((img) => ({
          url_or_base64: img.url,
          source: img.source || 'web_search',
          variant: 'gallery',
          notes: img.title || 'Web-Produktbild',
        }))
        .filter((img) => {
          const key = normalizeImageKeyV3(img.url_or_base64);
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    } catch (err) {
      searchError = err?.message || String(err);
    }
    // Nur mit echten Bildern einen Vorschlag anhängen (leere Suche = kein Vorschlag).
    if (images.length) state.imageSuggestions.push({ query, rationale, images });
    return {
      ok: !searchError,
      source: 'suggest_product_images',
      data: { query, rationale, count: images.length, found: images.length > 0 },
      confidence: images.length ? 0.8 : 0.3,
      meta: { durationMs: Date.now() - started },
      ...(searchError ? { error: { code: 'IMAGE_SEARCH_FAILED', message: searchError } } : {}),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Atomic result → evidence rows for cross-reference / confidence scoring
// ---------------------------------------------------------------------------

const ATOMIC_SOURCE_TO_WEIGHT_KEY = Object.freeze({
  lookup_gtin: 'ean_db',
  search_ebay_catalog: 'ebay_catalog',
  get_required_aspects: 'ebay_catalog',
  verify_brand: 'gs1_verified',
  search_amazon_product: 'amazon_product',
  search_manufacturer_site: 'manufacturer_website',
  fetch_url_content: 'url_context',
});

function mapToolSourceWeight(source) {
  return ATOMIC_SOURCE_TO_WEIGHT_KEY[source] || 'web_search_broad';
}

function extractEvidenceFromToolResult(result) {
  // Return shape: { rows: [{field, source, value, confidence}], citations: [{url, title, snippet, source}] }
  const out = { rows: [], citations: [] };
  if (!result || !result.ok || !result.data) return out;
  const weightKey = mapToolSourceWeight(result.source);
  const data = result.data;

  switch (result.source) {
    case 'lookup_gtin':
      if (Array.isArray(data.sources)) {
        for (const src of data.sources) {
          const d = src?.data || {};
          if (d.brand) out.rows.push({ field: 'brand', source: weightKey, value: d.brand, confidence: src.confidence });
          if (d.productName) out.rows.push({ field: 'title', source: weightKey, value: d.productName, confidence: src.confidence });
          if (d.category) out.rows.push({ field: 'category', source: weightKey, value: d.category, confidence: src.confidence });
        }
      }
      break;
    case 'search_ebay_catalog':
      if (data.catalog?.categoryId) {
        out.rows.push({ field: 'categoryId', source: 'ebay_catalog', value: String(data.catalog.categoryId), confidence: result.confidence });
      }
      if (Array.isArray(data.suggestions) && data.suggestions.length) {
        const top = data.suggestions[0];
        if (top?.categoryId) {
          out.rows.push({ field: 'categoryId', source: 'ebay_catalog', value: String(top.categoryId), confidence: top.score || result.confidence });
        }
      }
      break;
    case 'verify_brand':
      if (data.brand) out.rows.push({ field: 'brand', source: weightKey, value: data.brand, confidence: result.confidence });
      break;
    case 'search_amazon_product':
    case 'search_manufacturer_site':
    case 'fetch_url_content':
      // No per-field evidence — but keep a citation pointer.
      if (data?.result?.url || data?.url) {
        out.citations.push({
          url: data.url || data.result?.url,
          title: data.result?.title || '',
          snippet: truncate(String(data.result?.body || data.result?.snippet || ''), 240),
          source: weightKey,
        });
      }
      break;
    default:
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helper — resolve @google/genai client. Injectable for tests.
// ---------------------------------------------------------------------------

async function resolveAiClient(aiClient) {
  if (aiClient) return aiClient;
  const { getGenAIClient } = require('../lib/gemini3-client');
  return getGenAIClient();
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   product: object,
 *   message: string,
 *   history?: Array,
 *   attachments?: Array,
 *   onProgress?: (event: object) => void,
 *   maxIterations?: number,
 *   tenantId?: string,
 *   userId?: string,
 *   aiClient?: object,  // DI for tests — pre-built GoogleGenAI instance
 *   modelOverride?: string,
 * }} opts
 */
async function runProductChatV3({
  product,
  message,
  history = [],
  attachments = [],
  onProgress = null,
  maxIterations = DEFAULT_MAX_ITERATIONS,
  tenantId = null,
  userId = null,
  aiClient = null,
  modelOverride = null,
} = {}) {
  if (!product || typeof product !== 'object') {
    throw new Error('chat-v3 failed: product is required');
  }
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('chat-v3 failed: message is required');
  }

  const startedAt = Date.now();

  // Phase F.1b.3 — best-effort scope-config (additive, byte-identical default).
  // callerOverrides preserve the current hardcoded knobs so a missing scope or
  // Firestore failure still produces the legacy generationConfig.
  const _legacyTemperature = DEFAULT_CHAT_TEMPERATURE;
  const _legacyMaxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
  const _legacyThinking = defaultThinkingConfig({ level: 'high', includeThoughts: true });
  const scopeConfig = await _tryResolveScopeConfig('chat.product', tenantId, {
    temperature: _legacyTemperature,
    maxOutputTokens: _legacyMaxOutputTokens,
    thinkingConfig: _legacyThinking,
  });
  const _scopeGenCfg =
    scopeConfig && scopeConfig.generationConfig && typeof scopeConfig.generationConfig === 'object'
      ? scopeConfig.generationConfig
      : {};
  const _scopeModel =
    scopeConfig && typeof scopeConfig.model === 'string' && scopeConfig.model.trim()
      ? scopeConfig.model.trim()
      : null;

  const model = modelOverride || _scopeModel || resolveChatModel();
  const trace = {
    iterations: 0,
    toolCalls: [],
    thoughts: [],
    groundingChunks: [],
    urls: [],
    sawWriteCall: false,
    sawImageSearch: false,
    sawNonImageTool: false,
    forcedFinalizations: 0,
    ultimateFallbackTriggered: false,
    ultimateFallbackError: null,
  };

  const state = {
    product,          // für suggest_product_images (echte Bildsuche)
    datasheetChanges: [],
    imageSuggestions: [],
    sourceResults: [],
    evidenceRows: [], // for cross-reference
    citations: [],    // evidence block in return shape
  };

  let ai;
  try {
    ai = await resolveAiClient(aiClient);
  } catch (err) {
    throw new Error(`chat-v3 failed: unable to init Gemini client: ${err?.message || err}`);
  }

  const systemPrompt = buildSystemPromptV3(product);
  const functionDeclarations = [
    ...atomicTools.buildToolList({ includeAmazon: true, includeManufacturer: true }),
    UPDATE_DATASHEET_DECLARATION,
    SUGGEST_IMAGES_DECLARATION,
  ];
  const tools = [
    { googleSearch: {} },
    { urlContext: {} },
    { functionDeclarations },
  ];
  // Write-only toolset for FORCED finalization turns. Gemini rejects
  // functionCallingConfig.allowedFunctionNames when a native tool
  // (googleSearch/urlContext) is present in the SAME request:
  // "allowed_function_names should be a subset of the provided function_declarations".
  // The forced turn only needs to WRITE (research already happened), so we drop
  // the native grounding tools and pass only the function declarations.
  const writeOnlyTools = [{ functionDeclarations }];

  // NOTE: mediaResolution intentionally omitted — v1beta API rejects it with
  // 'Invalid value at generation_config.media_resolution' even for documented
  // enum values like 'HIGH'. Per-Part mediaResolution on Content.Part can be
  // re-introduced later once Gemini 3 Pro GA lands.
  // Merge order: hardcoded defaults < scopeConfig.generationConfig.
  // Tool-Config / functionCallingConfig is NOT migrated (per F.1b.3 scope).
  const config = {
    temperature: _legacyTemperature,
    maxOutputTokens: _legacyMaxOutputTokens,
    thinkingConfig: _legacyThinking,
    ..._scopeGenCfg,
    safetySettings: defaultSafetySettings(),
    tools,
    toolConfig: {
      functionCallingConfig: { mode: 'AUTO' },
      includeServerSideToolInvocations: true,
    },
    systemInstruction: systemPrompt,
  };

  let chat;
  try {
    chat = ai.chats.create({ model, config, history: Array.isArray(history) ? history : [] });
  } catch (err) {
    throw new Error(`chat-v3 failed: chats.create error: ${err?.message || err}`);
  }

  const executorMap = atomicTools.buildToolExecutorMap();

  // Eigene Produktbilder laden (fehlerrobust — wirft nie). Reihenfolge in der
  // User-Message: Text → Produktbilder → Attachments.
  let productImageParts = [];
  try {
    productImageParts = await fetchProductImageParts(product);
  } catch (imgErr) {
    console.warn('[chat-v3] product image fetch failed: %s', imgErr?.message || imgErr);
    productImageParts = [];
  }

  // Build the initial user message with product images + optional attachments.
  const userParts = [{ text: message }];
  for (const part of productImageParts) userParts.push(part);
  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      if (att && typeof att === 'object' && (att.inlineData || att.fileData || att.text)) {
        userParts.push(att);
      }
    }
  }
  // Wahrhaftiger Zähler der TATSÄCHLICH gesendeten Produktbild-Parts — der
  // GPSR-Guard vertraut Etikett-Daten nur, wenn hier > 0 steht (nicht anhand
  // von product.details.images, das könnte Bilder haben, die nie ankamen).
  const productImagesSent = productImageParts.length;

  try {
    if (typeof onProgress === 'function') {
      try { onProgress({ type: 'start', model, tenantId, userId }); } catch {}
    }

    let response = await withGeminiRetryV3(
      () => chat.sendMessage({ message: userParts }),
      { label: 'sendMessage-initial' }
    );

    emitThoughts(response, trace, onProgress);
    collectGrounding(response, trace, onProgress);

    let researchOnlyIters = 0;
    // Der laut System-Prompt geforderte "zuerst Text auf Deutsch"-Part kommt in
    // Zwischen-Turns NEBEN den functionCalls — der allerletzte Turn ist dagegen
    // oft nur Meta-Echo. Wir sichern hier die letzte echte Antwort.
    let lastContentAnswer = '';

    while (
      response &&
      Array.isArray(response.functionCalls) &&
      response.functionCalls.length > 0 &&
      trace.iterations < maxIterations
    ) {
      const callList = response.functionCalls;
      const turnText = collectAnswerText(response);
      if (turnText && !isMetaEchoAnswer(turnText)) lastContentAnswer = turnText;
      const hasWriteCall = callList.some((c) => c && c.name === WRITE_TOOL);
      // Turn-Tool-Provenienz mitschreiben: Bildsuche vs. datenblatt-relevantes Tool.
      // Nötig, um "reine Bild-Turns" zu erkennen und NICHT in einen Write zu zwingen.
      for (const c of callList) {
        const nm = c && c.name;
        if (nm === IMAGE_TOOL) trace.sawImageSearch = true;
        else if (nm && nm !== WRITE_TOOL) trace.sawNonImageTool = true;
      }
      if (hasWriteCall) {
        trace.sawWriteCall = true;
        researchOnlyIters = 0;
      } else {
        researchOnlyIters += 1;
      }

      // Dispatch function calls in parallel — atomic-tools executors are
      // guaranteed to never throw and always bounded by EXECUTOR_TIMEOUT_MS.
      // eslint-disable-next-line no-loop-func
      const toolResponses = await Promise.all(
        callList.map(async (call) => {
          const callName = call?.name || 'unknown';
          const callId = call?.id || null;
          const callArgs = call?.args || {};
          const startedMs = Date.now();

          if (typeof onProgress === 'function') {
            try { onProgress({ type: 'tool_start', name: callName, args: callArgs }); } catch {}
          }

          let result;
          try {
            const own = await ownExecutor(callName, callArgs, state);
            if (own) {
              result = own;
            } else if (typeof executorMap[callName] === 'function') {
              result = await executorMap[callName](callArgs, { product, tenantId, userId });
            } else {
              result = {
                ok: false,
                source: callName,
                data: null,
                confidence: 0,
                meta: { durationMs: Date.now() - startedMs },
                error: { code: 'UNKNOWN_TOOL', message: `No executor for ${callName}` },
              };
            }
          } catch (err) {
            result = {
              ok: false,
              source: callName,
              data: null,
              confidence: 0,
              meta: { durationMs: Date.now() - startedMs },
              error: { code: 'EXECUTOR_THREW', message: err?.message || String(err) },
            };
          }

          trace.toolCalls.push({
            id: callId,
            name: callName,
            ok: Boolean(result?.ok),
            latencyMs: result?.meta?.durationMs ?? (Date.now() - startedMs),
            error: result?.error?.message || null,
          });

          if (result?.ok && result.source) {
            state.sourceResults.push(result);
            const ev = extractEvidenceFromToolResult(result);
            for (const row of ev.rows) state.evidenceRows.push(row);
            for (const c of ev.citations) state.citations.push(c);
          }

          if (typeof onProgress === 'function') {
            try { onProgress({ type: 'tool_done', name: callName, ok: Boolean(result?.ok) }); } catch {}
          }

          // Gemini 3 mandate: preserve call.id on every functionResponse so the
          // model can correlate tool results with its originating calls.
          return {
            functionResponse: {
              id: callId || undefined,
              name: callName,
              response: result,
            },
          };
        })
      );

      trace.iterations += 1;

      // Decide config for the NEXT sendMessage. If we're about to run out of
      // iterations OR the model has been doing research-only turns for too
      // long, force it to emit the datasheet write-call via mode=ANY +
      // allowedFunctionNames. This is the official escape-hatch documented at
      // ai.google.dev/gemini-api/docs/function-calling.
      const atLastIter = trace.iterations >= maxIterations;
      const softForce = !trace.sawWriteCall && researchOnlyIters >= SOFT_RESEARCH_LIMIT;
      // Reine Bild-Turns NIE in einen Datenblatt-Write zwingen (siehe
      // computeImageOnlyTurn) — sonst entsteht eine sinnlose Übernehmen-Karte.
      const forceFinalize = (atLastIter || softForce) && !computeImageOnlyTurn(trace);
      if (forceFinalize) trace.forcedFinalizations += 1;

      const sendConfig = forceFinalize
        ? {
            tools: writeOnlyTools,
            toolConfig: {
              functionCallingConfig: {
                mode: FunctionCallingConfigMode.ANY,
                allowedFunctionNames: [WRITE_TOOL],
              },
            },
          }
        : undefined;

      // Feed tool responses back into the chat.
      // IMPORTANT: `message` must be PartListUnion (string | Part | Part[]) per
      // @google/genai SendMessageParameters. Passing a Content-shaped
      // { role, parts } object causes the SDK to mis-serialize tool responses
      // and the model never sees them — leading to "model answers in text
      // without update_product_datasheet" (the exact P0 incident on 2026-04-22).
      // Beim erzwungenen Write-Turn explizit VOLLSTÄNDIGE Inhalte verlangen —
      // ohne diese Anweisung lieferte der forced Write oft nur einen mageren
      // 2-Satz-Recap (Incident 2026-07-16, dünne Beschreibungen).
      const forcedParts = forceFinalize
        ? [{
            text:
              'Rufe jetzt update_product_datasheet mit VOLLSTÄNDIGEN Inhalten auf: ' +
              'ausführliche short_description als Fließtext (mindestens 4-6 Sätze mit den recherchierten Details), ' +
              'alle key_features und alle Attribute. KEINE Kurzfassung.',
          }]
        : [];
      // eslint-disable-next-line no-await-in-loop
      response = await withGeminiRetryV3(
        () =>
          sendConfig
            ? chat.sendMessage({ message: [...toolResponses, ...forcedParts], config: sendConfig })
            : chat.sendMessage({ message: toolResponses }),
        { label: `sendMessage-iter-${trace.iterations}` }
      );

      emitThoughts(response, trace, onProgress);
      collectGrounding(response, trace, onProgress);

      // If the forced iteration itself came back WITH function calls that
      // include the write-tool, execute them on the next loop tick. If the
      // response has no functionCalls at all, the while-predicate exits
      // naturally and the ultimate-fallback block below runs as needed.
    }

    // Ultimate fallback — if the loop exited without ever producing a
    // write-call (e.g. Gemini ended in plain text despite mode=ANY), send one
    // explicit finalization message. Without this, state.datasheetChanges
    // stays empty and the UI shows no "Übernehmen" button.
    //
    // Guard: only trigger when Gemini actually entered the research phase
    // (iterations > 0). If the model replies directly to an informational
    // question without calling any tools (e.g. "Alles okay — keine Änderungen
    // nötig"), respect that direct answer instead of forcing a write-call.
    // WICHTIG (Incident 2026-07-16): NICHT auf !sawWriteCall gaten — ein
    // Write-Call, dessen Argumente die Bereinigung komplett verwarf
    // (changes=0 bei sawWrite=true), braucht den Zwangs-Retry genauso.
    if (state.datasheetChanges.length === 0 && trace.iterations > 0 && !computeImageOnlyTurn(trace)) {
      console.warn(
        '[chat-v3] No %s call after loop — triggering ultimate fallback',
        WRITE_TOOL
      );
      try {
        const fallbackResponse = await withGeminiRetryV3(
          () =>
            chat.sendMessage({
              message:
                'Bitte rufe JETZT update_product_datasheet mit den konkreten Änderungsvorschlägen auf — mit VOLLSTÄNDIGEN Inhalten: ausführliche short_description als Fließtext (mindestens 4-6 Sätze mit den recherchierten Details), alle key_features, alle Attribute. KEINE Kurzfassung, keine 2-Satz-Beschreibung.',
              config: {
                tools: writeOnlyTools,
                toolConfig: {
                  functionCallingConfig: {
                    mode: FunctionCallingConfigMode.ANY,
                    allowedFunctionNames: [WRITE_TOOL],
                  },
                },
              },
            }),
          { label: 'sendMessage-ultimate-fallback' }
        );
        emitThoughts(fallbackResponse, trace, onProgress);
        collectGrounding(fallbackResponse, trace, onProgress);

        const fallbackCalls = Array.isArray(fallbackResponse?.functionCalls)
          ? fallbackResponse.functionCalls
          : [];
        for (const call of fallbackCalls) {
          if (!call || call.name !== WRITE_TOOL) continue;
          const callArgs = call.args || {};
          const callId = call.id || null;
          let result;
          try {
            result = await ownExecutor(WRITE_TOOL, callArgs, state);
          } catch (err) {
            result = {
              ok: false,
              source: WRITE_TOOL,
              data: null,
              confidence: 0,
              meta: { durationMs: 0 },
              error: { code: 'EXECUTOR_THREW', message: err?.message || String(err) },
            };
          }
          trace.toolCalls.push({
            id: callId,
            name: WRITE_TOOL,
            ok: Boolean(result?.ok),
            latencyMs: result?.meta?.durationMs ?? 0,
            error: result?.error?.message || null,
            fallback: true,
          });
          // Echo the functionResponse back so chat history stays consistent
          // for any subsequent turns. `message` must be a Part array, not a
          // Content object (see note at the loop sendMessage above).
          try {
            // eslint-disable-next-line no-await-in-loop
            const echoResponse = await chat.sendMessage({
              message: [
                {
                  functionResponse: {
                    id: callId || undefined,
                    name: WRITE_TOOL,
                    response: result,
                  },
                },
              ],
            });
            // Die Echo-Response enthält die eigentliche Abschluss-Antwort des
            // Modells NACH dem Write-Result — nur den Text übernehmen, nicht
            // `response` ersetzen (mode-AUTO-Echo kann selbst functionCalls haben).
            const echoText = collectAnswerText(echoResponse);
            if (echoText && !isMetaEchoAnswer(echoText)) lastContentAnswer = echoText;
          } catch (echoErr) {
            console.warn('[chat-v3] fallback echo send failed: %s', echoErr?.message || echoErr);
          }
          trace.sawWriteCall = true;
        }
        response = fallbackResponse;
        trace.ultimateFallbackTriggered = true;
      } catch (fallbackErr) {
        console.error(
          '[chat-v3] Ultimate fallback also failed: %s',
          fallbackErr?.message || fallbackErr
        );
        trace.ultimateFallbackError = fallbackErr?.message || String(fallbackErr);
      }
    }

    // ---- post-processing -----------------------------------------------------

    // Überlappende Karten aus mehreren Write-Calls zu EINER konsolidieren,
    // BEVOR draft/crossRef/Kategorie-Resolve darauf arbeiten.
    state.datasheetChanges = consolidateDatasheetChangesV3(state.datasheetChanges);
    enforceSeoPoliciesV3(state.datasheetChanges, product);

    // Build draft from aggregated datasheetChanges (last-wins per key).
    const draft = {};
    for (const change of state.datasheetChanges) {
      if (change.title) draft.title = change.title;
      if (change.identity) {
        if (change.identity.brand) draft.brand = change.identity.brand;
        if (change.identity.category) draft.category = change.identity.category;
        if (change.identity.gtin) draft.gtin = change.identity.gtin;
        if (change.identity.ean) draft.ean = change.identity.ean;
        if (change.identity.mpn) draft.mpn = change.identity.mpn;
      }
      if (change.pricing?.amount != null) draft.price = change.pricing.amount;
      if (change.gpsr) draft.gpsr = change.gpsr;
    }

    let crossRef = { resolved: draft, conflicts: [], confidence: {} };
    try {
      crossRef = crossReferenceProduct(draft, state.evidenceRows);
    } catch (err) {
      console.warn(`[chat-v3] crossReferenceProduct failed: ${err.message}`);
    }

    let aggregate = { score: 0, readyForPublish: false, fieldsConsidered: [], missingCritical: [] };
    try {
      aggregate = aggregateProductConfidence(crossRef.confidence || {});
    } catch (err) {
      console.warn(`[chat-v3] aggregateProductConfidence failed: ${err.message}`);
    }

    if (!aggregate.readyForPublish && typeof onProgress === 'function') {
      try {
        onProgress({
          type: 'needs_human',
          reason: 'missing_critical',
          missing: aggregate.missingCritical,
          suggestions: state.datasheetChanges.map((c) => c.summary).filter(Boolean).slice(0, 3),
        });
      } catch {}
    }

    let finalAnswer = collectAnswerText(response);
    if (isMetaEchoAnswer(finalAnswer)) {
      // Meta-Echo/leer als finale Antwort (Incident 2026-07-16): stattdessen die
      // letzte echte Turn-Antwort bzw. eine Zusammenfassung der Änderungen liefern.
      const recovered = lastContentAnswer || synthesizeAnswerFromChanges(state.datasheetChanges);
      if (recovered) {
        console.warn(
          '[chat-v3] meta/empty final answer suppressed — recovered=%s changes=%d',
          lastContentAnswer ? 'turn-text' : 'summaries',
          state.datasheetChanges.length
        );
        finalAnswer = recovered;
      } else if (!finalAnswer || !finalAnswer.trim()) {
        finalAnswer = 'Ich habe keine belastbaren neuen Informationen gefunden. Bitte prüfe das Produkt manuell.';
      }
      // Meta-Match ohne Recovery-Quelle und nicht-leer → Original behalten (konservativ).
    }

    if (typeof onProgress === 'function') {
      try {
        onProgress({
          type: 'complete',
          durationMs: Date.now() - startedAt,
          iterations: trace.iterations,
          changes: state.datasheetChanges.length,
        });
      } catch {}
    }

    console.log(
      '[chat-v3] done model=%s iters=%d changes=%d sawWrite=%s forcedFinalizations=%d ultimateFallback=%s durationMs=%d',
      model,
      trace.iterations,
      state.datasheetChanges.length,
      trace.sawWriteCall,
      trace.forcedFinalizations,
      trace.ultimateFallbackTriggered,
      Date.now() - startedAt
    );

    // Resolve any assistant-proposed category to a REAL eBay categoryId before
    // the change reaches the client (parity with chat-v2). V3 never resolves the
    // category itself, so without this the proposed "Kategorie-Korrektur" never
    // reaches details.categoryId on apply. See
    // services/category-resolver.js#resolveProposedCategoryForChanges.
    try {
      const { resolveProposedCategoryForChanges } = require('./category-resolver');
      await resolveProposedCategoryForChanges(state.datasheetChanges, product, { reason: 'chat_v3' });
    } catch (catErr) {
      console.warn(`[chat-v3] category resolution skipped: ${catErr?.message || catErr}`);
    }

    return {
      message: finalAnswer || '',
      datasheetChanges: state.datasheetChanges,
      imageSuggestions: state.imageSuggestions,
      productImagesSent,
      evidence: state.citations,
      confidence: {
        overall: aggregate.score,
        readyForPublish: aggregate.readyForPublish,
        fieldScores: crossRef.confidence || {},
        conflicts: crossRef.conflicts || [],
        missingCritical: aggregate.missingCritical,
      },
      trace: {
        iterations: trace.iterations,
        toolCalls: trace.toolCalls,
        thoughts: trace.thoughts,
        groundingChunks: trace.groundingChunks,
        urls: trace.urls,
      },
      model,
      iterations: trace.iterations,
      _pipeline: 'v3-context-circulation',
    };
  } catch (err) {
    if (err && typeof err.message === 'string' && err.message.startsWith('chat-v3 failed')) {
      throw err;
    }
    const wrapped = new Error(`chat-v3 failed: ${err?.message || String(err)}`);
    wrapped.cause = err;
    wrapped.status = err?.status ?? err?.code ?? null;
    throw wrapped;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  runProductChatV3,
  chatV3Enabled,
  UPDATE_DATASHEET_DECLARATION,
  SUGGEST_IMAGES_DECLARATION,
  _testables: {
    buildSystemPromptV3,
    buildSeoRulesBlock,
    enforceSeoPoliciesV3,
    sanitizeDatasheetChangeV3,
    ownExecutor,
    emitThoughts,
    collectGrounding,
    collectAnswerText,
    isMetaEchoAnswer,
    synthesizeAnswerFromChanges,
    summarizeChangeForCard,
    consolidateDatasheetChangesV3,
    computeImageOnlyTurn,
    fetchProductImageParts,
    extractEvidenceFromToolResult,
    mapToolSourceWeight,
    summarizeProduct,
    DEFAULT_MAX_ITERATIONS,
  },
};
