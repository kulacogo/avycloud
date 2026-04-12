'use strict';

const { isValidGtin, normalizeDigits } = require('./gtin');

/**
 * Post-processing quality pipeline for identify.
 * Applies all quality policies that the chat system uses but identify currently skips.
 *
 * Each step is isolated with try/catch — individual step failure
 * is logged but doesn't crash the pipeline.
 *
 * @param {object} product - Product object (mutated in place)
 * @param {object} groundedRecord - Raw grounding response from Gemini
 * @param {{ locale?: string }} opts
 * @returns {Promise<{ product: object, qualityReport: object }>}
 */
async function runIdentifyQualityPipeline(product, groundedRecord = {}, { locale = 'de-DE' } = {}) {
  const steps = [];

  // Step 1: EAN/GTIN/UPC Validation
  try {
    const result = validateIdentifiers(product);
    steps.push({ step: 'ean_validation', ok: true, ...result });
  } catch (e) {
    steps.push({ step: 'ean_validation', ok: false, error: e.message });
  }

  // Step 2: Web Image URLs from Grounding
  try {
    const result = integrateWebImages(product, groundedRecord);
    steps.push({ step: 'web_images', ok: true, ...result });
  } catch (e) {
    steps.push({ step: 'web_images', ok: false, error: e.message });
  }

  // Step 3: Mobile Snippet
  try {
    const result = integrateMobileSnippet(product, groundedRecord);
    steps.push({ step: 'mobile_snippet', ok: true, ...result });
  } catch (e) {
    steps.push({ step: 'mobile_snippet', ok: false, error: e.message });
  }

  return {
    product,
    qualityReport: { steps, totalIssues: steps.filter(s => !s.ok).length },
  };
}

function validateIdentifiers(product) {
  const ids = product?.details?.identifiers;
  if (!ids) return { validated: 0, discarded: 0 };

  let validated = 0;
  let discarded = 0;

  for (const field of ['ean', 'gtin', 'upc']) {
    const raw = typeof ids[field] === 'string' ? ids[field].trim() : '';
    if (!raw) continue;

    const digits = normalizeDigits(raw);
    if (digits && isValidGtin(digits)) {
      ids[field] = digits;
      validated++;
    } else {
      ids[field] = '';
      discarded++;
    }
  }

  // Also validate barcodes array in identification
  if (Array.isArray(product?.identification?.barcodes)) {
    product.identification.barcodes = product.identification.barcodes.filter(b => {
      const d = normalizeDigits(String(b || ''));
      return d && isValidGtin(d);
    });
  }

  return { validated, discarded };
}

function integrateWebImages(product, groundedRecord) {
  const urls = Array.isArray(groundedRecord?.web_image_urls) ? groundedRecord.web_image_urls : [];
  if (!urls.length) return { added: 0 };

  product.details = product.details || {};
  product.details.images = Array.isArray(product.details.images) ? product.details.images : [];

  const existingUrls = new Set(
    product.details.images.map(i => (i.url_or_base64 || '').split('?')[0].toLowerCase())
  );

  let added = 0;
  for (const url of urls.slice(0, 3)) {
    if (typeof url !== 'string' || !url.startsWith('http')) continue;
    const normalized = url.split('?')[0].toLowerCase();
    if (existingUrls.has(normalized)) continue;

    product.details.images.push({
      url_or_base64: url,
      source: 'grounding_web',
      variant: 'marketing',
    });
    existingUrls.add(normalized);
    added++;
  }
  return { added };
}

function integrateMobileSnippet(product, groundedRecord) {
  const snippet = typeof groundedRecord?.mobile_snippet === 'string'
    ? groundedRecord.mobile_snippet.trim().slice(0, 800)
    : '';
  if (!snippet) return { applied: false };

  product.marketplace = product.marketplace || {};
  product.marketplace.ebay = product.marketplace.ebay || {};
  product.marketplace.ebay.mobile_snippet = snippet;
  return { applied: true };
}

module.exports = { runIdentifyQualityPipeline };
