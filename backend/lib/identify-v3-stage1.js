'use strict';

const { isValidGtin, normalizeDigits, getGtinType } = require('./gtin');
const { lookupEan } = require('./ean-database');
const { identifyProductFocused, identifyProductWithGrounding } = require('../lib/gemini3-client');
const { extractOcrPayload } = require('./vision-ocr');
const { uploadImage } = require('./storage');
const { analyzeImage } = require('./image-quality');

const MAX_IMAGES = 4;
const MAX_EDGE = 1600;
const JPEG_QUALITY = 78;

// Feature flag: Stage-1 Image Quality Gate (default ON, additive metadata only).
function isImageQualityGateEnabled() {
  return String(process.env.STAGE1_IMAGE_QUALITY_GATE || 'true').toLowerCase() !== 'false';
}

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

    // Compress images for Gemini + optionally analyze quality (additive metadata).
    const imageParts = [];
    const imageQuality = [];
    const qualityGateOn = isImageQualityGateEnabled();
    for (let i = 0; i < Math.min(files.length, MAX_IMAGES); i++) {
      const f = files[i];
      if (!f?.buffer || !f?.mimetype?.startsWith('image/')) continue;
      try {
        const compressed = await sharp(f.buffer)
          .rotate()
          .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: '4:2:0' })
          .toBuffer();
        imageParts.push({ data: compressed.toString('base64'), mimeType: 'image/jpeg' });

        if (qualityGateOn) {
          try {
            const analysis = await analyzeImage(f.buffer, { computeHash: true });
            imageQuality.push({ fileIndex: i, ...analysis });
            if (analysis && analysis.meetsMinResolution === false) {
              console.warn(`[stage1] image[${i}] below min resolution: ${analysis.width}x${analysis.height}`);
            }
            if (analysis && analysis.isLikelyStockPhoto === true) {
              console.warn(`[stage1] image[${i}] flagged as likely stock photo (score=${analysis.qualityScore?.toFixed?.(2)})`);
            }
          } catch (qErr) {
            // Never fail the pipeline because of quality analysis.
            console.warn(`[stage1] image-quality analyze failed for index ${i}: ${qErr?.message || qErr}`);
          }
        }
      } catch {
        // Skip unprocessable image
      }
    }

    return { ocrPayload, uploadedImages, imageParts, imageQuality };
  })();

  // Track B: EAN lookup (best-effort)
  const primaryBarcode = explicitBarcodes.find((b) => isValidGtin(b)) || '';
  const trackB = primaryBarcode
    ? lookupEan(primaryBarcode).catch(() => null)
    : Promise.resolve(null);

  // Run A + B in parallel
  const [trackAResult, eanLookup] = await Promise.all([trackA, trackB]);

  const { ocrPayload, uploadedImages, imageParts, imageQuality } = trackAResult;

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
  let v2FallbackRecord = null;
  const SKIP_FOCUSED = String(process.env.STAGE1_SKIP_FOCUSED_GROUNDING || 'false').toLowerCase() === 'true';
  const SKIP_V2_FALLBACK = String(process.env.STAGE1_SKIP_V2_FALLBACK || 'false').toLowerCase() === 'true';
  if (imageParts.length || mergedBarcodes.length) {
    // Try focused grounding first (narrow schema, fast). Hard cap so a hung Gemini call
    // cannot consume the V3 master timeout — fall back to V2 grounding instead.
    // STAGE1_SKIP_FOCUSED_GROUNDING=true bypasses this entirely (emergency-bypass when
    // Gemini Grounding API has known 504/503 issues; goes straight to V2 fallback).
    const FOCUSED_GROUNDING_TIMEOUT_MS = parseInt(
      process.env.FOCUSED_GROUNDING_TIMEOUT_MS || '45000',
      10,
    );
    try {
      if (SKIP_FOCUSED) {
        throw new Error('STAGE1_SKIP_FOCUSED_GROUNDING=true — skipping focused grounding');
      }
      const focusedPromise = identifyProductFocused({
        imageParts,
        ocrText,
        barcodes: mergedBarcodes,
        locale,
        hint,
      });
      // Suppress orphan rejection if the source resolves/rejects after the timeout fires.
      Promise.resolve(focusedPromise).catch(() => {});
      groundingResult = await Promise.race([
        focusedPromise,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`Focused grounding timeout after ${FOCUSED_GROUNDING_TIMEOUT_MS}ms`)),
            FOCUSED_GROUNDING_TIMEOUT_MS,
          ),
        ),
      ]);
      groundingUsed = true;
    } catch (err) {
      console.warn('[stage1] Focused grounding failed, trying V2 grounding fallback:', err?.message);

      // Fallback: Use production-proven V2 grounding (same call that powers V2 identify).
      // Tight cap (default 20s) — if focused grounding already failed, the OUTER grounding
      // pipeline in routes/identify.js will retry the same call with its own budget. Long
      // waits here only steal from the V3 master timeout for no recovery benefit.
      // STAGE1_SKIP_V2_FALLBACK=true bypasses this entirely (emergency-bypass when both
      // grounding APIs are known broken; Stage1 continues without grounding using OCR+images).
      try {
        if (SKIP_V2_FALLBACK) {
          throw new Error('STAGE1_SKIP_V2_FALLBACK=true — skipping V2 grounding fallback');
        }
        const STAGE1_V2_FALLBACK_TIMEOUT_MS = parseInt(
          process.env.STAGE1_V2_FALLBACK_TIMEOUT_MS || '20000',
          10,
        );
        const v2FallbackPromise = identifyProductWithGrounding({ imageParts, ocrText, barcodes: mergedBarcodes, locale, hint });
        Promise.resolve(v2FallbackPromise).catch(() => {});
        v2FallbackRecord = await Promise.race([
          v2FallbackPromise,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`V2 grounding fallback timeout after ${STAGE1_V2_FALLBACK_TIMEOUT_MS}ms`)),
              STAGE1_V2_FALLBACK_TIMEOUT_MS,
            ),
          ),
        ]);
        console.log('[stage1] V2 grounding fallback succeeded');

        // Map V2 record to focused grounding format
        groundingResult = {
          brand: v2FallbackRecord.brand || '',
          model: v2FallbackRecord.model || '',
          mpn: v2FallbackRecord.mpn || '',
          variant: v2FallbackRecord.variant || '',
          condition: v2FallbackRecord.condition || 'Neu',
          internalCategory: v2FallbackRecord.internalCategory || '',
          weight_grams: v2FallbackRecord.weight_grams || null,
          color: v2FallbackRecord.color || '',
          size: v2FallbackRecord.size || '',
          material: v2FallbackRecord.material || '',
          ean: v2FallbackRecord.ean || '',
          gtin: v2FallbackRecord.gtin || '',
          upc: v2FallbackRecord.upc || '',
          _grounding: v2FallbackRecord._grounding || null,
        };
        groundingUsed = true;
      } catch (fallbackErr) {
        console.warn('[stage1] V2 grounding fallback also failed:', fallbackErr?.message);
      }
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
    webImageUrls: Array.isArray(groundingResult.web_image_urls)
      ? groundingResult.web_image_urls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u))
      : [],
    imageParts,
    v2FallbackRecord,
    _meta: {
      durationMs: Date.now() - startTime,
      groundingUsed,
      usedV2Fallback: Boolean(v2FallbackRecord),
      groundingSources: groundingResult._grounding?.sources || [],
      groundingModel: groundingResult._grounding?.model || null,
      imageQuality: Array.isArray(imageQuality) ? imageQuality : [],
      imageQualityGateEnabled: isImageQualityGateEnabled(),
    },
  };
}

module.exports = { runStage1Recognition };
