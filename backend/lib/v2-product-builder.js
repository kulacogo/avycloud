const crypto = require('crypto');
const { isValidGtin, normalizeDigits } = require('./gtin');

const UNKNOWN = 'unknown';

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeValue(v) {
  const s = safeString(v);
  if (!s) return '';
  if (s.toLowerCase() === UNKNOWN) return '';
  if (s.toLowerCase() === 'unbekannt') return '';
  return s;
}

function isUnknownToken(v) {
  const s = safeString(v).toLowerCase();
  if (!s) return true;
  if (s === UNKNOWN) return true;
  if (s === 'unbekannt') return true;
  if (s.startsWith('unbekannt')) return true;
  if (s.startsWith('unknown')) return true;
  return false;
}

function isGenericTitle(title) {
  const t = safeString(title).toLowerCase();
  if (!t) return true;
  // Avoid saving "Artikel"/"Produkt"/"Product" as a "real" title; these are fallback placeholders.
  if (t === 'artikel' || t === 'produkt' || t === 'product' || t === 'item') return true;
  return false;
}

function dedupe(values = []) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function parseBarcodeString(input = '') {
  if (!input || typeof input !== 'string') return [];
  return input
    .split(/[\s,;|]+/)
    .map((entry) => normalizeDigits(String(entry || '').trim()))
    .filter(Boolean);
}

function pickProductId(record, fallbackId) {
  const candidates = [
    normalizeValue(record?.ean),
    normalizeValue(record?.gtin),
    normalizeValue(record?.upc),
    normalizeValue(record?.sku),
  ]
    .map((v) => (v ? String(v).trim() : ''))
    .filter(Boolean);

  const first = candidates[0] || '';
  // Firestore doc IDs must not contain "/" (path separator).
  const safe = first.replace(/\//g, '_');
  if (safe) return safe;
  return fallbackId || crypto.randomUUID();
}

function buildImages(record) {
  const images = [];
  const hero = normalizeValue(record?.heroImageUrl);
  if (hero) {
    images.push({
      source: 'upload',
      variant: 'front',
      url_or_base64: hero,
      notes: 'pipeline-v2 hero',
    });
  }
  const gallery = Array.isArray(record?.galleryImageUrls) ? record.galleryImageUrls : [];
  gallery.forEach((url, index) => {
    const u = normalizeValue(url);
    if (!u) return;
    images.push({
      source: 'upload',
      variant: index % 3 === 0 ? 'detail' : index % 3 === 1 ? 'angle' : 'other',
      url_or_base64: u,
      notes: 'pipeline-v2 gallery',
    });
  });
  return images;
}

function buildAttributes(record) {
  const out = {};

  const add = (key, value) => {
    const k = normalizeValue(key);
    const v = normalizeValue(value);
    if (!k || !v) return;
    // Never store marketplace/meta keys as user attributes.
    if (/\b(ebay|kaufland)\b/i.test(k)) return;
    out[k] = v;
  };

  const specifics = Array.isArray(record?.item_specifics) ? record.item_specifics : [];
  specifics.forEach((attr) => add(attr?.key, attr?.value));
  const kauflandAttrs = Array.isArray(record?.attributes_kaufland) ? record.attributes_kaufland : [];
  kauflandAttrs.forEach((attr) => add(attr?.key, attr?.value));

  add('Marke', record?.brand);
  add('Modell', record?.model);
  add('Variante', record?.variant);
  add('Zustand', record?.condition);
  add('Farbe', record?.color);
  add('Material', record?.material);
  add('Größe', record?.size);

  // Prefer breadcrumb-like category (internalCategory often contains it after taxonomy mapping).
  const category = normalizeValue(record?.internalCategory) || normalizeValue(record?.ebayCategoryPath);
  if (category) {
    add('Kategorie', category);
    const leaf = category.includes('>') ? category.split('>').pop()?.trim() : category.trim();
    if (leaf) add('Produktart', leaf);
  }

  // Identifiers
  add('GTIN', record?.gtin);
  add('EAN', record?.ean);
  add('UPC', record?.upc);

  return out;
}

function buildKeyFeatures(record) {
  const seen = new Set();
  const result = [];

  const push = (text) => {
    const cleaned = safeString(text).replace(/\s+/g, ' ').trim();
    if (!cleaned) return;
    const sig = cleaned.toLowerCase();
    if (seen.has(sig)) return;
    if (sig === UNKNOWN || sig === 'unbekannt') return;
    seen.add(sig);
    result.push(cleaned);
  };

  const specifics = Array.isArray(record?.item_specifics) ? record.item_specifics : [];
  specifics.forEach((attr) => {
    const k = normalizeValue(attr?.key);
    const v = normalizeValue(attr?.value);
    if (!k || !v) return;
    push(`${k}: ${v}`);
  });

  // If we still have too few, use a few structured fields (never placeholders).
  if (result.length < 5) {
    const candidates = [
      record?.brand ? `Marke: ${record.brand}` : '',
      record?.model ? `Modell: ${record.model}` : '',
      record?.variant ? `Variante: ${record.variant}` : '',
      record?.color ? `Farbe: ${record.color}` : '',
      record?.material ? `Material: ${record.material}` : '',
      record?.size ? `Größe: ${record.size}` : '',
    ];
    candidates.forEach((c) => push(c));
  }

  return result.slice(0, 7);
}

function normalizeBarcodes({ record, manualBarcodes = [] }) {
  const fromRecord = [
    normalizeValue(record?.gtin),
    normalizeValue(record?.ean),
    normalizeValue(record?.upc),
  ].filter(Boolean);
  const fromSources = Array.isArray(record?.barcode_sources)
    ? record.barcode_sources.map((s) => normalizeValue(s?.code)).filter(Boolean)
    : [];

  const merged = dedupe([...manualBarcodes, ...fromRecord, ...fromSources])
    .map((code) => normalizeDigits(code))
    .filter(Boolean);

  // Keep both valid and invalid for traceability, but prioritize valid (frontend may show a warning otherwise).
  const valid = merged.filter((code) => isValidGtin(code));
  const invalid = merged.filter((code) => !isValidGtin(code));
  return dedupe([...valid, ...invalid]).slice(0, 10);
}

function computeConfidence(record = {}) {
  const gtinConf = typeof record?.gtin_confidence === 'number' ? record.gtin_confidence : 0;
  const eanConf = typeof record?.ean_confidence === 'number' ? record.ean_confidence : 0;
  const barcodeConfidence = Math.max(gtinConf, eanConf, 0);
  const hasBrand = !isUnknownToken(record?.brand) && normalizeValue(record?.brand).length >= 2;
  const hasModel = !isUnknownToken(record?.model) && normalizeValue(record?.model).length >= 2;
  const hasAnyId = Boolean(normalizeValue(record?.gtin) || normalizeValue(record?.ean) || normalizeValue(record?.upc));
  const identified = hasAnyId || (hasBrand && hasModel);
  return identified ? Math.min(0.92, Math.max(0.55, 0.55 + barcodeConfidence * 0.35)) : 0.22;
}

function normalizeSkuCandidate(value, record = {}) {
  if (value === undefined || value === null) return '';
  let s = String(value).trim();
  if (!s) return '';
  // Remove all whitespace including newlines (common OCR/LLM formatting artifact).
  s = s.replace(/\s+/g, '');

  // STRICT SKU POLICY:
  // SKU must be exactly "SKU-[10 digits]".
  // We do NOT accept placeholders like "unknown", and we do NOT accept arbitrary non-digit tokens.
  const lower = s.toLowerCase();
  if (lower === 'unknown' || lower === 'unbekannt' || lower === 'sku-unknown') return '';

  // Normalize prefix variants
  if (/^sku/i.test(s)) {
    s = `SKU-${s.replace(/^sku[-_]?/i, '')}`;
    s = s.replace(/^SKU-(SKU-)+/i, 'SKU-');
  }
  const rest = s.replace(/^SKU-/i, '');
  if (!rest) return '';

  // Only digits; pad to 10 if shorter; reject if longer than 10.
  if (!/^\d+$/.test(rest)) return '';
  const digits = rest;
  if (digits.length > 10) return '';

  // Reject barcode-as-sku (EAN/GTIN/UPC) when exact match.
  const ean = normalizeValue(record?.ean);
  const gtin = normalizeValue(record?.gtin);
  const upc = normalizeValue(record?.upc);
  if (digits === ean || digits === gtin || digits === upc) return '';

  const padded = digits.padStart(10, '0');
  return `SKU-${padded}`;
}

function buildProductFromV2Record(record, options = {}) {
  const manualBarcodes = parseBarcodeString(options?.barcodes || '');
  const productId = pickProductId(record, options?.fallbackId);
  const brand = normalizeValue(record?.brand);
  const model = normalizeValue(record?.model);
  const variant = normalizeValue(record?.variant);

  const titleCandidate =
    normalizeValue(record?.title_ebay) ||
    normalizeValue(record?.title_kaufland) ||
    [brand, model, variant].filter(Boolean).join(' ').trim();

  const usableTitle = isGenericTitle(titleCandidate) ? '' : titleCandidate;
  const name =
    usableTitle ||
    (options?.label ? `Unbekanntes Produkt (${options.label})` : 'Unbekanntes Produkt');

  const shortDescription =
    normalizeValue(record?.description_kaufland) ||
    normalizeValue(record?.description_ebay) ||
    ''; // Will be filled by server-side review step.

  const barcodes = normalizeBarcodes({ record, manualBarcodes });
  const images = buildImages(record);
  const attributes = buildAttributes(record);
  const keyFeatures = buildKeyFeatures(record);

  return {
    id: productId,
    locale: options?.locale || 'de-DE',
    identification: {
      method: record?.input_mode === 'label' ? 'barcode' : 'image',
      barcodes: barcodes.length ? barcodes : undefined,
      name,
      brand: brand || '',
      category: normalizeValue(record?.internalCategory) || 'Unkategorisiert',
      confidence: computeConfidence(record),
      sku: normalizeSkuCandidate(record?.sku, record) || undefined,
    },
    details: {
      short_description: shortDescription,
      key_features: keyFeatures,
      attributes,
      identifiers: {
        ean: normalizeValue(record?.ean) || undefined,
        gtin: normalizeValue(record?.gtin) || undefined,
        upc: normalizeValue(record?.upc) || undefined,
        sku: normalizeSkuCandidate(record?.sku, record) || undefined,
      },
      images,
      pricing: {
        lowest_price: {
          amount: 0,
          currency: 'EUR',
          sources: [],
        },
        price_confidence: 0,
      },
    },
    ops: {
      sync_status: 'pending',
      revision: 0,
      pending_intake_quantity: 0,
    },
    inventory: {
      quantity: 0,
      inventoryId: options?.inventoryId || null,
      inventoryName: options?.inventoryName || null,
    },
  };
}

module.exports = {
  buildProductFromV2Record,
};

