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
const { normalizeDigits, isValidGtin } = require('../lib/gtin');
const { coerceTitleToPolicy } = require('../lib/title-policy');
const { buildCommonPolicyText } = require('../lib/llm-policy-pack');
const { getActiveLlmConfig } = require('../lib/llm-config');
const { sanitizeListingText, sanitizeDescriptionToHtml, sanitizeHighlights } = require('../lib/listing-sanitize');
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

const MAX_CHAT_ITERATIONS = 8;
const MAX_PRODUCT_IMAGE_PARTS = 4;
const PRODUCT_IMAGE_TIMEOUT_MS = parseInt(process.env.CHAT_IMAGE_TIMEOUT_MS || '8000', 10);

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
  description: 'Suggest web-found product image URLs.',
  parameters: {
    type: 'OBJECT',
    properties: {
      rationale: { type: 'STRING' },
      images: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            url: { type: 'STRING' },
            source: { type: 'STRING' },
            variant: { type: 'STRING' },
            notes: { type: 'STRING' },
          },
          required: ['url'],
        },
      },
    },
    required: ['images'],
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
- Wenn der User "mehr Details", "ausführlich", "voller Report" sagt: antworte ausführlich.
- Du kannst auch einfache Fragen beantworten, Tipps geben, Analysen machen — du bist kein reiner Dateneditor.

TOOLS:
- Google Search: Steht dir automatisch zur Verfügung. Nutze es für Datenblätter, Preise, GPSR, Spezifikationen, Bilder.
- update_product_datasheet: PFLICHT wenn du Produktdaten ändern willst. IMMER aufrufen — beschreibe Änderungen NIE nur im Text ohne Tool-Call. IMMER mit Begründung (summary). Ohne Tool-Call werden Änderungen NICHT gespeichert.
- suggest_product_images: Nutze es für Web-Produktbilder.
- generate_ai_images: NUR wenn der User explizit KI-Bilder will.

KRITISCH: Wenn du Verbesserungen vorschlägst, MUSST du update_product_datasheet aufrufen. Text allein reicht nicht — der User kann nur Tool-Ergebnisse über "Übernehmen" anwenden. Ohne Tool-Call = keine Übernahme möglich.

QUALITÄT:
- Titel: 70–80 Zeichen, suchmaschinenoptimiert. Marke + Produkttyp + Kernmerkmal zuerst. Keine Marketing-Floskeln, keine EAN/GTIN/SKU.
- Beschreibung: HTML (<p>, <ul>, <li>, <strong>), 180–240 Wörter, faktenbasiert.
- Highlights: 5–7 Bulletpoints, je 70–120 Zeichen, "[Nutzen] - [Eigenschaft]".
- Attribute: Nur belegbare Fakten. Deutsche Schlüssel. ≤60 Zeichen pro Wert. Nur Schlüssel aus ebay.allowed_aspects verwenden.
- GPSR: Unter gpsr-Objekt, NIE als Attribute.
- Preis: Aktueller Marktpreis in EUR wenn findbar.
- Encoding: Echte Umlaute (ä, ö, ü, ß), kein HTML-Encoding.
- Titel-Konsistenz: Nie widersprüchliche Token mischen (z.B. Damen+Herren, verschiedene Marken).

SCOPE-REGEL: Wenn ein SCOPE angegeben ist, ändere NUR Felder innerhalb dieses Scopes.

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
    identity: {
      id: product?.id || null,
      title: product?.identification?.name || null,
      brand: product?.identification?.brand || null,
      category: product?.identification?.category || null,
      categoryId: categoryIdRaw,
      sku: product?.identification?.sku || product?.details?.identifiers?.sku || null,
      barcodes: Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : [],
    },
    ebay: {
      categoryId: categoryIdRaw,
      allowed_aspects: aspectCatalog && Array.isArray(aspectCatalog.allAspects) ? aspectCatalog.allAspects : [],
      required_aspects_meta: {
        missing_required_aspects: Array.isArray(requiredMeta?.missingAspects) ? requiredMeta.missingAspects : [],
        provided_required_aspects: Array.isArray(requiredMeta?.providedRequiredAspects) ? requiredMeta.providedRequiredAspects : [],
      },
      vehicle_fitment_mode: vehicleFitmentMode,
      title_insights: {
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
    // Apply proposed identity changes (category, brand)
    if (entry.identity) {
      preview.identification = preview.identification || {};
      if (entry.identity.category) preview.identification.category = safeString(entry.identity.category);
      if (entry.identity.brand) preview.identification.brand = safeString(entry.identity.brand);
    }
    // Apply proposed attribute changes (Farbe, Größe, Material, etc.)
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
    const coerced = coerceTitleToPolicy(preview, titleCandidate, {
      minLen: 30,
      maxLen: 80,
      softMaxLen: 80,
      extraHintTokens: titleHintTokens,
    });
    change.title = coerced || titleCandidate.slice(0, 80);
  }

  // Identity
  if (entry.identity && typeof entry.identity === 'object') {
    const id = {};
    if (change.title) id.name = change.title;
    if (entry.identity.brand) id.brand = safeString(entry.identity.brand);
    if (entry.identity.category) id.category = safeString(entry.identity.category);
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

    if (Object.keys(id).length) change.identity = id;
  }

  // Description
  if (typeof entry.short_description === 'string' && entry.short_description.trim()) {
    change.short_description = sanitizeDescriptionToHtml(entry.short_description);
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
} = {}) {
  const ai = await getGenAIClient();
  const modelName = resolveModel(modelOverride, 'CHAT_MODEL', 'gemini-3-pro-preview');
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

  // Build Gemini tools: Google Search Grounding + Function Declarations
  const tools = [
    { googleSearch: {} },
    {
      functionDeclarations: [
        UPDATE_DATASHEET_DECLARATION,
        SUGGEST_IMAGES_DECLARATION,
        GENERATE_AI_IMAGES_DECLARATION,
      ],
    },
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
  const chat = ai.chats.create({
    model: modelName,
    config: {
      tools,
      toolConfig: {
        includeServerSideToolInvocations: true,
      },
      systemInstruction: systemPromptText,
      temperature: 0.3,
      maxOutputTokens: 4096,
    },
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
  const existingImageKeys = new Set(
    (product?.details?.images || [])
      .map((img) => normalizeImageKey(img?.url_or_base64 || img?.url))
      .filter(Boolean)
  );

  try {
    onProgress?.({ type: 'start', text: 'Starte Analyse…' });

    // Diagnostic: log chat setup before first API call
    console.log(`[chat-v2] model=${modelName}, historyLen=${chatHistory.length}, toolsCount=${tools.length}, productImages=${productImageParts.length}, userAttachments=${attachmentPayload.imageParts.length}, scopeLen=${(messageText || '').length}`);

    // Send initial message
    let response;
    try {
      response = await chat.sendMessage({ message: messageText });
    } catch (sendError) {
      console.error(`[chat-v2] sendMessage FAILED:`, sendError?.message || sendError);
      console.error(`[chat-v2] sendMessage status:`, sendError?.status, 'code:', sendError?.code);
      if (sendError?.response) {
        try { console.error(`[chat-v2] API response body:`, JSON.stringify(sendError.response).slice(0, 1000)); } catch {}
      }
      throw sendError;
    }
    let responseText = response.text || '';
    let functionCalls = response.functionCalls;

    console.log(`[chat-v2] initial response: textLen=${responseText.length}, functionCalls=${functionCalls?.length || 0}, candidates=${response?.candidates?.length || 0}`);

    // Extract grounding metadata from response
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
          onProgress?.({ type: 'tool_start', tool: 'suggest_product_images' });
          const chatImages = sanitizeImageSuggestions(args).filter((img) => {
            const key = normalizeImageKey(img.url_or_base64);
            if (!key || existingImageKeys.has(key)) return false;
            existingImageKeys.add(key);
            return true;
          });
          imageSuggestions.push({ rationale: args?.rationale, images: chatImages });
          toolResult = { acknowledged: true, count: chatImages.length };
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

      // Send function responses back to model — SDK requires Content object with role
      response = await chat.sendMessage({
        message: {
          role: 'user',
          parts: functionResponseParts,
        },
      });
      responseText = response.text || '';
      functionCalls = response.functionCalls;

      // Extract grounding from follow-up response
      extractGroundingMetadata(response, groundingTrace);
    }

    // Build final result
    const consolidatedChange = consolidateChanges(datasheetChanges);
    const finalDatasheetChanges = consolidatedChange ? [consolidatedChange] : [];

    console.log(`[chat-v2] done: iterations=${iterations}, datasheetChanges=${datasheetChanges.length}, consolidated=${finalDatasheetChanges.length}, images=${imageSuggestions.length}, textLen=${responseText.length}`);
    if (!finalDatasheetChanges.length && responseText.length > 200) {
      console.warn('[chat-v2] WARNING: Long response text but NO datasheet changes — Gemini may have skipped update_product_datasheet tool call');
    }

    // eBay readiness check
    const ebayReadiness = evaluateReadiness(product, finalDatasheetChanges);

    onProgress?.({ type: 'tool_done', tool: 'chat_complete' });

    return {
      message: responseText || 'Antwort generiert.',
      datasheetChanges: finalDatasheetChanges,
      imageSuggestions,
      serpTrace: groundingTrace,
      ebayReadiness,
      modelUsed: modelName,
      intent: finalDatasheetChanges.length ? 'change' : 'info',
      _pipeline: 'v2-grounding',
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
  } catch {
    // Non-critical
  }
}

module.exports = {
  runProductChatV2,
};
