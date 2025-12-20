const { callGeminiStructured } = require('../lib/gemini-structured');

const MAX_MODEL_IMAGES = parseInt(process.env.PIPELINE_V2_IMAGE_LIMIT || '3', 10);
const MAX_OCR_LINES = parseInt(process.env.PIPELINE_V2_OCR_LINE_LIMIT || '80', 10);

const PRODUCT_RECORD_SCHEMA = {
  type: 'object',
  properties: {
    brand: { type: 'string' },
    model: { type: 'string' },
    sku: { type: 'string' },
    variant: { type: 'string' },
    gtin: { type: 'string' },
    ean: { type: 'string' },
    upc: { type: 'string' },
    color: { type: 'string' },
    size: { type: 'string' },
    material: { type: 'string' },
    condition: { type: 'string' },
    internalCategory: { type: 'string' },
    title_ebay: { type: 'string' },
    title_kaufland: { type: 'string' },
    description_ebay: { type: 'string' },
    description_kaufland: { type: 'string' },
    ean_confidence: { type: 'number' },
    gtin_confidence: { type: 'number' },
    barcode_sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          source: { type: 'string' },
          confidence: { type: 'number' },
        },
      },
    },
    item_specifics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['key', 'value'],
      },
    },
    attributes_kaufland: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['key', 'value'],
      },
    },
    hero_caption: { type: 'string' },
    notes: { type: 'string' },
  },
  required: [
    'brand',
    'model',
    'internalCategory',
    'title_ebay',
    'title_kaufland',
    'description_ebay',
    'description_kaufland',
  ],
};

function buildInstructionText({ locale, inputMode }) {
  return `
Du bist ein professioneller Produktdaten-Kurator für eBay.de und Kaufland.de.
Du erhältst:
- bis zu ${MAX_MODEL_IMAGES} Produkt- oder Label-Fotos
- OCR-Textzeilen vom Label
- extrahierte Barcode-Kandidaten

Aufgabe:
1. Identifiziere den Artikel ausschließlich anhand dieser Beweise (keine externen Datenquellen).
2. Leite Marke, Modell, Varianten, Farbe, Größe, Material, Zustand und Produkttyp ab.
3. Formuliere vollständige, marketplacespezifische Titel und Beschreibungen auf Deutsch (${locale}).
   - eBay-Titel max. 80 Zeichen.
   - Kaufland-Titel max. 100 Zeichen.
   - Beschreibungen als kurzer Absatz mit Features / Nutzen.
4. Priorisiere Barcodes: EAN = exakt 13 Ziffern, GTIN = exakt 14 Ziffern. Verwende nur Codes mit korrekter Checkdigit. Wenn keiner sicher ist, setze EAN/GTIN auf "unknown".
5. Bestimme eine passende Kategoriebezeichnung (interner Kategorie-String), z. B. "Schuhe > Sandalen".
6. Erstelle Attribute/Item-Specifics als Liste aus { key, value } mit deutschen Schlüsseln (z. B. "Farbe": "Marineblau").
7. Wenn eine Information nicht sicher ermittelbar ist, verwende exakt den String "unknown".

Kontext:
- Präferiere Label-Texte für Marken/GTIN
- ${inputMode === 'label' ? 'Der Nutzer hat Etiketten / Kartons hochgeladen.' : 'Der Nutzer hat Produktfotos hochgeladen.'}

Antwortformat:
- Gib ausschließlich JSON zurück, das exakt dem bereitgestellten Schema entspricht (keine zusätzlichen Felder, kein Markdown).
  `;
}

function buildOcrContext(ocrLines = [], barcodes = []) {
  const limitedLines = ocrLines.slice(0, MAX_OCR_LINES);
  const textBlock = limitedLines.join('\n');
  const barcodeList = barcodes.join(', ') || 'keine';
  return `OCR TEXTZEILEN:\n${textBlock || '(leer)'}\n\nBARCODES:\n${barcodeList}`;
}

function buildInlineParts(files = []) {
  if (!Array.isArray(files)) return [];
  const parts = [];
  for (let idx = 0; idx < files.length && parts.length < MAX_MODEL_IMAGES; idx += 1) {
    const file = files[idx];
    if (!file?.buffer || !file?.mimetype?.startsWith('image/')) continue;
    parts.push({
      inline_data: {
        mime_type: file.mimetype,
        data: file.buffer.toString('base64'),
      },
    });
  }
  return parts;
}

async function generateStructuredProductRecord({ files, ocrLines, barcodes, locale, inputMode }) {
  const parts = [
    ...buildInlineParts(files),
    { text: buildInstructionText({ locale, inputMode }) },
    { text: buildOcrContext(ocrLines, barcodes) },
  ];

  const raw = await callGeminiStructured({
    parts,
    responseSchema: PRODUCT_RECORD_SCHEMA,
    temperature: 0.15,
    topP: 0.8,
    topK: 32,
    maxOutputTokens: 2048,
  });

  // Defensive cleaning: strip Markdown fences, keep outermost JSON object only
  const sanitizeStructuredJson = (text = '') => {
    const withoutCode = text.replace(/```[\s\S]*?```/g, '').trim();
    const start = withoutCode.indexOf('{');
    const end = withoutCode.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      return withoutCode;
    }
    // Only keep the outermost JSON object
    let slice = withoutCode.slice(start, end + 1);
    // Remove trailing characters after the last balanced brace
    const lastBrace = slice.lastIndexOf('}');
    slice = slice.slice(0, lastBrace + 1);
    return slice;
  };

  const cleaned = sanitizeStructuredJson(raw);
  const fixTrailingCommas = (text = '') => text.replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    // Retry with a simple trailing-comma cleanup
    const fixed = fixTrailingCommas(cleaned);
    try {
      return JSON.parse(fixed);
    } catch (err2) {
      const snippet = cleaned.slice(0, 400);
      console.error(
        'Failed to parse Gemini structured JSON (cleaned snippet):',
        snippet,
        'error:',
        error.message
      );
      throw new Error(`Failed to parse Gemini structured JSON: ${err2.message}`);
    }
  }
}

module.exports = {
  generateStructuredProductRecord,
};

