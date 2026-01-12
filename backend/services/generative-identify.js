const { callGeminiStructured } = require('../lib/gemini-structured');
const { buildCommonPolicyText } = require('../lib/llm-policy-pack');
const sharp = require('sharp');

// Default to 4 images (not just 3) to better match "Google Lens-like" robustness on packaging/back labels.
const MAX_MODEL_IMAGES = parseInt(process.env.PIPELINE_V2_IMAGE_LIMIT || '4', 10);
const MAX_OCR_LINES = parseInt(process.env.PIPELINE_V2_OCR_LINE_LIMIT || '80', 10);
// Gemini inline-data requests should stay under ~20MB (including prompt). We keep a buffer for text.
// Source (official docs): Gemini API "Inline-Bilddaten übergeben" (image-understanding).
const MAX_INLINE_REQUEST_BYTES = parseInt(process.env.PIPELINE_V2_INLINE_REQUEST_BYTES || `${18 * 1024 * 1024}`, 10);
const MAX_INLINE_IMAGE_EDGE = parseInt(process.env.PIPELINE_V2_INLINE_IMAGE_EDGE || '1600', 10);
const INLINE_JPEG_QUALITY = parseInt(process.env.PIPELINE_V2_INLINE_JPEG_QUALITY || '78', 10);

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
1. Identifiziere den Artikel anhand der bereitgestellten Beweise (Bilder/OCR/Barcodes) und ggf. zusätzlicher WEB-EVIDENZ, wenn sie im Prompt enthalten ist.
2. Leite Marke, Modell, Varianten, Farbe, Größe, Material, Zustand und Produkttyp ab.
3. Formuliere vollständige, marketplacespezifische Titel und Beschreibungen auf Deutsch (${locale}).
   - eBay-Titel max. 80 Zeichen (TECHNISCH & suchbar).
   - Kaufland-Titel max. 100 Zeichen (TECHNISCH & suchbar).
   - Titel-Struktur: Marke + Produkttyp/Produktart + Modell/Herstellernummer + 1–2 technische Kerndaten (z. B. Spannung/Leistung/Größe/Volumen), soweit aus Label/OCR ableitbar. Keine Marketingfloskeln, keine Dubletten.
   - Beschreibungen als kurzer Absatz mit Features / Nutzen (faktenbasiert, keine Wiederholungen).
4. Priorisiere Barcodes: EAN = exakt 13 Ziffern, GTIN = exakt 14 Ziffern. Verwende nur Codes mit korrekter Checkdigit. Wenn keiner sicher ist, lasse EAN/GTIN/UPC leer.
5. Bestimme eine passende Kategoriebezeichnung (interner Kategorie-String), z. B. "Schuhe > Sandalen".
6. Erstelle Attribute/Item-Specifics als Liste aus { key, value } mit deutschen Schlüsseln (z. B. "Farbe": "Marineblau"). WICHTIG: technische Daten aus OCR/Label (Spannung/Leistung/Größe/Volumen/Modell/Herstellernummer) explizit als Attribute aufnehmen, wenn vorhanden.
7. Wenn eine Information nicht sicher ermittelbar ist, lasse das Feld leer und dokumentiere die Unsicherheit in notes.

${buildCommonPolicyText({ locale, allowWebEvidence: true })}

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

async function compressForInline(buffer, mimeType, remainingBudget) {
  try {
    if (!buffer || buffer.length === 0) return { buffer, mimeType };
    const pipeline = sharp(buffer).rotate();
    const meta = await pipeline.metadata();
    const longest = Math.max(meta.width || 0, meta.height || 0);
    let resized = pipeline;
    if (longest && longest > MAX_INLINE_IMAGE_EDGE) {
      resized =
        (meta.width || 0) >= (meta.height || 0)
          ? resized.resize({ width: MAX_INLINE_IMAGE_EDGE, fit: 'inside', withoutEnlargement: true })
          : resized.resize({ height: MAX_INLINE_IMAGE_EDGE, fit: 'inside', withoutEnlargement: true });
    }
    const q = remainingBudget < 2 * 1024 * 1024 ? Math.min(INLINE_JPEG_QUALITY, 72) : INLINE_JPEG_QUALITY;
    const out = await resized.jpeg({ quality: q, chromaSubsampling: '4:2:0' }).toBuffer();
    return { buffer: out, mimeType: 'image/jpeg' };
  } catch (error) {
    // Fall back to original buffer if compression fails.
    return { buffer, mimeType };
  }
}

async function buildInlineParts(files = []) {
  if (!Array.isArray(files)) return [];
  const parts = [];
  let usedBytes = 0;
  for (let idx = 0; idx < files.length && parts.length < MAX_MODEL_IMAGES; idx += 1) {
    const file = files[idx];
    if (!file?.buffer || !file?.mimetype?.startsWith('image/')) continue;
    const remainingBudget = Math.max(0, MAX_INLINE_REQUEST_BYTES - usedBytes);
    const candidate =
      file.buffer.length > remainingBudget || file.buffer.length > Math.ceil(MAX_INLINE_REQUEST_BYTES / Math.max(1, MAX_MODEL_IMAGES))
        ? await compressForInline(file.buffer, file.mimetype, remainingBudget)
        : { buffer: file.buffer, mimeType: file.mimetype };

    // If we still don't fit, skip this image (keep budget for other images + text).
    if (candidate.buffer.length > remainingBudget) {
      continue;
    }
    parts.push({
      inline_data: {
        mime_type: candidate.mimeType,
        data: candidate.buffer.toString('base64'),
      },
    });
    usedBytes += candidate.buffer.length;
  }
  return parts;
}

async function generateStructuredProductRecord({ files, ocrLines, barcodes, locale, inputMode }) {
  const parts = [
    ...(await buildInlineParts(files)),
    { text: buildInstructionText({ locale, inputMode }) },
    { text: buildOcrContext(ocrLines, barcodes) },
  ];

  const raw = await callGeminiStructured({
    parts,
    responseSchema: PRODUCT_RECORD_SCHEMA,
    temperature: 0.0,
    topP: 0.8,
    topK: 16,
    maxOutputTokens: 1200,
    candidateCount: 1,
    stopSequences: ['```'],
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

