const { extractOcrPayload } = require('../lib/vision-ocr');
const { uploadImage } = require('../lib/storage');
const { findEbayCategory } = require('../lib/ebay-taxonomy');
const { findKauflandCategory } = require('../lib/kaufland-taxonomy');
const { generateStructuredProductRecord } = require('./generative-identify');
const { isValidGtin, getGtinType, normalizeDigits, EAN_LENGTH, GTIN_LENGTH } = require('../lib/gtin');

const DEFAULT_TEXT = 'unknown';
const SOURCE_WEIGHTS = {
  manual: 6,
  input: 5,
  ocr: 5,
  'ocr-text': 4,
  llm: 3,
  numeric: 1,
};

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
        priority: isValidGtin(code) ? 0 : 1,
      });
    });
  merged.sort((a, b) => a.priority - b.priority);
  return merged.map((entry) => entry.code);
};

const MIN_BARCODE_LENGTH = 8;

const createBarcodeCandidate = (code, source, meta = {}) => {
  if (!code) return null;
  const digits = normalizeDigits(code);
  if (!digits || digits.length < MIN_BARCODE_LENGTH) return null;
  if (!/^\d+$/.test(digits)) return null;
  return {
    code: digits,
    length: digits.length,
    source,
    confidence: typeof meta.confidence === 'number' ? meta.confidence : null,
    fileIndex: meta.fileIndex ?? null,
    boundingPoly: meta.boundingPoly || null,
    isValid: isValidGtin(digits),
  };
};

const aggregateBarcodeCandidates = (candidates = []) => {
  const aggregates = new Map();
  const addCandidate = (candidate) => {
    if (!candidate) return;
    const existing = aggregates.get(candidate.code) || {
      code: candidate.code,
      length: candidate.length,
      isValid: candidate.isValid,
      sources: new Set(),
      score: 0,
      hits: 0,
      confidenceSamples: [],
      samples: [],
    };
    const baseWeight = SOURCE_WEIGHTS[candidate.source] || 1;
    let score = baseWeight;
    if (candidate.isValid) score += 4;
    if (candidate.length === EAN_LENGTH || candidate.length === GTIN_LENGTH) score += 2;
    if (candidate.confidence) {
      score += Math.min(candidate.confidence, 1) * 2;
      existing.confidenceSamples.push(candidate.confidence);
    }
    existing.score += score;
    existing.hits += 1;
    existing.isValid = existing.isValid || candidate.isValid;
    existing.sources.add(candidate.source);
    existing.samples.push(candidate);
    aggregates.set(candidate.code, existing);
  };

  candidates.forEach(addCandidate);

  const ranked = Array.from(aggregates.values()).map((entry) => {
    const avgConfidence =
      entry.confidenceSamples.length > 0
        ? entry.confidenceSamples.reduce((acc, value) => acc + value, 0) / entry.confidenceSamples.length
        : null;
    const normalizedConfidence = Math.min(entry.score / 12, 1);
    return {
      code: entry.code,
      length: entry.length,
      isValid: entry.isValid,
      score: entry.score,
      hits: entry.hits,
      sources: Array.from(entry.sources),
      confidence: avgConfidence != null ? Math.max(avgConfidence, normalizedConfidence) : normalizedConfidence,
    };
  });

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.hits !== a.hits) return b.hits - a.hits;
    return a.code.localeCompare(b.code);
  });

  return ranked;
};

const resolveBarcodeSet = ({ manualBarcodes = [], mergedBarcodes = [], ocrPayload = {}, llmRecord = null }) => {
  const candidates = [];

  manualBarcodes.forEach((code) => {
    candidates.push(createBarcodeCandidate(code, 'manual'));
  });

  mergedBarcodes.forEach((code) => {
    candidates.push(createBarcodeCandidate(code, 'input'));
  });

  (ocrPayload?.barcodeDetails || []).forEach((detail) => {
    candidates.push(
      createBarcodeCandidate(detail.code, 'ocr', {
        confidence: detail.confidence,
        fileIndex: detail.fileIndex,
        boundingPoly: detail.boundingPoly,
      })
    );
  });

  (ocrPayload?.barcodes || []).forEach((code) => {
    candidates.push(createBarcodeCandidate(code, 'ocr'));
  });

  (ocrPayload?.numericValues || []).forEach((code) => {
    candidates.push(createBarcodeCandidate(code, 'numeric'));
  });

  if (llmRecord) {
    if (llmRecord.ean && llmRecord.ean !== DEFAULT_TEXT) {
      candidates.push(createBarcodeCandidate(llmRecord.ean, 'llm'));
    }
    if (llmRecord.gtin && llmRecord.gtin !== DEFAULT_TEXT) {
      candidates.push(createBarcodeCandidate(llmRecord.gtin, 'llm'));
    }
    if (llmRecord.upc && llmRecord.upc !== DEFAULT_TEXT) {
      candidates.push(createBarcodeCandidate(llmRecord.upc, 'llm'));
    }
  }

  const ranked = aggregateBarcodeCandidates(candidates);
  const primary = ranked[0] || null;
  const bestEan = ranked.find((entry) => entry.length === EAN_LENGTH) || null;
  const bestGtin = ranked.find((entry) => entry.length === GTIN_LENGTH) || null;

  return {
    ranked,
    primary,
    bestEan,
    bestGtin,
  };
};

const normalizeRecordField = (value) => {
  const cleaned = normalizeWhitespace(value || '');
  return cleaned || DEFAULT_TEXT;
};

const isUnknownToken = (value) => {
  const cleaned = normalizeWhitespace(value || '').toLowerCase();
  if (!cleaned) return true;
  if (cleaned === DEFAULT_TEXT) return true; // "unknown"
  if (cleaned === 'unbekannt') return true;
  if (cleaned.startsWith('unbekannt')) return true;
  if (cleaned.startsWith('unknown')) return true;
  return false;
};

const computeIdentificationQuality = (record = {}) => {
  const brand = record.brand;
  const model = record.model;
  const variant = record.variant;
  const hasBrand = !isUnknownToken(brand) && normalizeWhitespace(brand).length >= 2;
  const hasModel = !isUnknownToken(model) && normalizeWhitespace(model).length >= 2;
  const hasVariant = !isUnknownToken(variant) && normalizeWhitespace(variant).length >= 2;

  const barcodeCandidates = [record.gtin, record.ean, record.upc]
    .map((value) => normalizeWhitespace(value || ''))
    .filter(Boolean)
    .filter((value) => !isUnknownToken(value));
  const hasValidBarcode = barcodeCandidates.some((code) => isValidGtin(code));

  const isIdentified = hasValidBarcode || (hasBrand && (hasModel || hasVariant));

  return {
    isIdentified,
    hasValidBarcode,
    hasBrand,
    hasModel,
    hasVariant,
  };
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

const scoreFileForIdentify = (fileSummary) => {
  if (!fileSummary) return 0;
  const textLen = Number(fileSummary.textLen || 0) || 0;
  const textScore = Math.min(textLen, 1400) / 1400 * 5; // 0..5

  const rawBarcodes = Array.isArray(fileSummary.barcodes) ? fileSummary.barcodes : [];
  const valid = rawBarcodes.filter((code) => isValidGtin(code));
  const barcodeScore = valid.length ? 7 : rawBarcodes.length ? 2 : 0;

  const webGuessScore = Array.isArray(fileSummary.web?.bestGuessLabels) && fileSummary.web.bestGuessLabels.length ? 2 : 0;
  const webEntityScore = Array.isArray(fileSummary.web?.webEntities) && fileSummary.web.webEntities.length ? 2 : 0;
  const logoScore = Array.isArray(fileSummary.web?.logos) && fileSummary.web.logos.length ? 2 : 0;
  return textScore + barcodeScore + webGuessScore + webEntityScore + logoScore;
};

const pickBestFilesForModel = (files = [], ocrPayload = {}) => {
  const summaries = Array.isArray(ocrPayload?.byFile) ? ocrPayload.byFile : [];
  if (!files.length || !summaries.length) return files;
  const scored = files.map((file, idx) => ({
    file,
    idx,
    score: scoreFileForIdentify(summaries[idx]),
  }));
  scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  // If everything scores 0, keep original ordering.
  if (!scored.length || scored[0].score <= 0) return files;
  return scored.map((s) => s.file);
};

const buildWebHintLines = (ocrPayload = {}) => {
  const web = ocrPayload?.web || null;
  if (!web) return [];
  const lines = [];
  const bestGuess = Array.isArray(web.bestGuessLabels) ? web.bestGuessLabels.filter(Boolean).slice(0, 6) : [];
  if (bestGuess.length) {
    lines.push(`WEB_DETECTION BestGuessLabels: ${bestGuess.join(' | ')}`);
  }
  const entities = Array.isArray(web.webEntities) ? web.webEntities.filter((e) => e?.description).slice(0, 6) : [];
  if (entities.length) {
    lines.push(
      `WEB_DETECTION WebEntities: ${entities
        .map((e) => `${e.description}${typeof e.score === 'number' ? ` (${e.score.toFixed(2)})` : ''}`)
        .join(' | ')}`
    );
  }
  const logos = Array.isArray(web.logos) ? web.logos.filter((e) => e?.description).slice(0, 5) : [];
  if (logos.length) {
    lines.push(
      `LOGO_DETECTION: ${logos
        .map((e) => `${e.description}${typeof e.score === 'number' ? ` (${e.score.toFixed(2)})` : ''}`)
        .join(' | ')}`
    );
  }
  return lines;
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

async function runSerpapiFreePipeline({ files = [], barcodes = '', locale = 'de-DE', inventoryId = null } = {}) {
  const manualBarcodes = parseBarcodes(barcodes);
  const ocrPayload = await extractOcrPayload(files);
  const mergedBarcodes = mergeBarcodeLists(manualBarcodes, ocrPayload.barcodes || []);
  const inputMode = determineInputMode(files, mergedBarcodes);
  const uploadedImages = await uploadReferenceImages(files);
  let llmRecord = null;
  let llmError = null;

  try {
    const filesForModel = pickBestFilesForModel(files, ocrPayload);
    const ocrLinesForModel = [
      ...((ocrPayload.textSnippets || []).filter(Boolean)),
      ...buildWebHintLines(ocrPayload),
    ];
    llmRecord = await generateStructuredProductRecord({
      files: filesForModel,
      ocrLines: ocrLinesForModel,
      barcodes: mergedBarcodes,
      locale,
      inputMode,
    });
  } catch (error) {
    console.warn('Structured product generation failed, falling back to defaults:', error.message);
    llmError = error?.message || String(error);
    llmRecord = null; // proceed with base defaults
  }

  const baseRecord = {
    input_mode: inputMode,
    brand: DEFAULT_TEXT,
    model: DEFAULT_TEXT,
    sku: DEFAULT_TEXT,
    variant: DEFAULT_TEXT,
    gtin: DEFAULT_TEXT,
    ean: DEFAULT_TEXT,
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
    heroImageUrl: uploadedImages[0]?.url || null,
    galleryImageUrls: uploadedImages.map((image) => image.url),
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

  const barcodeResolution = resolveBarcodeSet({
    manualBarcodes,
    mergedBarcodes,
    ocrPayload,
    llmRecord,
  });
  const fallbackBarcode = barcodeResolution.primary?.code || mergedBarcodes[0] || manualBarcodes[0] || null;

  if (barcodeResolution.bestGtin) {
    assign('gtin', barcodeResolution.bestGtin.code);
  } else if (fallbackBarcode && fallbackBarcode.length === GTIN_LENGTH && isValidGtin(fallbackBarcode)) {
    assign('gtin', fallbackBarcode);
  }
  if (barcodeResolution.bestEan) {
    assign('ean', barcodeResolution.bestEan.code);
  } else if (
    fallbackBarcode &&
    fallbackBarcode.length === EAN_LENGTH &&
    isValidGtin(fallbackBarcode)
  ) {
    assign('ean', fallbackBarcode);
  }

  mergedRecord.barcode_sources = barcodeResolution.ranked.slice(0, 6);
  mergedRecord.gtin_confidence =
    barcodeResolution.bestGtin?.confidence ||
    barcodeResolution.primary?.confidence ||
    0;
  mergedRecord.ean_confidence =
    barcodeResolution.bestEan?.confidence ||
    barcodeResolution.primary?.confidence ||
    0;

  const quality = computeIdentificationQuality(mergedRecord);

  return {
    locale,
    barcodes: mergedBarcodes,
    ocr: {
      textSnippets: ocrPayload.textSnippets || [],
      numericValues: ocrPayload.numericValues || [],
      web: ocrPayload.web || null,
    },
    record: mergedRecord,
    llm: {
      applied: Boolean(llmRecord),
      model: process.env.GEMINI_MULTIMODAL_MODEL || process.env.GEMINI_STRUCTURED_MODEL || 'gemini-3-pro-preview',
      error: llmError,
    },
    quality,
    inventoryId,
    barcodeInsights: {
      ranked: barcodeResolution.ranked,
      primary: barcodeResolution.primary?.code || null,
      selected: {
        gtin: mergedRecord.gtin !== DEFAULT_TEXT ? mergedRecord.gtin : null,
        ean: mergedRecord.ean !== DEFAULT_TEXT ? mergedRecord.ean : null,
      },
    },
  };
}

module.exports = {
  runSerpapiFreePipeline,
};

