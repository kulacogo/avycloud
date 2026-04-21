'use strict';

const { generateProductContent } = require('./gemini3-client');
const { sanitizeDescriptionToHtml } = require('./listing-sanitize');
const { normalizeHighlightsStrict } = require('./highlights-policy');
const { canonicalizeAttributesStrict } = require('./attribute-policy');
const { coerceTitleToPolicy } = require('./title-policy');

/**
 * Stage 3: Content Generation
 *
 * Builds a context-rich prompt with all Stage 1 + Stage 2 data,
 * calls generateProductContent(), and post-processes the output.
 */
async function runStage3ContentGeneration(stage1, stage2, locale = 'de-DE') {
  const startTime = Date.now();
  const identity = stage1.identity || {};

  // Build enrichment context for generateProductContent()
  const enrichment = {
    requiredAspects: stage2.requiredAspects || [],
    titleInsights: stage2.titleInsights || {},
    pricing: stage2.pricing || {},
    gpsr: stage2.gpsr || { found: false, data: null },
    category: stage2.category || {},
  };

  // Call Gemini with context-rich prompt
  let content;
  let usedFallback = false;
  try {
    content = await generateProductContent({
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
      imageParts: (stage1.imageParts || []).slice(0, 2),
      locale,
    });
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

  result._meta = {
    durationMs: Date.now() - startTime,
    fallbackUsed: usedFallback,
  };

  return result;
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

module.exports = { runStage3ContentGeneration };
