'use strict';

/**
 * Interactive Studio-Foto: photographic relighting of the selected real item.
 * Render first; require identity, condition, colour and presentation approval.
 * Keep the finished lighting/shadow; square padding never crops or remasks it.
 * STUDIO_PHOTOGRAPHIC=off restores the prior composite-first pipeline.
 */

const sharp = require('sharp');
const { photographicStudioEnabled, STUDIO_PHOTOGRAPHY_BRIEF, finishStudioCanvas } = require('../lib/studio-photography');
const { PROFESSIONAL_RELIGHTING, PRODUCT_PRESERVATION } = require('../lib/product-photo-policy');
const { neuerZaehler } = require('../lib/image-cost');
const { generateProductImages } = require('../lib/vertex-ai');
const { studioImageModelChain, maskImageModelChain, maxObjectReferences } = require('../lib/gemini-image-models');
const { assessBackgroundBrightness, judgeProductIdentity, classifyIdentityVerdict } = require('../lib/image-result-check');
const { bauePackshot, compositeEnabled } = require('../lib/packshot-composite');
const { buildMaskPrompt } = require('./prompt-engine');
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

// Legacy retouch prompt retained for explicit rollback. The current shared
// photographic brief is selected at request time below.
const MASKEN_PROMPT = buildMaskPrompt();

const STUDIO_PROMPT = [
  'Retouch this photo into a clean e-commerce packshot of the SAME physical item.',
  '',
  PROFESSIONAL_RELIGHTING,
  PRODUCT_PRESERVATION,
  'DO THIS:',
  '- Replace the whole background with seamless pure white, RGB 255,255,255, edge to edge. All four picture corners end up pure white — no gradient, no vignette, no grey wash, no tint, no visible horizon line. Only the background must be white; preserve all grey areas and discoloration on the item.',
  '- Remove everything that is not the item: hands, fingers, table, shelf, floor, other boxes, clutter.',
  '- Straighten the item so its edges sit level and square to the camera, and centre it in the frame with even white space on all sides.',
  '- Light it with soft, even studio light: lift only recoverable shadows and remove lighting colour casts. Preserve actual yellowing or discoloration of cardboard and faded print.',
  '- Cast a soft grey contact shadow under the item. It must be clearly visible: darkest right where the item meets the surface, then fading out to nothing within roughly one third of the item\'s width. Without that shadow the item looks pasted onto the page. Keep it tight under the item — everything further away stays pure white.',
  '',
  'KEEP EXACTLY AS PHOTOGRAPHED — this is the same real object, reproduced, not redesigned:',
  '- Shape, proportions, viewing angle, colours, materials and surface texture, including existing wear, creases, dents, scuffs and dust.',
  '- Every printed character on the item: brand and company names, street addresses, product codes, lot numbers, dates, barcode bars and their digits, certification marks and every line of multilingual small print — letter for letter, digit for digit, accent for accent, in the same language, the same typeface, the same size and the same position. Print that sits sideways or upside down on the item stays sideways or upside down.',
  '- Copy these characters as shapes; do not read them and set them again. Where a line is too small or too blurred to copy, reproduce it exactly that small and that blurred rather than inventing legible words.',
  '',
  'Add nothing: no props, no invented mirror image, no overlay text, no watermark, no border, no people.',
  '',
  'Output the retouched photograph only.',
].join('\n');

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
    .flatten({ background: '#ffffff' })
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

async function tryGeminiStudio(preBuffer, attempts, siblingDataUrls = [], promptText = STUDIO_PROMPT, opts = {}) {
  // Der MASKEN-Lauf ist ein anderer Auftrag als der Retusche-Lauf: von ihm wird
  // nur die SILHOUETTE gelesen, seine Pixel landen nie im Endbild. Detailtreue,
  // Kleindruck und Farbe sind dort gleichgueltig — also gehoert er auf das
  // billigste Modell in kleiner Groesse. Bis 2026-09-10 lief er auf demselben
  // teuren Modell in 2K wie die Retusche: 0,134 $ fuer Pixel, die weggeworfen
  // werden. Dieselbe Quelle wie die Galerie, keine zweite Tabelle.
  const kette = opts.maske ? maskImageModelChain() : studioModelChain();
  const zielGroesse = opts.maske ? (process.env.VARIANT_MASK_IMAGE_SIZE || '1K') : STUDIO_IMAGE_SIZE;
  const referenceImageBase64 = `data:image/jpeg;base64,${preBuffer.toString('base64')}`;

  // NUR DAS GEWAEHLTE FOTO (Korrektur 2026-09-04, Betreiber: "Studio-Foto nimmt
  // immer das erste Bild als Referenz").
  //
  // Am 02.09. wurden zusaetzliche Fotos desselben Artikels als "Identitaetsanker"
  // mitgeschickt. Der Prompt verbot ausdruecklich, deren Perspektive zu
  // uebernehmen — das Modell hielt sich nicht daran und mischte die Vorlagen.
  // Fuer den Bediener sah es so aus, als wuerde immer das erste Galeriebild
  // benutzt statt des ausgewaehlten.
  //
  // Der Denkfehler: Anker helfen, wenn eine Ansicht ERFUNDEN werden muss. Seit
  // der Umstellung wird nichts mehr erfunden, sondern EIN vorhandenes Foto
  // aufbereitet — alles Noetige steckt in genau diesem Foto. Weitere Bilder
  // koennen nur Drift erzeugen.
  const ankerErlaubt = String(process.env.STUDIO_SIBLING_ANCHORS || '').trim() === 'on';
  const anker = ankerErlaubt ? siblingDataUrls : [];

  for (const model of kette) {
    if (opts.cost && !opts.cost.darfNoch(model, zielGroesse)) {
      attempts.push({ model, reason: 'image_cost_cap' });
      continue;
    }
    // Die Obergrenze fuer Objekt-Referenzen ist MODELLABHAENGIG.
    const limit = Math.max(1, maxObjectReferences(model));
    const referenceImages = [referenceImageBase64, ...anker].slice(0, limit);
    try {
      // Vorab reservieren: auch ein Timeout kann bereits Kosten verursacht haben.
      opts.cost?.buche(model, zielGroesse, opts.maske ? 'studio_mask_attempt' : 'studio_retouch_attempt');
      const images = await generateProductImages({
        prompt:
          referenceImages.length > 1
            ? `${promptText} ${SIBLING_HINT(referenceImages.length)}`
            : promptText,
        count: 1,
        // KEIN erzwungenes Seitenverhaeltnis (gemessen 2026-09-04). '1:1' zwang
        // das Modell, ein 4:3-Foto neu zu KOMPONIEREN — und dabei zeichnete es
        // den Kleindruck neu: aus "glaskoch B. Koch jr. GmbH + Co. KG" wurde
        // "glaskooh B. Naoh p. Gnditt + Oa. KG". Ohne Vorgabe behaelt es das
        // Format der Vorlage und der Text bleibt buchstabengetreu.
        aspectRatio: !opts.maske && photographicStudioEnabled() ? '1:1' : null,
        referenceImages,
        model,
        timeoutMs: studioTimeoutMs(),
        imageSize: zielGroesse,
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

      let quality = null;
      if (!opts.maske) {
        const identity = await judgeProductIdentity(
          [{ inlineData: { data: preBuffer.toString('base64'), mimeType: 'image/jpeg' } }],
          { data: candidate.base64, mimeType: candidate.mimeType || 'image/png' },
          { requireCleanBackground: true, requireStudioPresentation: photographicStudioEnabled() },
        );
        quality = classifyIdentityVerdict(identity, { requireApproval: true, requireStudioPresentation: photographicStudioEnabled() });
        if (quality.action === 'verwerfen') {
          attempts.push({ model, reason: `${quality.reason}: ${quality.warnings.join('; ')}` });
          continue;
        }
      }
      return {
        buffer,
        mimeType: candidate.mimeType || 'image/png',
        model,
        quality,
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
 *   method: 'gemini' | 'composite',
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
  const cost = neuerZaehler();
  let result = null;
  let method = null;
  let model = null;

  // Legacy composite path, used only for explicit rollback.
  if (!photographicStudioEnabled() && compositeEnabled()) {
    try {
      const maskenLauf = await tryGeminiStudio(preBuffer, attempts, [], MASKEN_PROMPT, { maske: true, cost });
      if (maskenLauf) {
        const packshot = await bauePackshot(sourceBuffer, maskenLauf.buffer, {
          schattenlift: false,
          reviewResult: async (buffer) => classifyIdentityVerdict(await judgeProductIdentity(
            [{ inlineData: { data: preBuffer.toString('base64'), mimeType: 'image/jpeg' } }],
            { data: buffer.toString('base64'), mimeType: 'image/jpeg' },
            { requireCleanBackground: true },
          ), { requireApproval: true }),
        });
        if (packshot.ok) {
          result = { buffer: packshot.buffer, mimeType: 'image/jpeg', width: packshot.width, height: packshot.height };
          method = 'composite';
          model = maskenLauf.model;
          console.log(
            `[image-studio] Composite für ${productId} (${maskenLauf.model}): ${JSON.stringify(packshot.info)}`
          );
        } else {
          attempts.push({ model: maskenLauf.model, reason: `composite_verworfen: ${packshot.gruende.join(', ')}` });
        }
      }
    } catch (err) {
      attempts.push({ model: 'composite', reason: `composite_fehler: ${err.message}` });
    }
  }

  // Photographic default. No unverified flat-cutout fallback after rejection.
  if (!result) {
    const prompt = photographicStudioEnabled()
      ? [STUDIO_PHOTOGRAPHY_BRIEF, 'Edit image 1 only. Keep exactly the same item, pose, visible parts and viewing direction.', PROFESSIONAL_RELIGHTING, PRODUCT_PRESERVATION].join(' ')
      : STUDIO_PROMPT;
    result = await tryGeminiStudio(preBuffer, attempts, siblingDataUrls, prompt, { cost });
    method = 'gemini';
    model = result?.model || null;
  }

  if (!result) {
    const error = new Error('Kein Studiofoto hat die Qualitätsprüfung bestanden. Das Original bleibt erhalten. Bitte ein anderes Referenzfoto wählen.');
    error.code = 'STUDIO_QUALITY_REJECTED';
    error.attempts = attempts;
    throw error;
  }

  // Quadratisch erst NACH der Bearbeitung: kein generatives Umkomponieren,
  // kein Beschnitt. Upscaling ergänzt keine echte Bildinformation.
  Object.assign(result, await finishStudioCanvas(result.buffer));
  const qualityNote = result.quality?.action === 'ungeprueft'
    ? ' — Produkttreue nicht geprüft; bitte Original vergleichen.'
    : result.quality?.warnings?.length ? ` — Bitte prüfen: ${result.quality.warnings.join('; ')}` : '';

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
      ...(photographicStudioEnabled() ? { studioPipeline: 'photographic-v1' } : {}),
      source: method === 'gemini' ? 'studio_gemini' : 'studio_composite',
      notes:
        method === 'gemini'
          ? // "Gemini" im Text ist Absicht: markiert das Bild im Frontend als
            // trusted-AI (isTrustedAiImage) und hält es aus Referenz-Pools raus.
            'Studio-Foto (Gemini: Belichtung korrigiert, reinweißer Hintergrund, Kontaktschatten)' + qualityNote
          : 'Studio-Foto (Originaldetails erhalten, weißer Hintergrund, weicher Kontaktschatten)',
      mimeType,
      width: result.width || null,
      height: result.height || null,
    },
    method,
    model,
    attempts,
    cost: cost.bericht(),
  };
}

module.exports = {
  makeStudioPhoto,
  _internal: { validateStudioResult, preprocessInput, studioModelChain, STUDIO_PROMPT, padOnWhiteSquare, fallbackComposite },
};
