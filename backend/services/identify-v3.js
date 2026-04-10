'use strict';

const crypto = require('crypto');
const { runStage1Recognition } = require('../lib/identify-v3-stage1');
const { runStage2Enrichment } = require('../lib/identify-v3-stage2');
const { runStage3ContentGeneration } = require('../lib/identify-v3-stage3');
const { runStage4Validation } = require('../lib/identify-v3-stage4');

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

  // Stage 4: Validation (synchronous scoring)
  const stage4 = runStage4Validation(stage1, stage2, stage3, product);

  // Attach quality metadata to product
  product.ops = product.ops || {};
  product.ops.data_quality = product.ops.data_quality || {};
  product.ops.data_quality.identify_v3 = {
    checked_at_iso: new Date().toISOString(),
    overall_score: stage4.overallScore,
    field_confidence: stage4.fieldConfidence,
    aspect_coverage: stage4.requiredAspectsCoverage,
    marketplace_readiness: stage4.marketplaceReadiness,
  };

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

  // Category: prefer Stage 2 resolved eBay breadcrumb
  const category = stage2.category?.ebayBreadcrumb || identity.internalCategory || 'Unkategorisiert';
  const categoryId = stage2.category?.ebayId || null;

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

  // Images: uploads + web search results
  const images = [
    ...(stage1.uploadedImages || []).map((img) => ({
      url_or_base64: img.url,
      source: 'upload',
      variant: 'reference',
    })),
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

  // GPSR: prefer registry data, fallback to Stage 3 generated
  let gpsr;
  if (stage2.gpsr?.found && stage2.gpsr?.data) {
    gpsr = stage2.gpsr.data;
  } else if (stage3.gpsr_manufacturer_name) {
    gpsr = {
      manufacturer_name: stage3.gpsr_manufacturer_name || '',
      manufacturer_address: stage3.gpsr_manufacturer_address || '',
      email: stage3.gpsr_manufacturer_email || '',
      manufacturer_phone: stage3.gpsr_manufacturer_phone || '',
      entity_country: stage3.gpsr_manufacturer_country || '',
    };
  }

  return {
    id,
    locale: opts.locale || 'de-DE',
    identification: {
      method: barcodeArray.length && !stage1.uploadedImages?.length ? 'barcode' : 'image',
      barcodes: barcodeArray.length ? barcodeArray : undefined,
      name,
      brand: identity.brand || '',
      category,
      confidence: 0.8, // Will be overwritten by Stage 4
      sku: undefined, // Allocated by saveProductV2
    },
    details: {
      categoryId: categoryId || undefined,
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
    },
    marketplace: {
      ebay: {
        title: titleEbay,
        description: stage3.description_ebay || '',
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
      weight_grams: identity.weight_grams || null,
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

module.exports = { identifyProductV3 };
