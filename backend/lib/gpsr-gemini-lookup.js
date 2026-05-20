'use strict';

/**
 * gpsr-gemini-lookup.js — Gemini-with-googleSearch GPSR lookup for orphan brands.
 *
 * Why this exists: products_v2 contains brands (z.B. GANT, Desigual, TOMMY JEANS,
 * Lululemon, FLENNOR, …) for which we have ZERO GPSR records anywhere in the
 * collection. The brand-lookup pre-tier in `services/kaufland-attribute-enricher.js`
 * therefore returns nothing, and the regex-based web-fallback (`lib/gpsr-web-fallback.js`)
 * frequently misses or scrapes the wrong Impressum. As a result those listings
 * stay invalid on Kaufland (missing `product_safety_contact`).
 *
 * This module asks Gemini-3-Flash with the built-in `googleSearch` tool to
 * locate the EU-responsible party / manufacturer for a brand. The response is
 * a strict JSON object matching `LOOKUP_SCHEMA` below. We then cache results
 * in Firestore collection `brand_gpsr_cache` keyed by a normalized brand id
 * (TTL 30 days) so we don't repeat the lookup for every product.
 *
 * Safety:
 *   - Per-call hard timeout (15s default, ENV `GPSR_GEMINI_TIMEOUT_MS`)
 *   - All errors swallowed → returns null on failure
 *   - Cache misses with confidence < 0.3 are NOT persisted (we'd rather have
 *     nothing than a wrong Impressum entry that gets copied to many products)
 *   - This module never writes to products_v2 — callers do that via saveProductV2()
 *   - Additive: no existing code paths are modified by simply requiring this file
 */

const { gemini3GenerateJSON } = require('./gemini3-client');
const logger = (() => {
  try { return require('./logger'); } catch { return { warn: () => {}, info: () => {} }; }
})();

const DEFAULT_TIMEOUT_MS = 15000;
const CACHE_COLLECTION = 'brand_gpsr_cache';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_CACHE_CONFIDENCE = 0.3;

// Lazy Firestore client — same pattern as gpsr-manufacturer-registry.js to avoid
// circular dependencies with lib/firestore.js
let _firestore = null;
function _getFirestore() {
  if (!_firestore) {
    const { Firestore } = require('@google-cloud/firestore');
    _firestore = new Firestore({
      projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud',
    });
  }
  return _firestore;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

/**
 * Build a stable Firestore doc-id from a brand name.
 *   "TOMMY JEANS" → "tommy-jeans"
 *   "Grana Home / EU"  → "grana-home-eu"
 */
function brandCacheKey(brand) {
  const raw = safeString(brand).toLowerCase();
  if (!raw) return '';
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// JSON-Schema (Gemini 3 SDK) for the structured response.
const LOOKUP_SCHEMA = {
  type: 'object',
  properties: {
    manufacturer_name: { type: 'string', description: 'Juristische Person, z.B. ACME GmbH / Inc. — null wenn nicht zugaenglich.' },
    manufacturer_address: { type: 'string', description: 'Strasse + Hausnummer — null wenn nicht zugaenglich.' },
    manufacturer_city: { type: 'string', description: 'Stadt — null wenn nicht zugaenglich.' },
    manufacturer_postalcode: { type: 'string', description: 'PLZ — null wenn nicht zugaenglich.' },
    country_code: { type: 'string', description: '2-Buchstaben ISO Country Code (DE/AT/FR/…). null wenn nicht zugaenglich.' },
    entity_country: { type: 'string', description: 'Vollstaendiger Laendername. null wenn nicht zugaenglich.' },
    email: { type: 'string', description: 'Support- oder Kontaktadresse — null wenn nicht zugaenglich.' },
    url: { type: 'string', description: 'Hauptwebsite oder Impressum-URL — null wenn nicht zugaenglich.' },
    confidence: { type: 'number', description: 'Wie sicher du bist (0..1).' },
  },
  required: ['confidence'],
};

function buildPrompt(brand) {
  const b = safeString(brand);
  return [
    `Finde die EU-verantwortliche Person/Hersteller fuer die Marke '${b}' nach EU-Produktsicherheitsverordnung (GPSR).`,
    'Suche im Web nach Impressum/Imprint der Marke.',
    'Bevorzuge EU-Entities — falls mehrere Moeglichkeiten bestehen, waehle die deutsche/oesterreichische/franzoesische/niederlaendische/italienische/spanische/belgische Niederlassung.',
    'Antworte AUSSCHLIESSLICH als reines JSON-Objekt mit den Feldern:',
    '- manufacturer_name (juristische Person/GmbH/Inc.)',
    '- manufacturer_address (Strasse + Hausnummer)',
    '- manufacturer_city',
    '- manufacturer_postalcode',
    '- country_code (DE/AT/FR etc., 2-Buchstaben ISO)',
    '- entity_country (vollstaendiger Laendername)',
    '- email (Support/Kontakt)',
    '- url (Hauptwebsite oder Impressum-URL)',
    '- confidence (0..1, wie sicher du bist)',
    'Wenn ein Feld unzugaenglich ist: jeweiliges Feld als null.',
    'KEIN Markdown, KEIN Erklaerungstext, NUR das JSON-Objekt.',
  ].join('\n');
}

/**
 * Validate + normalize the Gemini response into our canonical GPSR shape.
 * Returns null when the response is unusable.
 */
function normalizeResponse(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {
    manufacturer_name: safeString(raw.manufacturer_name) || null,
    manufacturer_address: safeString(raw.manufacturer_address) || null,
    manufacturer_city: safeString(raw.manufacturer_city) || null,
    manufacturer_postalcode: safeString(raw.manufacturer_postalcode) || null,
    country_code: safeString(raw.country_code) || null,
    entity_country: safeString(raw.entity_country) || null,
    email: safeString(raw.email) || null,
    url: safeString(raw.url) || null,
    confidence: Number.isFinite(raw.confidence) ? Math.max(0, Math.min(1, Number(raw.confidence))) : 0,
  };
  // Uppercase ISO 2-letter country codes
  if (out.country_code) {
    const cc = out.country_code.toUpperCase().replace(/[^A-Z]/g, '');
    out.country_code = cc.length === 2 ? cc : null;
  }
  // Reject 'null', 'n/a', 'unbekannt', etc. — Gemini occasionally returns the
  // literal string "null" instead of the JSON null.
  for (const k of Object.keys(out)) {
    if (k === 'confidence') continue;
    const v = out[k];
    if (typeof v === 'string') {
      const lower = v.toLowerCase().trim();
      if (lower === 'null' || lower === 'n/a' || lower === 'na' || lower === 'unbekannt' || lower === 'unknown' || lower === '-' || lower === '—') {
        out[k] = null;
      }
    }
  }
  // Require at least one address-or-name signal to be useful — pure email
  // matches without company name are too noisy for GPSR.
  const hasAnyUseful = out.manufacturer_name || out.manufacturer_address || out.email || out.url;
  if (!hasAnyUseful) return null;
  return out;
}

/**
 * Call Gemini with googleSearch grounding to find GPSR data for a brand.
 *
 * @param {string} brand
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=15000]
 * @returns {Promise<null|{
 *   manufacturer_name: string|null,
 *   manufacturer_address: string|null,
 *   manufacturer_city: string|null,
 *   manufacturer_postalcode: string|null,
 *   country_code: string|null,
 *   entity_country: string|null,
 *   email: string|null,
 *   url: string|null,
 *   confidence: number
 * }>}
 */
async function lookupGpsrViaGemini(brand, opts = {}) {
  const b = safeString(brand);
  if (!b) return null;

  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs
    : (parseInt(process.env.GPSR_GEMINI_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS);

  const model = opts.model
    || process.env.GPSR_GEMINI_MODEL
    || 'gemini-3-flash-preview';

  try {
    const parsed = await Promise.race([
      gemini3GenerateJSON({
        prompt: buildPrompt(b),
        schema: LOOKUP_SCHEMA,
        model,
        temperature: 0.2,
        maxOutputTokens: 1024,
        timeoutMs,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('gpsr-gemini timeout')), timeoutMs + 1000)),
    ]);

    const normalized = normalizeResponse(parsed);
    if (!normalized) return null;
    if (normalized.confidence < MIN_CACHE_CONFIDENCE) return null;
    return normalized;
  } catch (err) {
    try {
      logger.warn(
        { brand: b, error: err?.message || String(err) },
        '[gpsr-gemini-lookup] lookup failed'
      );
    } catch (_) { /* logger optional */ }
    return null;
  }
}

/**
 * Read the cached GPSR record for a brand if present AND fresh.
 * Returns null when the cache misses / is stale / cannot be read.
 */
async function readBrandGpsrCache(brand) {
  const key = brandCacheKey(brand);
  if (!key) return null;
  try {
    const db = _getFirestore();
    const snap = await db.collection(CACHE_COLLECTION).doc(key).get();
    if (!snap.exists) return null;
    const data = snap.data() || {};
    const ts = data.lookedUpAt;
    let tsMs = null;
    if (ts && typeof ts.toMillis === 'function') tsMs = ts.toMillis();
    else if (ts instanceof Date) tsMs = ts.getTime();
    else if (typeof ts === 'number') tsMs = ts;
    else if (ts && typeof ts.seconds === 'number') tsMs = ts.seconds * 1000;
    if (!tsMs) return null;
    if ((Date.now() - tsMs) > CACHE_TTL_MS) return null;
    if (!data.gpsr || typeof data.gpsr !== 'object') return null;
    return {
      gpsr: data.gpsr,
      source: data.source || 'gemini-googleSearch',
      confidence: Number.isFinite(data.confidence) ? data.confidence : 0,
      cached: true,
      lookedUpAtMs: tsMs,
    };
  } catch (err) {
    try {
      logger.warn(
        { brand, error: err?.message || String(err) },
        '[gpsr-gemini-lookup] cache read failed'
      );
    } catch (_) { /* */ }
    return null;
  }
}

/**
 * Persist a fresh lookup result. Never throws — swallows all errors.
 */
async function writeBrandGpsrCache(brand, normalized) {
  const key = brandCacheKey(brand);
  if (!key) return;
  if (!normalized || normalized.confidence < MIN_CACHE_CONFIDENCE) return;
  try {
    const db = _getFirestore();
    const { gpsr, confidence } = splitNormalized(normalized);
    await db.collection(CACHE_COLLECTION).doc(key).set({
      brand: safeString(brand),
      brand_lc: safeString(brand).toLowerCase(),
      gpsr,
      source: 'gemini-googleSearch',
      confidence,
      lookedUpAt: new Date(),
      fromBrandQuery: safeString(brand),
    });
  } catch (err) {
    try {
      logger.warn(
        { brand, error: err?.message || String(err) },
        '[gpsr-gemini-lookup] cache write failed'
      );
    } catch (_) { /* */ }
  }
}

/**
 * Split the Gemini normalized result into (gpsr-fields, confidence).
 * Keeps only non-null GPSR fields so the cached doc stays compact.
 */
function splitNormalized(normalized) {
  const { confidence, ...rest } = normalized || {};
  const gpsr = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v != null && v !== '') gpsr[k] = v;
  }
  return {
    gpsr,
    confidence: Number.isFinite(confidence) ? confidence : 0,
  };
}

/**
 * Get-or-fetch wrapper: check cache first (max 30d old), fall back to Gemini
 * and persist the result.
 *
 * @param {string} brand
 * @param {object} [opts]
 * @returns {Promise<null|{ gpsr: object, confidence: number, source: string, cached: boolean }>}
 */
async function getOrFetchBrandGpsr(brand, opts = {}) {
  const b = safeString(brand);
  if (!b) return null;

  // 1) Cache hit?
  if (opts.useCache !== false) {
    const cached = await readBrandGpsrCache(b);
    if (cached && cached.gpsr) {
      return {
        gpsr: cached.gpsr,
        confidence: cached.confidence,
        source: cached.source,
        cached: true,
      };
    }
  }

  // 2) Cache miss → Gemini
  const normalized = await lookupGpsrViaGemini(b, opts);
  if (!normalized) return null;

  const { gpsr, confidence } = splitNormalized(normalized);
  if (Object.keys(gpsr).length === 0) return null;

  await writeBrandGpsrCache(b, normalized);

  return {
    gpsr: { ...gpsr },
    confidence,
    source: 'gemini-googleSearch',
    cached: false,
  };
}

module.exports = {
  lookupGpsrViaGemini,
  getOrFetchBrandGpsr,
  readBrandGpsrCache,
  writeBrandGpsrCache,
  brandCacheKey,
  normalizeResponse,
  splitNormalized,
  // constants exposed for tests
  CACHE_COLLECTION,
  CACHE_TTL_MS,
  MIN_CACHE_CONFIDENCE,
  LOOKUP_SCHEMA,
};
