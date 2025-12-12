const { getProduct, saveProduct } = require('../lib/firestore');
const {
  runProductIdentification,
  runDatasheetReview,
  applyEbayTaxonomy,
  applyKauflandTaxonomy,
} = require('./enrichment');
const { fetchWithUnlocker } = require('../lib/web-unlocker');

const MAX_REFERENCE_IMAGES = parseInt(process.env.IMPROVE_REFERENCE_IMAGES || '4', 10);
const LENS_UPLOAD_PATTERN = /\/uploads\/(identify|improve)_/i;
const GENERATED_IMAGE_SIGNATURE = /\b(generated|gpt|gemini|ai[-\s]?image|ai[-\s]?render)\b/i;
const PACKAGING_REGEX = /(etikett|karton|verpackung|sichtbar)/i;
const ATTRIBUTE_BLACKLIST = new Set([
  'key features',
  'keyfeatures',
  'highlights',
  'bullets',
  'bullet points',
  'beschreibung',
  'kurzbeschreibung',
  'features',
]);

function collectBarcodes(product) {
  const codes = new Set(
    Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : []
  );
  const identifiers = product?.details?.identifiers || {};
  ['ean', 'gtin', 'upc'].forEach((key) => {
    if (identifiers[key]) {
      codes.add(String(identifiers[key]));
    }
  });
  return Array.from(codes).filter(Boolean).join(', ');
}

function buildImproveContext(product) {
  const lines = [];
  lines.push(`Aktueller Titel: ${product?.identification?.name || 'unbekannt'}`);
  lines.push(`Marke: ${product?.identification?.brand || 'unbekannt'}`);
  lines.push(`Kategorie: ${product?.identification?.category || 'unbekannt'}`);
  if (product?.details?.short_description) {
    lines.push(`Beschreibung:\n${product.details.short_description}`);
  }
  if (Array.isArray(product?.details?.key_features) && product.details.key_features.length) {
    lines.push(`Highlights:\n- ${product.details.key_features.join('\n- ')}`);
  }
  const attributes = product?.details?.attributes;
  if (attributes) {
    if (Array.isArray(attributes)) {
      lines.push(
        `Attribute:\n${attributes
          .map((entry) => `• ${entry?.key}: ${entry?.value}`)
          .filter(Boolean)
          .join('\n')}`
      );
    } else {
      lines.push(
        `Attribute:\n${Object.entries(attributes)
          .map(([key, value]) => `• ${key}: ${value}`)
          .join('\n')}`
      );
    }
  }
  const price = product?.details?.pricing?.lowest_price;
  if (price?.amount) {
    lines.push(`Aktueller Preis: ${price.amount} ${price.currency || 'EUR'}`);
  }
  return lines.join('\n');
}

function cleanAttributeValue(value) {
  if (typeof value === 'string') {
    return value.replace(/\s+/g, ' ').trim();
  }
  return value;
}

function sanitizeKeyFeatures(features = [], limit = 7) {
  if (!Array.isArray(features) || !features.length) {
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const raw of features) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.replace(/\s+/g, ' ').trim();
    if (trimmed.length < 8) continue;
    if (PACKAGING_REGEX.test(trimmed)) continue;
    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(trimmed);
    if (result.length >= limit) break;
  }
  return result;
}

function attributeQuality(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    return Math.min(500, trimmed.length);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return 400;
  }
  if (typeof value === 'boolean') {
    return 200;
  }
  return 0;
}

function normalizeAttributePairs(source) {
  if (!source) return [];
  if (Array.isArray(source)) {
    return source
      .map((entry) => [entry?.key, entry?.value])
      .filter(([key]) => typeof key === 'string' && key.trim());
  }
  return Object.entries(source).filter(([key]) => typeof key === 'string' && key.trim());
}

function normalizeImageKey(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return `${parsed.hostname}${parsed.pathname}`.toLowerCase();
  } catch {
    return value.toString().trim().toLowerCase() || null;
  }
}

function looksGeneratedImage(image = {}) {
  if (!image || typeof image !== 'object') return false;
  const source = (image.source || '').toString().toLowerCase();
  const notes = (image.notes || '').toString().toLowerCase();
  if (GENERATED_IMAGE_SIGNATURE.test(source) || GENERATED_IMAGE_SIGNATURE.test(notes)) {
    return true;
  }
  return false;
}

function classifyImageSource(image = {}, isExisting = false) {
  if (looksGeneratedImage(image)) {
    return 'generated';
  }
  return isExisting ? 'fallback' : 'reference';
}

function shouldSkipIncomingImage(image, existingKeys) {
  if (!image) return true;
  const url = image.url_or_base64 || image.url;
  if (!url) return true;
  if (LENS_UPLOAD_PATTERN.test(url)) {
    return true;
  }
  const key = normalizeImageKey(url);
  if (key && existingKeys.has(key)) {
    return true;
  }
  return false;
}

function mergeAttributes(existing, incoming) {
  const map = new Map();

  const ingest = (pairs, isIncoming) => {
    for (const [rawKey, rawValue] of normalizeAttributePairs(pairs)) {
      const normalizedKey = rawKey.trim().toLowerCase();
      if (!normalizedKey) continue;
      if (ATTRIBUTE_BLACKLIST.has(normalizedKey)) continue;
      const displayKey = rawKey.trim().replace(/\s+/g, ' ');
      const cleanedValue = cleanAttributeValue(rawValue);
      const quality = attributeQuality(cleanedValue);
      if (!map.has(normalizedKey)) {
        map.set(normalizedKey, {
          key: displayKey,
          value: cleanedValue,
          quality,
        });
        continue;
      }
      const current = map.get(normalizedKey);
      const isMeaningful = quality > 0;
      if (!isMeaningful) {
        continue;
      }
      const shouldOverride =
        quality > current.quality ||
        (isIncoming && quality === current.quality) ||
        (!current.quality && isMeaningful);
      if (shouldOverride) {
        map.set(normalizedKey, {
          key: displayKey,
          value: cleanedValue,
          quality,
        });
      }
    }
  };

  ingest(existing, false);
  ingest(incoming, true);

  const result = {};
  for (const { key, value } of map.values()) {
    if (!key) continue;
    const cleanedKey = key || '';
    result[cleanedKey] = typeof value === 'string' ? value.trim() : value;
  }
  return result;
}

function isValidSku(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.length > 64) return false;
  return /^[A-Za-z0-9._\-\/]+$/.test(trimmed);
}

function mergeIdentifiers(existing = {}, incoming = {}) {
  const merged = { ...(existing || {}) };
  Object.entries(incoming || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string' && !value.trim()) {
      return;
    }
    if (key === 'sku') {
      if (!isValidSku(value)) return;
      const existingSku = typeof existing?.sku === 'string' ? existing.sku.trim() : '';
      const incomingSku = value.trim();
      // SKU is immutable once set: keep the first non-empty SKU
      if (existingSku && existingSku !== incomingSku) return;
    }
    merged[key] = typeof value === 'string' ? value.trim() : value;
  });
  return merged;
}

function mergeKeyFeatures(existing = [], incoming = []) {
  const result = [];
  const seen = new Set();
  const addList = (list) => {
    if (!Array.isArray(list)) return;
    list.forEach((item) => {
      if (typeof item !== 'string') return;
      const cleaned = item.replace(/\s+/g, ' ').trim();
      if (!cleaned) return;
      const signature = cleaned.toLowerCase();
      if (seen.has(signature)) return;
      seen.add(signature);
      result.push(cleaned);
    });
  };
  addList(incoming);
  addList(existing);
  return result;
}

function mergeImages(existing = [], incoming = []) {
  // Safety Check: If incoming is empty or invalid, return existing to strictly prevent data loss
  if (!incoming || (Array.isArray(incoming) && incoming.length === 0)) {
    if (Array.isArray(existing) && existing.length > 0) {
      console.log('[mergeImages] Incoming images empty. Preserving existing images.');
      return existing;
    }
  }

  const existingKeys = new Set(
    (existing || [])
      .map((img) => normalizeImageKey(img?.url_or_base64 || img?.url))
      .filter(Boolean)
  );
  const dedupe = new Set();
  const buckets = {
    generated: [],
    reference: [],
    fallback: [],
  };

  const pushToBucket = (image, bucket) => {
    if (!image || typeof image !== 'object') return;
    const url = image.url_or_base64 || image.url;
    if (!url) {
      return;
    }
    const key = normalizeImageKey(url);
    if (key && dedupe.has(key)) {
      return;
    }
    if (key) {
      dedupe.add(key);
      existingKeys.add(key);
    }
    buckets[bucket].push({ ...image });
  };

  if (Array.isArray(incoming)) {
    incoming.forEach((image) => {
      const url = image.url_or_base64 || image.url;
      if (url && LENS_UPLOAD_PATTERN.test(url)) {
        return;
      }
      if (shouldSkipIncomingImage(image, existingKeys)) {
        return;
      }
      const bucket = classifyImageSource(image, false);
      if (bucket === 'generated') {
        // Keep incoming generated images if they are new, but maybe deprioritize?
        // Actually, let's keep them.
      }
      pushToBucket(image, bucket);
    });
  }

  if (Array.isArray(existing)) {
    existing.forEach((image) => {
      if (!image) return;
      const bucket = classifyImageSource(image, true);
      pushToBucket(image, bucket);
    });
  }

  // Restore generated bucket to ensure we don't lose images
  let combined = [...buckets.generated, ...buckets.reference, ...buckets.fallback];
  return combined.slice(0, 10);
}

function textQuality(text) {
  if (typeof text !== 'string') return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const sentenceCount = trimmed.split(/[.!?]/).filter((part) => part.trim()).length || 1;
  return Math.min(2000, trimmed.length + sentenceCount * 10);
}

function pickBetterText(existing, incoming) {
  const incomingQuality = textQuality(incoming);
  const existingQuality = textQuality(existing);
  if (incomingQuality === 0 && existingQuality === 0) return '';
  if (incomingQuality === 0) return existing?.trim() || '';
  if (existingQuality === 0) return incoming?.trim() || '';
  return incomingQuality >= existingQuality ? incoming.trim() : existing.trim();
}

function mergeNotes(existing = {}, incoming = {}) {
  const mergeList = (primary = [], secondary = []) => {
    const set = new Set();
    const combined = [];
    const add = (value) => {
      if (typeof value !== 'string') return;
      const cleaned = value.replace(/\s+/g, ' ').trim();
      if (!cleaned) return;
      const key = cleaned.toLowerCase();
      if (set.has(key)) return;
      set.add(key);
      combined.push(cleaned);
    };
    (Array.isArray(primary) ? primary : []).forEach(add);
    (Array.isArray(secondary) ? secondary : []).forEach(add);
    return combined;
  };

  const unsure = mergeList(incoming?.unsure, existing?.unsure);
  const warnings = mergeList(incoming?.warnings, existing?.warnings);
  const notes = {};
  if (unsure.length) notes.unsure = unsure;
  if (warnings.length) notes.warnings = warnings;
  return Object.keys(notes).length ? notes : undefined;
}

function mergeBarcodes(existing = [], incoming = []) {
  const set = new Set();
  const add = (list) => {
    if (!Array.isArray(list)) return;
    list.forEach((code) => {
      if (code && typeof code === 'string') {
        const trimmed = code.trim();
        if (trimmed) set.add(trimmed);
      }
    });
  };
  add(existing);
  add(incoming);
  return Array.from(set);
}

function mergeDetails(existing = {}, incoming = {}) {
  const merged = {
    ...(existing || {}),
    ...(incoming || {}),
  };
  // GPSR data is now supported
  merged.gpsr = { ...(existing?.gpsr || {}), ...(incoming?.gpsr || {}) };
  merged.short_description = pickBetterText(existing?.short_description, incoming?.short_description);
  merged.key_features = mergeKeyFeatures(existing?.key_features, incoming?.key_features);
  merged.key_features = sanitizeKeyFeatures(merged.key_features);
  merged.attributes = mergeAttributes(existing?.attributes, incoming?.attributes);
  merged.images = mergeImages(existing?.images, incoming?.images);
  merged.identifiers = mergeIdentifiers(existing?.identifiers, incoming?.identifiers);
  merged.pricing = incoming?.pricing || existing?.pricing || null;
  return merged;
}

function isValidString(str) {
  return str && typeof str === 'string' && str.trim().length > 0 && !/unbekannt|unknown|nicht angegeben/i.test(str);
}

function pickBetterTitle(existing = '', incoming = '', brand = '') {
  const result = (() => {
    const exValid = isValidString(existing);
    const incValid = isValidString(incoming);

    if (!exValid && !incValid) return '';
    if (exValid && !incValid) return existing.trim();
    if (!exValid && incValid) return incoming.trim();

    // Both are valid strings. Compare quality.
    const ex = existing.trim();
    const inc = incoming.trim();

    // 1. Prefer title containing the Brand
    if (brand && isValidString(brand)) {
      const brandLower = brand.toLowerCase();
      const exHas = ex.toLowerCase().includes(brandLower);
      const incHas = inc.toLowerCase().includes(brandLower);
      if (exHas && !incHas) return ex;
      if (!exHas && incHas) return inc;
    }

    // 2. Prefer significantly longer title (usually more descriptive)
    // But cap it? No, marketplace titles are usually 80-150 chars.
    if (inc.length > ex.length + 10) return inc;
    if (ex.length > inc.length + 10) return ex;

    // 3. Fallback to incoming if roughly equal, assuming it might be "fresher" or normalized
    return inc;
  })();
  // console.log(`[pickTitle] Existing: "${existing.substring(0, 20)}..." | Incoming: "${incoming.substring(0, 20)}..." | Choice: "${result.substring(0, 20)}..."`);
  return result;
}

function mergeProductRecords(existing, incoming) {
  console.log('[mergeProductRecords] Starting merge...');
  console.log('[mergeProductRecords] Incoming product keys:', Object.keys(incoming));
  console.log('[mergeProductRecords] Existing product keys:', Object.keys(existing));
  // Start with a deep copy of existing to ensure we don't accidentally lose deep properties
  // or overwrite them with shallow spreads.
  const merged = JSON.parse(JSON.stringify(existing));

  // 1. Identification: Safe Merge
  if (incoming.identification) {
    const incId = incoming.identification;

    // Smart Title Selection
    const oldTitle = merged.identification.name;
    merged.identification.name = pickBetterTitle(
      merged.identification.name,
      incId.name,
      incId.brand || merged.identification.brand
    );
    if (merged.identification.name !== oldTitle) {
      console.log('[mergeProductRecords] Title updated.');
    }

    if (isValidString(incId.brand)) {
      if (merged.identification.brand !== incId.brand) console.log('[mergeProductRecords] Brand updated.');
      merged.identification.brand = incId.brand;
    }

    if (isValidString(incId.category)) {
      if (merged.identification.category !== incId.category) console.log('[mergeProductRecords] Category updated.');
      merged.identification.category = incId.category;
    }

    // Barcodes: STRICT UNION. Never lose a barcode.
    merged.identification.barcodes = mergeBarcodes(
      merged.identification.barcodes,
      incId.barcodes
    );
  }

  // 2. Details: Safe Merge
  if (incoming.details) {
    merged.details = merged.details || {};
    const incDet = incoming.details;

    // Text Content
    merged.details.short_description = pickBetterText(merged.details.short_description, incDet.short_description);

    // Features (Union + Dedupe)
    merged.details.key_features = mergeKeyFeatures(merged.details.key_features, incDet.key_features);
    merged.details.key_features = sanitizeKeyFeatures(merged.details.key_features);

    // Attributes (Merge, keep existing if meaningful)
    console.log(`[mergeProductRecords] Merging attributes. Existing keys: ${Object.keys(merged.details.attributes || {}).length}, Incoming keys: ${Object.keys(incDet.attributes || {}).length}`);
    merged.details.attributes = mergeAttributes(merged.details.attributes, incDet.attributes);
    console.log(`[mergeProductRecords] Merged attributes count: ${Object.keys(merged.details.attributes || {}).length}`);

    // Images: User requested strict preservation.
    // The "Improve" workflow should NOT modify, add, or delete images.
    // We ignore 'incDet.images' entirely to prevent "No Image" placeholders or data loss.
    merged.details.images = existing.details?.images || [];

    // Identifiers (Merge keys)
    merged.details.identifiers = mergeIdentifiers(merged.details.identifiers, incDet.identifiers);

    // Pricing: Only update if incoming has valid pricing data
    if (incDet.pricing && incDet.pricing.lowest_price) {
      merged.details.pricing = incDet.pricing;
    }

    // GPSR
    if (incDet.gpsr) {
      merged.details.gpsr = { ...(merged.details.gpsr || {}), ...incDet.gpsr };
    }
  }

  // 3. Operational Data: Preserve Inventory/Storage strictly
  // Improve workflow should NEVER change stock or bin locations.
  // existing.inventory and existing.storage are already in 'merged' from the deep copy.
  // We simply ensure we don't copy over any accidental nulls from incoming.

  // Update revision and sync status
  merged.ops = merged.ops || {};
  merged.ops.revision = (merged.ops.revision || 0) + 1;
  merged.ops.sync_status = 'pending';
  merged.ops.updated_at_iso = new Date().toISOString();
  console.log('[mergeProductRecords] Updated ops fields.');

  // Protect critical fields
  console.log('[mergeProductRecords] Protecting critical fields (inventory, storage, storageBins).');
  merged.inventory = existing.inventory;
  merged.storage = existing.storage;
  merged.storageBins = existing.storageBins;

  // 4. Notes
  merged.notes = mergeNotes(merged.notes, incoming.notes);

  console.log('[mergeProductRecords] Merged product keys (final):', Object.keys(merged));
  console.log('[mergeProductRecords] Finished merge.');
  return merged;
}

const IMPROVE_REFERENCE_TIMEOUT_MS = parseInt(process.env.IMPROVE_REFERENCE_TIMEOUT_MS || '20000', 10);

async function downloadImageBuffer(url, index) {
  if (!url || typeof url !== 'string') return null;
  try {
    const result = await fetchWithUnlocker({
      url,
      method: 'GET',
      format: 'raw',
      timeoutMs: IMPROVE_REFERENCE_TIMEOUT_MS,
      headers: {
        'User-Agent': 'avystock-improve/1.0',
        Accept: 'image/*,*/*;q=0.8',
      },
    });
    if (!result.success) {
      throw new Error(result.error || 'Unlocker request failed');
    }
    const mimeType = result.contentType || 'image/jpeg';
    if (!mimeType.startsWith('image/')) {
      throw new Error(`Unexpected content-type ${mimeType}`);
    }
    const buffer = result.body_base64
      ? Buffer.from(result.body_base64, 'base64')
      : Buffer.from(result.body || '', 'binary');
    return {
      fieldname: 'images',
      originalname: `improve_${index}`,
      encoding: '7bit',
      mimetype: mimeType,
      size: buffer.length,
      buffer,
    };
  } catch (error) {
    console.warn(`Failed to download reference image ${url}:`, error.message);
    return null;
  }
}

async function buildReferenceFiles(product) {
  const images = Array.isArray(product?.details?.images) ? product.details.images : [];
  const candidates = images
    .filter((img) => typeof img?.url_or_base64 === 'string' && img.url_or_base64.startsWith('http'))
    .slice(0, MAX_REFERENCE_IMAGES);

  const files = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const file = await downloadImageBuffer(candidates[i].url_or_base64, i);
    if (file) {
      files.push(file);
    }
  }
  return files;
}

async function improveExistingProduct(productId, onProgress) {
  console.log(`[improveExistingProduct] Starting for ${productId}`);
  const product = await getProduct(productId);
  if (!product) {
    const error = new Error('Produkt wurde nicht gefunden.');
    error.code = 404;
    throw error;
  }

  if (onProgress) await onProgress('downloading_images');
  console.log('[improve] Downloading reference images...');
  const files = await buildReferenceFiles(product);
  const barcodes = collectBarcodes(product);

  console.log(`[improve] Running Identification. Files: ${files.length}, Barcodes: ${barcodes.length}`);

  // If we have no files and no barcodes, we can't identify.
  if (files.length === 0 && barcodes.length === 0) {
    console.warn('[improve] No reference images downloadable and no barcodes. Skipping identification.');
    // Return original product or fail? Fail is better so user knows.
  }
  const result = await runProductIdentification({
    files,
    barcodes,
    locale: product.locale || 'de-DE',
    modelOverride: null,
    improveContext: buildImproveContext(product),
    skipExternalSearch: true,
    onProgress,
  });

  const improvedOutput = result?.bundle?.products?.[0];
  if (!improvedOutput) {
    console.error('[improve] No product returned from identification flow!');
    throw new Error('Improve-Fluss hat kein Produkt zurückgegeben.');
  }

  console.log('[improve] Merging records...');
  if (onProgress) await onProgress('merging');
  let mergedProduct = mergeProductRecords(product, improvedOutput);

  console.log('[improve] Applying Taxonomy...');
  if (onProgress) await onProgress('enriching');
  mergedProduct = applyEbayTaxonomy(mergedProduct);
  mergedProduct = applyKauflandTaxonomy(mergedProduct);

  console.log('[improve] Final Review & Save...');
  if (onProgress) await onProgress('reviewing');
  await runDatasheetReview([mergedProduct], { locale: product.locale || 'de-DE' });
  await saveProduct(mergedProduct);

  console.log('[improve] SUCCESS.');
  return mergedProduct;
}

module.exports = {
  improveExistingProduct,
};

