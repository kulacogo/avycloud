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
  const sharp = require('sharp');
  const { extractOcrPayload } = require('../lib/vision-ocr');
  const { uploadImage } = require('../lib/storage');

  // 1) OCR + Image Upload (parallel)
  const [ocrPayload, uploadedImages] = await Promise.all([
    extractOcrPayload(files),
    Promise.all(
      files.map(async (f) => {
        if (!f?.buffer) return null;
        try {
          const url = await uploadImage(f.buffer, f.mimetype || 'image/jpeg');
          return { url };
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
        ean: groundedRecord.ean || '',
        gtin: groundedRecord.gtin || '',
        upc: groundedRecord.upc || '',
        mpn: groundedRecord.mpn || '',
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

  // Map web images
  if (Array.isArray(groundedRecord.web_image_urls)) {
    for (const url of groundedRecord.web_image_urls.filter(Boolean).slice(0, 3)) {
      product.details.images.push({
        url_or_base64: url,
        source: 'web_search',
        variant: 'marketing',
      });
    }
  }

  // Map GPSR
  if (groundedRecord.gpsr_manufacturer_name) {
    product.details.gpsr = {
      manufacturer_name: groundedRecord.gpsr_manufacturer_name || '',
      manufacturer_address: groundedRecord.gpsr_manufacturer_address || '',
      manufacturer_email: groundedRecord.gpsr_manufacturer_email || '',
      manufacturer_phone: groundedRecord.gpsr_manufacturer_phone || '',
      manufacturer_country: groundedRecord.gpsr_manufacturer_country || '',
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
