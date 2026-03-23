'use strict';

function buildGroupingPrompt(imageCount) {
  return [
    'Du bist ein Bildanalyse-Experte für Produktfotos in einem E-Commerce-Warenlager.',
    '',
    `Dir werden ${imageCount} Bilder gezeigt. Deine Aufgabe:`,
    '1. Erkenne wie viele VERSCHIEDENE Produkte in den Bildern zu sehen sind.',
    '2. Gruppiere die Bilder nach Produkten.',
    '3. WICHTIG: Ein einzelnes Bild kann MEHRERE Produkte zeigen (z.B. Palette, Tisch mit Ware, Regal).',
    '   In dem Fall ordne das Bild ALLEN Gruppen zu, deren Produkt darauf sichtbar ist.',
    '',
    'STRENGE REGELN:',
    '- Zähle NUR Produkte die du auf den Bildern KLAR SIEHST.',
    '- Erfinde KEINE Produkte. Im Zweifel: alles in EINE Gruppe.',
    '- Mehrere Ansichten desselben Produkts (Vorne, Hinten, Seite, Detail) = EINE Gruppe.',
    '- Unterschiedliche Farben/Varianten desselben Modells = EINE Gruppe.',
    '- Nur wenn Marke ODER Produkttyp ODER Form klar unterschiedlich → separate Gruppe.',
    '- Falls ein Bild einen Barcode/EAN zeigt: notiere ihn bei der Gruppe.',
    '- Ein Bild darf in MEHREREN Gruppen vorkommen wenn es mehrere Produkte zeigt.',
    '- Übersichtsfotos (mehrere Produkte auf einem Bild) gehören zu JEDER dort sichtbaren Gruppe.',
    '- Nie mehr Gruppen als Bilder.',
    '',
    'Antworte NUR mit JSON (kein Markdown, kein Kommentar):',
    '{',
    '  "product_count": <Zahl>,',
    '  "groups": [',
    '    {',
    '      "label": "Produkt 1",',
    '      "image_indices": [0, 2, 4],',
    '      "confidence": 0.95,',
    '      "reason": "Gleiche Nike Schachtel von drei Seiten",',
    '      "detected_barcode": "4006381333931"',
    '    }',
    '  ]',
    '}',
  ].join('\n');
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
    console.warn('[image-grouping] Failed to parse Gemini response as JSON, returning empty groups');
    return [];
  }
  const groups = Array.isArray(parsed?.groups) ? parsed.groups : [];

  return groups
    .filter((g) => Array.isArray(g.image_indices) && g.image_indices.length > 0)
    .map((g, idx) => ({
      id: `group_${idx}`,
      label: g.label || `Produkt ${idx + 1}`,
      image_indices: g.image_indices.filter(
        (i) => typeof i === 'number' && i >= 0 && i < imageCount
      ),
      confidence:
        typeof g.confidence === 'number'
          ? Math.min(1, Math.max(0, g.confidence))
          : 0.5,
      reason: typeof g.reason === 'string' ? g.reason : '',
      detected_barcode:
        typeof g.detected_barcode === 'string' && g.detected_barcode.trim()
          ? g.detected_barcode.trim()
          : null,
    }))
    .filter((g) => g.image_indices.length > 0);
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

function parseDetectionResponse(rawText) {
  let text = typeof rawText === 'string' ? rawText : JSON.stringify(rawText);
  // Strip markdown fences if present
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) text = jsonMatch[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.warn('[image-grouping] Failed to parse multi-product detection response');
    return [];
  }

  const products = Array.isArray(parsed?.products) ? parsed.products : [];

  return products
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
    temperature: 0.1,
    topP: 0.8,
    topK: 16,
    maxOutputTokens: 1024,
    stopSequences: [],
  });

  return parseDetectionResponse(raw);
}

module.exports = {
  buildGroupingPrompt,
  parseGroupingResponse,
  buildMultiProductPrompt,
  parseDetectionResponse,
  detectMultipleProducts,
  MULTI_PRODUCT_DETECTION_SCHEMA,
};
