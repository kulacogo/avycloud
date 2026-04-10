'use strict';

const { findEbayCategory, getCategoryAspectCatalog } = require('./ebay-taxonomy');
const { enrichPriceParallel } = require('./price-enrichment');
const { getManufacturerGpsrByName } = require('./gpsr-manufacturer-registry');
const { fetchCategoryTitleInsights } = require('./ebay-browse-title-insights');
const { searchProductImages } = require('./image-search');
const { confirmBarcodeWithWeb } = require('./barcode-web-confirm');

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

  // Resolve eBay category synchronously first (needed for aspects + title insights)
  const categoryMatch = findEbayCategory(identity.internalCategory);
  const categoryId = categoryMatch?.id || '';

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

    // 2. Price Enrichment
    (async () => {
      try {
        const priceData = await enrichPriceParallel(tempProduct, { force: true, reason: 'identify-v3' });
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
        const gpsr = await getManufacturerGpsrByName(identity.brand);
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
        const insights = await fetchCategoryTitleInsights({ categoryId, query, limit: 10 });
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
        const images = await searchProductImages(tempProduct, {
          query: imageQuery,
          limit: 5,
          minWidth: 400,
          minHeight: 400,
        });
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
        const confirmation = await confirmBarcodeWithWeb({
          barcode,
          brand: identity.brand,
          mpn: identity.mpn,
        });
        return confirmation || { confirmed: false };
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

  return {
    category: {
      ebayId: categoryId,
      ebayBreadcrumb: categoryMatch?.breadcrumb || identity.internalCategory || '',
      match: categoryMatch || null,
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
    titleInsights,
    webImages: Array.isArray(webImages) ? webImages : [],
    barcodeConfirmation,
    _meta: {
      durationMs: Date.now() - startTime,
      enrichmentResults,
    },
  };
}

module.exports = { runStage2Enrichment };
