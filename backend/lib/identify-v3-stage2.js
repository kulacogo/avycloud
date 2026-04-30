'use strict';

const { findEbayCategory, getCategoryAspectCatalog } = require('./ebay-taxonomy');
const { enrichPriceParallel } = require('./price-enrichment');
const { getManufacturerGpsrByName } = require('./gpsr-manufacturer-registry');
const { fetchCategoryTitleInsights } = require('./ebay-browse-title-insights');
const { searchProductImages } = require('./image-search');
const { confirmBarcodeWithWeb } = require('./barcode-web-confirm');
const { lookupWeightFromWeb } = require('./weight-web-lookup');
const { lookupGpsrFromWeb } = require('./gpsr-web-fallback');

// Category-Resolver-V2 is the 4-stage cascade (catalog → suggestions → local → gemini)
// in `services/category-resolver.js`. It produces structurally better results than
// the local string match when GTIN/brand are available (eBay Catalog API beats
// our local taxonomy lookup whenever the product is registered). We require()
// inside the call to avoid an import cycle (category-resolver depends on Gemini).
function _tryRequireCategoryResolverV2() {
  try {
    return require('../services/category-resolver');
  } catch {
    return null;
  }
}

// Feature flags — default ON; set env var to 'false'/'0' to disable.
function envFlag(name, defaultValue = true) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;
  const v = String(raw).trim().toLowerCase();
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return true;
}

function stage2WeightWebLookup() {
  return envFlag('STAGE2_WEIGHT_WEB_FALLBACK', true);
}

function stage2GpsrWebFallback() {
  return envFlag('STAGE2_GPSR_WEB_FALLBACK', true);
}

// Per-lookup hard cap for best-effort web enrichments. Kept well below the V3 master timeout
// (90s) so a single hung HTTP call cannot stall the pipeline. Override via env if needed.
const STAGE2_LOOKUP_TIMEOUT_MS = parseInt(process.env.STAGE2_LOOKUP_TIMEOUT_MS || '12000', 10);
const STAGE2_FALLBACK_TIMEOUT_MS = parseInt(process.env.STAGE2_FALLBACK_TIMEOUT_MS || '15000', 10);

// Race a promise against a timeout. The source promise is wrapped so that a late rejection
// cannot escape as an unhandled rejection (which previously caused stack overflows in the
// V4 pricing-worker — same pattern reused here defensively).
function withTimeout(promise, ms, label) {
  const guarded = Promise.resolve(promise);
  guarded.catch(() => {});
  return Promise.race([
    guarded,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms),
    ),
  ]);
}

function hasMeaningfulGpsr(gpsr) {
  if (!gpsr) return false;
  if (gpsr.found === false) return false;
  const data = gpsr.data || gpsr.gpsr || gpsr;
  if (!data || typeof data !== 'object') return false;
  const hasName = Boolean(data.manufacturer_name);
  const hasAddress = Boolean(data.manufacturer_address);
  const hasEmail = Boolean(data.email || data.manufacturer_email);
  return hasName && (hasAddress || hasEmail);
}

/**
 * Stage 2: Parallel Enrichment
 *
 * Runs 6 independent enrichment sources via Promise.allSettled:
 *   1. Category + Required Aspects (eBay taxonomy)
 *   2. Price (3-source parallel lookup)
 *   3. GPSR (manufacturer registry)
 *   4. Title Insights (eBay competitor titles)
 *   5. Web Images (SerpAPI image search)
 *   6. Barcode Confirmation (web verification)
 *
 * Individual failures are isolated and don't block other enrichments.
 */
async function runStage2Enrichment(stage1, locale = 'de-DE') {
  const startTime = Date.now();
  const identity = stage1.identity || {};
  const barcodes = stage1.barcodes || {};

  // Build temporary product for enrichment functions that expect Product shape
  const tempProduct = {
    identification: {
      name: `${identity.brand} ${identity.model}`.trim(),
      brand: identity.brand || '',
      category: identity.internalCategory || '',
      barcodes: barcodes.ranked?.map((r) => r.code).filter(Boolean) || [],
    },
    details: {
      identifiers: {
        ean: barcodes.ean || '',
        gtin: barcodes.gtin || '',
        upc: barcodes.upc || '',
        mpn: identity.mpn || '',
      },
      attributes: {},
      images: (stage1.uploadedImages || []).map((img) => ({
        url_or_base64: img.url,
        source: 'upload',
        variant: 'reference',
      })),
      pricing: {},
    },
  };

  // Build image search query
  const imageQuery = [identity.brand, identity.model, barcodes.ean || barcodes.gtin]
    .filter(Boolean)
    .join(' ')
    .trim();

  // ─── Category resolution ───────────────────────────────────────────────
  //
  // We run TWO category resolvers in parallel:
  //  - findEbayCategory(): local breadcrumb-string lookup (instant, but only
  //    matches what's already in our local taxonomy — gemini-vision phantom
  //    categories like "Bootsport" for Anker Powerbanks fall through).
  //  - resolveCategoryV2(): 4-stage cascade (eBay Catalog by GTIN → eBay
  //    Taxonomy Suggestions → local lookup → Gemini fallback). Confidence-
  //    aware. This is the production-grade resolver used by the admin
  //    bulk-recategorize. Returns `{ categoryId, breadcrumb, source, confidence }`.
  //
  // Selection rule (the new behaviour, default ON via STAGE2_USE_CATEGORY_V2):
  //  - If V2 returns a result with confidence >= ACCEPT_THRESHOLD (0.85): use V2.
  //  - Otherwise fall back to the local match (same behaviour as before).
  //  - On any failure: use the local match — V2 must never break Stage 2.
  //
  // The previous behaviour can be re-enabled via STAGE2_USE_CATEGORY_V2=false.
  const useV2 = envFlag('STAGE2_USE_CATEGORY_V2', true);
  const localMatch = findEbayCategory(identity.internalCategory);
  let categoryMatch = localMatch;
  let categoryId = localMatch?.id || '';
  let categoryResolveMeta = { source: 'local', confidence: localMatch ? 0.9 : 0 };

  if (useV2) {
    try {
      const resolverModule = _tryRequireCategoryResolverV2();
      if (resolverModule && typeof resolverModule.resolveCategoryV2 === 'function') {
        const v2TimeoutMs = parseInt(process.env.STAGE2_CATEGORY_V2_TIMEOUT_MS || '8000', 10);
        const v2Result = await withTimeout(
          resolverModule.resolveCategoryV2(tempProduct, { reason: 'identify-v3-stage2' }),
          v2TimeoutMs,
          'CategoryResolverV2',
        ).catch((err) => {
          console.warn('[stage2] category-resolver-v2 failed:', err?.message || err);
          return null;
        });
        const acceptThreshold = resolverModule.STRATEGY_ACCEPT_THRESHOLD || 0.85;
        if (
          v2Result &&
          v2Result.categoryId &&
          typeof v2Result.confidence === 'number' &&
          v2Result.confidence >= acceptThreshold
        ) {
          categoryId = String(v2Result.categoryId);
          categoryMatch = {
            id: categoryId,
            breadcrumb: v2Result.breadcrumb || localMatch?.breadcrumb || identity.internalCategory || '',
          };
          categoryResolveMeta = {
            source: `v2:${v2Result.source}`,
            confidence: v2Result.confidence,
            keywordMatch: v2Result.keywordMatch,
            confidenceBreakdown: v2Result.confidenceBreakdown,
            alternatives: Array.isArray(v2Result.alternatives) ? v2Result.alternatives.slice(0, 3) : [],
          };
        } else if (v2Result && v2Result.categoryId) {
          // V2 found something but below threshold — keep local, log for telemetry.
          categoryResolveMeta.v2BelowThreshold = {
            categoryId: v2Result.categoryId,
            breadcrumb: v2Result.breadcrumb,
            source: v2Result.source,
            confidence: v2Result.confidence,
          };
        }
      }
    } catch (err) {
      console.warn('[stage2] category-resolver-v2 wrapper error:', err?.message || err);
    }
  }

  // Run all 6 enrichments in parallel
  const enrichmentResults = {};
  const [
    aspectsResult,
    priceResult,
    gpsrResult,
    titleInsightsResult,
    webImagesResult,
    barcodeConfirmResult,
  ] = await Promise.allSettled([
    // 1. Category Aspects
    (async () => {
      if (!categoryId) return { requiredAspects: [], catalog: null };
      const catalog = getCategoryAspectCatalog(categoryId);
      const requiredAspects = catalog?.required?.map((a) => a.name || a) || [];
      return { requiredAspects, catalog };
    })(),

    // 2. Price Enrichment (capped at 15s — non-blocking, can be enriched later)
    (async () => {
      try {
        const priceData = await Promise.race([
          enrichPriceParallel(tempProduct, { force: true, reason: 'identify-v3' }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Price enrichment timeout (15s)')), 15000)),
        ]);
        return priceData;
      } catch (err) {
        console.warn('[stage2] Price enrichment failed:', err?.message);
        return null;
      }
    })(),

    // 3. GPSR Registry
    (async () => {
      if (!identity.brand) return { found: false, data: null };
      try {
        const gpsr = await withTimeout(
          getManufacturerGpsrByName(identity.brand),
          STAGE2_LOOKUP_TIMEOUT_MS,
          'GPSR registry',
        );
        return gpsr || { found: false, data: null };
      } catch (err) {
        console.warn('[stage2] GPSR lookup failed:', err?.message);
        return { found: false, data: null };
      }
    })(),

    // 4. Title Insights
    (async () => {
      if (!categoryId) return null;
      try {
        const query = [identity.brand, identity.model].filter(Boolean).join(' ').trim();
        const insights = await withTimeout(
          fetchCategoryTitleInsights({ categoryId, query, limit: 10 }),
          STAGE2_LOOKUP_TIMEOUT_MS,
          'Title insights',
        );
        return insights;
      } catch (err) {
        console.warn('[stage2] Title insights failed:', err?.message);
        return null;
      }
    })(),

    // 5. Web Images
    (async () => {
      if (!imageQuery) return [];
      try {
        const images = await withTimeout(
          searchProductImages(tempProduct, {
            query: imageQuery,
            limit: 5,
            minWidth: 400,
            minHeight: 400,
          }),
          STAGE2_LOOKUP_TIMEOUT_MS,
          'Web image search',
        );
        return images || [];
      } catch (err) {
        console.warn('[stage2] Web image search failed:', err?.message);
        return [];
      }
    })(),

    // 6. Barcode Confirmation
    (async () => {
      const barcode = barcodes.ean || barcodes.gtin || barcodes.upc;
      if (!barcode) return { confirmed: false };
      try {
        const confirmation = await withTimeout(
          confirmBarcodeWithWeb({
            barcode,
            brand: identity.brand,
            mpn: identity.mpn,
          }),
          STAGE2_LOOKUP_TIMEOUT_MS,
          'Barcode confirmation',
        );
        return { confirmed: Boolean(confirmation?.ok), barcode: confirmation?.barcode, evidence: confirmation?.evidence };
      } catch (err) {
        console.warn('[stage2] Barcode confirmation failed:', err?.message);
        return { confirmed: false };
      }
    })(),
  ]);

  // Extract results (fulfilled or null)
  const aspects = aspectsResult.status === 'fulfilled' ? aspectsResult.value : { requiredAspects: [], catalog: null };
  const pricing = priceResult.status === 'fulfilled' ? priceResult.value : null;
  const gpsr = gpsrResult.status === 'fulfilled' ? gpsrResult.value : { found: false, data: null };
  const titleInsights = titleInsightsResult.status === 'fulfilled' ? titleInsightsResult.value : null;
  const webImages = webImagesResult.status === 'fulfilled' ? webImagesResult.value : [];
  const barcodeConfirmation = barcodeConfirmResult.status === 'fulfilled' ? barcodeConfirmResult.value : { confirmed: false };

  // Track which enrichments succeeded
  enrichmentResults.aspects = aspectsResult.status;
  enrichmentResults.pricing = priceResult.status;
  enrichmentResults.gpsr = gpsrResult.status;
  enrichmentResults.titleInsights = titleInsightsResult.status;
  enrichmentResults.webImages = webImagesResult.status;
  enrichmentResults.barcodeConfirmation = barcodeConfirmResult.status;

  // -------------------------------------------------------------------------
  // Web-based fallbacks (best-effort, additive — never block pipeline)
  // -------------------------------------------------------------------------
  const webFallback = {
    weightTried: false,
    weightFound: false,
    gpsrTried: false,
    gpsrFound: false,
  };

  let weightFallback = null;
  let gpsrWebFallback = null;

  const stage1Weight = Number(identity.weight_grams || 0);
  const hasIdentityAnchor = Boolean(identity.brand || identity.model || identity.mpn);
  const needWeightFallback = (!stage1Weight || stage1Weight <= 0) && stage2WeightWebLookup() && hasIdentityAnchor;
  const needGpsrFallback = !hasMeaningfulGpsr(gpsr) && stage2GpsrWebFallback() && Boolean(identity.brand);

  const fallbackJobs = [];
  if (needWeightFallback) {
    webFallback.weightTried = true;
    fallbackJobs.push(
      (async () => {
        try {
          const r = await withTimeout(
            lookupWeightFromWeb(identity),
            STAGE2_FALLBACK_TIMEOUT_MS,
            'Weight web fallback',
          );
          if (r && r.weight_grams) {
            webFallback.weightFound = true;
            weightFallback = r;
          }
        } catch (err) {
          console.warn('[stage2] weight web fallback failed:', err?.message || err);
        }
      })(),
    );
  }
  if (needGpsrFallback) {
    webFallback.gpsrTried = true;
    fallbackJobs.push(
      (async () => {
        try {
          const r = await withTimeout(
            lookupGpsrFromWeb(identity.brand),
            STAGE2_FALLBACK_TIMEOUT_MS,
            'GPSR web fallback',
          );
          if (r && (r.manufacturer_name || r.manufacturer_address || r.manufacturer_email)) {
            webFallback.gpsrFound = true;
            gpsrWebFallback = r;
          }
        } catch (err) {
          console.warn('[stage2] GPSR web fallback failed:', err?.message || err);
        }
      })(),
    );
  }
  if (fallbackJobs.length) {
    await Promise.allSettled(fallbackJobs);
  }

  return {
    category: {
      ebayId: categoryId,
      ebayBreadcrumb: categoryMatch?.breadcrumb || identity.internalCategory || '',
      match: categoryMatch || null,
      resolver: categoryResolveMeta,
    },
    requiredAspects: aspects.requiredAspects || [],
    aspectCatalog: aspects.catalog || null,
    pricing: pricing ? {
      amount: pricing.lowest_price?.amount || pricing.amount || 0,
      currency: pricing.lowest_price?.currency || pricing.currency || 'EUR',
      sources: pricing.lowest_price?.sources || pricing.sources || [],
      confidence: pricing.price_confidence || pricing.confidence || 0.7,
      via: pricing.via || 'enrichPriceParallel',
    } : null,
    gpsr,
    gpsrWebFallback,
    titleInsights,
    webImages: Array.isArray(webImages) ? webImages : [],
    barcodeConfirmation,
    weightFallback,
    _meta: {
      durationMs: Date.now() - startTime,
      enrichmentResults,
      stage2: {
        webFallback,
      },
    },
  };
}

module.exports = {
  runStage2Enrichment,
  stage2WeightWebLookup,
  stage2GpsrWebFallback,
  withTimeout,
};
