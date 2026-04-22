'use strict';

/**
 * image-enhance.js
 *
 * High-level image enhancement pipeline for product photos in Identify-V4.
 *
 * Capabilities:
 *   1. Upscale via sharp (deterministic, local, fast) — target 1600px max edge
 *   2. Background-removal via `gemini-3-pro-image-preview` (best-effort, returns
 *      original if Gemini fails)
 *   3. Angle classification via Gemini Flash (front/back/detail/lifestyle/pack)
 *   4. Image ranking: sorts by angle priority × quality score
 *
 * The Gemini integration is DEFERRED to call-site injection — image-enhance.js
 * itself does not import gemini3-client directly (makes it trivially testable).
 * Workers pass a `geminiClient` option when they want AI enhancement.
 *
 * All functions are best-effort: on any error, the original buffer is returned
 * unchanged. Never throws, never blocks the pipeline.
 */

const TARGET_EDGE_PX = 1600;
const MIN_UPSCALE_RATIO = 1.2; // don't upscale if already close to target
const DEFAULT_JPEG_QUALITY = 88;

const ANGLE_PRIORITY = Object.freeze({
  front: 0,
  detail: 1,
  side: 2,
  back: 3,
  pack: 4,
  lifestyle: 5,
  unknown: 6,
});

const VALID_ANGLES = Object.freeze(['front', 'detail', 'side', 'back', 'pack', 'lifestyle', 'unknown']);

let _sharp = null;
function getSharp() {
  if (_sharp !== null) return _sharp;
  try {
    _sharp = require('sharp');
  } catch (err) {
    _sharp = false; // cached negative result
  }
  return _sharp || null;
}

/**
 * upscaleImage(buffer, { targetEdge, quality }) → Promise<{ buffer, width, height, upscaled, reason }>
 *
 * Uses sharp.resize with `fit: 'inside'` so aspect ratio is preserved.
 * If the input is already >= targetEdge / MIN_UPSCALE_RATIO, returns as-is.
 */
async function upscaleImage(buffer, options = {}) {
  const { targetEdge = TARGET_EDGE_PX, quality = DEFAULT_JPEG_QUALITY } = options;
  const sharp = getSharp();

  if (!sharp) {
    return { buffer, width: 0, height: 0, upscaled: false, reason: 'sharp_not_available' };
  }
  if (!buffer || !Buffer.isBuffer(buffer)) {
    return { buffer, width: 0, height: 0, upscaled: false, reason: 'invalid_buffer' };
  }

  try {
    const img = sharp(buffer);
    const meta = await img.metadata();
    const { width = 0, height = 0 } = meta;
    const longerEdge = Math.max(width, height);

    if (longerEdge === 0) {
      return { buffer, width: 0, height: 0, upscaled: false, reason: 'unknown_dimensions' };
    }
    if (longerEdge * MIN_UPSCALE_RATIO >= targetEdge) {
      return { buffer, width, height, upscaled: false, reason: 'already_sufficient' };
    }

    const resized = await img
      .rotate()
      .resize({
        width: targetEdge,
        height: targetEdge,
        fit: 'inside',
        withoutEnlargement: false,
        kernel: sharp.kernel.lanczos3,
      })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    return {
      buffer: resized.data,
      width: resized.info.width,
      height: resized.info.height,
      upscaled: true,
      reason: 'sharp_lanczos3',
    };
  } catch (err) {
    return { buffer, width: 0, height: 0, upscaled: false, reason: `sharp_error: ${err.message}` };
  }
}

/**
 * removeBackground(buffer, { geminiClient, prompt? }) → Promise<{ buffer, modified, reason }>
 *
 * Best-effort. If geminiClient is not provided or the call fails, returns the
 * original buffer with `modified: false`. Does NOT throw.
 *
 * The Gemini Image Preview API accepts an image + prompt and returns a
 * modified image. We use a zero-shot "remove background, neutral white"
 * prompt. Caller decides whether the result is acceptable.
 */
async function removeBackground(buffer, options = {}) {
  const { geminiClient = null, prompt = null } = options;

  if (!buffer || !Buffer.isBuffer(buffer)) {
    return { buffer, modified: false, reason: 'invalid_buffer' };
  }
  if (!geminiClient || typeof geminiClient.generateImage !== 'function') {
    return { buffer, modified: false, reason: 'no_gemini_client' };
  }

  const effectivePrompt =
    prompt ||
    'Remove the background cleanly. Keep the product sharp and unchanged. ' +
      'Replace background with a pure neutral white (#FFFFFF). Maintain original ' +
      'lighting, shadows, and color accuracy. Output 1:1 or original aspect ratio.';

  try {
    const result = await geminiClient.generateImage({
      model: 'gemini-3-pro-image-preview',
      prompt: effectivePrompt,
      inputImage: { inlineData: { data: buffer.toString('base64'), mimeType: 'image/jpeg' } },
    });

    const outBase64 = result?.image?.inlineData?.data || result?.base64 || null;
    if (!outBase64 || typeof outBase64 !== 'string') {
      return { buffer, modified: false, reason: 'no_image_in_response' };
    }

    const outBuffer = Buffer.from(outBase64, 'base64');
    if (outBuffer.length < 100) {
      return { buffer, modified: false, reason: 'output_too_small' };
    }

    return { buffer: outBuffer, modified: true, reason: 'gemini_image_preview' };
  } catch (err) {
    return { buffer, modified: false, reason: `gemini_error: ${err.message}` };
  }
}

/**
 * classifyImageAngle(imagePart, { geminiClient }) → Promise<{angle, confidence, reason}>
 *
 * imagePart: { inlineData: { data, mimeType } } — already in Gemini SDK format.
 *
 * Returns one of VALID_ANGLES (normalized) with a confidence 0..1.
 * Best-effort. On failure: returns { angle: 'unknown', confidence: 0 }.
 */
async function classifyImageAngle(imagePart, options = {}) {
  const { geminiClient = null } = options;

  if (!imagePart || typeof imagePart !== 'object') {
    return { angle: 'unknown', confidence: 0, reason: 'invalid_part' };
  }
  if (!geminiClient || typeof geminiClient.generateContent !== 'function') {
    return { angle: 'unknown', confidence: 0, reason: 'no_gemini_client' };
  }

  const instruction =
    'Classify this product photo by viewing angle. Respond with JSON only: ' +
    `{"angle": "front" | "detail" | "side" | "back" | "pack" | "lifestyle" | "unknown", "confidence": 0.0-1.0}. ` +
    '"front" = standard product-front view. "detail" = close-up of a feature. ' +
    '"side"/"back" = alternate angles. "pack" = in original packaging/box. ' +
    '"lifestyle" = in-use or contextual scene. "unknown" = unclear.';

  try {
    const response = await geminiClient.generateContent({
      model: 'gemini-3-flash-preview',
      contents: [imagePart, { text: instruction }],
      config: { responseMimeType: 'application/json', temperature: 0.1 },
    });

    const text = response?.text || response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text) return { angle: 'unknown', confidence: 0, reason: 'empty_response' };

    const parsed = JSON.parse(text.trim());
    const angle = VALID_ANGLES.includes(parsed.angle) ? parsed.angle : 'unknown';
    const confidence =
      typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0;

    return { angle, confidence, reason: 'gemini_flash' };
  } catch (err) {
    return { angle: 'unknown', confidence: 0, reason: `classify_error: ${err.message}` };
  }
}

/**
 * rankImages(images) → sorted array (best first).
 *
 * images: Array<{ angle?, quality?, source? }>
 * Sort key: (angle priority, -quality, source preference)
 */
function rankImages(images) {
  if (!Array.isArray(images)) return [];
  const sourcePriority = { upload: 0, manufacturer: 1, web: 2, generated: 3 };

  return [...images].sort((a, b) => {
    const aAngle = ANGLE_PRIORITY[a?.angle] ?? ANGLE_PRIORITY.unknown;
    const bAngle = ANGLE_PRIORITY[b?.angle] ?? ANGLE_PRIORITY.unknown;
    if (aAngle !== bAngle) return aAngle - bAngle;

    const aQual = typeof a?.quality === 'number' ? a.quality : 0;
    const bQual = typeof b?.quality === 'number' ? b.quality : 0;
    if (aQual !== bQual) return bQual - aQual;

    const aSrc = sourcePriority[a?.source] ?? 99;
    const bSrc = sourcePriority[b?.source] ?? 99;
    return aSrc - bSrc;
  });
}

module.exports = {
  TARGET_EDGE_PX,
  ANGLE_PRIORITY,
  VALID_ANGLES,
  upscaleImage,
  removeBackground,
  classifyImageAngle,
  rankImages,
  _internal: { getSharp },
};
