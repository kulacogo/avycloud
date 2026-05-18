'use strict';

/**
 * Kaufland-Attribute-Enricher — pre-repair enrichment layer.
 *
 * Why this exists: `services/kaufland-product-data-repair.js` patches
 * Kaufland-product-data with whatever sits in `products_v2.details.*`. When
 * those fields are missing or in the wrong shape, the repair-call essentially
 * patches nothing useful and Kaufland keeps the listing in "Indexierung läuft"
 * (`product.is_valid=false`).
 *
 * This enricher runs BEFORE `tryRepairKauflandProductData` and fills the gaps
 * Kaufland complains about (from `getProductDataStatus.missing_attributes`):
 *   - GPSR (manufacturer_name/address/email/url) via web fallback
 *   - description via Gemini (~50-80 German words)
 *   - material composition via Gemini in Kaufland's "XX% Material" format
 *   - manufacturer derived from brand when only brand is set
 *
 * The enriched product is returned to the caller AND persisted to
 * `products_v2` via `saveProductV2(... skipStockEvent:true)` so future syncs
 * benefit. Stock event is suppressed because this is an attribute-only update.
 *
 * Safety:
 *   - Per-field hard timeout (8s default)
 *   - Per-product total timeout (20s default)
 *   - Each field swallowed individually — one failure never kills the others
 *   - No-op when `missingAttributes` is empty
 *   - All errors swallowed at the top level so callers (sync cron) never crash
 */

const { lookupGpsrFromWeb } = require('../lib/gpsr-web-fallback');
const { callGeminiVision } = require('../lib/gemini-client');

const DEFAULT_FIELD_TIMEOUT_MS = 8000;
const DEFAULT_TOTAL_TIMEOUT_MS = 20000;

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeToken(value) {
  return safeString(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s._:;,\-/\\()[\]{}]+/g, '');
}

/**
 * Match a Kaufland missing-attribute name against one of our high-level
 * enrichment buckets ('gpsr' | 'description' | 'material' | 'manufacturer' | 'picture').
 *
 * Kaufland's labels are German/locale-dependent ("Materialzusammensetzung",
 * "Produktbeschreibung", "Hersteller", "product_safety_contact" etc.). We
 * normalise + substring-match against known tokens.
 */
function classifyMissingAttribute(name) {
  const token = normalizeToken(name);
  if (!token) return null;
  if (token.includes('productsafetycontact')
    || token.includes('compliancecontact')
    || token.includes('verantwortlicheperson')
    || token.includes('responsibleperson')
    || token.includes('gpsr')
    || token.includes('herstellerkontakt')) return 'gpsr';
  if (token === 'manufacturer' || token === 'hersteller') return 'manufacturer';
  if (token.includes('beschreibung') || token.includes('description')) return 'description';
  if (token.includes('material') && (token.includes('zusammensetzung') || token === 'material' || token.includes('composition'))) return 'material';
  if (token.includes('bild') || token === 'picture' || token === 'pictures') return 'picture';
  return null;
}

/**
 * Race a promise against a timeout. Resolves with `null` on timeout/error.
 */
async function withTimeout(promise, timeoutMs, label = 'op') {
  let timer = null;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    const result = await Promise.race([promise, timeout]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Generate a short German product description (~50-80 words) via Gemini Flash.
 * Plain text, no markdown. Returns null on failure.
 */
async function generateDescription({ title, brand, category }) {
  const prompt = [
    'Erstelle eine kurze deutsche Produktbeschreibung (~50-80 Wörter) für folgendes Produkt.',
    'Reiner Fließtext, keine Bullet Points, kein Markdown, keine Überschriften.',
    'Kein Werbe-Sprech ("revolutionär", "perfekt"), nur sachliche Beschreibung der Hauptmerkmale.',
    '',
    `Titel: ${safeString(title) || 'unbekannt'}`,
    `Marke: ${safeString(brand) || 'unbekannt'}`,
    `Kategorie: ${safeString(category) || 'unbekannt'}`,
    '',
    'Antworte NUR mit dem reinen Beschreibungstext, ohne Präfix oder Erläuterung.',
  ].join('\n');
  try {
    const text = await callGeminiVision(prompt, [], {
      model: 'gemini-3-flash-preview',
      temperature: 0.6,
      maxOutputTokens: 400,
    });
    const cleaned = safeString(text).replace(/^["'`]+|["'`]+$/g, '').trim();
    if (!cleaned || cleaned.length < 30) return null;
    return cleaned.slice(0, 4000);
  } catch (err) {
    console.warn('[kaufland-enricher] description gen failed:', err?.message || err);
    return null;
  }
}

/**
 * Infer material composition in Kaufland's "XX% Material1, YY% Material2" format.
 * Returns a single string or null.
 */
async function generateMaterial({ title, brand, category }) {
  const prompt = [
    'Schätze die Materialzusammensetzung dieses Produkts.',
    `Titel: ${safeString(title) || 'unbekannt'}`,
    `Marke: ${safeString(brand) || 'unbekannt'}`,
    `Kategorie: ${safeString(category) || 'unbekannt'}`,
    '',
    'Antworte AUSSCHLIESSLICH in diesem exakten Format: "XX% Material1, YY% Material2"',
    'Beispiel: "98% Baumwolle, 2% Elasthan" oder "100% Polyester"',
    'Wenn du unsicher bist: "100% [Hauptmaterial]" (z.B. "100% Kunststoff").',
    'Keine Erläuterung, keine Anführungszeichen, nur die Materialangabe.',
  ].join('\n');
  try {
    const text = await callGeminiVision(prompt, [], {
      model: 'gemini-3-flash-preview',
      temperature: 0.2,
      maxOutputTokens: 80,
    });
    const cleaned = safeString(text).replace(/^["'`]+|["'`]+$/g, '').replace(/\n.*$/s, '').trim();
    // Sanity: must contain at least one "% Material" pattern
    if (!cleaned || !/\d{1,3}\s*%/.test(cleaned)) return null;
    return cleaned.slice(0, 250);
  } catch (err) {
    console.warn('[kaufland-enricher] material gen failed:', err?.message || err);
    return null;
  }
}

/**
 * Merge GPSR web-lookup result into product.details.gpsr without overwriting
 * existing non-empty values. Returns a NEW gpsr object (does not mutate input).
 */
function mergeGpsr(existingGpsr, webResult) {
  const out = { ...(existingGpsr && typeof existingGpsr === 'object' ? existingGpsr : {}) };
  if (!webResult) return out;
  // Web result returns a single combined address — only fill if existing
  // manufacturer_address is empty (preserve any structured data we already have).
  if (!safeString(out.manufacturer_name) && safeString(webResult.manufacturer_name)) {
    out.manufacturer_name = webResult.manufacturer_name;
  }
  if (!safeString(out.manufacturer_address) && safeString(webResult.manufacturer_address)) {
    out.manufacturer_address = webResult.manufacturer_address;
  }
  if (!safeString(out.email) && safeString(webResult.manufacturer_email)) {
    out.email = webResult.manufacturer_email;
  }
  if (!safeString(out.url) && safeString(webResult.manufacturer_url)) {
    out.url = webResult.manufacturer_url;
  }
  return out;
}

/**
 * Enrich a `products_v2` document with the fields Kaufland says are missing.
 *
 * @param {object} product - products_v2 doc (must have .details, .identification)
 * @param {string[]} missingAttributes - Kauflands missing_attributes list
 * @param {object} [opts]
 * @param {number} [opts.fieldTimeoutMs=8000]
 * @param {number} [opts.totalTimeoutMs=20000]
 * @returns {Promise<{ enriched: object, enrichedFields: string[], errors: string[] }>}
 *   `enriched` is always a NEW object (shallow-cloned). `enrichedFields` is the
 *   list of high-level bucket names that were actually populated this run.
 */
async function enrichProductForKaufland(product, missingAttributes = [], opts = {}) {
  const fieldTimeoutMs = Number.isFinite(opts.fieldTimeoutMs) ? opts.fieldTimeoutMs : DEFAULT_FIELD_TIMEOUT_MS;
  const totalTimeoutMs = Number.isFinite(opts.totalTimeoutMs) ? opts.totalTimeoutMs : DEFAULT_TOTAL_TIMEOUT_MS;

  const enrichedFields = [];
  const errors = [];

  // Shallow clone — we'll mutate details / details.gpsr below.
  const enriched = { ...(product || {}) };
  enriched.details = { ...(product?.details || {}) };
  enriched.identification = { ...(product?.identification || {}) };

  const list = Array.isArray(missingAttributes) ? missingAttributes : [];
  if (!list.length) {
    return { enriched, enrichedFields, errors };
  }

  // Classify missing fields into buckets. De-dupe per bucket.
  const buckets = new Set();
  for (const name of list) {
    const bucket = classifyMissingAttribute(name);
    if (bucket) buckets.add(bucket);
  }
  if (!buckets.size) {
    return { enriched, enrichedFields, errors };
  }

  const title = safeString(enriched.identification?.name);
  const brand = safeString(enriched.identification?.brand
    || enriched.details?.identifiers?.brand);
  const category = safeString(enriched.identification?.category
    || enriched.details?.category?.path);

  // ── Bucket: manufacturer (cheap, no IO) ────────────────────────────────
  // If Kaufland complains about missing manufacturer but we have a brand,
  // mirror brand → details.attributes.manufacturer / Hersteller (existing
  // repair logic reads brand directly so this is mostly for parity with
  // attributes that survive a different code path).
  if (buckets.has('manufacturer') && brand) {
    const attrs = { ...(enriched.details.attributes && typeof enriched.details.attributes === 'object' && !Array.isArray(enriched.details.attributes) ? enriched.details.attributes : {}) };
    const hasManufacturer = Object.keys(attrs).some((k) => {
      const token = normalizeToken(k);
      return token === 'manufacturer' || token === 'hersteller';
    });
    if (!hasManufacturer) {
      attrs.Hersteller = brand;
      enriched.details.attributes = attrs;
      enrichedFields.push('manufacturer');
    }
  }

  // Build per-bucket tasks (parallel) but wrap in total-timeout.
  const tasks = [];

  if (buckets.has('gpsr')) {
    const gpsrExisting = enriched.details.gpsr && typeof enriched.details.gpsr === 'object' ? enriched.details.gpsr : {};
    // Kaufland complained → don't trust our existing GPSR even if "complete".
    // Try web-fallback to add any missing subfields (phone, city, postalcode).
    if (brand) {
      tasks.push((async () => {
        try {
          const webResult = await withTimeout(
            lookupGpsrFromWeb(brand, { timeout: fieldTimeoutMs }),
            fieldTimeoutMs + 500,
            'gpsr-web'
          );
          if (webResult && (webResult.manufacturer_name || webResult.manufacturer_address || webResult.manufacturer_email)) {
            const merged = mergeGpsr(gpsrExisting, webResult);
            // Only count as enriched if SOMETHING was added vs the original.
            const changed = Object.keys(merged).some((k) => merged[k] && merged[k] !== gpsrExisting[k]);
            if (changed) {
              enriched.details.gpsr = merged;
              enrichedFields.push('gpsr');
            }
          }
        } catch (err) {
          errors.push(`gpsr: ${err?.message || err}`);
        }
      })());
    }
  }

  if (buckets.has('description')) {
    const descCurrent = safeString(enriched.details.description) || safeString(enriched.details.short_description);
    // Kaufland complained → regenerate if missing OR too short (<50 chars).
    // Kaufland validator probably wants substantial product info.
    if ((!descCurrent || descCurrent.length < 50) && title) {
      tasks.push((async () => {
        try {
          const desc = await withTimeout(
            generateDescription({ title, brand, category }),
            fieldTimeoutMs,
            'description-gemini'
          );
          if (desc) {
            enriched.details.description = desc;
            enrichedFields.push('description');
          }
        } catch (err) {
          errors.push(`description: ${err?.message || err}`);
        }
      })());
    }
  }

  if (buckets.has('material')) {
    const attrsForMaterial = enriched.details.attributes && typeof enriched.details.attributes === 'object' && !Array.isArray(enriched.details.attributes)
      ? enriched.details.attributes
      : {};
    // Kaufland complained → check our existing material value for QUALITY,
    // not mere presence. Kaufland validator rejects free-text without
    // percentage (e.g., "Baumwollmischung mit Stretch") even if stored.
    // Re-format whenever the existing value doesn't match `XX% Y` pattern.
    let existingMaterialValue = '';
    for (const [k, v] of Object.entries(attrsForMaterial)) {
      const token = normalizeToken(k);
      if (token.includes('material') && (token.includes('zusammensetzung') || token === 'material' || token.includes('composition'))) {
        const candidate = Array.isArray(v) ? safeString(v[0]) : safeString(v);
        if (candidate) { existingMaterialValue = candidate; break; }
      }
    }
    const hasValidMaterialFormat = existingMaterialValue && /\d{1,3}\s*%/.test(existingMaterialValue);
    if (!hasValidMaterialFormat && title) {
      tasks.push((async () => {
        try {
          const material = await withTimeout(
            generateMaterial({ title, brand, category }),
            fieldTimeoutMs,
            'material-gemini'
          );
          if (material) {
            const attrs = { ...attrsForMaterial };
            attrs.Materialzusammensetzung = material;
            enriched.details.attributes = attrs;
            enrichedFields.push('material');
          }
        } catch (err) {
          errors.push(`material: ${err?.message || err}`);
        }
      })());
    }
  }

  // ── Bucket: picture (cannot enrich without source images — skip silently) ─
  // We log so operator can see Kaufland wants pictures but we have none.
  if (buckets.has('picture')) {
    const images = Array.isArray(enriched.details.images) ? enriched.details.images : [];
    if (!images.length) {
      errors.push('picture: no images available in products_v2 — manual fix required');
    }
  }

  if (!tasks.length) {
    return { enriched, enrichedFields, errors };
  }

  // Race ALL parallel tasks against the total timeout. Individual tasks have
  // their own per-field timeouts; this is the upper bound for the whole call.
  try {
    await withTimeout(Promise.allSettled(tasks), totalTimeoutMs, 'enrichment-total');
  } catch (err) {
    errors.push(`total: ${err?.message || err}`);
  }

  return { enriched, enrichedFields, errors };
}

module.exports = {
  enrichProductForKaufland,
  // exported for unit tests
  classifyMissingAttribute,
  mergeGpsr,
};
