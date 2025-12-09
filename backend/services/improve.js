const { getProduct, saveProduct } = require('../lib/firestore');
const { runProductIdentification, runDatasheetReview } = require('./enrichment');
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

function mergeIdentifiers(existing = {}, incoming = {}) {
  const merged = { ...(existing || {}) };
  Object.entries(incoming || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string' && !value.trim()) {
      return;
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
    if (!url || LENS_UPLOAD_PATTERN.test(url)) {
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
      if (shouldSkipIncomingImage(image, existingKeys)) {
        return;
      }
      const bucket = classifyImageSource(image, false);
      if (bucket === 'generated') {
        console.warn('Skipping generated incoming image during merge:', image?.url || image?.url_or_base64 || '');
        return;
      }
      pushToBucket(image, bucket);
    });
  }

  if (Array.isArray(existing)) {
    existing.forEach((image) => {
      if (!image) return;
      const url = image.url_or_base64 || image.url;
      // Do not filter existing images based on pattern - if they are there, keep them
      const bucket = classifyImageSource(image, true);
      if (bucket === 'generated') {
        console.warn('Dropping generated existing image during merge:', image?.url || image?.url_or_base64 || '');
        return;
      }
      pushToBucket(image, bucket);
    });
  }

  let combined = [...buckets.generated, ...buckets.reference, ...buckets.fallback];
  // generated bucket is intentionally ignored to keep only real images
  combined = [...buckets.reference, ...buckets.fallback];
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
  if (Array.isArray(incoming) && incoming.length) {
    return incoming.slice(0, 1);
  }
  if (Array.isArray(existing) && existing.length) {
    return existing.slice(0, 1);
  }
  return [];
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

function mergeProductRecords(existing, incoming) {
  const merged = {
    ...existing,
    ...incoming,
  };

  merged.id = existing.id;
  merged.identification = {
    ...(existing.identification || {}),
    ...(incoming.identification || {}),
  };
  merged.identification.barcodes = mergeBarcodes(
    existing.identification?.barcodes,
    incoming.identification?.barcodes
  );

  merged.details = mergeDetails(existing.details || {}, incoming.details || {});
  merged.inventory = existing.inventory || incoming.inventory || null;
  merged.storage = existing.storage || incoming.storage || null;
  merged.storageBins = existing.storageBins || incoming.storageBins || [];
  merged.ops = {
    ...(existing.ops || {}),
    ...(incoming.ops || {}),
    sync_status: 'pending',
    last_synced_iso: null,
    revision: (existing.ops?.revision || 0) + 1,
  };
  if (incoming.ops?.revision && incoming.ops.revision > merged.ops.revision) {
    merged.ops.revision = incoming.ops.revision;
  }

  merged.notes = mergeNotes(existing.notes, incoming.notes);
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

async function improveExistingProduct(productId) {
  const product = await getProduct(productId);
  if (!product) {
    const error = new Error('Produkt wurde nicht gefunden.');
    error.code = 404;
    throw error;
  }

  const files = await buildReferenceFiles(product);
  const barcodes = collectBarcodes(product);

  const result = await runProductIdentification({
    files,
    barcodes,
    locale: product.locale || 'de-DE',
    modelOverride: null,
    improveContext: buildImproveContext(product),
  });

  const improvedOutput = result?.bundle?.products?.[0];
  if (!improvedOutput) {
    throw new Error('Improve-Fluss hat kein Produkt zurückgegeben.');
  }

  const mergedProduct = mergeProductRecords(product, improvedOutput);
  await runDatasheetReview([mergedProduct], { locale: product.locale || 'de-DE' });
  await saveProduct(mergedProduct);
  return mergedProduct;
}

module.exports = {
  improveExistingProduct,
};

