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

module.exports = { runIdentifyQualityPipeline };
