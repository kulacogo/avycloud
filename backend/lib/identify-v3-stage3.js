'use strict';

const { generateProductContent, gemini3GenerateJSON } = require('./gemini3-client');
const { sanitizeDescriptionToHtml } = require('./listing-sanitize');
const { normalizeHighlightsStrict } = require('./highlights-policy');
const { canonicalizeAttributesStrict } = require('./attribute-policy');
const { coerceTitleToPolicy } = require('./title-policy');

// Lazy-load the agentic module so that test fixtures that don't need it (and
// don't have @google/genai stubbed at module-load time) are not affected.
let _agenticModule = null;
function _getAgenticModule() {
  if (_agenticModule === null) {
    try {
      _agenticModule = require('./identify-v3-stage3-agentic');
    } catch (err) {
      console.warn('[stage3] agentic module unavailable:', err?.message || err);
      _agenticModule = false;
    }
  }
  return _agenticModule || null;
}

/**
 * Stage 3: Content Generation
 *
 * Builds a context-rich prompt with all Stage 1 + Stage 2 data,
 * calls generateProductContent(), and post-processes the output.
 *
 * Aspect enforcement (STAGE3_ASPECT_ENFORCEMENT, default true):
 *  - Normalizes requiredAspects to rich objects ({ name, localizedName, values }).
 *  - Injects explicit PFLICHT-MERKMALE block into the prompt via enrichment.
 *  - After Gemini returns, back-fills missing required keys with "Unbekannt".
 *  - Optionally triggers a focused repair call when >30% of required aspects
 *    ended up as "Unbekannt" (STAGE3_ASPECT_REPAIR, default true).
 */
async function runStage3ContentGeneration(stage1, stage2, locale = 'de-DE') {
  const startTime = Date.now();
  const identity = stage1.identity || {};

  const enforcementEnabled = isFlagEnabled(process.env.STAGE3_ASPECT_ENFORCEMENT, true);
  const repairEnabled = isFlagEnabled(process.env.STAGE3_ASPECT_REPAIR, true);

  // Normalize requiredAspects to rich objects once so the prompt + post-gen path
  // can rely on a single shape (also tolerates legacy string[] inputs).
  const normalizedRequiredAspects = normalizeRequiredAspects(
    stage2.requiredAspects || [],
    stage2.aspectCatalog || null
  );

  // The existing `generateProductContent()` prompt renders each aspect via
  // `${a}` — we therefore attach a custom `toString()` that produces
  //   "Marke (erlaubt: Sony, Bose, ...)"
  // so the prompt injection stays data-driven without modifying gemini3-client.
  const promptAspects = normalizedRequiredAspects.length
    ? normalizedRequiredAspects.map(decorateAspectForPrompt)
    : (stage2.requiredAspects || []);

  // Build enrichment context for generateProductContent()
  const enrichment = {
    requiredAspects: enforcementEnabled ? promptAspects : (stage2.requiredAspects || []),
    titleInsights: stage2.titleInsights || {},
    pricing: stage2.pricing || {},
    gpsr: stage2.gpsr || { found: false, data: null },
    category: stage2.category || {},
  };

  // Call Gemini with context-rich prompt. Hard cap (default 60s — Stage 3 is now
  // the heavy LLM call with thinking + urlContext + googleSearch; raised from
  // 25s so Gemini can actually finish the agentic recherche before the master
  // timeout fires) — falls through to the V2/minimal fallback below if exceeded.
  const STAGE3_CONTENT_TIMEOUT_MS = parseInt(
    process.env.STAGE3_CONTENT_TIMEOUT_MS || '60000',
    10,
  );
  let content;
  let usedFallback = false;
  let usedAgentic = false;
  try {
    const ocrSnippets = Array.isArray(stage1.ocrPayload?.textSnippets)
      ? stage1.ocrPayload.textSnippets
      : [];

    const generationInput = {
      identity: {
        brand: identity.brand,
        model: identity.model,
        mpn: identity.mpn,
        ean: stage1.barcodes?.ean,
        variant: identity.variant,
        color: identity.color,
        size: identity.size,
        material: identity.material,
        condition: identity.condition,
      },
      enrichment,
      // Pass ALL uploaded images (Stage 1 already capped to 4 + compressed). Previously we
      // sliced to 2 here, which meant Stage 3 was effectively blind on multi-angle shots
      // (front/back/box/label). Gemini-3 Pro handles 4 images comfortably.
      imageParts: stage1.imageParts || [],
      locale,
      // OCR is the most valuable signal for warehouse-style packaging photos —
      // it was extracted in Stage 1 but never reached Stage 3 until now.
      ocrSnippets,
      eanLookup: stage1.eanLookup || null,
      webImages: stage2.webImages || [],
      weightFallback: stage2.weightFallback || null,
      // GPSR web fallback (Stage 2 actively searched for it) was previously discarded.
      gpsrWebFallback: stage2.gpsrWebFallback || null,
      barcodeConfirmation: stage2.barcodeConfirmation || null,
    };

    // Agentic path — Chat-V3 pattern: ai.chats.create + googleSearch +
    // urlContext + 9 atomic-tools + write_product_datasheet, max 5 iterations
    // with forced-finalization. Default OFF; opt-in via STAGE3_AGENTIC=true or
    // STAGE3_AGENTIC_SAMPLE=0.X. Falls back to single-shot on any failure.
    const agentic = _getAgenticModule();
    const useAgentic = agentic && agentic.isAgenticEnabled();

    let contentPromise;
    if (useAgentic) {
      usedAgentic = true;
      contentPromise = agentic.generateProductContentAgentic(generationInput).catch(async (err) => {
        // Soft-fall-through to single-shot — log but don't propagate.
        console.warn('[stage3] agentic path failed, falling back to single-shot:', err?.message || err);
        usedAgentic = false;
        return generateProductContent(generationInput);
      });
    } else {
      contentPromise = generateProductContent(generationInput);
    }
    Promise.resolve(contentPromise).catch(() => {});
    content = await Promise.race([
      contentPromise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Stage 3 content generation timeout after ${STAGE3_CONTENT_TIMEOUT_MS}ms`)),
          STAGE3_CONTENT_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    console.warn('[stage3] Content generation failed:', err?.message);
    // Fallback: use V2 grounding data if available (high quality), else minimal content
    if (stage1.v2FallbackRecord) {
      console.log('[stage3] Using V2 grounding record as content fallback');
      content = buildFallbackFromV2(stage1.v2FallbackRecord, identity, stage2);
    } else {
      content = buildFallbackContent(identity, stage2);
    }
    usedFallback = true;
  }

  // Post-processing
  const result = { ...content };

  // Title normalization
  if (result.title_ebay) {
    try {
      const coerced = coerceTitleToPolicy(result.title_ebay, {
        brand: identity.brand,
        model: identity.model,
      });
      if (coerced?.title) result.title_ebay = coerced.title;
    } catch {
      // Keep original title
    }
  }

  // Description sanitization
  if (result.description_ebay) {
    try {
      result.description_ebay = sanitizeDescriptionToHtml(result.description_ebay);
    } catch {
      // Keep as-is
    }
  }
  if (result.description_kaufland) {
    try {
      result.description_kaufland = sanitizeDescriptionToHtml(result.description_kaufland);
    } catch {
      // Keep as-is
    }
  }

  // Highlights normalization
  if (Array.isArray(result.key_features)) {
    try {
      const dummyProduct = {
        identification: { brand: identity.brand },
        details: { key_features: result.key_features },
      };
      const normalized = normalizeHighlightsStrict(dummyProduct, result.key_features);
      if (Array.isArray(normalized) && normalized.length) {
        result.key_features = normalized;
      }
    } catch {
      // Keep as-is
    }
  }

  // Attribute canonicalization
  if (Array.isArray(result.item_specifics)) {
    try {
      const attrObj = Object.fromEntries(
        result.item_specifics.filter((s) => s?.key).map((s) => [s.key, s.value])
      );
      const canonical = canonicalizeAttributesStrict(attrObj);
      const canonicalAttrs = canonical?.attributes;
      if (canonicalAttrs && typeof canonicalAttrs === 'object') {
        result.item_specifics = Object.entries(canonicalAttrs).map(([key, value]) => ({
          key,
          value: String(value).slice(0, 60),
        }));
      }
    } catch {
      // Keep as-is
    }
  }

  // Enforce required aspects (back-fill missing, optionally repair via Gemini)
  let aspectEnforcementMeta = null;
  if (enforcementEnabled && normalizedRequiredAspects.length) {
    aspectEnforcementMeta = enforceRequiredAspectsPostGen(result, normalizedRequiredAspects);
    if (aspectEnforcementMeta.missing.length) {
      console.warn(
        `[stage3] Missing required aspects post-gen: [${aspectEnforcementMeta.missing.join(', ')}]`
      );
    }

    // Trigger Gemini repair call when too many required aspects are unknown.
    // Default threshold lowered from 0.30 → 0.10 (configurable) so partial
    // gaps like 4 of 20 unknown ("only" 20% — but eBay Cassini still penalises
    // each gap individually) still get a focused recherche pass.
    const repairThreshold = (() => {
      const raw = process.env.STAGE3_ASPECT_REPAIR_THRESHOLD;
      if (raw == null || raw === '') return 0.1;
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.1;
    })();
    if (
      repairEnabled &&
      !usedFallback &&
      normalizedRequiredAspects.length > 0 &&
      aspectEnforcementMeta.unknownCount > 0 &&
      aspectEnforcementMeta.unknownCount / normalizedRequiredAspects.length >= repairThreshold
    ) {
      try {
        const repaired = await runAspectRepair({
          identity,
          stage2,
          unknownAspects: aspectEnforcementMeta.unknownAspects,
          requiredAspects: normalizedRequiredAspects,
        });
        if (repaired && typeof repaired === 'object') {
          applyRepairValues(result, repaired, normalizedRequiredAspects);
          aspectEnforcementMeta.repairApplied = true;
          aspectEnforcementMeta.repairedKeys = Object.keys(repaired.repaired || {});
        }
      } catch (err) {
        console.warn('[stage3] Aspect repair call failed:', err?.message);
        aspectEnforcementMeta.repairApplied = false;
        aspectEnforcementMeta.repairError = err?.message;
      }
    }
  }

  result._meta = {
    durationMs: Date.now() - startTime,
    fallbackUsed: usedFallback,
    agenticUsed: usedAgentic,
    agenticTrace: result._agentic || null,
    aspectEnforcement: aspectEnforcementMeta,
  };
  // Don't bleed the internal `_agentic` field into the saved product.
  delete result._agentic;

  return result;
}

/**
 * Decorate a normalized aspect object with a `toString()` that renders the
 * prompt-ready string "{Name} (erlaubt: v1, v2, v3)".  The prompt in
 * gemini3-client uses `${a}` template interpolation, which invokes toString().
 * Returning a string directly when no values are present keeps backwards
 * compatibility with existing stringy downstream consumers.
 */
function decorateAspectForPrompt(aspect) {
  const display = aspect.localizedName || aspect.name;
  if (!aspect.values || aspect.values.length === 0) return display;
  const decorated = Object.assign(Object.create(null), aspect);
  Object.defineProperty(decorated, 'toString', {
    value() {
      return `${display} (erlaubt: ${aspect.values.slice(0, 8).join(', ')})`;
    },
    enumerable: false,
  });
  return decorated;
}

/**
 * Normalize requiredAspects to an array of { name, localizedName, values } objects.
 * Accepts either legacy string[] or objects.  When a catalog is provided and the
 * input is string[], tries to enrich each name with allowed values from the catalog.
 */
function normalizeRequiredAspects(requiredAspects, aspectCatalog) {
  if (!Array.isArray(requiredAspects) || requiredAspects.length === 0) return [];
  const catalogRows = Array.isArray(aspectCatalog?.aspects) ? aspectCatalog.aspects : [];
  const byName = new Map();
  for (const row of catalogRows) {
    const name = typeof row === 'object' && row ? String(row.name || '').trim() : '';
    if (!name) continue;
    byName.set(name.toLowerCase(), row);
  }

  const out = [];
  const seen = new Set();
  for (const raw of requiredAspects) {
    if (!raw) continue;
    let name = '';
    let localizedName = '';
    let values = [];
    if (typeof raw === 'string') {
      name = raw.trim();
    } else if (typeof raw === 'object') {
      name = String(raw.name || raw.localizedName || '').trim();
      localizedName = String(raw.localizedName || '').trim();
      if (Array.isArray(raw.values)) {
        values = raw.values.map((v) => (typeof v === 'string' ? v : v?.name || v?.value || '')).filter(Boolean);
      } else if (Array.isArray(raw.aspectValues)) {
        values = raw.aspectValues.map((v) => v?.localizedValue || v?.value || '').filter(Boolean);
      }
    }
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if ((!values || values.length === 0) && byName.has(key)) {
      const row = byName.get(key);
      const rowValues = Array.isArray(row?.values)
        ? row.values.map((v) => (typeof v === 'string' ? v : v?.name || v?.value || '')).filter(Boolean)
        : Array.isArray(row?.aspectValues)
          ? row.aspectValues.map((v) => v?.localizedValue || v?.value || '').filter(Boolean)
          : [];
      if (rowValues.length) values = rowValues;
      if (!localizedName && row?.localizedName) localizedName = String(row.localizedName);
    }
    out.push({ name, localizedName: localizedName || name, values });
  }
  return out;
}

/**
 * Post-generation validator + back-fill.
 * For each required aspect not present (case-insensitive) in item_specifics,
 * inserts { key, value: 'Unbekannt' } and sets item_specifics_confidence[key] = 0.
 */
function enforceRequiredAspectsPostGen(content, requiredAspects) {
  if (!Array.isArray(content.item_specifics)) content.item_specifics = [];
  if (!content.item_specifics_confidence || typeof content.item_specifics_confidence !== 'object') {
    content.item_specifics_confidence = {};
  }

  const presentByNormKey = new Map();
  for (const entry of content.item_specifics) {
    if (!entry || typeof entry !== 'object') continue;
    const key = String(entry.key || '').trim();
    if (!key) continue;
    const value = String(entry.value || '').trim();
    if (!value) continue;
    presentByNormKey.set(normalizeAspectKey(key), entry);
  }

  const missing = [];
  const unknownAspects = [];
  let unknownCount = 0;

  for (const aspect of requiredAspects) {
    const norm = normalizeAspectKey(aspect.name);
    if (!norm) continue;
    const existing = presentByNormKey.get(norm);
    if (!existing) {
      // Back-fill with placeholder.
      const allowedValueHint = (aspect.values && aspect.values.length)
        ? pickLikeliestFallback(aspect.values)
        : 'Unbekannt';
      content.item_specifics.push({ key: aspect.name, value: allowedValueHint });
      content.item_specifics_confidence[aspect.name] = 0;
      missing.push(aspect.name);
      if (isUnknownValue(allowedValueHint)) {
        unknownCount += 1;
        unknownAspects.push(aspect);
      }
      continue;
    }
    // If the value is one of the unknown placeholders already, count it.
    if (isUnknownValue(existing.value)) {
      unknownCount += 1;
      unknownAspects.push(aspect);
      // Make sure the confidence is explicitly low.
      const existingConf = content.item_specifics_confidence[existing.key];
      if (existingConf == null) content.item_specifics_confidence[existing.key] = 0;
    }
  }

  return {
    missing,
    unknownAspects,
    unknownCount,
    repairApplied: false,
  };
}

function normalizeAspectKey(raw) {
  if (raw == null) return '';
  return String(raw)
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[‐-―]/g, '-')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUnknownValue(v) {
  if (!v) return true;
  const s = String(v).trim().toLowerCase();
  return s === '' || s === 'unbekannt' || s === 'unknown' || s === 'n/a' || s === 'k.a.' || s === 'nicht zutreffend';
}

function pickLikeliestFallback(values) {
  // When the aspect has an enum of allowed values, prefer a generic-ish one so the
  // listing does not get blocked; callers can still flag confidence=0.
  const preferred = ['Sonstige', 'Unbekannt', 'Keine Angabe'];
  for (const pref of preferred) {
    const hit = values.find((v) => String(v).toLowerCase() === pref.toLowerCase());
    if (hit) return hit;
  }
  // Otherwise fall back to the first value, but expose the value string limited to 60 chars.
  return String(values[0] || 'Unbekannt').slice(0, 60);
}

/**
 * Focused Gemini repair call for unknown aspects.  Fire-and-safe: any failure
 * returns null and the caller keeps the Unbekannt placeholders.
 */
async function runAspectRepair({ identity, stage2, unknownAspects, requiredAspects }) {
  if (!Array.isArray(unknownAspects) || unknownAspects.length === 0) return null;

  const aspectLines = unknownAspects.map((a) => {
    if (a.values && a.values.length) {
      return `- ${a.localizedName || a.name} (erlaubt: ${a.values.slice(0, 8).join(', ')})`;
    }
    return `- ${a.localizedName || a.name}`;
  });

  const contextLines = [];
  if (identity.brand) contextLines.push(`- Marke: ${identity.brand}`);
  if (identity.model) contextLines.push(`- Modell: ${identity.model}`);
  if (identity.mpn) contextLines.push(`- MPN: ${identity.mpn}`);
  if (identity.variant) contextLines.push(`- Variante: ${identity.variant}`);
  if (identity.color) contextLines.push(`- Farbe: ${identity.color}`);
  if (stage2?.category?.ebayBreadcrumb) contextLines.push(`- eBay Kategorie: ${stage2.category.ebayBreadcrumb}`);
  if (stage2?.pricing?.amount) contextLines.push(`- Preis: ${stage2.pricing.amount} ${stage2.pricing.currency || 'EUR'}`);

  const prompt = `Für das Produkt fehlen folgende eBay-Pflichtmerkmale.
Verfügbare Daten:
${contextLines.join('\n') || '- (keine zusätzlichen Daten)'}

Fehlende Merkmale:
${aspectLines.join('\n')}

AUFGABE: Recherchiere im Web und fülle plausible Werte ein.
Antwort strikt als JSON mit folgender Struktur:
{ "repaired": { "Merkmal-Name": "Wert", ... }, "confidence": { "Merkmal-Name": 0.0-1.0 } }
Nichts erfinden — wenn du nichts findest, lasse den Key weg.`;

  const schema = {
    type: 'object',
    properties: {
      repaired: { type: 'object', additionalProperties: { type: 'string' } },
      confidence: { type: 'object', additionalProperties: { type: 'number' } },
    },
    required: ['repaired'],
  };

  // Hard cap on the repair Gemini call so it cannot consume the V3 master timeout.
  // Returns null on timeout — caller treats that as "repair unavailable" and continues.
  const ASPECT_REPAIR_TIMEOUT_MS = parseInt(
    process.env.STAGE3_REPAIR_TIMEOUT_MS || '15000',
    10,
  );
  let parsed;
  try {
    const repairPromise = gemini3GenerateJSON({
      prompt,
      schema,
      temperature: 0.1,
      maxOutputTokens: 1024,
    });
    Promise.resolve(repairPromise).catch(() => {});
    parsed = await Promise.race([
      repairPromise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Aspect repair timeout after ${ASPECT_REPAIR_TIMEOUT_MS}ms`)),
          ASPECT_REPAIR_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    console.warn('[stage3] Aspect repair Gemini call failed:', err?.message);
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (!parsed.repaired || typeof parsed.repaired !== 'object') return null;
  return parsed;
}

function applyRepairValues(content, repaired, requiredAspects) {
  if (!Array.isArray(content.item_specifics)) content.item_specifics = [];
  if (!content.item_specifics_confidence || typeof content.item_specifics_confidence !== 'object') {
    content.item_specifics_confidence = {};
  }
  const repairedMap = repaired.repaired || {};
  const confidenceMap = repaired.confidence || {};

  const requiredByNorm = new Map();
  for (const aspect of requiredAspects) {
    requiredByNorm.set(normalizeAspectKey(aspect.name), aspect);
  }

  for (const [rawKey, rawValue] of Object.entries(repairedMap)) {
    const value = String(rawValue == null ? '' : rawValue).trim();
    if (!value || isUnknownValue(value)) continue;
    const norm = normalizeAspectKey(rawKey);
    const aspect = requiredByNorm.get(norm);
    const canonicalKey = aspect ? aspect.name : rawKey;
    // Find existing entry and replace, else push a new one.
    let replaced = false;
    for (const entry of content.item_specifics) {
      if (!entry || typeof entry !== 'object') continue;
      if (normalizeAspectKey(entry.key) === norm) {
        entry.key = canonicalKey;
        entry.value = value.slice(0, 60);
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      content.item_specifics.push({ key: canonicalKey, value: value.slice(0, 60) });
    }
    const conf = Number(confidenceMap[rawKey] ?? confidenceMap[canonicalKey]);
    content.item_specifics_confidence[canonicalKey] = Number.isFinite(conf)
      ? Math.max(0, Math.min(1, conf))
      : 0.5;
  }
}

function isFlagEnabled(envValue, defaultValue) {
  if (envValue == null || envValue === '') return defaultValue;
  const s = String(envValue).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return defaultValue;
}

function buildFallbackContent(identity, stage2) {
  const nameParts = [identity.brand, identity.model, identity.variant].filter(Boolean);
  const name = nameParts.join(' ').trim() || 'Produkt';

  return {
    title_ebay: name.slice(0, 80),
    title_kaufland: name.slice(0, 100),
    description_ebay: `<p>${name}</p>`,
    description_kaufland: `<p>${name}</p>`,
    key_features: nameParts.map((p) => p),
    item_specifics: [
      identity.brand ? { key: 'Marke', value: identity.brand } : null,
      identity.model ? { key: 'Modell', value: identity.model } : null,
      identity.color ? { key: 'Farbe', value: identity.color } : null,
    ].filter(Boolean),
    mobile_snippet: name,
  };
}

/**
 * Build content from V2 grounding record — uses production-proven data
 * instead of the minimal fallback. Quality floor = V2.
 */
function buildFallbackFromV2(v2Record, identity, stage2) {
  return {
    title_ebay: v2Record.title_ebay || `${identity.brand} ${identity.model}`.trim().slice(0, 80),
    title_kaufland: v2Record.title_kaufland || v2Record.title_ebay || `${identity.brand} ${identity.model}`.trim().slice(0, 100),
    description_ebay: v2Record.description_ebay || `<p>${identity.brand} ${identity.model}</p>`,
    description_kaufland: v2Record.description_kaufland || v2Record.description_ebay || `<p>${identity.brand} ${identity.model}</p>`,
    key_features: Array.isArray(v2Record.key_features) ? v2Record.key_features : [],
    item_specifics: Array.isArray(v2Record.item_specifics) ? v2Record.item_specifics : [
      identity.brand ? { key: 'Marke', value: identity.brand } : null,
      identity.model ? { key: 'Modell', value: identity.model } : null,
    ].filter(Boolean),
    mobile_snippet: (v2Record.title_ebay || `${identity.brand} ${identity.model}`).slice(0, 60),
    gpsr_manufacturer_name: v2Record.gpsr_manufacturer_name || '',
    gpsr_manufacturer_address: v2Record.gpsr_manufacturer_address || '',
    gpsr_manufacturer_email: v2Record.gpsr_manufacturer_email || '',
    gpsr_manufacturer_phone: v2Record.gpsr_manufacturer_phone || '',
  };
}

module.exports = {
  runStage3ContentGeneration,
  // Exported for unit testing.
  enforceRequiredAspectsPostGen,
  normalizeRequiredAspects,
};
