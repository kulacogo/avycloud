'use strict';

/**
 * Kaufland-Manufacturer-Whitelist Validator
 * ─────────────────────────────────────────
 *
 * Kaufland's product-data validator declines `manufacturer` attribute values
 * that are not in their internal Hersteller-Whitelist (attribute id=21):
 *
 *     "DECLINED, not_manufacturer_name, invalid_value"
 *
 * Observed in production (May 2026):
 *   - "namuk"          → 0 hits   → not registered, push fails
 *   - "BRAX"           → 16 hits, exact label is "Brax"   (case mismatch)
 *   - "Adidas"         → 67 hits, exact label is "adidas" (case mismatch)
 *   - "Tommy Hilfiger" → 7  hits, exact label matches
 *
 * Pre-push validator that:
 *   1. Looks up the brand in Kaufland's whitelist via
 *      `GET /attributes/{id_attribute}/shared-set?q=…`
 *   2. Returns the EXACT label Kaufland expects (preserving casing).
 *   3. Caches results in Firestore `kaufland_manufacturer_cache` for 30d.
 *   4. Fails safe: any lookup error → returns `{source:'error', found:false}`
 *      so a single Whitelist-API outage cannot block a marketplace push.
 *
 * Production-safety contract:
 *   - Whitelist-API failure is **never** propagated to the caller.
 *   - Cache TTL 30d (whitelist is near-static).
 *   - One log-line per brand per UTC-day on "not in whitelist" misses, so
 *     production logs don't drown in repetitive warnings.
 *   - Module-state caches the manufacturer attribute-id (`21`) after first
 *     successful resolve; fallback to hard-coded `21` if `/attributes` fails.
 */

const { kauflandRequest } = require('./kaufland-api');
const { firestore } = require('./firestore');
const { FieldValue, Timestamp } = require('@google-cloud/firestore');

// ─── Configuration ────────────────────────────────────────────────────────

const COLLECTION_NAME = 'kaufland_manufacturer_cache';
const CACHE_TTL_DAYS = 30;
const CACHE_TTL_MS = CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
const FALLBACK_MANUFACTURER_ATTRIBUTE_ID = 21;
const SHARED_SET_LIMIT = 20;
const MAX_SUGGESTIONS_STORED = 5;

// Process-local memoisation
let cachedManufacturerAttributeId = null;
let attributeIdLookupPromise = null;

// Per-process miss-log-throttle so we don't spam logs on every push call.
// Map<brandLc, utcDayString>
const missLogThrottle = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────

function safeString(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeBrandForCacheKey(brand) {
  return safeString(brand)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function utcDayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function maybeLogMissOncePerDay(brand, total) {
  const key = String(brand || '').toLowerCase();
  if (!key) return;
  const today = utcDayKey();
  const last = missLogThrottle.get(key);
  if (last === today) return;
  missLogThrottle.set(key, today);
  console.warn(
    `[kaufland-manufacturer-whitelist] Brand "${brand}" not in Kaufland whitelist (hits=${total}). ` +
      'Register via Kaufland Kontaktformular oder Hersteller-Anfrage.'
  );
}

function cacheDocRef(brandSlug) {
  return firestore.collection(COLLECTION_NAME).doc(brandSlug);
}

function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isCacheFresh(cacheDoc) {
  const ms = toMillis(cacheDoc?.lookedUpAt);
  if (!ms) return false;
  return Date.now() - ms < CACHE_TTL_MS;
}

function sanitizeSuggestion(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const label = safeString(entry.label || entry.name);
  const value = safeString(entry.value || entry.id);
  if (!label && !value) return null;
  return { label, value };
}

function sanitizeSuggestionList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    const cleaned = sanitizeSuggestion(entry);
    if (cleaned) out.push(cleaned);
    if (out.length >= MAX_SUGGESTIONS_STORED) break;
  }
  return out;
}

function findExactMatch(label, suggestions) {
  const needle = String(label || '').toLowerCase();
  if (!needle || !Array.isArray(suggestions)) return null;
  for (const entry of suggestions) {
    if (!entry || typeof entry !== 'object') continue;
    const candidateLabel = safeString(entry.label);
    if (!candidateLabel) continue;
    if (candidateLabel.toLowerCase() === needle) return candidateLabel;
  }
  return null;
}

// ─── Attribute-ID Resolver ────────────────────────────────────────────────

/**
 * Resolves the manufacturer attribute id and caches it in module-state.
 * Falls back to the verified production value `21` if `/attributes` is
 * unreachable. Never throws — production-safety contract.
 *
 * @returns {Promise<number>}
 */
async function getManufacturerAttributeId() {
  if (cachedManufacturerAttributeId != null) return cachedManufacturerAttributeId;
  if (attributeIdLookupPromise) return attributeIdLookupPromise;

  attributeIdLookupPromise = (async () => {
    try {
      // Best-effort discovery; the storefront/locale shouldn't matter for the
      // attribute taxonomy itself but we mirror the standard locale.
      const res = await kauflandRequest('GET', '/attributes', {
        query: { storefront: 'de', locale: 'de-DE', limit: 200 },
      });
      const list = Array.isArray(res?.data?.data) ? res.data.data : [];
      for (const item of list) {
        const name = safeString(item?.name || item?.label).toLowerCase();
        if (name === 'manufacturer' || name === 'hersteller') {
          const id = Number(item?.id_attribute || item?.id);
          if (Number.isFinite(id) && id > 0) {
            cachedManufacturerAttributeId = id;
            return id;
          }
        }
      }
    } catch (err) {
      console.warn(
        `[kaufland-manufacturer-whitelist] getManufacturerAttributeId failed (${safeString(err?.message)}), ` +
          `falling back to id=${FALLBACK_MANUFACTURER_ATTRIBUTE_ID}.`
      );
    } finally {
      attributeIdLookupPromise = null;
    }
    cachedManufacturerAttributeId = FALLBACK_MANUFACTURER_ATTRIBUTE_ID;
    return FALLBACK_MANUFACTURER_ATTRIBUTE_ID;
  })();

  return attributeIdLookupPromise;
}

// ─── Cache Layer ──────────────────────────────────────────────────────────

async function readCache(brandSlug) {
  try {
    const snap = await cacheDocRef(brandSlug).get();
    if (!snap.exists) return null;
    return snap.data() || null;
  } catch (err) {
    console.warn(
      `[kaufland-manufacturer-whitelist] readCache(${brandSlug}) failed: ${safeString(err?.message)}`
    );
    return null;
  }
}

async function writeCache(brandSlug, payload) {
  try {
    await cacheDocRef(brandSlug).set(
      {
        ...payload,
        lookedUpAt: Timestamp.now(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (err) {
    console.warn(
      `[kaufland-manufacturer-whitelist] writeCache(${brandSlug}) failed: ${safeString(err?.message)}`
    );
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Search for `brand` in Kaufland's manufacturer whitelist.
 *
 * @param {string} brand
 * @param {object} [opts]
 * @param {string} [opts.storefront='de']
 * @param {string} [opts.locale='de-DE']
 * @param {boolean} [opts.bypassCache=false]
 * @returns {Promise<{
 *   found: boolean,
 *   label: string|null,
 *   exactMatch: boolean,
 *   total: number,
 *   suggestions: Array<{label: string, value: string}>,
 *   source: 'cache'|'api'|'error',
 *   cachedAt?: Date,
 * }>}
 */
/**
 * Generate Brand-Search-Varianten für Robustheit gegen Schreibweise-Unterschiede.
 * Beispiel: "Levi's" → ["Levi's", "Levis", "Levi"]
 *           "Levi Strauss & Co. BV" → ["Levi Strauss & Co. BV", "Levi Strauss & Co.", "Levi Strauss & Co", "Levi Strauss", "Levi"]
 * Erst-Treffer mit exact-match gewinnt.
 */
function generateBrandVariants(brand) {
  const variants = [];
  const seen = new Set();
  const add = (s) => {
    const v = safeString(s);
    if (!v) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    variants.push(v);
  };
  add(brand);
  // ohne Apostroph(e)
  add(brand.replace(/['']/g, ''));
  // ohne possessives 's
  add(brand.replace(/['']s\b/gi, ''));
  // Legal-Suffix-Stripping (iteratively)
  const LEGAL_SUFFIX_RX = /\s+(GmbH|AG|Inc\.?|Ltd\.?|LLC|S\.?p\.?A\.?|B\.?V\.?|S\.?A\.?S?|SE|S\.?r\.?l\.?|Limited|Co\.,?\s*Ltd|Co\.\s*KG|OHG|KG|UG|& Co\.?( KG)?)\b\.?/i;
  let stripped = brand;
  for (let i = 0; i < 5 && LEGAL_SUFFIX_RX.test(stripped); i += 1) {
    stripped = stripped.replace(LEGAL_SUFFIX_RX, '').trim().replace(/,\s*$/, '').trim();
    add(stripped);
  }
  return variants;
}

async function findManufacturerInWhitelist(brand, opts = {}) {
  const cleanedBrand = safeString(brand);
  const storefront = safeString(opts?.storefront) || 'de';
  const locale = safeString(opts?.locale) || 'de-DE';
  const bypassCache = !!opts?.bypassCache;

  if (!cleanedBrand) {
    return { found: false, label: null, exactMatch: false, total: 0, suggestions: [], source: 'api' };
  }

  const brandSlug = normalizeBrandForCacheKey(cleanedBrand);
  if (!brandSlug) {
    return { found: false, label: null, exactMatch: false, total: 0, suggestions: [], source: 'api' };
  }

  // ── 1. Cache lookup ─────────────────────────────────────────────────────
  if (!bypassCache) {
    const cached = await readCache(brandSlug);
    if (cached && isCacheFresh(cached)) {
      const cachedAtMs = toMillis(cached.lookedUpAt);
      return {
        found: !!cached.found,
        label: cached.label || null,
        exactMatch: !!cached.exactMatch,
        total: Number(cached.total) || 0,
        suggestions: Array.isArray(cached.suggestions) ? cached.suggestions : [],
        source: 'cache',
        cachedAt: cachedAtMs ? new Date(cachedAtMs) : undefined,
      };
    }
  }

  // ── 2. Live whitelist lookup — try variants until first exact match ─────
  // "Levi's" alleine matcht nicht (Whitelist hat "Levis" ohne Apostroph).
  // Daher generieren wir Varianten + nehmen den ersten exact-match.
  let attributeId = FALLBACK_MANUFACTURER_ATTRIBUTE_ID;
  try {
    attributeId = await getManufacturerAttributeId();
  } catch (_) { /* fallback already set */ }

  const variants = generateBrandVariants(cleanedBrand);
  let lastApiResult = null;
  let exactLabel = null;
  let usedVariant = cleanedBrand;
  for (const variant of variants) {
    try {
      const res = await kauflandRequest(
        'GET',
        `/attributes/${encodeURIComponent(String(attributeId))}/shared-set`,
        { query: { q: variant, storefront, locale, limit: SHARED_SET_LIMIT } }
      );
      const items = Array.isArray(res?.data?.data) ? res.data.data : [];
      lastApiResult = res?.data || null;
      const m = findExactMatch(variant, items);
      if (m) { exactLabel = m; usedVariant = variant; break; }
      // Auch gegen original-brand prüfen falls Variante was Brauchbares findet
      const m2 = findExactMatch(cleanedBrand, items);
      if (m2) { exactLabel = m2; usedVariant = variant; break; }
    } catch (err) {
      console.warn(
        `[kaufland-manufacturer-whitelist] findManufacturer "${variant}" lookup failed: ${safeString(err?.message)}`
      );
      // Continue with next variant
    }
  }

  if (!lastApiResult) {
    return {
      found: false, label: null, exactMatch: false, total: 0, suggestions: [], source: 'error',
    };
  }

  const rawSuggestions = Array.isArray(lastApiResult?.data) ? lastApiResult.data : [];
  const suggestions = sanitizeSuggestionList(rawSuggestions);
  const total = Number(lastApiResult?.pagination?.total ?? rawSuggestions.length) || 0;
  const exactMatch = !!exactLabel;
  const found = exactMatch;
  const label = exactLabel || null;

  const payload = {
    brand: cleanedBrand,
    brand_lc: cleanedBrand.toLowerCase(),
    found,
    label,
    exactMatch,
    total,
    suggestions,
    storefront,
    locale,
    attributeId,
  };

  // Fire-and-forget cache write; never blocks caller.
  writeCache(brandSlug, payload).catch(() => {});

  if (!exactMatch) {
    maybeLogMissOncePerDay(cleanedBrand, total);
  }

  return {
    found,
    label,
    exactMatch,
    total,
    suggestions,
    source: 'api',
  };
}

module.exports = {
  findManufacturerInWhitelist,
  getManufacturerAttributeId,
  // Exported for tests so they can reset module-state between cases.
  __resetForTests() {
    cachedManufacturerAttributeId = null;
    attributeIdLookupPromise = null;
    missLogThrottle.clear();
  },
};
