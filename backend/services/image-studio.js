'use strict';

/**
 * image-studio.js
 *
 * Turns an arbitrary product photo into a professional studio packshot:
 * corrected exposure, PURE WHITE backdrop (#FFFFFF, seamless — eBay/Google-
 * Shopping-Hauptbild-Standard, siehe Picture Policy) and a soft natural contact
 * shadow. The product itself must stay pixel-faithful (shape, colors, labels,
 * text).
 *
 * Strategy (each step best-effort, never returns nothing without trying all):
 *   1. Gemini image model chain: STUDIO_IMAGE_MODEL → STUDIO_IMAGE_FALLBACK_MODEL
 *   2. Result validation (decodable, min edge, bright top border = studio bg)
 *   3. Deterministic fallback: sharp cutout on gradient + synthetic contact shadow
 *   4. Upload to GCS; if upload fails the data URL is returned instead (the UI
 *      stores data URLs the same way the client-side improve actions do).
 */

const sharp = require('sharp');
const { generateProductImages } = require('../lib/vertex-ai');
const { fetchImageAsDataUrl } = require('./image-generation');
const { uploadBase64Image } = require('../lib/storage');

const MIN_EDGE_PX = 512;
const PRE_MAX_EDGE_PX = 1600;
const FALLBACK_CANVAS_PX = 1200;

const STUDIO_PROMPT =
  'Transform this product photo into a professional e-commerce studio photograph. ' +
  'Keep the product itself completely unchanged: same shape, proportions, colors, materials, ' +
  'labels and printed text — do not redraw, restyle or replace the product. ' +
  'Correct the exposure and white balance so the product is evenly and naturally lit, ' +
  'as if photographed in a softbox studio lighting setup. ' +
  'Replace the background with a PURE WHITE seamless studio backdrop — flat pure white ' +
  '#FFFFFF (RGB 255,255,255), NO gradient, no off-white, no colored tint. This is the ' +
  'eBay / Google Shopping main-image standard. Add only a soft, natural contact shadow ' +
  'directly under the product so it sits grounded on the surface (the surrounding backdrop ' +
  'stays pure white). ' +
  'No props, no text, no watermark, no people, no reflections of other objects, no added items. ' +
  'Keep the original camera perspective, show the product fully in frame with balanced margins.';

function studioModelChain() {
  const primary = process.env.STUDIO_IMAGE_MODEL || 'gemini-2.5-flash-image';
  const fallback =
    process.env.STUDIO_IMAGE_FALLBACK_MODEL || process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
  return [...new Set([primary, fallback])];
}

function studioTimeoutMs() {
  const raw = parseInt(process.env.STUDIO_IMAGE_TIMEOUT_MS || '60000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 60000;
}

function minBackgroundBrightness() {
  const raw = parseInt(process.env.STUDIO_MIN_BG_BRIGHTNESS || '200', 10);
  return Number.isFinite(raw) ? raw : 200;
}

function dataUrlToBuffer(dataUrl) {
  const match = /^data:(?<mime>[^;]+);base64,(?<data>.+)$/.exec(dataUrl || '');
  if (!match?.groups?.data) throw new Error('Invalid data URL');
  return { buffer: Buffer.from(match.groups.data, 'base64'), mimeType: match.groups.mime };
}

/**
 * EXIF-rotate + cap the longer edge so the model gets a clean, bounded input.
 */
async function preprocessInput(buffer) {
  const out = await sharp(buffer)
    .rotate()
    .resize({
      width: PRE_MAX_EDGE_PX,
      height: PRE_MAX_EDGE_PX,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
  return out;
}

/**
 * A valid studio result must decode, be reasonably large and have a bright top
 * border (the studio backdrop). Rejects dark/garbage generations so the chain
 * can move on to the next model or the deterministic fallback.
 */
async function validateStudioResult(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;
    if (Math.min(width, height) < MIN_EDGE_PX) {
      return { ok: false, reason: `too_small(${width}x${height})` };
    }
    const stripH = Math.max(1, Math.round(height * 0.06));
    const stats = await sharp(buffer)
      .extract({ left: 0, top: 0, width, height: stripH })
      .stats();
    const rgb = stats.channels.slice(0, 3);
    const mean = rgb.reduce((sum, c) => sum + c.mean, 0) / rgb.length;
    if (mean < minBackgroundBrightness()) {
      return { ok: false, reason: `background_too_dark(${Math.round(mean)})` };
    }
    return { ok: true, width, height };
  } catch (err) {
    return { ok: false, reason: `decode_error: ${err.message}` };
  }
}

async function tryGeminiStudio(preBuffer, attempts) {
  const referenceImageBase64 = `data:image/jpeg;base64,${preBuffer.toString('base64')}`;
  for (const model of studioModelChain()) {
    try {
      const images = await generateProductImages({
        prompt: STUDIO_PROMPT,
        count: 1,
        aspectRatio: '1:1',
        referenceImageBase64,
        model,
        timeoutMs: studioTimeoutMs(),
      });
      const candidate = images?.[0];
      if (!candidate?.base64) {
        attempts.push({ model, reason: 'no_image_in_response' });
        continue;
      }
      const buffer = Buffer.from(candidate.base64, 'base64');
      const verdict = await validateStudioResult(buffer);
      if (!verdict.ok) {
        attempts.push({ model, reason: verdict.reason });
        continue;
      }
      return {
        buffer,
        mimeType: candidate.mimeType || 'image/png',
        model,
        width: verdict.width,
        height: verdict.height,
      };
    } catch (err) {
      attempts.push({ model, reason: `gemini_error: ${err.message}` });
    }
  }
  return null;
}

/**
 * Deterministischer Studio-Fallback (wenn die Gemini-Kette scheitert): trimmt den
 * (meist weißen) Rand des Lieferantenfotos und zentriert das Produkt UNVERÄNDERT
 * auf einem reinweißen Quadrat mit Rand.
 *
 * BEWUSST OHNE removeBackground/Freisteller (Incident 2026-07-18): die
 * schwellenwert-basierte Near-White-Maske macht bei hellen/metallischen Produkten
 * (z.B. Alu-Dose) die Produkt-Innenflächen transparent → das Produkt zerfällt in
 * Fragmente, die beim Compositen zu Streifen verschmieren. Es gibt keine
 * zuverlässige Heuristik, „guten" von „zerstörerischem" Freisteller zu trennen —
 * darum stellen wir im Fallback NIE frei und liefern nur ein sauberes, intaktes
 * Produkt auf Weiß. Der schöne Freisteller + Kontaktschatten ist Aufgabe des
 * Gemini-Wegs (Primär).
 */
async function padOnWhiteSquare(buffer, size = FALLBACK_CANVAS_PX) {
  let trimmed = buffer;
  try {
    trimmed = await sharp(buffer).trim({ threshold: 12 }).toBuffer();
  } catch {
    trimmed = buffer;
  }
  const pad = Math.round(size * 0.08);
  const inner = size - pad * 2;
  const resized = await sharp(trimmed)
    .resize(inner, inner, { fit: 'inside', withoutEnlargement: false })
    .toBuffer();
  const rm = await sharp(resized).metadata();
  const out = await sharp({
    create: { width: size, height: size, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([{ input: resized, left: Math.round((size - (rm.width || inner)) / 2), top: Math.round((size - (rm.height || inner)) / 2) }])
    .png()
    .toBuffer();
  return { buffer: out, mimeType: 'image/png', width: size, height: size };
}

async function fallbackComposite(preBuffer) {
  return padOnWhiteSquare(preBuffer);
}

/**
 * makeStudioPhoto({ productId, image }) → {
 *   image: { url_or_base64, variant, source, notes, mimeType, width, height },
 *   method: 'gemini' | 'composite_fallback',
 *   model: string|null,
 *   attempts: Array<{model, reason}>,
 * }
 *
 * `image` is a product image ref ({ url_or_base64 }) — URL or data URL.
 */
async function makeStudioPhoto({ productId, image }) {
  if (!productId) throw new Error('productId is required');
  if (!image?.url_or_base64) throw new Error('image with url_or_base64 is required');

  const sourceDataUrl = await fetchImageAsDataUrl(image);
  const { buffer: sourceBuffer } = dataUrlToBuffer(sourceDataUrl);
  const preBuffer = await preprocessInput(sourceBuffer);

  const attempts = [];
  let result = await tryGeminiStudio(preBuffer, attempts);
  let method = 'gemini';
  let model = result?.model || null;

  if (!result) {
    console.warn(
      `[image-studio] Gemini chain failed for ${productId} (${attempts
        .map((a) => `${a.model}: ${a.reason}`)
        .join(' | ')}), using composite fallback`
    );
    result = await fallbackComposite(preBuffer);
    method = 'composite_fallback';
    model = null;
  }

  const resultDataUrl = `data:${result.mimeType};base64,${result.buffer.toString('base64')}`;

  let finalUrl = resultDataUrl;
  let mimeType = result.mimeType;
  try {
    const uploaded = await uploadBase64Image(resultDataUrl, productId, 'studio');
    if (uploaded?.url) {
      finalUrl = uploaded.url;
      mimeType = uploaded.mimeType || mimeType;
    }
  } catch (uploadErr) {
    console.warn(`[image-studio] GCS upload failed for ${productId}, returning data URL: ${uploadErr.message}`);
  }

  return {
    image: {
      url_or_base64: finalUrl,
      variant: 'studio_front',
      source: method === 'gemini' ? 'studio_gemini' : 'studio_composite',
      notes:
        method === 'gemini'
          ? // "Gemini" im Text ist Absicht: markiert das Bild im Frontend als
            // trusted-AI (isTrustedAiImage) und hält es aus Referenz-Pools raus.
            'Studio-Foto (Gemini: Belichtung korrigiert, reinweißer Hintergrund, Kontaktschatten)'
          : 'Studio-Foto (Produkt zentriert auf reinweißem Hintergrund)',
      mimeType,
      width: result.width || null,
      height: result.height || null,
    },
    method,
    model,
    attempts,
  };
}

module.exports = {
  makeStudioPhoto,
  _internal: { validateStudioResult, preprocessInput, studioModelChain, STUDIO_PROMPT, padOnWhiteSquare, fallbackComposite },
};
