'use strict';

/**
 * image-studio.js
 *
 * Turns an arbitrary product photo into an authentic white-background packshot:
 * PURE WHITE backdrop (#FFFFFF) and a soft natural contact shadow, while the
 * product itself stays pixel-faithful (shape, colors, labels, text, even
 * imperfections). Deliberately NOT a glossy high-end studio render — the look
 * keeps a believable, slightly amateur "private seller phone photo" character
 * (Owner requirement 2026-07-21). Product authenticity is the top priority: the
 * prompt forbids any redraw/retouch/reshape/re-color of the product.
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
const { studioImageModelChain, maxObjectReferences } = require('../lib/gemini-image-models');
const { assessBackgroundBrightness } = require('../lib/image-result-check');
const { fetchImageAsDataUrl } = require('./image-generation');
const { uploadBase64Image } = require('../lib/storage');

const MIN_EDGE_PX = 512;
const PRE_MAX_EDGE_PX = 1600;
const FALLBACK_CANVAS_PX = 1200;
// eBay schaltet die Zoomlupe erst ab 1.600 px frei; '2K' liegt darueber. Fuehrt
// ein Modell die Groessensteuerung nicht, wird das Feld gar nicht erst gesendet.
const STUDIO_IMAGE_SIZE = process.env.STUDIO_IMAGE_SIZE || '2K';

const SIBLING_HINT = (total) =>
  `Image 1 is the photo you must edit. Images 2 to ${total} show the SAME physical item from ` +
  'other angles — use them ONLY to confirm its true shape, colors, materials and markings. ' +
  'Do NOT copy their camera angle and do NOT merge them into the result. ' +
  "The output must keep image 1's perspective and framing.";

const STUDIO_PROMPT =
  'Edit ONLY the background and overall lighting of this product photo. ' +
  'The product is the single most important element and MUST stay 100% authentic and unchanged: ' +
  'do NOT redraw, regenerate, restyle, retouch, beautify, sharpen, reshape, rotate or re-color it. ' +
  'Preserve every detail of the product EXACTLY as in the original — the exact shape, proportions, ' +
  'viewing angle, colors, materials, surface texture, labels, logos and printed text, including any ' +
  'existing wear, scratches, dents, dust or small imperfections. Never invent, add, remove or "improve" ' +
  'any part of the product itself. If in doubt, leave the product pixel-for-pixel as it is. ' +
  'Replace ONLY the background with a plain PURE WHITE backdrop — flat pure white #FFFFFF ' +
  '(RGB 255,255,255), NO gradient, no off-white, no colored tint. ' +
  'Add a soft, natural contact shadow directly under the product so it looks grounded on the surface. ' +
  'Keep the result honest and believable, like a real photo taken by a small private online seller: ' +
  'a simple phone snapshot of the item placed on a plain white surface. Natural, slightly uneven everyday ' +
  'lighting is fine and even wanted — do NOT turn it into a glossy, high-end, hyper-polished or overly ' +
  'perfect commercial studio render. It should keep a slightly amateur, genuine look, not an advertisement. ' +
  'No props, no added text, no watermark, no people, no reflections of other objects, no added items. ' +
  'Keep the original camera perspective and framing; show the product fully in frame.';

// Modellkette kommt seit 2026-09-02 aus lib/gemini-image-models.js. Vorher stand
// hier ein eigener Default-String, und der in CLAUDE.md dokumentierte
// STUDIO_IMAGE_MODEL='gemini-3-pro-image-preview' zeigte seit dem 25.06.2026 auf
// ein ABGESCHALTETES Modell — jeder Studio-Aufruf verbrannte den Primaerversuch
// in einen Fehler und lief unbemerkt in die Fallback-Kette.
function studioModelChain() {
  return studioImageModelChain();
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
 * Ein gültiges Studio-Ergebnis muss dekodieren, ausreichend gross sein und einen
 * hellen HINTERGRUND haben.
 *
 * KORREKTUR 2026-09-03: die Helligkeit wird über die vier ECKEN gemessen, nicht
 * mehr über den oberen Randstreifen. Der Streifen lief über die volle Breite —
 * reicht das Produkt in den oberen Bildrand (bei einem formatfüllenden Packshot
 * der Normalfall), sank der Mittelwert unter die Schwelle und ein korrektes
 * Studio-Foto wurde verworfen. Gemessen in Produktion: 5 von 5 Läufen
 * scheiterten so, über drei Modelle hinweg — jedes Mal landete der
 * deterministische Rückfall in der Galerie statt des fertigen Studio-Fotos.
 * Die Prüfung liegt jetzt in `lib/image-result-check.js`, gemeinsam mit dem
 * Varianten-Pfad (der denselben Fehler geerbt hatte).
 */
async function validateStudioResult(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;
    if (Math.min(width, height) < MIN_EDGE_PX) {
      return { ok: false, reason: `too_small(${width}x${height})` };
    }
    const hg = await assessBackgroundBrightness(buffer, minBackgroundBrightness());
    if (!hg.ok) {
      return { ok: false, reason: `background_too_dark(Ecken ${hg.corners.join('/')})` };
    }
    return { ok: true, width, height };
  } catch (err) {
    return { ok: false, reason: `decode_error: ${err.message}` };
  }
}

async function tryGeminiStudio(preBuffer, attempts, siblingDataUrls = []) {
  const referenceImageBase64 = `data:image/jpeg;base64,${preBuffer.toString('base64')}`;
  // Weitere echte Fotos DESSELBEN Artikels als Identitaetsanker. Sie aendern die
  // Perspektive nicht (das verbietet der Prompt ausdruecklich), geben dem Modell
  // aber Form, Farbe und Beschriftung aus mehreren Blickwinkeln vor — der
  // dokumentierte Hebel gegen Identitaetsdrift.
  for (const model of studioModelChain()) {
    // Die Obergrenze fuer Objekt-Referenzen ist MODELLABHAENGIG. Ohne diese
    // Kappung gingen vier Bilder an ein Modell mit dokumentiertem Limit drei.
    const limit = Math.max(1, maxObjectReferences(model));
    const referenceImages = [referenceImageBase64, ...siblingDataUrls].slice(0, limit);
    try {
      const images = await generateProductImages({
        prompt:
          referenceImages.length > 1
            ? `${STUDIO_PROMPT} ${SIBLING_HINT(referenceImages.length)}`
            : STUDIO_PROMPT,
        count: 1,
        aspectRatio: '1:1',
        referenceImages,
        model,
        timeoutMs: studioTimeoutMs(),
        imageSize: STUDIO_IMAGE_SIZE,
        // Die Modellkette IST die Wiederholung — sonst bis zu sechs bezahlte
        // Bildaufrufe und ~360 s Laufzeit je Studio-Foto.
        maxAttempts: 1,
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

  // SEITENVERHAELTNIS BEHALTEN (Korrektur 2026-09-03). Vorher wurde IMMER auf ein
  // Quadrat gelegt: ein Querformat-Foto bekam dadurch breite weisse Balken oben
  // und unten und das Produkt schrumpfte auf rund die Haelfte der Bildhoehe. Das
  // Ergebnis war sichtbar SCHLECHTER als die Vorlage — der Rueckfall soll ein
  // Foto retten, nicht verschlimmern.
  const tm = await sharp(trimmed).metadata();
  const srcW = tm.width || size;
  const srcH = tm.height || size;
  const seite = srcW / srcH;

  // Laengere Kante auf `size`, kuerzere proportional — mit schmalem weissen Rand.
  const zielW = seite >= 1 ? size : Math.round(size * seite);
  const zielH = seite >= 1 ? Math.round(size / seite) : size;
  const pad = Math.round(Math.min(zielW, zielH) * 0.04);
  const innerW = Math.max(1, zielW - pad * 2);
  const innerH = Math.max(1, zielH - pad * 2);

  const resized = await sharp(trimmed)
    .resize(innerW, innerH, { fit: 'inside', withoutEnlargement: false })
    .toBuffer();
  const rm = await sharp(resized).metadata();
  const out = await sharp({
    create: { width: zielW, height: zielH, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([
      {
        input: resized,
        left: Math.round((zielW - (rm.width || innerW)) / 2),
        top: Math.round((zielH - (rm.height || innerH)) / 2),
      },
    ])
    .png()
    .toBuffer();
  return { buffer: out, mimeType: 'image/png', width: zielW, height: zielH };
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
async function makeStudioPhoto({ productId, image, siblingImages = [] }) {
  if (!productId) throw new Error('productId is required');
  if (!image?.url_or_base64) throw new Error('image with url_or_base64 is required');

  const sourceDataUrl = await fetchImageAsDataUrl(image);
  const { buffer: sourceBuffer } = dataUrlToBuffer(sourceDataUrl);
  const preBuffer = await preprocessInput(sourceBuffer);

  // Geschwisterbilder sind rein additiv: schlaegt ein Download fehl, laeuft der
  // Studio-Weg genau wie bisher mit einem einzigen Bild weiter.
  const siblingKandidaten = (Array.isArray(siblingImages) ? siblingImages : [])
    .filter((sib) => sib?.url_or_base64 && sib.url_or_base64 !== image.url_or_base64)
    .slice(0, 3);
  // PARALLEL: nacheinander konnten drei Downloads mit je 20 s Timeout und
  // Web-Unlocker-Rueckfall das Studio-Foto um bis zu zwei Minuten verzoegern.
  const siblingDataUrls = (
    await Promise.all(
      siblingKandidaten.map(async (sibling) => {
        try {
          const raw = await fetchImageAsDataUrl(sibling);
          const { buffer } = dataUrlToBuffer(raw);
          const pre = await preprocessInput(buffer);
          return `data:image/jpeg;base64,${pre.toString('base64')}`;
        } catch (err) {
          console.warn(`[image-studio] Geschwisterbild uebersprungen: ${err.message}`);
          return null;
        }
      })
    )
  ).filter(Boolean);

  const attempts = [];
  let result = await tryGeminiStudio(preBuffer, attempts, siblingDataUrls);
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
