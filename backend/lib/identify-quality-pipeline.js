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

  // Step 4: GPSR Registry Merge
  try {
    const result = await mergeGpsr(product, groundedRecord);
    steps.push({ step: 'gpsr_merge', ok: true, ...result });
  } catch (e) {
    steps.push({ step: 'gpsr_merge', ok: false, error: e.message });
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

async function mergeGpsr(product, groundedRecord) {
  const brand = product?.identification?.brand || groundedRecord?.gpsr_manufacturer_name || '';
  if (!brand) return { source: 'none' };

  // Build GPSR object from grounding flat fields
  const fromGrounding = {};
  if (groundedRecord?.gpsr_manufacturer_name) fromGrounding.manufacturer_name = groundedRecord.gpsr_manufacturer_name;
  if (groundedRecord?.gpsr_manufacturer_address) fromGrounding.manufacturer_address = groundedRecord.gpsr_manufacturer_address;
  if (groundedRecord?.gpsr_manufacturer_email) fromGrounding.email = groundedRecord.gpsr_manufacturer_email;
  if (groundedRecord?.gpsr_manufacturer_phone) fromGrounding.manufacturer_phone = groundedRecord.gpsr_manufacturer_phone;
  if (groundedRecord?.gpsr_manufacturer_country) fromGrounding.country_code = groundedRecord.gpsr_manufacturer_country;

  // Lazy-load registry module (uses Firestore)
  const { getManufacturerGpsrByName, upsertManufacturerGpsr } = require('./gpsr-manufacturer-registry');

  // Lookup registry
  let registryEntry = null;
  try {
    registryEntry = await getManufacturerGpsrByName(brand);
  } catch { /* registry unavailable */ }

  // Merge: grounding fills gaps in registry data (grounding is fresher for new fields)
  const registryGpsr = registryEntry?.gpsr || {};
  const merged = {};

  // Take registry values as base, overlay grounding values (non-empty only)
  for (const key of Object.keys({ ...registryGpsr, ...fromGrounding })) {
    const regVal = typeof registryGpsr[key] === 'string' ? registryGpsr[key].trim() : '';
    const grndVal = typeof fromGrounding[key] === 'string' ? fromGrounding[key].trim() : '';
    merged[key] = grndVal || regVal; // Grounding takes priority when present
  }

  // Store at canonical location
  product.details = product.details || {};
  product.details.gpsr = merged;
  delete product.gpsr; // Remove incorrect top-level location if it exists

  // Upsert new data to registry for future products (best-effort)
  const hasNewData = Object.values(fromGrounding).some(v => typeof v === 'string' && v.trim());
  if (hasNewData) {
    try {
      await upsertManufacturerGpsr({
        manufacturer_name: brand,
        gpsr: fromGrounding,
        sources: ['identify'],
        from_product_id: product.id || null,
        overwrite: false,
      });
    } catch { /* best-effort */ }
  }

  return {
    source: registryEntry ? 'merged' : 'grounding_only',
    fieldsFromRegistry: Object.keys(registryGpsr).filter(k => registryGpsr[k]).length,
    fieldsFromGrounding: Object.keys(fromGrounding).filter(k => fromGrounding[k]).length,
  };
}

module.exports = { runIdentifyQualityPipeline };
