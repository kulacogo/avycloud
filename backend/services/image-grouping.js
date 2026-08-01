'use strict';

const { buildGenerationConfig } = require('../lib/gemini-config');

// Vision classification calls need deterministic output (low temp) and
// constrained sampling (low topP/topK). Token limits differ per call site:
// large output for multi-image grouping (8192), small for single-image
// detection (1024). Centralizing via buildGenerationConfig hooks into the
// shared defaults from lib/gemini-config.js.
const VISION_GROUPING_CONFIG = buildGenerationConfig({
  temperature: 0.1,
  topP: 0.8,
  topK: 16,
  maxOutputTokens: 8192,
});

// 8192 statt 1024: Thinking-Modelle (gemini-3-flash-preview) verbrauchen das
// Budget auch für Denk-Tokens — bei 1024 endete JEDE Mehrprodukt-Erkennung in
// MAX_TOKENS-Truncation + Parse-Fail (Prod 2026-08-01), Fallback war immer
// "1 Gruppe, 100%".
const VISION_DETECTION_CONFIG = buildGenerationConfig({
  temperature: 0.1,
  topP: 0.8,
  topK: 16,
  maxOutputTokens: 8192,
});

// BUG-090: Structured output schema for grouping (replaces free-text JSON)
const GROUPING_SCHEMA = {
  type: 'object',
  properties: {
    product_count: { type: 'integer' },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          image_indices: { type: 'array', items: { type: 'integer' } },
          confidence: { type: 'number' },
          reason: { type: 'string' },
          detected_barcode: { type: 'string' },
          brand_hint: { type: 'string' },
          category_hint: { type: 'string' },
          position_hint: { type: 'string' },
        },
        required: ['label', 'image_indices', 'confidence'],
      },
    },
  },
  required: ['product_count', 'groups'],
};

function buildGroupingPrompt(imageCount) {
  return [
    'Du bist ein Bildanalyse-Experte für Produktfotos in einem E-Commerce-Warenlager.',
    '',
    `Dir werden ${imageCount} Bilder gezeigt. Diese Bilder zeigen WAHRSCHEINLICH verschiedene Produkte.`,
    '',
    'Aufgabe:',
    '1. Erkenne wie viele VERSCHIEDENE Produkte in den Bildern zu sehen sind.',
    '2. Gruppiere die Bilder nach Produkten.',
    '3. Ein einzelnes Bild kann MEHRERE Produkte zeigen (z.B. Palette, Tisch mit Ware).',
    '   In dem Fall: erstelle für JEDES dieser Produkte eine EIGENE Gruppe und ordne das',
    '   Bild JEDER dieser Gruppen zu. Gib dann pro Gruppe position_hint an (z.B. "oben links",',
    '   "Mitte rechts"), damit klar ist, welches Produkt auf dem geteilten Bild gemeint ist.',
    '',
    'REGELN:',
    '- Zähle NUR Produkte die du KLAR SIEHST. Erfinde KEINE.',
    '- Im Zweifel: lieber eine Gruppe zu VIEL als zu wenig. Nur zusammenfassen wenn Bilder KLAR dasselbe Produkt zeigen.',
    '- Mehrere Ansichten desselben Produkts (Vorne, Hinten, Detail) = EINE Gruppe.',
    '- Mehrere Exemplare desselben Produkts (auch nebeneinander auf einem Bild) = EIN Produkt = EINE Gruppe. Nicht doppelt zählen.',
    '- Unterschiedliche Farben/Varianten desselben Modells = EINE Gruppe.',
    '- Verschiedene Marken, Produkttypen oder Formen → SEPARATE Gruppen.',
    '- Falls ein Bild einen Barcode/EAN zeigt: notiere ihn NUR bei der Gruppe, zu deren Produkt er eindeutig gehört. Im Zweifel weglassen.',
    '- Übersichtsfotos gehören zu JEDER dort sichtbaren Gruppe.',
    '- Falls erkennbar, fülle pro Gruppe brand_hint (Marke) und category_hint (Produkttyp).',
  ].join('\n');
}

// Repariert am Token-Limit abgeschnittenes JSON. Scannt mit echtem
// Klammer-Stack (string-/escape-aware) und schließt innerste Ebenen zuerst —
// die frühere lastIndexOf-Heuristik schloss in falscher Reihenfolge und
// scheiterte am häufigsten Truncation-Muster (Schnitt mitten im letzten
// Array-Element). Wirft, wenn auch Tier 2 nicht parsebar ist.
function repairTruncatedJson(text) {
  const attempt = (candidate) => {
    const stack = [];
    let inString = false;
    let escaped = false;
    for (const ch of candidate) {
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') stack.push('}');
      else if (ch === '[') stack.push(']');
      else if (ch === '}' || ch === ']') stack.pop();
    }
    let repaired = candidate;
    if (inString) repaired += '"';
    // Hängende Reste wie `"confidence":` oder trailing comma neutralisieren
    repaired = repaired.replace(/:\s*$/, ': null').replace(/,\s*$/, '');
    while (stack.length) repaired += stack.pop();
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(repaired);
  };

  try {
    const parsed = attempt(text);
    console.warn('[image-grouping] Repaired truncated JSON (tier 1: closed open scopes)');
    return parsed;
  } catch {
    // Tier 2: letztes unvollständiges Element abschneiden, dann schließen
    const cut = text.lastIndexOf('}');
    if (cut <= 0) throw new Error('unrepairable truncated JSON');
    const parsed = attempt(text.slice(0, cut + 1));
    console.warn('[image-grouping] Repaired truncated JSON (tier 2: dropped incomplete tail)');
    return parsed;
  }
}

function parseGroupingResponse(rawResponse, imageCount) {
  let text = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);
  // Gemini may wrap JSON in markdown code blocks
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) text = jsonMatch[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = repairTruncatedJson(text);
    } catch {
      console.warn('[image-grouping] Failed to parse Gemini response as JSON, returning empty groups. Raw (100 chars):', text.substring(0, 100));
      return [];
    }
  }
  const groups = Array.isArray(parsed?.groups) ? parsed.groups : [];

  const mapped = groups
    .filter((g) => Array.isArray(g.image_indices) && g.image_indices.length > 0)
    .map((g, idx) => {
      const brandHint = typeof g.brand_hint === 'string' ? g.brand_hint.trim() : '';
      const categoryHint = typeof g.category_hint === 'string' ? g.category_hint.trim() : '';
      const positionHint = typeof g.position_hint === 'string' ? g.position_hint.trim() : '';
      // Kein Label im Hint — StepAnalysis stellt das Label dem Hint ohnehin voran.
      const hint = (brandHint || categoryHint || positionHint)
        ? [
            brandHint ? `Marke: ${brandHint}` : null,
            categoryHint ? `Kategorie: ${categoryHint}` : null,
            positionHint ? `Position: ${positionHint}` : null,
          ].filter(Boolean).join('. ')
        : null;
      return {
        id: `group_${idx}`,
        label: g.label || `Produkt ${idx + 1}`,
        image_indices: [...new Set(g.image_indices.filter(
          (i) => typeof i === 'number' && i >= 0 && i < imageCount
        ))],
        confidence:
          typeof g.confidence === 'number'
            ? Math.min(1, Math.max(0, g.confidence))
            : 0.5,
        reason: typeof g.reason === 'string' ? g.reason : '',
        detected_barcode:
          typeof g.detected_barcode === 'string' && g.detected_barcode.trim()
            ? g.detected_barcode.trim()
            : null,
        hint,
      };
    })
    .filter((g) => g.image_indices.length > 0);

  // Ein Barcode gehört zu genau EINEM Produkt. Meldet das Modell denselben
  // Wert für mehrere Gruppen (geteiltes Foto), ist die Zuordnung unklar →
  // überall entfernen. Sonst schickt das Frontend denselben Barcode als
  // expliziten (trusted) Barcode in mehrere identify-Calls → Falsch-Reuse/
  // Phantom-Intake (Incident-Klassen 2026-07-08 / 2026-07-30).
  const barcodeCounts = new Map();
  for (const g of mapped) {
    if (g.detected_barcode) {
      barcodeCounts.set(g.detected_barcode, (barcodeCounts.get(g.detected_barcode) || 0) + 1);
    }
  }
  for (const g of mapped) {
    if (g.detected_barcode && barcodeCounts.get(g.detected_barcode) > 1) {
      g.detected_barcode = null;
    }
  }
  return mapped;
}

/**
 * BUG-090: Grouping via structured output with image compression.
 * Replaces the fragile callGeminiVision (free-text JSON) path.
 * Compresses images to 800px/JPEG 70% for grouping (high res not needed).
 * For >10 images, processes in batches and merges results.
 *
 * @param {Array<{buffer: Buffer, mimeType: string}>} imageBuffers
 * @param {number} imageCount
 * @returns {Promise<Array>} Parsed groups
 */
async function groupImagesStructured(imageBuffers, imageCount) {
  const { callGeminiStructured } = require('../lib/gemini-structured');
  const sharp = require('sharp');

  // Compress all images for grouping (low res is fine for classification)
  const compressedParts = [];
  let compressSkipped = 0;
  for (const img of imageBuffers) {
    if (!img?.buffer) {
      compressSkipped++;
      continue;
    }
    let buf = img.buffer;
    let mime = img.mimeType || 'image/jpeg';
    try {
      buf = await sharp(buf)
        .rotate()
        .resize({ width: 800, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();
      mime = 'image/jpeg';
    } catch (compErr) {
      console.warn(`[group-images] sharp compression failed for image, using original:`, compErr.message);
    }
    compressedParts.push({ inline_data: { mime_type: mime, data: buf.toString('base64') } });
  }

  if (compressSkipped > 0) {
    console.warn(`[group-images] ${compressSkipped}/${imageCount} images had no buffer — skipped`);
  }
  console.log(`[group-images] Compressed ${compressedParts.length} images for grouping (requested: ${imageCount})`);

  // Use actual compressed count to avoid index mismatches
  const effectiveCount = compressedParts.length;
  if (effectiveCount === 0) {
    console.warn('[group-images] No valid images after compression — returning empty');
    return [];
  }

  const BATCH_SIZE = 6;

  if (effectiveCount <= BATCH_SIZE) {
    // Single batch — send all images together
    const parts = [
      ...compressedParts,
      { text: buildGroupingPrompt(effectiveCount) },
    ];

    const raw = await callGeminiStructured({
      parts,
      responseSchema: GROUPING_SCHEMA,
      ...VISION_GROUPING_CONFIG,
      stopSequences: [],
    });

    console.log(`[group-images] Single-batch raw response (first 500 chars):`, typeof raw === 'string' ? raw.substring(0, 500) : JSON.stringify(raw).substring(0, 500));
    const groups = parseGroupingResponse(raw, effectiveCount);
    console.log(`[group-images] Single-batch parsed ${groups.length} groups`);
    return groups;
  }

  // Multi-batch: process in chunks and merge groups
  const allGroups = [];

  for (let batchStart = 0; batchStart < effectiveCount; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, effectiveCount);
    const batchParts = compressedParts.slice(batchStart, batchEnd);
    const batchSize = batchEnd - batchStart;

    const parts = [
      ...batchParts,
      { text: buildGroupingPrompt(batchSize) },
    ];

    try {
      const raw = await callGeminiStructured({
        parts,
        responseSchema: GROUPING_SCHEMA,
        ...VISION_GROUPING_CONFIG,
        stopSequences: [],
      });

      console.log(`[group-images] Batch ${batchStart}-${batchEnd} raw (first 300 chars):`, typeof raw === 'string' ? raw.substring(0, 300) : JSON.stringify(raw).substring(0, 300));
      const batchGroups = parseGroupingResponse(raw, batchSize);
      console.log(`[group-images] Batch ${batchStart}-${batchEnd} parsed ${batchGroups.length} groups`);

      if (batchGroups.length === 0) {
        console.warn(`[group-images] Batch ${batchStart}-${batchEnd} returned 0 groups from valid response — creating individual groups`);
        for (let i = batchStart; i < batchEnd; i++) {
          allGroups.push({
            id: `group_${allGroups.length}`,
            label: `Produkt ${allGroups.length + 1}`,
            image_indices: [i],
            confidence: 0.3,
            reason: 'Leere Gemini-Response — bitte manuell prüfen',
            detected_barcode: null,
            hint: null,
          });
        }
        continue;
      }

      // Remap indices to global positions
      for (const g of batchGroups) {
        g.image_indices = g.image_indices.map((i) => i + batchStart);
        g.id = `group_${allGroups.length}`;
        allGroups.push(g);
      }
    } catch (err) {
      console.warn(`[group-images] Batch ${batchStart}-${batchEnd} failed:`, err.message);
      // Fallback: each image in this batch becomes its own group
      for (let i = batchStart; i < batchEnd; i++) {
        allGroups.push({
          id: `group_${allGroups.length}`,
          label: `Produkt ${allGroups.length + 1}`,
          image_indices: [i],
          confidence: 0.3,
          reason: 'Batch-Fehler — bitte manuell prüfen',
          detected_barcode: null,
          hint: null,
        });
      }
    }
  }

  console.log(`[group-images] Multi-batch complete: ${allGroups.length} groups from ${effectiveCount} images`);
  return allGroups;
}

// --- Multi-Product Detection from Single Image ---

const MAX_DETECTED_PRODUCTS = 10;

const MULTI_PRODUCT_DETECTION_SCHEMA = {
  type: 'object',
  properties: {
    product_count: { type: 'integer' },
    products: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          bounding_description: { type: 'string' },
          brand_hint: { type: 'string' },
          category_hint: { type: 'string' },
          barcode_hint: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['label', 'confidence'],
      },
    },
  },
  required: ['product_count', 'products'],
};

function buildMultiProductPrompt() {
  return [
    'Du bist ein Bildanalyse-Experte für Produktfotos in einem E-Commerce-Warenlager.',
    '',
    'Dir wird 1 einzelnes Bild gezeigt, auf dem MEHRERE verschiedene Produkte sichtbar sein können',
    '(z.B. Tisch, Palette, Regal mit verschiedener Ware).',
    '',
    'Aufgabe:',
    '1. Zähle wie viele VERSCHIEDENE Produkte auf dem Bild zu sehen sind.',
    '2. Für jedes Produkt: beschreibe Position, erkennbare Marke, Produkttyp, ggf. Barcode.',
    '3. Gib für jedes Produkt einen bounding_description (Position im Bild, z.B. "oben links", "Mitte rechts").',
    '',
    'STRENGE REGELN:',
    '- Zähle NUR Produkte die du KLAR SIEHST. Erfinde KEINE.',
    '- Mehrere Exemplare desselben Produkts = 1 Produkt (nicht doppelt zählen).',
    '- Liegt DASSELBE Modell mehrfach im Bild (z.B. mehrere Kartons derselben Ware): liste es GENAU EINMAL.',
    '- Varianten (Farbe/Größe) des gleichen Modells = 1 Produkt.',
    '- Im Zweifel: WENIGER Produkte zählen, nicht mehr.',
    '- Verpackungsmaterial, Tisch, Hintergrund, Klebeband, Füllmaterial sind KEINE Produkte.',
    `- Maximal ${MAX_DETECTED_PRODUCTS} Produkte.`,
    '- Falls du nur 1 Produkt erkennst, gib product_count: 1 mit genau einem Eintrag zurück.',
    '',
    'Für jedes Produkt:',
    '- label: Kurzer Name (z.B. "Nike Laufschuh", "Bosch Akkuschrauber")',
    '- bounding_description: Position im Bild (z.B. "oben links, roter Karton")',
    '- brand_hint: Erkennbare Marke oder "" falls unklar',
    '- category_hint: Produkttyp (z.B. "Schuhe", "Werkzeug") oder "" falls unklar',
    '- barcode_hint: Sichtbarer Barcode/EAN oder "" falls keiner lesbar',
    '- confidence: 0.0-1.0 wie sicher du bist, dass es ein eigenständiges Produkt ist',
  ].join('\n');
}

// Modellnummern-artige Schlüssel aus einem Label ziehen: gemischte
// Buchstaben+Ziffern-Token ("40pfs6000", "xp442c") plus Alpha+Zahl-Bigramme
// ("KF 1500" → "kf1500"). Reine Zahlen (Wattagen, Größen) zählen NICHT.
function extractModelKeys(label) {
  const tokens = String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  const keys = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^(?=.*[a-z])(?=.*\d)[a-z0-9]{4,}$/.test(t)) keys.add(t);
    if (/^[a-z]{1,3}$/.test(t) && /^\d{3,}$/.test(tokens[i + 1] || '')) {
      keys.add(t + tokens[i + 1]);
    }
  }
  return keys;
}

// Dubletten aus der Mehrprodukt-Erkennung entfernen (Prod 2026-08-01: derselbe
// Fernseher wurde 3x gelistet → 3 identify-Calls → 3 Produkt-Dubletten).
// Duplikat-Kriterien: gleicher Modellnummern-Schlüssel, identischer
// barcode_hint oder identisches normalisiertes Label. Höchste Confidence
// gewinnt, fehlende Hint-Felder werden vom Verlierer übernommen.
function dedupeDetectedProducts(products) {
  const kept = [];
  const normalize = (label) =>
    String(label || '').toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim();
  for (const p of products) {
    const keys = extractModelKeys(p.label);
    const normLabel = normalize(p.label);
    const dup = kept.find((k) =>
      (p.barcode_hint && k.entry.barcode_hint && p.barcode_hint === k.entry.barcode_hint) ||
      k.normLabel === normLabel ||
      [...keys].some((key) => k.keys.has(key))
    );
    if (!dup) {
      kept.push({ entry: { ...p }, keys, normLabel });
      continue;
    }
    const winner = p.confidence > dup.entry.confidence ? { ...p } : dup.entry;
    const loser = winner === dup.entry ? p : dup.entry;
    for (const f of ['bounding_description', 'brand_hint', 'category_hint', 'barcode_hint']) {
      if (!winner[f] && loser[f]) winner[f] = loser[f];
    }
    dup.entry = winner;
    for (const key of keys) dup.keys.add(key);
  }
  return kept.map((k, idx) => ({ ...k.entry, id: `detected_${idx}` }));
}

function parseDetectionResponse(rawText) {
  let text = typeof rawText === 'string' ? rawText : JSON.stringify(rawText);
  // Strip markdown fences if present
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) text = jsonMatch[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = repairTruncatedJson(text);
    } catch {
      console.warn('[image-grouping] Failed to parse multi-product detection response. Raw (100 chars):', text.substring(0, 100));
      return [];
    }
  }

  const products = Array.isArray(parsed?.products) ? parsed.products : [];

  const mapped = products
    .slice(0, MAX_DETECTED_PRODUCTS)
    .filter((p) => typeof p.label === 'string' && p.label.trim())
    .map((p, idx) => ({
      id: `detected_${idx}`,
      label: p.label.trim(),
      bounding_description: typeof p.bounding_description === 'string' ? p.bounding_description.trim() : '',
      brand_hint: typeof p.brand_hint === 'string' ? p.brand_hint.trim() : '',
      category_hint: typeof p.category_hint === 'string' ? p.category_hint.trim() : '',
      barcode_hint: typeof p.barcode_hint === 'string' ? p.barcode_hint.trim() : '',
      confidence: typeof p.confidence === 'number'
        ? Math.min(1, Math.max(0, p.confidence))
        : 0.5,
    }));

  return dedupeDetectedProducts(mapped);
}

/**
 * Detect multiple products in a single image using Gemini structured output.
 * @param {Array<{buffer: Buffer, mimeType: string}>} imageBuffers — exactly 1 image
 * @returns {Promise<Array>} Detected products (max 10)
 */
async function detectMultipleProducts(imageBuffers) {
  const { callGeminiStructured } = require('../lib/gemini-structured');
  const sharp = require('sharp');

  const img = imageBuffers[0];
  if (!img?.buffer) return [];

  // Compress image for inline budget (same pattern as generative-identify.js)
  let imgBuffer = img.buffer;
  let imgMime = img.mimeType || 'image/jpeg';
  try {
    imgBuffer = await sharp(imgBuffer)
      .rotate()
      .resize({ width: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toBuffer();
    imgMime = 'image/jpeg';
  } catch {
    // keep original
  }

  const parts = [
    { inline_data: { mime_type: imgMime, data: imgBuffer.toString('base64') } },
    { text: buildMultiProductPrompt() },
  ];

  const raw = await callGeminiStructured({
    parts,
    responseSchema: MULTI_PRODUCT_DETECTION_SCHEMA,
    ...VISION_DETECTION_CONFIG,
    stopSequences: [],
  });

  return parseDetectionResponse(raw);
}

module.exports = {
  buildGroupingPrompt,
  parseGroupingResponse,
  groupImagesStructured,
  GROUPING_SCHEMA,
  buildMultiProductPrompt,
  parseDetectionResponse,
  detectMultipleProducts,
  MULTI_PRODUCT_DETECTION_SCHEMA,
  VISION_DETECTION_CONFIG,
};
