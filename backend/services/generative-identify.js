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
3. Titel-Policy (WICHTIG): Der finale eBay Titel wird serverseitig deterministisch gebaut (maschinen-/regelbasiert).
   - Du lieferst dafür die Bausteine: brand, internalCategory (Produkttyp), model/mpn/teilenummer, sowie technische Kerndaten als item_specifics/attributes.
   - Falls du title_ebay / title_kaufland ausfüllst, dann nur als ENTWURF und strikt nach Regeln:
     - Reihenfolge ist schema-/kategorieabhängig (siehe "TITLE-SCHEMA GUIDELINES" im Policy-Block unten). NICHT frei umsortieren.
     - Erste 3-5 Wörter sind CTR-kritisch (Marke + Produkttyp + Kernmerkmal).
     - Priorität A muss in den ersten 60 Zeichen sein (schemaabhängig):
       - Auto/Tech: Marke + Produkttyp + Modell/MPN/OE/Teilenummer.
       - Kleidung/Schuhe/Sneaker: Marke + Produkttyp + Größe (keine kryptischen Modellcodes).
       - Haus, Bau & Ausstattung: Marke + Modell/Serie + Produkttyp.
     - Keyword-Governance: 2-3 Kernbegriffe + max. 1-2 Synonym-Varianten, kein Keyword-Stuffing.
     - Keine Marketingfloskeln, keine Emojis, keine Dubletten.
     - eBay-Titel: 70–80 Zeichen (bevorzugt), Hard-Max 80.
4. Beschreibungen: strukturiert, faktenbasiert, keine Wiederholungen. Bei ausreichender Beleglage ca. 180–240 Wörter, natürlich lesbar (kein Keyword-Stuffing).
5. Priorisiere Barcodes: EAN = exakt 13 Ziffern, GTIN = exakt 14 Ziffern. Verwende nur Codes mit korrekter Checkdigit. Wenn keiner sicher ist, lasse EAN/GTIN/UPC leer.
6. Bestimme eine passende Kategoriebezeichnung (interner Kategorie-String), z. B. "Schuhe > Sandalen".
7. Erstelle Attribute/Item-Specifics als Liste aus { key, value } mit deutschen Schlüsseln (z. B. "Farbe": "Marineblau"). WICHTIG: technische Daten aus OCR/Label (Spannung/Leistung/Größe/Volumen/Modell/Herstellernummer) explizit als Attribute aufnehmen, wenn vorhanden.
8. Wenn eine Information nicht sicher ermittelbar ist, lasse das Feld leer und dokumentiere die Unsicherheit in notes.

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
    // IMPORTANT:
    // - Do NOT use stopSequences like ``` here. The model often wraps JSON in fenced blocks,
    //   and stopping on ``` can cut the payload before the JSON is emitted.
    // - We'll instead robustly extract JSON from the returned text.
    stopSequences: [],
  });

  // Defensive extraction:
  // Gemini sometimes prepends text like "Here is the JSON..." and/or wraps JSON in ```json fences.
  // We should keep the JSON *content* and extract the first JSON object/array we can find.
  const stripMarkdownFencesKeepContent = (text = '') => {
    // Remove only the fence markers, not the enclosed content.
    return String(text)
      .replace(/```(?:json|javascript)?\s*/gi, '')
      .replace(/```/g, '')
      .trim();
  };

  const extractFirstJsonValue = (text = '') => {
    const s = stripMarkdownFencesKeepContent(text);
    const firstObj = s.indexOf('{');
    const firstArr = s.indexOf('[');
    let start = -1;
    let open = '';
    let close = '';
    if (firstObj === -1 && firstArr === -1) return s.trim();
    if (firstObj !== -1 && (firstArr === -1 || firstObj < firstArr)) {
      start = firstObj;
      open = '{';
      close = '}';
    } else {
      start = firstArr;
      open = '[';
      close = ']';
    }
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let i = start; i < s.length; i += 1) {
      const ch = s[i];
      if (inStr) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\\\') {
          escaped = true;
        } else if (ch === '"') {
          inStr = false;
        }
        continue;
      }
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === open) depth += 1;
      if (ch === close) depth -= 1;
      if (depth === 0) {
        return s.slice(start, i + 1).trim();
      }
    }
    // If we couldn't balance, return from start as best-effort (will likely fail parse and be logged).
    return s.slice(start).trim();
  };

  const cleaned = extractFirstJsonValue(raw);
  const fixTrailingCommas = (text = '') => text.replace(/,\s*([}\]])/g, '$1');
  // Repair common JSON issues from LLMs:
  // - raw newlines inside quoted strings -> escape as \n (otherwise JSON.parse throws "Unterminated string")
  // - raw carriage returns inside quoted strings -> escape as \r
  const escapeNewlinesInsideStrings = (text = '') => {
    const s = String(text);
    let out = '';
    let inStr = false;
    let escaped = false;
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (!inStr) {
        if (ch === '"') {
          inStr = true;
          out += ch;
          continue;
        }
        out += ch;
        continue;
      }
      // inside string
      if (escaped) {
        escaped = false;
        out += ch;
        continue;
      }
      if (ch === '\\\\') {
        escaped = true;
        out += ch;
        continue;
      }
      if (ch === '"') {
        inStr = false;
        out += ch;
        continue;
      }
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      out += ch;
    }
    return out;
  };

  const salvageFlatFieldsFromJsonLike = (text = '') => {
    const s = String(text || '');
    const out = {};

    const unescapeJsonString = (value = '') =>
      String(value || '')
        .replace(/\\\\/g, '\\')
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .trim();

    const getString = (key) => {
      // Prefer closed-quote matches
      const closed = s.match(new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`));
      if (closed?.[1] != null) return unescapeJsonString(closed[1]);
      // Fallback: allow truncated strings (no closing quote). Capture until newline.
      const open = s.match(new RegExp(`"${key}"\\s*:\\s*"([^\\n\\r]*)`));
      if (open?.[1] != null) {
        return unescapeJsonString(open[1].replace(/[\\s,}]*$/, ''));
      }
      return '';
    };

    const getNumber = (key) => {
      const match = s.match(new RegExp(`"${key}"\\s*:\\s*([-+]?\\d+(?:\\.\\d+)?)`));
      if (!match?.[1]) return null;
      const num = Number(match[1]);
      return Number.isFinite(num) ? num : null;
    };

    // Only salvage scalar fields that we actually use downstream for identification success.
    const scalarKeys = [
      'brand',
      'model',
      'sku',
      'variant',
      'gtin',
      'ean',
      'upc',
      'color',
      'size',
      'material',
      'condition',
      'internalCategory',
      'title_ebay',
      'title_kaufland',
      'description_ebay',
      'description_kaufland',
      'hero_caption',
      'notes',
    ];
    for (const key of scalarKeys) {
      const value = getString(key);
      if (value) out[key] = value;
    }
    const eanConf = getNumber('ean_confidence');
    const gtinConf = getNumber('gtin_confidence');
    if (eanConf != null) out.ean_confidence = eanConf;
    if (gtinConf != null) out.gtin_confidence = gtinConf;

    const hasMeaningful =
      Boolean(out.brand) ||
      Boolean(out.model) ||
      Boolean(out.sku) ||
      Boolean(out.gtin) ||
      Boolean(out.ean) ||
      Boolean(out.upc) ||
      Boolean(out.title_ebay) ||
      Boolean(out.title_kaufland);

    return hasMeaningful ? out : null;
  };

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    // Retry with a simple trailing-comma cleanup
    const fixed = fixTrailingCommas(cleaned);
    try {
      return JSON.parse(fixed);
    } catch (err2) {
      // Retry with newline/carriage-return escaping inside quoted strings
      const repaired = escapeNewlinesInsideStrings(fixed);
      try {
        return JSON.parse(repaired);
      } catch (err3) {
        // Last resort: salvage partial scalar fields from truncated JSON-like output.
        // This prevents losing strong signals (brand/model/sku) when the model output is cut mid-string.
        const salvaged = salvageFlatFieldsFromJsonLike(repaired);
        if (salvaged) {
          salvaged.notes = salvaged.notes
            ? `${salvaged.notes} | json_parse_salvaged=true`
            : 'json_parse_salvaged=true';
          return salvaged;
        }
        const snippet = String(repaired).slice(0, 800);
      console.error(
        'Failed to parse Gemini structured JSON (cleaned snippet):',
        snippet,
        'error:',
        error.message
      );
        throw new Error(`Failed to parse Gemini structured JSON: ${err3.message}`);
      }
    }
  }
}

module.exports = {
  generateStructuredProductRecord,
};

