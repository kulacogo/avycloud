'use strict';

/**
 * identify-grounding.js — Google Search Grounding wrapper for the job runner.
 *
 * Returns the same format as runProductIdentification() from enrichment.js:
 *   { bundle: { products: [...] }, serpTrace: [...], modelUsed: string }
 *
 * Uses identifyProductWithGrounding() from gemini3-client.js (single Gemini call
 * with images + Google Search + structured JSON output).
 *
 * ENV: IDENTIFY_GROUNDING=true (default) — job-runner.js selects this pipeline.
 */

const crypto = require('crypto');
const { identifyProductWithGrounding } = require('../lib/gemini3-client');
const { ensureCategories, applyEbayTaxonomy, applyKauflandTaxonomy } = require('./enrichment');
const { enrichKTypIfPossible } = require('../lib/ktype-enrichment');
const { searchProductImages } = require('../lib/image-search');

/**
 * Run product identification via Google Search Grounding.
 *
 * @param {{
 *   files: Array<{buffer: Buffer, mimetype: string, originalname: string}>,
 *   barcodes: string,
 *   locale: string,
 *   modelOverride: string|null,
 *   hint: string|null,
 * }} opts
 * @returns {Promise<{bundle: {products: object[]}, serpTrace: object[], modelUsed: string}>}
 */
async function runProductIdentificationGrounding({
  files = [],
  barcodes = '',
  locale = 'de-DE',
  modelOverride = null,
  hint = null,
} = {}) {
  // ─── IDENTIFY V3: Multi-Stage Pipeline ───
  const V3_ENABLED = String(process.env.IDENTIFY_V3 || 'false').toLowerCase() === 'true';
  if (V3_ENABLED) {
    try {
      const { identifyProductV3 } = require('./identify-v3');
      console.log('[identify-grounding] Using V3 multi-stage pipeline');
      const V3_TIMEOUT_MS = parseInt(process.env.V3_TIMEOUT_MS || '60000', 10);
      const { product, meta } = await Promise.race([
        identifyProductV3({ files, barcodes, locale, hint }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`V3 pipeline timeout after ${V3_TIMEOUT_MS}ms`)), V3_TIMEOUT_MS)
        ),
      ]);

      // Category + Taxonomy (V3 may have resolved, but job-runner expects post-processing)
      try {
        await ensureCategories([product]);
        applyEbayTaxonomy(product);
        applyKauflandTaxonomy(product);
      } catch (e) {
        console.warn('[identify-grounding-v3] Category enrichment failed:', e?.message);
      }
      try {
        await enrichKTypIfPossible(product, { reason: 'identify-grounding-v3' });
      } catch {}

      const serpTrace = meta.stages?.stage1?.groundingUsed ? [{
        type: 'google_search_grounding_v3',
        model: 'gemini-3-pro-preview',
        queries: [],
        sources: [],
      }] : [];

      return {
        bundle: { products: [product] },
        serpTrace,
        modelUsed: 'gemini-3-pro-preview',
      };
    } catch (v3Error) {
      console.warn('[identify-grounding] V3 pipeline failed, falling back to V2:', v3Error?.message);
      // Fall through to existing V2 grounding pipeline
    }
  }

  const sharp = require('sharp');
  const { extractOcrPayload } = require('../lib/vision-ocr');
  const { uploadImage } = require('../lib/storage');

  // 1) OCR + Image Upload (parallel)
  const [ocrPayload, uploadedImages] = await Promise.all([
    extractOcrPayload(files),
    Promise.all(
      files.map(async (f, idx) => {
        if (!f?.buffer) return null;
        try {
          const result = await uploadImage(f.buffer, f.mimetype || 'image/jpeg', 'identify-uploads', `v2_${Date.now()}_${idx}`);
          return { url: result.url, width: result.width, height: result.height };
        } catch { return null; }
      })
    ).then((results) => results.filter(Boolean)),
  ]);

  // 2) Merge barcodes
  const mergedBarcodes = [
    ...new Set([
      ...(barcodes ? barcodes.split(/[\s,;|]+/).filter(Boolean) : []),
      ...(ocrPayload.barcodes || []),
    ]),
  ];

  // 3) Build inline image parts (compressed, base64)
  const MAX_IMAGES = 4;
  const MAX_EDGE = 1600;
  const JPEG_QUALITY = 78;
  const imageParts = [];
  for (const f of files.slice(0, MAX_IMAGES)) {
    if (!f?.buffer || !f?.mimetype?.startsWith('image/')) continue;
    try {
      const compressed = await sharp(f.buffer)
        .rotate()
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: '4:2:0' })
        .toBuffer();
      imageParts.push({
        data: compressed.toString('base64'),
        mimeType: 'image/jpeg',
      });
    } catch {
      // Skip unprocessable image
    }
  }

  if (!imageParts.length && !mergedBarcodes.length) {
    throw new Error('Grounding pipeline requires at least one image or barcode');
  }

  const ocrText = (ocrPayload.textSnippets || []).filter(Boolean).join('\n');

  // 4) Run grounding call
  console.log(`[identify-grounding] Starting (${imageParts.length} images, ${mergedBarcodes.length} barcodes)`);
  const groundedRecord = await identifyProductWithGrounding({
    imageParts,
    ocrText,
    barcodes: mergedBarcodes,
    locale,
    hint,
  });

  // 5) Map grounded record to product format
  const productId = crypto.randomUUID();
  const product = {
    id: productId,
    identification: {
      name: groundedRecord.title_ebay || '',
      brand: groundedRecord.brand || 'unknown',
      category: groundedRecord.internalCategory || '',
      sku: groundedRecord.sku || '',
      barcodes: mergedBarcodes,
    },
    details: {
      categoryId: null,
      short_description: groundedRecord.description_ebay || '',
      key_features: Array.isArray(groundedRecord.key_features) ? groundedRecord.key_features : [],
      attributes: {},
      identifiers: {
        ean: groundedRecord.ean != null ? String(groundedRecord.ean).trim() : '',
        gtin: groundedRecord.gtin != null ? String(groundedRecord.gtin).trim() : '',
        upc: groundedRecord.upc != null ? String(groundedRecord.upc).trim() : '',
        mpn: groundedRecord.mpn != null ? String(groundedRecord.mpn).trim() : '',
      },
      images: uploadedImages.map((img) => ({
        url_or_base64: img.url,
        source: 'upload',
        variant: 'reference',
      })),
      pricing: {},
      condition: groundedRecord.condition || 'Neu',
    },
    marketplace: {
      ebay: {
        title: groundedRecord.title_ebay || '',
        description: groundedRecord.description_ebay || '',
      },
      kaufland: {
        title: groundedRecord.title_kaufland || '',
        description: groundedRecord.description_kaufland || '',
      },
    },
    ops: {
      weight_grams: groundedRecord.weight_grams || null,
      identify_pipeline: 'grounding',
    },
    notes: {},
  };

  // Map item_specifics → attributes
  if (Array.isArray(groundedRecord.item_specifics)) {
    for (const spec of groundedRecord.item_specifics) {
      if (spec?.key && spec?.value) {
        product.details.attributes[spec.key] = String(spec.value).slice(0, 60);
      }
    }
  }

  // Map price
  if (groundedRecord.price_eur && groundedRecord.price_eur > 0) {
    product.details.pricing = {
      lowest_price: {
        amount: groundedRecord.price_eur,
        currency: 'EUR',
        sources: groundedRecord.price_source_url
          ? [{ url: groundedRecord.price_source_url, name: groundedRecord.price_source_name || 'web' }]
          : [],
        last_checked_iso: new Date().toISOString(),
      },
      price_confidence: 0.75,
    };
  }

  // Map web images — use SerpAPI for real URLs instead of Gemini-hallucinated ones
  try {
    const imageQuery = [
      groundedRecord.brand,
      groundedRecord.model,
      groundedRecord.ean || groundedRecord.gtin,
    ].filter(Boolean).join(' ').trim();
    if (imageQuery) {
      console.log(`[identify-grounding] SerpAPI image search: "${imageQuery}"`);
      const serpImages = await searchProductImages(product, {
        query: imageQuery,
        limit: 3,
        minWidth: 400,
        minHeight: 400,
      });
      for (const img of serpImages) {
        product.details.images.push({
          url_or_base64: img.url,
          source: 'web_search',
          variant: 'marketing',
          notes: img.title || '',
        });
      }
      console.log(`[identify-grounding] SerpAPI found ${serpImages.length} real images`);
    }
  } catch (imgErr) {
    console.warn('[identify-grounding] SerpAPI image search failed:', imgErr?.message);
    // Non-blocking — continue without web images
  }

  // Map GPSR — canonical field names per schema (siehe routes/identify.js:686-692).
  // BUGFIX (2026-07): vorher `manufacturer_email` + `manufacturer_country` — beides
  // NICHT-kanonische Keys, die normalizeGpsrObject (lib/gpsr-manufacturer-registry.js)
  // still droppt (Whitelist kennt nur `email` + `entity_country`). Folge: GPSR-Email
  // und -Land wurden verworfen und nie publiziert.
  if (groundedRecord.gpsr_manufacturer_name) {
    product.details.gpsr = {
      manufacturer_name: groundedRecord.gpsr_manufacturer_name || '',
      manufacturer_address: groundedRecord.gpsr_manufacturer_address || '',
      email: groundedRecord.gpsr_manufacturer_email || '',
      manufacturer_phone: groundedRecord.gpsr_manufacturer_phone || '',
      entity_country: groundedRecord.gpsr_manufacturer_country || '',
    };
  }

  // Grounding metadata
  if (groundedRecord._grounding) {
    product.ops.identify_grounding = groundedRecord._grounding;
  }
  if (groundedRecord.notes) {
    product.notes.identify_notes = groundedRecord.notes;
  }

  // 6) Category + Taxonomy + K-Typ
  try {
    await ensureCategories([product]);
    applyEbayTaxonomy(product);
    applyKauflandTaxonomy(product);
  } catch (e) {
    console.warn('[identify-grounding] Category/taxonomy enrichment failed:', e?.message);
  }

  try {
    await enrichKTypIfPossible(product, { reason: 'identify-grounding' });
  } catch (e) {
    // Non-blocking
  }

  console.log(`[identify-grounding] Complete for ${productId}: "${product.identification.name}"`);

  // 7) Return in job-runner compatible format
  const serpTrace = groundedRecord._grounding ? [{
    type: 'google_search_grounding',
    model: groundedRecord._grounding.model,
    queries: groundedRecord._grounding.searchQueries || [],
    sources: groundedRecord._grounding.sources || [],
  }] : [];

  return {
    bundle: {
      products: [product],
    },
    serpTrace,
    modelUsed: groundedRecord._grounding?.model || 'gemini-3-pro-preview',
  };
}

module.exports = {
  runProductIdentificationGrounding,
};
