'use strict';

const { isValidGtin, normalizeDigits, getGtinType } = require('./gtin');
const { lookupEan } = require('./ean-database');
const { identifyProductFocused } = require('../lib/gemini3-client');
const { extractOcrPayload } = require('./vision-ocr');
const { uploadImage } = require('./storage');

const MAX_IMAGES = 4;
const MAX_EDGE = 1600;
const JPEG_QUALITY = 78;

/**
 * Stage 1: Product Recognition
 *
 * Runs 3 parallel tracks:
 *   A) OCR + image upload + image compression
 *   B) EAN database lookup (if barcode available)
 *   C) Focused Gemini grounding (narrow schema, identity only)
 *
 * Returns merged identity + barcodes + grounding metadata.
 */
async function runStage1Recognition({ files = [], barcodes = '', hint = null, locale = 'de-DE' } = {}) {
  const startTime = Date.now();

  // Parse explicit barcodes
  const explicitBarcodes = barcodes
    ? String(barcodes).split(/[\s,;|]+/).filter(Boolean)
    : [];

  // Track A: OCR + image upload + compression (parallel sub-tasks)
  const trackA = (async () => {
    const sharp = require('sharp');
    const [ocrPayload, uploadedImages] = await Promise.all([
      extractOcrPayload(files),
      Promise.all(
        files.map(async (f, idx) => {
          if (!f?.buffer) return null;
          try {
            const result = await uploadImage(f.buffer, f.mimetype || 'image/jpeg', 'identify-uploads', `v3_${Date.now()}_${idx}`);
            return { url: result.url, width: result.width, height: result.height };
          } catch { return null; }
        })
      ).then((results) => results.filter(Boolean)),
    ]);

    // Compress images for Gemini
    const imageParts = [];
    for (const f of files.slice(0, MAX_IMAGES)) {
      if (!f?.buffer || !f?.mimetype?.startsWith('image/')) continue;
      try {
        const compressed = await sharp(f.buffer)
          .rotate()
          .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: '4:2:0' })
          .toBuffer();
        imageParts.push({ data: compressed.toString('base64'), mimeType: 'image/jpeg' });
      } catch {
        // Skip unprocessable image
      }
    }

    return { ocrPayload, uploadedImages, imageParts };
  })();

  // Track B: EAN lookup (best-effort)
  const primaryBarcode = explicitBarcodes.find((b) => isValidGtin(b)) || '';
  const trackB = primaryBarcode
    ? lookupEan(primaryBarcode).catch(() => null)
    : Promise.resolve(null);

  // Run A + B in parallel
  const [trackAResult, eanLookup] = await Promise.all([trackA, trackB]);

  const { ocrPayload, uploadedImages, imageParts } = trackAResult;

  // Merge barcodes from explicit + OCR
  const mergedBarcodes = [
    ...new Set([
      ...explicitBarcodes,
      ...(ocrPayload.barcodes || []),
    ]),
  ];

  // Track C: Focused grounding (needs imageParts from Track A)
  const ocrText = (ocrPayload.textSnippets || []).filter(Boolean).join('\n');

  let groundingResult = {};
  let groundingUsed = false;
  if (imageParts.length || mergedBarcodes.length) {
    try {
      groundingResult = await identifyProductFocused({
        imageParts,
        ocrText,
        barcodes: mergedBarcodes,
        locale,
        hint,
      });
      groundingUsed = true;
    } catch (err) {
      console.warn('[stage1] Focused grounding failed:', err?.message);
    }
  }

  // Merge barcodes from all sources (OCR, grounding, EAN DB, explicit)
  const allBarcodeCandidates = [
    ...mergedBarcodes,
    normalizeDigits(groundingResult.ean || ''),
    normalizeDigits(groundingResult.gtin || ''),
    normalizeDigits(groundingResult.upc || ''),
    normalizeDigits(eanLookup?.productName ? primaryBarcode : ''),
  ].filter(Boolean);

  const uniqueBarcodes = [...new Set(allBarcodeCandidates)];
  const validBarcodes = uniqueBarcodes.filter((b) => isValidGtin(b));
  const rankedBarcodes = validBarcodes.map((code) => ({
    code,
    type: getGtinType(code),
    valid: true,
  }));

  // Pick best barcode per type
  const ean = rankedBarcodes.find((b) => b.type === 'ean13')?.code || '';
  const gtin = rankedBarcodes.find((b) => b.type === 'gtin14')?.code || '';
  const upc = rankedBarcodes.find((b) => b.type === 'upc12')?.code || '';

  // Cross-check: EAN DB brand vs grounding brand
  const eanBrandMatch = eanLookup?.brand && groundingResult.brand
    ? eanLookup.brand.toLowerCase() === groundingResult.brand.toLowerCase()
    : null;

  return {
    identity: {
      brand: groundingResult.brand || eanLookup?.brand || '',
      model: groundingResult.model || '',
      mpn: groundingResult.mpn || '',
      variant: groundingResult.variant || '',
      condition: groundingResult.condition || 'Neu',
      internalCategory: groundingResult.internalCategory || eanLookup?.category || '',
      weight_grams: groundingResult.weight_grams || null,
      color: groundingResult.color || '',
      size: groundingResult.size || '',
      material: groundingResult.material || '',
    },
    barcodes: {
      ean,
      gtin,
      upc,
      ranked: rankedBarcodes,
      explicit: explicitBarcodes,
    },
    eanLookup: eanLookup || null,
    eanBrandMatch,
    ocrPayload,
    uploadedImages,
    imageParts,
    _meta: {
      durationMs: Date.now() - startTime,
      groundingUsed,
      groundingSources: groundingResult._grounding?.sources || [],
      groundingModel: groundingResult._grounding?.model || null,
    },
  };
}

module.exports = { runStage1Recognition };
