const { extractOcrPayload, isLikelyGtin } = require('../lib/vision-ocr');
const { uploadImage } = require('../lib/storage');
const { findEbayCategory } = require('../lib/ebay-taxonomy');
const { findKauflandCategory } = require('../lib/kaufland-taxonomy');
const { generateStructuredProductRecord } = require('./generative-identify');

const DEFAULT_TEXT = 'unknown';

const normalizeWhitespace = (value = '') =>
  value
    .toString()
    .replace(/\s+/g, ' ')
    .trim();

const truncate = (text, limit) => {
  if (!text) return '';
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit - 1)}…`;
};

const parseBarcodes = (raw = '') => {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(/[\s,;|]+/)
    .map((code) => code.trim())
    .filter(Boolean);
};

const normalizeBarcodeValue = (value = '') => {
  if (!value) return '';
  const digits = value.replace(/[^\d]/g, '');
  if (digits.length >= 8) {
    return digits;
  }
  return value.trim();
};

const mergeBarcodeLists = (...sources) => {
  const merged = [];
  const seen = new Set();
  sources
    .flat()
    .map((code) => normalizeBarcodeValue(code))
    .filter(Boolean)
    .forEach((code) => {
      if (seen.has(code)) return;
      seen.add(code);
      merged.push({
        code,
        priority: isLikelyGtin(code) ? 0 : 1,
      });
    });
  merged.sort((a, b) => a.priority - b.priority);
  return merged.map((entry) => entry.code);
};

const normalizeRecordField = (value) => {
  const cleaned = normalizeWhitespace(value || '');
  return cleaned || DEFAULT_TEXT;
};

const buildTitle = (record, marketplace) => {
  const parts = [];
  if (record.brand !== DEFAULT_TEXT) parts.push(record.brand);
  if (record.model !== DEFAULT_TEXT) parts.push(record.model);
  if (record.variant !== DEFAULT_TEXT) parts.push(record.variant);
  if (record.internalCategory !== DEFAULT_TEXT) parts.push(record.internalCategory);
  const fallback = marketplace === 'kaufland' ? 'Produkt' : 'Artikel';
  const joined = parts.length ? parts.join(' ') : fallback;
  const limit = marketplace === 'kaufland' ? 100 : 80;
  return truncate(joined || fallback, limit);
};

const buildDescription = (record) => {
  const info = [];
  info.push(`Marke: ${record.brand}`);
  info.push(`Modell: ${record.model}`);
  if (record.gtin !== DEFAULT_TEXT) info.push(`GTIN/EAN: ${record.gtin}`);
  info.push(`Zustand: ${record.condition}`);
  info.push(`Farbe: ${record.color}`);
  info.push(`Material: ${record.material}`);
  return `${info.join(' • ')}. Weitere Informationen werden ergänzt, sobald zusätzliche Daten verfügbar sind.`;
};

const determineInputMode = (files = [], mergedBarcodes = []) => {
  if (mergedBarcodes.length > 0 && files.length <= 2) {
    return 'label';
  }
  return 'product-image';
};

const buildMarketplaceAttributes = (record) => {
  const attrs = [];
  if (record.color !== DEFAULT_TEXT) attrs.push({ key: 'Farbe', value: record.color });
  if (record.size !== DEFAULT_TEXT) attrs.push({ key: 'Größe', value: record.size });
  if (record.material !== DEFAULT_TEXT) attrs.push({ key: 'Material', value: record.material });
  if (record.condition !== DEFAULT_TEXT) attrs.push({ key: 'Zustand', value: record.condition });
  if (record.gtin !== DEFAULT_TEXT) attrs.push({ key: 'GTIN', value: record.gtin });
  return attrs;
};

const sanitizeAttributesArray = (rows = []) =>
  rows
    .map((row) => ({
      key: normalizeRecordField(row?.key),
      value: normalizeRecordField(row?.value),
    }))
    .filter(
      (row) =>
        row.key &&
        row.key !== DEFAULT_TEXT &&
        row.value &&
        row.value !== DEFAULT_TEXT
    );

const enforceLimit = (value, limit, fallback) => {
  const cleaned = normalizeWhitespace(value || '');
  if (!cleaned) return fallback;
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, limit - 1)}…`;
};

const preferString = (primary, fallback = DEFAULT_TEXT) => {
  const cleaned = normalizeWhitespace(primary);
  if (cleaned) return cleaned;
  const fallbackClean = normalizeWhitespace(fallback);
  return fallbackClean || DEFAULT_TEXT;
};

async function uploadReferenceImages(files = []) {
  const uploaded = [];
  for (let idx = 0; idx < files.length; idx += 1) {
    const file = files[idx];
    if (!file?.buffer || !file?.mimetype?.startsWith('image/')) continue;
    try {
      const result = await uploadImage(
        file.buffer,
        file.mimetype,
        'serpapi-free',
        `v2_${Date.now()}_${idx}`
      );
      uploaded.push({
        url: result.url,
        width: result.width,
        height: result.height,
      });
    } catch (error) {
      console.warn('Failed to upload reference image for v2 pipeline:', error.message);
    }
  }
  return uploaded;
}

async function runSerpapiFreePipeline({ files = [], barcodes = '', locale = 'de-DE' } = {}) {
  const manualBarcodes = parseBarcodes(barcodes);
  const ocrPayload = await extractOcrPayload(files);
  const mergedBarcodes = mergeBarcodeLists(manualBarcodes, ocrPayload.barcodes || []);
  const inputMode = determineInputMode(files, mergedBarcodes);
  const uploadedImages = inputMode === 'product-image' ? await uploadReferenceImages(files) : [];
  const primaryBarcode = mergedBarcodes[0] || DEFAULT_TEXT;
  let llmRecord = null;

  try {
    llmRecord = await generateStructuredProductRecord({
      files,
      ocrLines: ocrPayload.textSnippets || [],
      barcodes: mergedBarcodes,
      locale,
      inputMode,
    });
  } catch (error) {
    console.warn('Structured product generation failed, falling back to defaults:', error.message);
  }

  const baseRecord = {
    input_mode: inputMode,
    brand: DEFAULT_TEXT,
    model: DEFAULT_TEXT,
    sku: DEFAULT_TEXT,
    variant: DEFAULT_TEXT,
    gtin: primaryBarcode,
    ean: primaryBarcode,
    upc: DEFAULT_TEXT,
    color: DEFAULT_TEXT,
    size: DEFAULT_TEXT,
    material: DEFAULT_TEXT,
    condition: inputMode === 'label' ? 'new' : 'used',
    internalCategory: DEFAULT_TEXT,
    ebayCategoryId: DEFAULT_TEXT,
    ebayCategoryPath: DEFAULT_TEXT,
    kauflandCategoryId: DEFAULT_TEXT,
    kauflandCategoryPath: DEFAULT_TEXT,
    title_ebay: DEFAULT_TEXT,
    title_kaufland: DEFAULT_TEXT,
    description_ebay: DEFAULT_TEXT,
    description_kaufland: DEFAULT_TEXT,
    item_specifics: [],
    attributes_kaufland: [],
    heroImageUrl: inputMode === 'product-image' && uploadedImages[0] ? uploadedImages[0].url : null,
    galleryImageUrls:
      inputMode === 'product-image' ? uploadedImages.map((image) => image.url) : [],
  };

  if (baseRecord.heroImageUrl === null && baseRecord.galleryImageUrls.length) {
    [baseRecord.heroImageUrl] = baseRecord.galleryImageUrls;
  }

  const mergedRecord = { ...baseRecord };
  const assign = (key, value) => {
    mergedRecord[key] = preferString(value, mergedRecord[key]);
  };

  if (llmRecord) {
    assign('brand', llmRecord.brand);
    assign('model', llmRecord.model);
    assign('sku', llmRecord.sku);
    assign('variant', llmRecord.variant);
    assign('gtin', llmRecord.gtin);
    assign('ean', llmRecord.ean);
    assign('upc', llmRecord.upc);
    assign('color', llmRecord.color);
    assign('size', llmRecord.size);
    assign('material', llmRecord.material);
    assign('condition', llmRecord.condition);
    assign('internalCategory', llmRecord.internalCategory);
    assign('title_ebay', llmRecord.title_ebay);
    assign('title_kaufland', llmRecord.title_kaufland);
    assign('description_ebay', llmRecord.description_ebay);
    assign('description_kaufland', llmRecord.description_kaufland);

    if (Array.isArray(llmRecord.item_specifics) && llmRecord.item_specifics.length) {
      mergedRecord.item_specifics = sanitizeAttributesArray(llmRecord.item_specifics);
    }
    if (Array.isArray(llmRecord.attributes_kaufland) && llmRecord.attributes_kaufland.length) {
      mergedRecord.attributes_kaufland = sanitizeAttributesArray(llmRecord.attributes_kaufland);
    }
  }

  mergedRecord.title_ebay = enforceLimit(
    mergedRecord.title_ebay,
    80,
    buildTitle(mergedRecord, 'ebay')
  );
  mergedRecord.title_kaufland = enforceLimit(
    mergedRecord.title_kaufland,
    100,
    buildTitle(mergedRecord, 'kaufland')
  );
  mergedRecord.description_ebay = preferString(
    mergedRecord.description_ebay,
    buildDescription(mergedRecord)
  );
  mergedRecord.description_kaufland = preferString(
    mergedRecord.description_kaufland,
    buildDescription(mergedRecord)
  );

  if (!Array.isArray(mergedRecord.item_specifics) || !mergedRecord.item_specifics.length) {
    mergedRecord.item_specifics = buildMarketplaceAttributes(mergedRecord);
  }
  if (!Array.isArray(mergedRecord.attributes_kaufland) || !mergedRecord.attributes_kaufland.length) {
    mergedRecord.attributes_kaufland = buildMarketplaceAttributes(mergedRecord);
  }

  const categorySource =
    mergedRecord.internalCategory === DEFAULT_TEXT && llmRecord?.internalCategory
      ? llmRecord.internalCategory
      : mergedRecord.internalCategory;
  const ebayCategory = findEbayCategory(categorySource);
  if (ebayCategory) {
    mergedRecord.ebayCategoryId = String(ebayCategory.id || ebayCategory.categoryId || DEFAULT_TEXT);
    mergedRecord.ebayCategoryPath = ebayCategory.breadcrumb || ebayCategory.name || DEFAULT_TEXT;
    if (mergedRecord.internalCategory === DEFAULT_TEXT) {
      mergedRecord.internalCategory = ebayCategory.breadcrumb || ebayCategory.name || DEFAULT_TEXT;
    }
  }

  const kauflandCategory =
    findKauflandCategory(mergedRecord.internalCategory) ||
    findKauflandCategory(llmRecord?.internalCategory);
  if (kauflandCategory) {
    mergedRecord.kauflandCategoryId = String(kauflandCategory.id);
    mergedRecord.kauflandCategoryPath =
      kauflandCategory.dePath || kauflandCategory.enPath || DEFAULT_TEXT;
  }

  return {
    locale,
    barcodes: mergedBarcodes,
    ocr: {
      textSnippets: ocrPayload.textSnippets || [],
      numericValues: ocrPayload.numericValues || [],
    },
    record: mergedRecord,
    llm: {
      applied: Boolean(llmRecord),
      model: process.env.GEMINI_MULTIMODAL_MODEL || process.env.GEMINI_STRUCTURED_MODEL || 'gemini-2.0-flash',
    },
  };
}

module.exports = {
  runSerpapiFreePipeline,
};

