'use strict';

const crypto = require('crypto');
const { runStage1Recognition } = require('../lib/identify-v3-stage1');
const { runStage2Enrichment } = require('../lib/identify-v3-stage2');
const { runStage3ContentGeneration } = require('../lib/identify-v3-stage3');
const { runStage4Validation } = require('../lib/identify-v3-stage4');
const { runStage4CrossReference } = require('../lib/identify-v3-evidence');

function _stage4CrossRefEnabled() {
  const raw = String(process.env.STAGE4_CROSS_REFERENCE || 'true').trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'no' && raw !== 'off';
}

/**
 * Identify V3: Multi-Stage Pipeline
 *
 * Stage 1: Recognition (OCR + EAN DB + focused grounding)
 * Stage 2: Enrichment (6 parallel sources)
 * Stage 3: Content Generation (context-rich Gemini call)
 * Stage 4: Validation & Confidence Scoring
 *
 * Returns a canonical Product + confidence metadata.
 */
async function identifyProductV3({ files = [], barcodes = '', locale = 'de-DE', hint = null, paletteCode = null, inventoryId = null } = {}) {
  const startTime = Date.now();

  // Stage 1: Recognition
  const stage1 = await runStage1Recognition({ files, barcodes, hint, locale });

  // Stage 2: Enrichment (parallel)
  const stage2 = await runStage2Enrichment(stage1, locale);

  // Stage 3: Content Generation
  const stage3 = await runStage3ContentGeneration(stage1, stage2, locale);

  // Assemble product in canonical format (matches types.ts Product interface)
  const productId = crypto.randomUUID();
  const product = assembleProduct(productId, stage1, stage2, stage3, {
    locale, paletteCode, inventoryId,
  });

  // Stage 4: Validation (synchronous scoring) — custom per-field scoring with
  // hard-coded SOURCE_BASE_SCORES, kept for backward compat (downstream code
  // and UI read its `overall_score` / `field_confidence` keys).
  const stage4 = runStage4Validation(stage1, stage2, stage3, product);

  // Stage 4b: Cross-Reference + per-field-Confidence pass — additive, runs
  // alongside the custom Stage 4 scoring. Uses the calibrated `SOURCE_WEIGHTS`
  // table from `lib/confidence-scoring.js` (gs1_verified=0.98, ebay_catalog=0.95,
  // manufacturer_website=0.90, ean_db=0.85, gemini_inference=0.55, …) and the
  // multi-source consensus logic from `lib/cross-reference.js` (the same
  // module Chat-V3 and Identify-V4 use). Output lands in
  // `ops.data_quality.identify_v3.cross_reference` — Stage 4's output is NOT
  // mutated, so UI and quality-gates that currently read `overall_score` are
  // unchanged. Gated by STAGE4_CROSS_REFERENCE (default ON, additive only).
  let crossRefBlock = null;
  if (_stage4CrossRefEnabled()) {
    try {
      crossRefBlock = runStage4CrossReference(stage1, stage2, stage3);
    } catch (err) {
      // Never let an evidence/aggregation bug poison the pipeline.
      console.warn('[identify-v3] cross-reference pass failed:', err?.message || err);
      crossRefBlock = null;
    }
  }

  // Attach quality metadata to product
  product.ops = product.ops || {};
  product.ops.data_quality = product.ops.data_quality || {};
  product.ops.data_quality.identify_v3 = {
    checked_at_iso: new Date().toISOString(),
    overall_score: stage4.overallScore,
    field_confidence: stage4.fieldConfidence,
    aspect_coverage: stage4.requiredAspectsCoverage,
    marketplace_readiness: stage4.marketplaceReadiness,
    ...(crossRefBlock
      ? {
          cross_reference: {
            evidence_count: crossRefBlock.evidenceCount,
            confidence: crossRefBlock.confidence,
            conflicts: crossRefBlock.conflicts,
            aggregate: crossRefBlock.aggregate,
          },
        }
      : {}),
  };

  // Surface conflicts as warnings so the editor sees them in the UI without
  // any backend mutation of the resolved values (Phase 1 — observe, don't
  // overwrite).
  if (crossRefBlock?.conflicts?.length) {
    product.notes = product.notes || {};
    product.notes.warnings = Array.from(
      new Set([
        ...(product.notes.warnings || []),
        ...crossRefBlock.conflicts.map(
          (c) => `Cross-Reference-Konflikt: ${c.field} (${c.alternatives?.length || 0} Alternativen)`,
        ),
      ]),
    );
  }

  const totalDurationMs = Date.now() - startTime;

  return {
    product,
    meta: {
      pipeline: 'v3',
      totalDurationMs,
      stages: {
        stage1: { durationMs: stage1._meta?.durationMs, groundingUsed: stage1._meta?.groundingUsed },
        stage2: { durationMs: stage2._meta?.durationMs, enrichmentResults: stage2._meta?.enrichmentResults },
        stage3: { durationMs: stage3._meta?.durationMs },
      },
      confidence: stage4,
    },
  };
}

/**
 * Assemble canonical Product from all stage outputs.
 * MUST match the Product interface in types.ts exactly.
 */
function assembleProduct(id, stage1, stage2, stage3, opts) {
  const identity = stage1.identity || {};
  const barcodes = stage1.barcodes || {};

  // Title: prefer Stage 3 generated title, fallback to brand+model
  const titleEbay = stage3.title_ebay || '';
  const name = titleEbay || [identity.brand, identity.model, identity.variant].filter(Boolean).join(' ').trim() || 'Unbekanntes Produkt';

  // Brand resolution — multi-source consensus (in order of trust).
  let brand = identity.brand || '';
  if (!brand && stage1.eanLookup?.brand) {
    brand = String(stage1.eanLookup.brand).trim();
  }
  if (!brand && stage1.v2FallbackRecord?.brand) {
    brand = stage1.v2FallbackRecord.brand;
  }
  if (!brand && Array.isArray(stage3.item_specifics)) {
    const markeSpec = stage3.item_specifics.find(
      (s) => s?.key && /^(marke|brand|hersteller)$/i.test(String(s.key).trim()) && s?.value
    );
    if (markeSpec) {
      const v = String(markeSpec.value).trim();
      if (v && !/^(unbekannt|unknown|n\/a|k\.a\.|sonstige|generic|noname)$/i.test(v)) {
        brand = v;
      }
    }
  }
  // First-word-of-title fallback removed: it produces false positives like
  // "Hochwertige" or "Original" becoming brand. If we can't establish a brand
  // by this point, leave it empty — Stage 4 marks the field low-confidence and
  // the editor can fix it manually instead of having to undo a wrong guess.

  // Category: prefer Stage 2 resolved eBay breadcrumb. categorySource is set
  // from the resolver meta so that downstream `enforceEbayAspects` knows
  // whether the category is auto-resolved (and may be overridden) or sticky.
  const category = stage2.category?.ebayBreadcrumb || identity.internalCategory || 'Unkategorisiert';
  const categoryId = stage2.category?.ebayId || null;
  const resolverSource = stage2.category?.resolver?.source || 'local';
  // resolver.source is one of: 'local', 'v2:catalog', 'v2:suggestions',
  // 'v2:local', 'v2:gemini'. The prefix-stripped form aligns with the
  // taxonomy expected in details.categorySource per CLAUDE.md.
  const categorySource = resolverSource.startsWith('v2:')
    ? `auto:${resolverSource.slice(3)}`
    : 'auto:local';

  // Barcodes array
  const barcodeArray = barcodes.ranked?.map((r) => r.code).filter(Boolean) || [];

  // Attributes from item_specifics
  const attributes = {};
  if (Array.isArray(stage3.item_specifics)) {
    for (const spec of stage3.item_specifics) {
      if (spec?.key && spec?.value) {
        attributes[spec.key] = String(spec.value).slice(0, 60);
      }
    }
  }
  // Ensure core attributes are present
  if (identity.brand && !attributes.Marke) attributes.Marke = identity.brand;
  if (identity.model && !attributes.Modell) attributes.Modell = identity.model;
  if (identity.color && !attributes.Farbe) attributes.Farbe = identity.color;

  // Per-attribute confidence map. Stage 3 builds this in
  // `enforceRequiredAspectsPostGen()` (sets confidence=0 for "Unbekannt"
  // back-fills) and `applyRepairValues()` (sets confidence from the repair
  // Gemini call). Until 2026-05-07 this was discarded — only the aggregate
  // overall_score in ops.data_quality survived. The UI/QA-Gates can now
  // distinguish "verified value" from "Unbekannt placeholder" per field.
  const attributeConfidence =
    stage3.item_specifics_confidence && typeof stage3.item_specifics_confidence === 'object'
      ? { ...stage3.item_specifics_confidence }
      : null;

  // Images: uploads + grounding web_image_urls + SerpAPI web search results
  const groundingImageEntries = (stage1.webImageUrls || []).map((url) => ({
    url_or_base64: url,
    source: 'grounding_web',
    variant: 'marketing',
  }));
  const images = [
    ...(stage1.uploadedImages || []).map((img) => ({
      url_or_base64: img.url,
      source: 'upload',
      variant: 'reference',
    })),
    ...groundingImageEntries,
    ...(stage2.webImages || []).map((img) => ({
      url_or_base64: img.url,
      source: 'web_search',
      variant: 'marketing',
      notes: img.title || '',
    })),
  ];

  // Pricing
  const pricing = stage2.pricing?.amount > 0 ? {
    lowest_price: {
      amount: stage2.pricing.amount,
      currency: stage2.pricing.currency || 'EUR',
      sources: stage2.pricing.sources || [],
      last_checked_iso: new Date().toISOString(),
    },
    price_confidence: stage2.pricing.confidence || 0.7,
  } : {
    lowest_price: { amount: 0, currency: 'EUR', sources: [] },
    price_confidence: 0,
  };

  // GPSR: field-by-field merge across 3 sources, in priority order:
  //   Registry (`stage2.gpsr.data`) > Stage-3 LLM > Stage-2 web fallback.
  // Until 2026-05-07 this was a strict whole-record precedence — if the
  // highest-priority source had even a partial hit (e.g. registry only knew
  // the name), every lower-priority field was discarded even when the
  // registry lacked address/email. Now each field falls through independently
  // so a name from Registry can co-exist with an address+email from the web
  // fallback. The strict precedence pattern was a known leak after the GPSR
  // assembler bug fix on 2026-04-30 (see history of this comment).
  // Note: `gpsr-web-fallback.js` returns `manufacturer_email` (not `email`),
  // so the previous read of `wf.email` was always undefined — fixed here.
  const gpsr = (() => {
    const registryData = stage2.gpsr?.found && stage2.gpsr?.data ? stage2.gpsr.data : null;
    const wf = stage2.gpsrWebFallback && typeof stage2.gpsrWebFallback === 'object'
      ? stage2.gpsrWebFallback
      : null;
    const pickFrom = (...sources) => {
      for (const v of sources) {
        if (v == null) continue;
        const s = String(v).trim();
        if (s) return s;
      }
      return '';
    };
    const manufacturer_name = pickFrom(
      registryData?.manufacturer_name,
      stage3.gpsr_manufacturer_name,
      wf?.manufacturer_name,
    );
    const manufacturer_address = pickFrom(
      registryData?.manufacturer_address,
      stage3.gpsr_manufacturer_address,
      wf?.manufacturer_address,
    );
    const email = pickFrom(
      registryData?.email,
      registryData?.manufacturer_email,
      stage3.gpsr_manufacturer_email,
      wf?.manufacturer_email,
      wf?.email,
    );
    const manufacturer_phone = pickFrom(
      registryData?.manufacturer_phone,
      stage3.gpsr_manufacturer_phone,
      wf?.manufacturer_phone,
    );
    const entity_country = pickFrom(
      registryData?.entity_country,
      stage3.gpsr_manufacturer_country,
      wf?.entity_country,
    );
    if (
      !manufacturer_name &&
      !manufacturer_address &&
      !email &&
      !manufacturer_phone &&
      !entity_country
    ) {
      return undefined;
    }
    return { manufacturer_name, manufacturer_address, email, manufacturer_phone, entity_country };
  })();

  return {
    id,
    locale: opts.locale || 'de-DE',
    identification: {
      method: barcodeArray.length && !stage1.uploadedImages?.length ? 'barcode' : 'image',
      barcodes: barcodeArray.length ? barcodeArray : undefined,
      name,
      brand: brand || '',
      category,
      confidence: 0.8, // Will be overwritten by Stage 4
      sku: undefined, // Allocated by saveProductV2
    },
    details: {
      categoryId: categoryId || undefined,
      categorySource,
      short_description: stage3.description_ebay || '',
      key_features: Array.isArray(stage3.key_features) ? stage3.key_features : [],
      attributes,
      identifiers: {
        ean: barcodes.ean || undefined,
        gtin: barcodes.gtin || undefined,
        upc: barcodes.upc || undefined,
        mpn: identity.mpn || undefined,
        sku: undefined,
      },
      images,
      pricing,
      gpsr: gpsr || undefined,
      attribute_confidence: attributeConfidence || undefined,
    },
    marketplace: {
      ebay: {
        title: titleEbay,
        description: stage3.description_ebay || '',
        mobile_snippet: stage3.mobile_snippet || '',
      },
      kaufland: {
        title: stage3.title_kaufland || '',
        description: stage3.description_kaufland || '',
      },
    },
    ops: {
      sync_status: 'pending',
      revision: 0,
      pending_intake_quantity: 0,
      // Weight precedence: Stage 1 OCR/grounding (most authoritative — printed on box)
      // → Stage 2 web fallback (best-effort search of brand+model+gewicht).
      // Until 2026-05-07 the fallback was computed but discarded — same bug
      // pattern as the GPSR fallback fixed 2026-04-30.
      weight_grams:
        identity.weight_grams ||
        (Number.isFinite(stage2.weightFallback?.weight_grams)
          ? stage2.weightFallback.weight_grams
          : null) ||
        null,
      identify_pipeline: 'v3',
      sourcePalette: opts.paletteCode || null,
      sourcePaletteAt: opts.paletteCode ? new Date().toISOString() : null,
    },
    inventory: {
      quantity: 0,
      inventoryId: opts.inventoryId || null,
      inventoryName: null,
    },
    notes: {},
  };
}

module.exports = {
  identifyProductV3,
  // Exported for unit testing of the stage-output → product-shape assembly
  // (weight fallback routing, GPSR field-merge, attribute_confidence
  // propagation). Not a stable public API — internal contract may shift
  // between V3 and V4 unification.
  _assembleProduct: assembleProduct,
};
