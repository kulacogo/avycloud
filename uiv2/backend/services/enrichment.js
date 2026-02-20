const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const sharp = require('sharp');
const crypto = require('crypto');
const { productBundleSchema } = require('../lib/product-schema');
const { getGeminiClient } = require('../lib/gemini-client'); // Replaced OpenAI
const { uploadImage } = require('../lib/storage');
const { extractOcrPayload } = require('../lib/vision-ocr');
const { callSerpApi, summarizeSerpEntries } = require('../lib/serpapi');
const { search: searchEvidence } = require('../lib/evidence-provider');
const { resolveModel } = require('../lib/model-select');
const path = require('path');
const { findEbayCategory, getRequiredAspects } = require('../lib/ebay-taxonomy');
const { findKauflandCategory, getKauflandAttributes } = require('../lib/kaufland-taxonomy');
const { MarketplaceLookup } = require('../lib/marketplace-lookup');
const { isValidGtin, normalizeDigits, getGtinType } = require('../lib/gtin');
const { coerceTitleToPolicy } = require('../lib/title-policy');
const { sanitizeListingText } = require('../lib/listing-sanitize');
const { buildCommonPolicyText } = require('../lib/llm-policy-pack');
const { normalizeProductStrict } = require('../lib/llm-rulebook');
const { getVehicleFitmentMode } = require('../lib/vehicle-fitment');
const { filterBarcodesByWebConfirm } = require('../lib/barcode-web-confirm');
const { searchWeb, fetchPageText } = require('../lib/web-search-html');
const { evaluateEbayReady } = require('../lib/datasheet-quality');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

// Clean JSON schema to be compatible with Gemini responseSchema
function cleanSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(cleanSchemaForGemini);

  const cleaned = { ...schema };

  if (Array.isArray(cleaned.type)) {
    const validTypes = cleaned.type.filter((t) => t !== 'null');
    cleaned.type = validTypes.length === 1 ? validTypes[0] : validTypes[0] || 'string';
  }

  if (cleaned.properties) {
    const props = {};
    for (const [key, val] of Object.entries(cleaned.properties)) {
      props[key] = cleanSchemaForGemini(val);
    }
    cleaned.properties = props;
  }

  if (cleaned.items) {
    cleaned.items = cleanSchemaForGemini(cleaned.items);
  }

  // Remove fields Gemini rejects in responseSchema
  delete cleaned.additionalProperties;
  delete cleaned.default;
  return cleaned;
}

const MAX_TOOL_ITERATIONS = 8;
const MAX_BARCODE_COUNT = 10000;
const MAX_IMAGE_PAYLOAD_BYTES = parseInt(process.env.MAX_IMAGE_PAYLOAD_BYTES || `${45 * 1024 * 1024}`, 10);
const SOFT_IMAGE_PAYLOAD_BYTES = parseInt(process.env.SOFT_IMAGE_PAYLOAD_BYTES || `${32 * 1024 * 1024}`, 10);
const INLINE_IMAGE_CAP = parseInt(process.env.MAX_INLINE_IMAGES || '12', 10);
const BARCODE_LIMIT_ERROR = 'BARCODE_LIMIT_EXCEEDED';
const IMAGE_PAYLOAD_ERROR = 'IMAGE_PAYLOAD_LIMIT_EXCEEDED';
const TOOL_ITERATION_ERROR = 'TOOL_ITERATION_LIMIT';
const MAX_BARCODE_PREFETCH = parseInt(process.env.MAX_BARCODE_PREFETCH || '5', 10);
const DEFAULT_PRICE_CURRENCY = process.env.DEFAULT_PRICE_CURRENCY || 'EUR';
const PRICE_TRACE_ENGINES = new Set(['google_shopping', 'google', 'ebay', 'bing_shopping', 'amazon']);
const PRIMARY_BARCODE_KEYS = ['ean', 'gtin', 'upc'];
const ATTRIBUTE_BLACKLIST = new Set([
  'key features',
  'keyfeatures',
  'highlights',
  'bullet points',
  'bullets',
  'beschreibung',
  'description',
  'kurzbeschreibung',
  'features',
  'sku',
]);
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateProductBundle = ajv.compile(productBundleSchema);

// Marketplace lookup (uses JSON caches or CSV)
const EBAY_CATEGORY_CSV = path.join(__dirname, '..', 'ebay', 'DE_New_Structure_(May2023).csv');
const KAUFLAND_CATEGORY_CSV = path.join(__dirname, '..', 'kaufland', 'category_tree_all_languages.csv');
const marketplaceLookup = new MarketplaceLookup({
  ebayCsvPath: EBAY_CATEGORY_CSV,
  kauflandCsvPath: KAUFLAND_CATEGORY_CSV,
  ebayPathColumn: 'category_path',
  kauflandPathColumn: 'category_path',
});

const isNumericId = (v) => v !== undefined && v !== null && /^\d+$/.test(String(v).trim());
const normalizePath = (v) => (v ? v.toString().trim() : '');

async function resolveCategoryWithGemini(product, target) {
  try {
    const client = await getGeminiClient();
    const modelName = resolveModel(null, 'CATEGORY_MODEL', 'gemini-2.5-flash');
    const model = client.getGenerativeModel({ model: modelName });
    const attrs = product?.details?.attributes || {};

    const safeString = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
    const normalizeText = (text = '') =>
      safeString(text)
        .toLowerCase()
        .replace(/ä/g, 'a')
        .replace(/ö/g, 'o')
        .replace(/ü/g, 'u')
        .replace(/ß/g, 'ss')
        .replace(/[\u2010-\u2015-]/g, ' ')
        .replace(/[^\p{L}\p{N}\s>]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const tokenize = (text = '') => {
      const t = normalizeText(text);
      if (!t) return [];
      const stop = new Set([
        'und',
        'oder',
        'fur',
        'fuer',
        'für',
        'mit',
        'ohne',
        'set',
        'neu',
        'new',
        'original',
        'ovp',
        'teile',
        'zubehor',
        'zubehör',
        'sonstige',
        'der',
        'die',
        'das',
        'ein',
        'eine',
      ]);
      return t
        .split(/\s+/g)
        .map((w) => w.trim())
        .filter((w) => w.length >= 4 && !stop.has(w));
    };

    // Deterministic candidate shortlist (prevents "nonsense" / invented paths).
    // We only allow Gemini to choose from these candidates.
    const buildEbayCandidates = () => {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const EBAY_CATEGORIES = require('../ebay-data/categories.json');
      const entries = Object.keys(EBAY_CATEGORIES || {})
        .map((id) => {
          const c = EBAY_CATEGORIES[id];
          const breadcrumb = safeString(c?.breadcrumb);
          if (!breadcrumb || !breadcrumb.includes('>')) return null;
          return { id: String(c?.id ?? id), breadcrumb, name: safeString(c?.name) };
        })
        .filter(Boolean);

      const productType =
        safeString(attrs.Produktart) ||
        safeString(attrs.Produkttyp) ||
        safeString(attrs['Produkttyp (Produktart)']) ||
        safeString(attrs.Artikeltyp) ||
        '';
      const seedText = [
        safeString(product?.identification?.brand),
        safeString(product?.identification?.name),
        productType,
        safeString(product?.details?.short_description),
      ]
        .filter(Boolean)
        .join(' ');

      const tokens = Array.from(new Set(tokenize(seedText))).slice(0, 10);
      if (!tokens.length) return [];

      const scored = [];
      for (const e of entries) {
        const hay = normalizeText(`${e.breadcrumb} ${e.name}`);
        let hit = 0;
        for (const t of tokens) {
          if (hay.includes(t)) hit += 1;
        }
        if (hit === 0) continue;
        const score = hit * 1000 - hay.length; // prefer many token hits; then prefer shorter breadcrumb
        scored.push({ ...e, score, hit });
      }
      scored.sort((a, b) => b.hit - a.hit || b.score - a.score);
      return scored.slice(0, 60);
    };

    if (target === 'ebay') {
      const candidates = buildEbayCandidates();
      if (!candidates.length) return null;
      const prompt = [
        'Du bist ein Kategorisierungs-Assistent.',
        'Aufgabe: Wähle GENAU EINE eBay Kategorie aus der vorgegebenen Kandidatenliste.',
        'Regeln (kritisch):',
        '- Du darfst NUR eine ID aus der Kandidatenliste zurückgeben. Keine neue ID erfinden.',
        '- Wähle die beste Leaf-Kategorie, die zum Produkt passt.',
        '',
        'Produkt:',
        `SKU: ${safeString(product?.details?.identifiers?.sku || product?.identification?.sku || product?.id)}`,
        `Name: ${safeString(product?.identification?.name)}`,
        `Marke: ${safeString(product?.identification?.brand)}`,
        `Produktart: ${safeString(attrs.Produktart || attrs.Produkttyp || attrs['Produkttyp (Produktart)'] || '')}`,
        `Beschreibung: ${safeString(product?.details?.short_description || product?.details?.description || '')}`,
        '',
        'Kandidaten (id | breadcrumb):',
        ...candidates.map((c) => `- ${c.id} | ${c.breadcrumb}`),
        '',
        'Antworte NUR als JSON: {"id":"..."}',
      ].join('\n');

      const resp = await model.generateContent(prompt);
      const text = resp?.response?.text() || '';
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const json = JSON.parse(match[0]);
      const pickedId = safeString(json?.id);
      if (!pickedId) return null;
      const picked = candidates.find((c) => String(c.id) === pickedId);
      if (!picked) return null;
      return { id: String(picked.id), path: picked.breadcrumb };
    }

    // Kaufland: keep existing behavior for now (separate taxonomy system).
    const prompt = `
Du bist ein Kategorisierungs-Assistent. Finde einen passenden Kategorie-PFAD (deutsch)
für Kaufland (inventory 85404).
Liefere NUR ein JSON-Objekt: { "path": "..." }
- Keine IDs erfinden, nur einen realistischen Pfadtext.

Daten:
SKU: ${product?.details?.identifiers?.sku || product?.identification?.sku || product?.id}
Name: ${product?.identification?.name || ''}
Marke: ${product?.identification?.brand || ''}
Freie Kategorie: ${product?.identification?.category || ''}
Beschreibung: ${product?.details?.description || product?.details?.short_description || ''}
Attribute: ${Object.entries(attrs)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join(' | ')}
    `.trim();
    const resp = await model.generateContent(prompt);
    const text = resp?.response?.text() || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const json = JSON.parse(match[0]);
    const pathText = json.path || json.category || json.category_path;
    if (!pathText) return null;
    const id = marketplaceLookup.lookupKaufland(pathText);
    if (id) return { id: String(id), path: pathText };
  } catch (e) {
    console.warn('Gemini category resolution failed:', e.message);
  }
  return null;
}

// Gemini Helper: Convert buffer to generative part
function bufferToGenerativePart(buffer, mimeType) {
  return {
    inlineData: {
      data: buffer.toString("base64"),
      mimeType
    },
  };
}



const marketingCopySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'highlights'],
  properties: {
    // Keep schema flexible to avoid blocked generations; enforce title policy in code after parsing (optimal 65–75, hard max 80).
    title: { type: 'string', minLength: 20, maxLength: 140 },
    description: { type: 'string', minLength: 300 },
    highlights: {
      type: 'array',
      minItems: 5,
      maxItems: 7,
      items: { type: 'string', minLength: 8, maxLength: 160 },
    },
  },
};
const validateMarketingCopy = ajv.compile(marketingCopySchema);

function parseBarcodes(raw) {
  if (!raw) return [];
  const list = raw
    .split(/[\s,;|]+/)
    .map((code) => code.trim())
    .filter(Boolean);

  if (list.length > MAX_BARCODE_COUNT) {
    const error = new Error(BARCODE_LIMIT_ERROR);
    error.code = BARCODE_LIMIT_ERROR;
    error.meta = { max: MAX_BARCODE_COUNT };
    throw error;
  }
  return list;
}

function normalizeBarcodeValue(value = '') {
  if (!value) return '';
  const digits = value.replace(/[^\d]/g, '');
  if (digits.length >= 8) {
    return digits;
  }
  return value.trim();
}

function normalizeBarcodeList(list = []) {
  const seen = new Set();
  const normalized = [];
  list
    .map((code) => normalizeBarcodeValue(code))
    .filter(Boolean)
    .forEach((code) => {
      if (seen.has(code)) return;
      seen.add(code);
      normalized.push(code);
    });
  return normalized;
}

function mergeBarcodeLists(...sources) {
  const merged = [];
  const seen = new Set();
  sources
    .flat()
    .map((code) => normalizeBarcodeValue(code))
    .filter(Boolean)
    .forEach((code) => {
      if (seen.has(code)) return;
      seen.add(code);
      merged.push({
        code,
        priority: isValidGtin(code) ? 0 : 1,
      });
    });
  merged.sort((a, b) => a.priority - b.priority);
  return merged.slice(0, MAX_BARCODE_COUNT).map((entry) => entry.code);
}

async function prepareImages(files = []) {
  if (!files.length) {
    return { imageParts: [], hostedImages: [] };
  }

  const imageParts = [];
  const hostedImages = [];
  let payloadBytes = 0;
  let inlineCount = 0;

  const compressToBudget = async (buffer, mimeType, remainingBudget) => {
    if (!mimeType?.startsWith('image/') || remainingBudget <= 256 * 1024) {
      return { buffer, mimeType };
    }
    try {
      const pipeline = sharp(buffer).rotate();
      const meta = await pipeline.metadata();
      const longest = Math.max(meta.width || 0, meta.height || 0);
      const targetEdge = longest && longest > 1800 ? 1800 : longest || 1600;
      let resized = pipeline;
      if (longest && longest > targetEdge) {
        resized =
          meta.width >= meta.height
            ? resized.resize({ width: targetEdge, fit: 'inside', withoutEnlargement: false })
            : resized.resize({ height: targetEdge, fit: 'inside', withoutEnlargement: false });
      }
      const quality = remainingBudget < 3 * 1024 * 1024 ? 78 : 86;
      const output = await resized.jpeg({ quality, chromaSubsampling: '4:2:0' }).toBuffer();
      return { buffer: output, mimeType: 'image/jpeg' };
    } catch (error) {
      console.warn('Image compression failed, using original buffer:', error.message);
      return { buffer, mimeType };
    }
  };

  for (let idx = 0; idx < files.length; idx++) {
    const file = files[idx];
    let inlineBuffer = file.buffer;
    let inlineMime = file.mimetype || 'application/octet-stream';

    // Compress if we would exceed the inline payload budget
    if (payloadBytes + inlineBuffer.length > MAX_IMAGE_PAYLOAD_BYTES) {
      const budget = MAX_IMAGE_PAYLOAD_BYTES - payloadBytes;
      const compressed = await compressToBudget(inlineBuffer, inlineMime, budget);
      inlineBuffer = compressed.buffer;
      inlineMime = compressed.mimeType || inlineMime;
    }

    const willFitInline =
      inlineCount < INLINE_IMAGE_CAP && payloadBytes + inlineBuffer.length <= MAX_IMAGE_PAYLOAD_BYTES;
    if (willFitInline) {
      const base64 = inlineBuffer.toString('base64');
      imageParts.push({
        type: 'input_image',
        image_url: `data:${inlineMime};base64,${base64}`,
      });
      payloadBytes += inlineBuffer.length;
      inlineCount += 1;
    }

    try {
      const { url: publicUrl, width, height } = await uploadImage(
        file.buffer,
        file.mimetype,
        'uploads',
        `identify_${Date.now()}_${idx}`
      );
      hostedImages.push({
        filename: file.originalname,
        mimeType: file.mimetype,
        url: publicUrl,
        width,
        height,
        size: file.size,
      });
    } catch (error) {
      console.warn('Failed to upload image for Lens usage:', error.message);
    }
  }

  if (payloadBytes > SOFT_IMAGE_PAYLOAD_BYTES) {
    console.log(
      `Inline image payload ${Math.round(payloadBytes / (1024 * 1024))} MB (soft limit ${SOFT_IMAGE_PAYLOAD_BYTES / (1024 * 1024)
      } MB) - remaining images are provided via hosted URLs for Lens.`
    );
  }

  return { imageParts, hostedImages };
}

async function fetchBarcodeSerpData(barcode, serpTrace = []) {
  const engines = [
    { engine: 'google_shopping', params: { q: barcode, num: 20 } },
    { engine: 'google', params: { q: barcode, num: 10 } },
    { engine: 'bing_shopping', params: { q: barcode, count: 15 } },
  ];

  for (const spec of engines) {
    try {
      const raw = await callSerpApi(spec.engine, spec.params);
      const summary = summarizeSerpEntries(spec.engine, raw, spec.params.num || 10);
      if (!summary.length) continue;
      serpTrace.push({
        engine: spec.engine,
        query: barcode,
        summary,
        params: spec.params,
        prefetched: true,
      });
      return {
        barcode,
        engine: spec.engine,
        items: summary.slice(0, 4).map((item) => ({
          title: item.title,
          source: item.source,
          price: item.price,
          url: item.url,
        })),
      };
    } catch (error) {
      serpTrace.push({
        engine: spec.engine,
        query: barcode,
        summary: [],
        params: spec.params,
        error: error.message || String(error),
        prefetched: true,
      });
    }
  }
  return null;
}

function buildSystemPrompt(locale = 'de-DE') {
  return [
    `Du bist Gemini (Google) und agierst als Product Intelligence Brain.`,
    buildCommonPolicyText({ locale, allowWebEvidence: true }),
    '',
    `Zusatzregeln für Identify:`,
    `- Du darfst KEINE eigenen Web-Calls ausführen. Wenn WEB-EVIDENZ im Prompt enthalten ist, darfst du sie nutzen.`,
    `- Wenn Informationen fehlen: Feld leer lassen + in notes.unsure dokumentieren.`,
    `- Ausgabe strikt im ProductBundle-Schema (kein Markdown, keine Freitexte).`,
    `- Ziel: ein eBay-fertiges Produktdatenblatt (Titel optimal 65–75 Zeichen, Hard-Max 80, Beschreibung >= 300 Zeichen, 5–7 Highlights, Breadcrumb-Kategorie).`,
  ].join('\n');
}

function buildUserPrompt({
  barcodeList,
  hostedImages,
  locale,
  fileCount = 0,
  improveContext = null,
  ocrTextSnippets = [],
  ocrNumericValues = [],
  webEvidence = null,
}) {
  const parts = [];
  if (barcodeList.length) {
    parts.push(
      `Barcodes: ${barcodeList.join(', ')}\nPriorität: Nutze diese Codes (EAN/GTIN/UPC) zuerst. Wenn Barcode-Resultate von Bildannahmen abweichen, vertraue den Barcode/Händlerinformationen und korrigiere die Bildinterpretation.`
    );
  } else {
    parts.push('Barcodes: keine angegeben');
  }

  if (hostedImages.length) {
    parts.push(
      'Öffentlich abrufbare Bild-URLs (für Google Lens/Reverse Image / google_reverse_image):',
      hostedImages
        .map((img, idx) => `${idx + 1}. ${img.url} (${img.mimeType}, ${img.filename || 'upload'})`)
        .join('\n')
    );
  } else {
    parts.push('Es liegen keine vorab gehosteten Bilder vor.');
  }

  if (Array.isArray(ocrTextSnippets) && ocrTextSnippets.length) {
    parts.push(
      'OCR-Textauszüge (aus den hochgeladenen Bildern extrahiert – nutze diese Fakten, bevor du Vermutungen aus Vision ableitest):',
      ocrTextSnippets
        .slice(0, 40)
        .map((line, idx) => `${idx + 1}. ${line}`)
        .join('\n')
    );
  }

  if (Array.isArray(ocrNumericValues) && ocrNumericValues.length) {
    parts.push(
      'OCR-Ziffern & Nummern (potentielle Seriennummern, SKUs, Barcodes):',
      ocrNumericValues
        .slice(0, 40)
        .map((value) => `- ${value}`)
        .join('\n')
    );
  }

  if (fileCount && fileCount > 1) {
    parts.push(
      `Hinweis: Es wurden ${fileCount} Upload-Bilder geliefert. Wenn sie unterschiedliche Produkte oder unterschiedliche Barcodes zeigen, erzeuge mehrere Produkte im products-Array (je Barcode ein Eintrag, eindeutige IDs, keine Zusammenfassung).`
    );
  }
  if (improveContext) {
    parts.push(
      'Verbesserungsmodus: Nutze den bestehenden Datensatz als Ausgangspunkt, korrigiere Fehler, fülle Lücken und optimiere Stil/Marketing. Wichtige Fakten (Marke, Modell, EAN) nur überschreiben, falls neue verifizierte Informationen vorliegen.',
      improveContext
    );
  }

  if (webEvidence) {
    parts.push(
      'WEB-EVIDENZ (aus HTML-Websuche/Fetch; nur als zusätzliche Quelle verwenden, nicht halluzinieren):',
      typeof webEvidence === 'string' ? webEvidence : JSON.stringify(webEvidence, null, 2)
    );
  }

  parts.push(
    `Aufgabe (mit optionaler WEB-EVIDENZ im Prompt):`,
    `1. Analysiere Bilder/OCR/Barcodes, um Marke/Modell zu erkennen.`,
    `2. Titel & Copy marketplace-ready:`,
    `   - Titel: Mobile-first. Priorität A in den ersten 60 Zeichen (schema-/kategorieabhängig; siehe TITLE-SCHEMA GUIDELINES im Policy-Block). Optimal 65–75, Hard-Max 80.`,
    `   - Zustand: Wenn nicht explizit vorhanden, setze Attribut "Zustand" = "NEU". "Gebraucht" nur wenn im Datensatz gesetzt.`,
    `   - short_description: mind. 3 Absätze à 2 Sätze (Einsatz, Nutzen, Ausstattung, Material/Verarbeitung, Lieferumfang, Bedienung/Pflege).`,
    `   - key_features: 5-7 Nutzen-Bullets, je Bullet ca. 70–120 Zeichen (je Kategorie) und im Format "[Nutzen] – [konkrete Eigenschaft/Spec]" (Dash/En-Dash mit Leerzeichen).`,
    `   - Keine Preisangaben oder Preisorientierung in Titel/Beschreibung/Highlights.`,
    `3. Bilder: nur eindeutige, Dubletten entfernen.`,
    `4. Attribute als Liste ausgeben: [{ "key": "Material", "value": "100% Baumwolle", "value_type": "string" }, ...].`,
    `5. Bei mehreren Produkten: für jedes ein separates Objekt im products-Array (eindeutige id, bevorzugt EAN/GTIN).`,
    `6. Pro Produkt nur EIN Barcode/EAN/GTIN zulassen (keine Mehrfach-Barcodes).`,
    `7. Preise nur, wenn sicher aus gelieferten Daten ableitbar, sonst leer lassen.`,
    `8. Unsicherheiten in notes.unsure dokumentieren.`,
    `9. Ordne eBay.de Kategorie (Breadcrumb) zu und füge die Pflichtattribute (Item Specifics) als Keys OHNE Prefix (leer bei Unbekannt) hinzu.`,
    `10. OPTIONAL: Kaufland-Kategorie/Attribute werden nachgelagert im System ergänzt (du musst sie hier nicht erzwingen).`,
    `Sprache: Deutsch (${locale}).`
  );
  if (improveContext) {
    parts.push(
      'Stelle sicher, dass der Output gegenüber dem bestehenden Datensatz eine Verbesserung darstellt (keine Verkürzungen oder Auslassungen).'
    );
  }

  return parts.join('\n\n');
}

function looksUnknown(value) {
  const v = (value || '').toString().trim().toLowerCase();
  if (!v) return true;
  if (v === 'unknown' || v === 'unbekannt') return true;
  if (v.startsWith('unknown')) return true;
  if (v.startsWith('unbekannt')) return true;
  // Guard against placeholder titles like "Produkt 1", "Ürün 1"
  if (/^(produkt|product|ürün|urun|artikel)\s*#?\s*\d+\b/i.test(v)) return true;
  return false;
}

function isLowQualityIdentifyProduct(p) {
  const brand = p?.identification?.brand || '';
  const title = p?.identification?.name || '';
  const cat = p?.identification?.category || '';
  const desc = p?.details?.short_description || '';
  const features = Array.isArray(p?.details?.key_features) ? p.details.key_features : [];
  const hasBarcode =
    Array.isArray(p?.identification?.barcodes) && p.identification.barcodes.length > 0;
  const attrs = p?.details?.attributes;
  const attrCount =
    attrs && typeof attrs === 'object'
      ? (Array.isArray(attrs) ? attrs.length : Object.keys(attrs).length)
      : 0;
  const score =
    (looksUnknown(brand) ? 2 : 0) +
    (title.trim().length < 60 || looksUnknown(title) ? 2 : 0) +
    (desc.trim().length < 260 ? 2 : 0) +
    (features.length < 5 ? 1 : 0) +
    (!cat.includes('>') ? 1 : 0) +
    (attrCount < 5 ? 1 : 0) +
    (!hasBarcode ? 1 : 0);
  return score >= 3;
}

async function prefetchWebEvidenceForIdentify({ barcodeList = [], ocrTextSnippets = [], locale = 'de-DE' } = {}) {
  // SerpAPI-free web evidence (best-effort).
  // We only provide URL/title plus a tiny excerpt from fetched pages (no hallucinations).
  const queries = [];
  barcodeList.slice(0, 3).forEach((code) => {
    const c = String(code || '').trim();
    if (c && c.length >= 8) queries.push(c);
  });
  const ocrLine = (ocrTextSnippets || []).find((l) => typeof l === 'string' && l.trim().length >= 8) || '';
  if (ocrLine) queries.push(ocrLine.trim().slice(0, 120));

  const unique = Array.from(new Set(queries)).slice(0, 3);
  if (!unique.length) return null;

  const blocks = [];
  for (const q of unique) {
    const search = await searchWeb(q, { limit: 6, locale });
    const items = [];
    for (const r of (search.results || []).slice(0, 4)) {
      const url = r?.url;
      if (!url) continue;
      const page = await fetchPageText(url, { timeoutMs: 25_000 });
      const excerpt = page.ok ? String(page.text || '').slice(0, 600) : '';
      items.push({
        title: r.title || '',
        url,
        via: page.via,
        status: page.status,
        excerpt,
      });
    }
    blocks.push({
      engine: search.engine,
      query: q,
      search_url: search.url,
      items,
      error: search.ok ? null : (search.error || 'search_failed'),
    });
  }

  return JSON.stringify({ locale, fetched_at: new Date().toISOString(), blocks }, null, 2);
}

function parseModelJson(response) {
  if (response.refusal) {
    throw new Error(`Model refusal: ${response.refusal}`);
  }
  const text = (response.output_text || '').trim();
  if (!text) {
    throw new Error('Model response did not contain output_text');
  }
  return JSON.parse(text);
}

function ensureSchema(bundle) {
  if (!validateProductBundle(bundle)) {
    const message = validateProductBundle.errors?.map((e) => `${e.instancePath} ${e.message}`).join('; ');
    throw new Error(`Model output failed ProductBundle schema validation: ${message}`);
  }
}

function normalizeBundle(bundle) {
  if (!bundle?.products) return bundle;
  bundle.products = bundle.products.map((product) => {
    const cloned = { ...product };
    // Ensure identification exists and required strings are non-empty
    cloned.identification = cloned.identification || {};
    // Keep empty strings instead of placeholder tokens; later stages may fill.
    cloned.identification.brand = (cloned.identification.brand || '').trim();
    cloned.identification.name = (cloned.identification.name || '').trim();
    cloned.identification.category = (cloned.identification.category || '').trim();
    if (looksUnknown(cloned.identification.brand)) cloned.identification.brand = '';
    if (looksUnknown(cloned.identification.name) || /^unbekanntes produkt$/i.test(cloned.identification.name)) {
      cloned.identification.name = '';
    }
    if (looksUnknown(cloned.identification.category)) cloned.identification.category = '';
    if (Array.isArray(cloned.details?.attributes)) {
      const attrObj = {};
      for (const entry of cloned.details.attributes) {
        const key = entry?.key?.trim();
        if (!key) continue;
        attrObj[key] = entry?.value ?? '';
      }
      cloned.details = { ...cloned.details, attributes: attrObj };
    }
    cloned.details = cloned.details || {};
    cloned.details.attributes = sanitizeAttributesMap(cloned.details.attributes || {});
    enforceSingleBarcode(cloned);
    ensureProductId(cloned);
    cloned.details.key_features = sanitizeKeyFeatures(cloned.details.key_features || []);
    return cloned;
  });
  return bundle;
}

function assertIdentifiedProduct(product) {
  if (!product) {
    throw new Error('Produkt fehlt im Bundle');
  }
  const name = (product.identification?.name || '').trim();
  const brand = (product.identification?.brand || '').trim();
  const hasName =
    name.length >= 3 &&
    !/^unbekannt$/i.test(name) &&
    !/^(produkt|product|ürün|urun|artikel)\s*#?\s*\d+\b/i.test(name);
  const hasBrand = brand.length >= 2 && !/^unbekannt$/i.test(brand);
  const hasBarcode =
    Array.isArray(product.identification?.barcodes) && product.identification.barcodes.length > 0;
  const hasImage =
    Array.isArray(product.details?.images) &&
    product.details.images.some((img) => img && (img.url_or_base64 || img.url || img.href));

  if (!hasName || (!hasBrand && !hasBarcode && !hasImage)) {
    throw new Error('Identifikation unvollständig (Name oder Basis-Metadaten fehlen)');
  }
}

function attachReferenceImages(products = [], hostedImages = []) {
  if (!Array.isArray(products) || !products.length) {
    return;
  }
  if (!Array.isArray(hostedImages) || !hostedImages.length) {
    return;
  }
  const normalizedUploads = hostedImages
    .map((img, index) => {
      if (!img?.url) return null;
      return {
        source: 'upload',
        variant: 'reference',
        url_or_base64: img.url,
        notes: img.filename || `upload_${index + 1}`,
        width: img.width || null,
        height: img.height || null,
        mimeType: img.mimeType || null,
      };
    })
    .filter(Boolean);
  if (!normalizedUploads.length) {
    return;
  }
  products.forEach((product) => {
    if (!product) return;
    product.details = product.details || {};
    const existing = Array.isArray(product.details.images) ? [...product.details.images] : [];
    const existingKeys = new Set(
      existing.map((img) => (img?.url_or_base64 || '').toLowerCase()).filter(Boolean)
    );
    const toAppend = [];
    for (const upload of normalizedUploads) {
      const key = upload.url_or_base64.toLowerCase();
      if (existingKeys.has(key)) {
        continue;
      }
      toAppend.push(upload);
      existingKeys.add(key);
    }
    if (toAppend.length) {
      product.details.images = [...existing, ...toAppend];
    } else {
      product.details.images = existing;
    }
  });
}

function injectMissingBarcodes(products = [], barcodeList = []) {
  if (!Array.isArray(products) || !products.length || !barcodeList.length) {
    return;
  }
  // Only accept checkdigit-valid GTIN/UPC lengths from upstream OCR/manual sources.
  // This prevents random OCR numbers from being injected as "barcodes".
  const remaining = [
    ...new Set(
      barcodeList
        .map((code) => normalizeDigits(String(code || '')))
        .filter((code) => [8, 12, 13, 14].includes(code.length) && isValidGtin(code))
    ),
  ];
  products.forEach((product) => {
    if (remaining.length === 0) return;
    const hasBarcode =
      Array.isArray(product.identification?.barcodes) && product.identification.barcodes.length > 0;
    if (hasBarcode) {
      return;
    }
    const nextBarcode = remaining.shift();
    if (!nextBarcode) return;
    product.identification = {
      ...(product.identification || {}),
      barcodes: [nextBarcode],
    };
    // IMPORTANT:
    // Do NOT write identifiers.ean/gtin/upc here. We only set identifiers from validated barcodes
    // in saveProduct() when syncIdentifiersFromBarcodes is enabled, after all invariants and audits.
  });
}

function parseCategoryIdFromString(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const match = raw.match(/\\[(\\d+)\\]/);
  if (match) {
    const num = parseInt(match[1], 10);
    if (Number.isFinite(num)) return num;
  }
  const numeric = parseInt(raw, 10);
  return Number.isFinite(numeric) ? numeric : null;
}

function applyEbayTaxonomy(input) {
  // Support both Bundle and Single Product
  if (input?.products && Array.isArray(input.products)) {
    input.products = input.products.map((p) => processEbayProduct(p));
    return input;
  }
  if (input && input.identification) {
    return processEbayProduct(input);
  }
  return input;
}

function resolveEbayCategory({ details = {}, attributes = {}, identification = {} }) {
  const rawId =
    attributes.ebay_category_id ||
    attributes.ebayCategoryId ||
    attributes.category_id ||
    attributes.categoryId ||
    attributes['ebay.category_id'] ||
    details.ebayCategoryId ||
    null;

  // NOTE:
  // - `identification.category` is an internal/free-text classification in this app and is NOT reliably an eBay breadcrumb.
  // - Many eBay leaf names are ambiguous ("Sonstige", "Elektronik & Computer", ...). Never resolve by leaf-only names.
  // Prefer explicit eBay path fields and canonical "Kategorie" (which we set to the FULL breadcrumb on save).
  const pathCandidates = [
    details.ebayCategoryPath,
    attributes.ebay_category_path,
    attributes.ebay_category,
    details.ebayCategory,
    attributes.Kategorie,
    attributes.category,
  ]
    .map((v) => normalizePath(v))
    .filter(Boolean);
  // Prefer candidates that look like a full breadcrumb/path (contain ">" separators).
  // If multiple, pick the longest (most specific).
  const bestPath =
    pathCandidates
      .filter((p) => p.includes('>'))
      .sort((a, b) => b.length - a.length)[0] ||
    null;

  if (isNumericId(rawId) && marketplaceLookup.isValidEbayId(String(rawId).trim())) {
    return { id: String(rawId).trim(), path: bestPath || pathCandidates[0] || '' };
  }

  // Only resolve by breadcrumb/path if we actually have a breadcrumb (avoid leaf-only strings).
  if (bestPath) {
    const byPath = marketplaceLookup.lookupEbay(bestPath);
  if (byPath) {
      return { id: byPath, path: bestPath };
    }
  }

  const idCandidate = parseCategoryIdFromString(rawId);
  let cat = null;
  if (idCandidate) cat = findEbayCategory(idCandidate);
  // Fallback: best-effort map from breadcrumb-like paths only (never from leaf-only strings).
  if (!cat && bestPath) cat = findEbayCategory(bestPath);
  if (cat) {
    return { id: String(cat.id), path: cat.breadcrumb || bestPath || '' };
  }
  return null;
}

function processEbayProduct(product) {
  const cloned = { ...product };
  // IMPORTANT: Some legacy imports store marketplace meta keys under `details.attributes_extra`.
  // We need those for category resolution, but we never persist them back into user-facing attributes here.
  const attributes = {
    ...(cloned.details?.attributes_extra &&
    typeof cloned.details.attributes_extra === 'object' &&
    !Array.isArray(cloned.details.attributes_extra)
      ? cloned.details.attributes_extra
      : {}),
    ...(cloned.details?.attributes &&
    typeof cloned.details.attributes === 'object' &&
    !Array.isArray(cloned.details.attributes)
      ? cloned.details.attributes
      : {}),
  };

  const resolved = resolveEbayCategory({
    details: cloned.details,
    attributes,
    identification: cloned.identification,
  });

  if (resolved) {
    cloned.details = {
      ...(cloned.details || {}),
      categoryId: resolved.id,
      ebayCategoryId: resolved.id,
      ebayCategoryBreadcrumb: resolved.path || cloned.details?.ebayCategoryBreadcrumb || resolved.id,
      ebayCategoryPath: resolved.path || cloned.details?.ebayCategoryPath || resolved.id,
    };

    // Do NOT write eBay meta keys into user attributes. These are treated as meta and moved to attributes_extra on save.

    cloned.identification = {
      ...(cloned.identification || {}),
      category: resolved.path || cloned.identification?.category,
    };

    const required = getRequiredAspects(resolved.id);
    required.forEach((aspect) => {
      if (attributes[aspect] === undefined) {
        attributes[aspect] = '';
      }
    });
  }

  cloned.details = cloned.details || {};
  cloned.details.attributes = attributes;
  return cloned;
}

function applyKauflandTaxonomy(input) {
  // Support both Bundle ({ products: [] }) and Single Product input
  if (input?.products && Array.isArray(input.products)) {
    input.products = input.products.map((p) => processKauflandProduct(p));
    return input;
  }
  // Single product case
  if (input && input.identification) {
    return processKauflandProduct(input);
  }
  return input;
}

// Ensure categories using Gemini fallback if missing
async function ensureCategories(products = []) {
  for (const p of products) {
    if (!p || !p.details) continue;
    const attrs = p.details.attributes || {};

    const existingEbayIdRaw = p.details.categoryId || p.details.ebayCategoryId;
    const existingEbayId = existingEbayIdRaw ? String(existingEbayIdRaw).trim() : '';
    const ebayIdOk = existingEbayId && marketplaceLookup.isValidEbayId(existingEbayId);
    const existingCat = ebayIdOk ? findEbayCategory(existingEbayId) : null;
    const existingBreadcrumb = existingCat?.breadcrumb ? String(existingCat.breadcrumb) : '';
    // Prevent overly generic top-level categories (no '>' breadcrumb). We want a real category tree path.
    const ebayTooBroad = Boolean(existingBreadcrumb) && !existingBreadcrumb.includes('>');

    if (!ebayIdOk || ebayTooBroad) {
      const g = await resolveCategoryWithGemini(p, 'ebay');
      if (g?.id) {
        // Canonical category id is details.categoryId (single-category system).
        p.details.categoryId = g.id;
        // Legacy fields for backward compatibility (some scripts still read them)
        p.details.ebayCategoryId = g.id;
        p.details.ebayCategoryPath = g.path;
      }
    }

    if (
      !p.details.kauflandCategoryId ||
      !marketplaceLookup.isValidKauflandId(String(p.details.kauflandCategoryId))
    ) {
      const g = await resolveCategoryWithGemini(p, 'kaufland');
      if (g?.id) {
        p.details.kauflandCategoryId = g.id;
        p.details.kauflandCategoryPath = g.path;
      }
    }

    p.details.attributes = attrs;
  }
}

function resolveKauflandCategory({ details = {}, attributes = {}, identification = {} }) {
  const rawId =
    attributes.kaufland_category_id ||
    attributes.kauflandCategoryId ||
    attributes['kaufland.category_id'] ||
    details.kauflandCategoryId ||
    null;

  const rawPath =
    details.kauflandCategoryPath ||
    attributes.kaufland_category_path ||
    attributes.kaufland_category ||
    attributes.Kategorie ||
    attributes.category ||
    identification.category ||
    null;

  if (isNumericId(rawId) && marketplaceLookup.isValidKauflandId(String(rawId).trim())) {
    return { id: String(rawId).trim(), path: normalizePath(rawPath) };
  }

  const byPath = marketplaceLookup.lookupKaufland(normalizePath(rawPath));
  if (byPath) {
    return { id: byPath, path: normalizePath(rawPath) };
  }

  const idCandidate = parseCategoryIdFromString(rawId);
  let cat = null;
  if (idCandidate) cat = findKauflandCategory(idCandidate);
  if (!cat) cat = findKauflandCategory(rawPath);
  if (cat) {
    return { id: String(cat.id), path: cat.dePath || cat.enPath || normalizePath(rawPath) };
  }
  return null;
}

function processKauflandProduct(product) {
  const cloned = { ...product }; // Shallow copy
  cloned.details = cloned.details || {};
  cloned.details.attributes = cloned.details.attributes || {};

  const attributes = cloned.details.attributes;
  const resolved = resolveKauflandCategory({
    details: cloned.details,
    attributes,
    identification: cloned.identification,
  });

  if (resolved) {
    cloned.details.kauflandCategoryId = resolved.id;
    cloned.details.kauflandCategoryPath = resolved.path || resolved.id;

    attributes.kaufland_category_id = resolved.id;
    attributes.kaufland_category_path = resolved.path || resolved.id;
    attributes.Kategorie = resolved.path || attributes.Kategorie;
  }

  cloned.details.attributes = attributes;
  return cloned;
}

function enforceSingleBarcode(product) {
  const cloned = product || {};
  const identifiers = { ...(cloned.details?.identifiers || {}) };
  const candidateList = [];

  // Collect barcodes from identification
  if (Array.isArray(cloned.identification?.barcodes)) {
    cloned.identification.barcodes.forEach((b) => b && candidateList.push(String(b).trim()));
  }
  // Collect from identifiers
  PRIMARY_BARCODE_KEYS.forEach((key) => {
    const val = identifiers[key];
    if (val) candidateList.push(String(val).trim());
  });

  // Normalize + validate (checkdigit) and only keep valid GTIN/UPC lengths.
  const normalized = candidateList
    .map((v) => normalizeDigits(String(v || '')))
    .filter(Boolean)
    .filter((v) => [8, 12, 13, 14].includes(v.length) && isValidGtin(v));

  const primary = normalized[0] || null;
  const unique = primary ? [primary] : [];

  // Write back a single barcode (if valid), but do NOT force it into all identifier keys.
  if (cloned.identification) {
    cloned.identification.barcodes = unique;
  }

  // Only set the matching identifier slot for the GTIN type; never clone into ean+gtin+upc.
  PRIMARY_BARCODE_KEYS.forEach((key) => {
    if (identifiers[key] != null && identifiers[key] !== '') {
      // keep existing non-empty values; they'll be validated by saveProduct later
      return;
    }
  });
  if (primary) {
    const type = getGtinType(primary);
    if (type === 'ean13') identifiers.ean = primary;
    if (type === 'gtin14') identifiers.gtin = primary;
    if (type === 'upc12') identifiers.upc = primary;
    // If we got only GTIN14 starting with 0, derive EAN13 too (safe equivalence)
    if (type === 'gtin14' && primary.startsWith('0')) {
      const derived = primary.slice(1);
      if (derived.length === 13 && isValidGtin(derived)) {
        identifiers.ean = identifiers.ean || derived;
      }
    }
  }

  if (cloned.details) {
    cloned.details.identifiers = identifiers;
  }
}

function ensureProductId(product) {
  if (!product) return;
  const identifiers = product.details?.identifiers || {};
  const primary = identifiers.ean || identifiers.gtin || identifiers.upc || null;
  const hasId = typeof product.id === 'string' && product.id.trim().length >= 3;
  if (!hasId) {
    product.id = (primary && String(primary).trim()) || `prod-${crypto.randomUUID()}`;
  }
}

const CURRENCY_MAP = {
  '€': 'EUR',
  eur: 'EUR',
  $: 'USD',
  usd: 'USD',
  '£': 'GBP',
  gbp: 'GBP',
};

function normalizePriceString(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { amount: raw, currency: DEFAULT_PRICE_CURRENCY };
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Avoid monthly installment strings (SerpAPI can expose installment separately for some Shopping results).
  if (/(\/\s*mon(at)?|per\s*month|\/\s*mo\b|\bmonat\b)/i.test(trimmed)) {
    return null;
  }
  const currencyMatch = trimmed.match(/(€|eur|\$|usd|£|gbp)/i);
  const currency = currencyMatch ? CURRENCY_MAP[currencyMatch[1].toLowerCase()] || DEFAULT_PRICE_CURRENCY : DEFAULT_PRICE_CURRENCY;
  const numericPortion = trimmed.replace(/[^0-9,.\-]/g, '');
  if (!numericPortion) return null;
  const commaCount = (numericPortion.match(/,/g) || []).length;
  const dotCount = (numericPortion.match(/\./g) || []).length;
  let normalized = numericPortion;
  if (commaCount && dotCount) {
    if (numericPortion.lastIndexOf(',') > numericPortion.lastIndexOf('.')) {
      normalized = numericPortion.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = numericPortion.replace(/,/g, '');
    }
  } else if (commaCount === 1 && dotCount === 0) {
    normalized = numericPortion.replace(',', '.');
  } else {
    normalized = numericPortion.replace(/,/g, '');
  }
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return null;
  return { amount, currency };
}

function collectProductKeywords(product) {
  const values = [
    product?.identification?.brand,
    product?.details?.identifiers?.mpn,
    product?.details?.attributes?.Herstellernummer,
    product?.details?.attributes?.mpn,
    product?.details?.identifiers?.ean,
    product?.details?.identifiers?.gtin,
    product?.details?.identifiers?.upc,
  ].filter(Boolean);

  const title = (product?.identification?.name || '').toString();
  const titleTokens = title
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/[\u2010-\u2015-]/g, ' ')
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter(Boolean);

  const STOP = new Set([
    'und','oder','mit','fur','fuer','für','der','die','das','ein','eine','einer','eines','zum','zur','im','in','auf','an','von','für','set','kit','neu','new'
  ]);

  const tokens = [
    ...values.map((v) => String(v).trim().toLowerCase()),
    ...titleTokens.filter((t) => t.length >= 4 && !STOP.has(t)),
  ]
    .filter((v) => v && v.length >= 3)
    .slice(0, 16);

  return Array.from(new Set(tokens));
}

function collectAttributePairs(product) {
  const attributes = product?.details?.attributes;
  if (!attributes) return [];
  if (Array.isArray(attributes)) {
    return attributes
      .map((entry) => `${entry?.key}: ${entry?.value}`)
      .filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
  }
  return Object.entries(attributes)
    .map(([key, value]) => `${key}: ${value}`)
    .filter((entry) => entry.trim().length > 0);
}

function sanitizeKeyFeatures(features = [], limit = 7) {
  if (!Array.isArray(features) || !features.length) {
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const raw of features) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.replace(/\s+/g, ' ').trim();
    if (trimmed.length < 8) continue;
    if (containsPackagingReference(trimmed)) continue;
    if (containsPriceReference(trimmed)) continue;
    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(trimmed);
    if (result.length >= limit) break;
  }
  return result;
}

function sanitizeAttributesMap(attributes = {}) {
  if (!attributes || typeof attributes !== 'object') {
    return {};
  }
  const cleaned = {};
  for (const [rawKey, rawValue] of Object.entries(attributes)) {
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    const key = rawKey?.toString().trim();
    if (!key) continue;
    if (ATTRIBUTE_BLACKLIST.has(key.toLowerCase())) {
      continue;
    }
    if (typeof rawValue === 'string') {
      const val = rawValue.trim();
      if (!val) continue;
      cleaned[key] = val;
      continue;
    }
    cleaned[key] = rawValue;
  }
  return cleaned;
}

const DATASHEET_REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'short_description', 'highlights', 'attributes', 'warnings'],
  properties: {
    // Keep schema flexible to avoid blocked generations; enforce title policy in code after parsing (optimal 65–75, hard max 80).
    title: { type: 'string', minLength: 15, maxLength: 140 },
    short_description: { type: 'string', minLength: 300, maxLength: 2000 },
    highlights: {
      type: 'array',
      minItems: 5,
      maxItems: 7,
      items: { type: 'string', minLength: 10, maxLength: 160 },
    },
    attributes: {
      type: 'array',
      // We want granular, marketplace-ready datasheets by default.
      // Quality Gate only requires >=5, but for operational quality we enforce a higher floor here.
      minItems: 10,
      maxItems: 40,
      items: {
        type: 'object',
        required: ['key', 'value'],
        additionalProperties: false,
        properties: {
          key: { type: 'string', minLength: 2, maxLength: 60 },
          // Allow numeric single-digit values like "1" (e.g. "Anzahl der Einheiten: 1").
          value: { type: 'string', minLength: 1, maxLength: 140 },
        },
      },
    },
    warnings: {
      type: 'array',
      maxItems: 10,
      items: { type: 'string', minLength: 6, maxLength: 160 },
    },
    // Optional: identifiers (critical for auto/moto parts and downstream K-Typ enrichment).
    // Only fill when supported by evidence; otherwise use empty string / null.
    identifiers: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mpn: { type: 'string', minLength: 0, maxLength: 80 },
        ean: { type: 'string', minLength: 0, maxLength: 32 },
        gtin: { type: 'string', minLength: 0, maxLength: 32 },
        upc: { type: 'string', minLength: 0, maxLength: 32 },
      },
      required: [],
    },
    // Optional: GPSR manufacturer/contact data (EU compliance).
    // IMPORTANT: do not invent values; only extract from evidence.
    gpsr: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entity_country: { type: 'string', minLength: 0, maxLength: 80 },
        manufacturer_name: { type: 'string', minLength: 0, maxLength: 140 },
        manufacturer_address: { type: 'string', minLength: 0, maxLength: 140 },
        manufacturer_city: { type: 'string', minLength: 0, maxLength: 80 },
        manufacturer_postalcode: { type: 'string', minLength: 0, maxLength: 20 },
        manufacturer_state_province: { type: 'string', minLength: 0, maxLength: 80 },
        email: { type: 'string', minLength: 0, maxLength: 140 },
        manufacturer_phone: { type: 'string', minLength: 0, maxLength: 80 },
        url: { type: 'string', minLength: 0, maxLength: 200 },
      },
      required: [],
    },
  },
};

function buildReviewPrompt(product, locale, { webEvidence = null, qualityIssues = [], llmOverrides = null } = {}) {
  const snapshot = {
    id: product?.id,
    brand: product?.identification?.brand,
    title: product?.identification?.name,
    category: product?.identification?.category,
    description: product?.details?.short_description,
    highlights: product?.details?.key_features,
    attributes: product?.details?.attributes,
    ebayCategoryId: product?.details?.ebayCategoryId,
    condition_locked: Boolean(product?.ops?.condition_locked),
  };

  const catIdRaw = product?.details?.categoryId || product?.details?.ebayCategoryId || null;
  const requiredAspects = catIdRaw ? getRequiredAspects(String(catIdRaw).trim()) : [];
  const requiredPreview = Array.isArray(requiredAspects) ? requiredAspects.slice(0, 40) : [];
  const requiredLine = requiredPreview.length
    ? `Pflicht-Item-Specifics (nicht leer lassen): ${requiredPreview.join(', ')}${requiredAspects.length > requiredPreview.length ? ` … (+${requiredAspects.length - requiredPreview.length} mehr)` : ''}`
    : null;
  const fitmentMode = catIdRaw ? getVehicleFitmentMode(String(catIdRaw).trim()) : null;
  const fitmentLine = fitmentMode
    ? `Fahrzeugverwendungsliste möglich (${fitmentMode}). Wenn es ein Fahrzeugteil ist: K-Typ muss als Attribut \"K-Typ\" gepflegt werden. Nie raten – nur aus WEB-EVIDENZ/OCR/Belegen.`
    : null;
  const gpsrLine =
    'GPSR/Compliance: Wenn WEB-EVIDENZ Hersteller/Verantwortlicher enthält, extrahiere und liefere gpsr.* (Adresse/Ort/PLZ/Land/E-Mail/Telefon/Name). Wenn nicht belegbar: Felder leer lassen (nicht raten).';
  const idsLine =
    'Identifiers: Wenn WEB-EVIDENZ/OCR MPN/Herstellernummer/EAN/GTIN/UPC enthält, liefere identifiers.* und zusätzlich als Attribute (z.B. "Herstellernummer"). Keine IDs erfinden.';

  const promptMode = llmOverrides?.promptMode === 'replace' ? 'replace' : 'append';
  const rulesMode = llmOverrides?.rulesMode === 'replace' ? 'replace' : 'append';
  const promptOverride = typeof llmOverrides?.promptText === 'string' ? llmOverrides.promptText : '';
  const rulesOverride = typeof llmOverrides?.rulesText === 'string' ? llmOverrides.rulesText : '';

  const baseIntro =
    'Du bist ein Marketplace-Quality-Inspector für eBay und Amazon. Deine Aufgabe: prüfe das vorliegende Produktdatenblatt und liefere eine korrigierte, maximal verkaufsstarke Version.';
  const baseRules = buildCommonPolicyText({ locale, allowWebEvidence: Boolean(webEvidence) });

  const effectiveIntro =
    promptOverride && promptMode === 'replace'
      ? promptOverride
      : [baseIntro, promptOverride].filter(Boolean).join('\n\n');
  const effectiveRules =
    rulesOverride && rulesMode === 'replace'
      ? rulesOverride
      : [baseRules, rulesOverride].filter(Boolean).join('\n\n');

  return [
    effectiveIntro,
    effectiveRules,
    '',
    'Zusatzregeln für Review:',
    requiredLine,
    fitmentLine,
    idsLine,
    gpsrLine,
    '- Plausibilitätscheck: Nutze WEB-EVIDENZ (Marktplatz-Suchergebnisse, falls enthalten) um Daten zu verifizieren und fehlende Spezifikationen zu ergänzen. Erfinde keine Werte.',
    '- Beschreibung: SEO-stark und gut lesbar. HTML ist erlaubt (nur <p>, <ul>, <li>, <strong>). Empfohlen: 1 Einleitungs-<p> (2–3 Sätze) + <ul> mit 5–7 Punkten (Nutzen + Spec) + 1 <p> mit technischen Eckdaten/Kompatibilität/Abmessungen/Gewicht (nur wenn belegbar). Keine Preis-/Versandtexte, keine Platzhalter, keine Dubletten.',
    '- Highlights: 5–7 Bulletpoints, je Bullet ca. 70–120 Zeichen (je Kategorie) und im Format "[Nutzen] – [konkrete Eigenschaft/Spec]" (Dash/En-Dash mit Leerzeichen). Neutral formulieren (kein "Ihr/Dein"), technisch/faktenbasiert, keine Verpackungshinweise, keine Dubletten.',
    '- Attribute: mindestens 10, sehr granular/technisch, keine Dubletten (auch nicht als Synonyme).',
    '- Zustand: Wenn condition_locked=false, ist "Gebraucht/Used" nicht erlaubt (auf NEU normalisieren).',
    '- Wenn das Datenblatt nicht eBay-ready ist, musst du es reparieren (fehlende Felder ergänzen, Mindestlängen erfüllen).',
    qualityIssues && qualityIssues.length
      ? `Quality-Issues (müssen behoben werden): ${qualityIssues.join(', ')}`
      : null,
    webEvidence ? 'WEB-EVIDENZ (nur wenn enthalten):\n' + (typeof webEvidence === 'string' ? webEvidence : JSON.stringify(webEvidence, null, 2)) : null,
    'Rückgabe ausschließlich gemäß JSON Schema.',
    'Vorliegender Datensatz:',
    JSON.stringify(snapshot, null, 2),
  ].filter(Boolean).join('\n\n');
}

function applyReviewResult(product, review) {
  if (!product || !review) return;
  product.identification = product.identification || {};
  product.details = product.details || {};
  product.details.identifiers =
    product.details.identifiers && typeof product.details.identifiers === 'object' ? product.details.identifiers : {};
  product.details.gpsr =
    product.details.gpsr && typeof product.details.gpsr === 'object' ? product.details.gpsr : {};

  // Preserve K-Typ if it already exists but the review output omits it.
  // The datasheet review currently replaces the whole attributes map, so without this,
  // a manually curated K-Typ could be wiped by the Improve job.
  const existingAttrs =
    product.details.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};
  const existingKTypKey = Object.keys(existingAttrs).find((k) => {
    const lower = String(k || '').trim().toLowerCase();
    return lower === 'k-typ' || lower === 'ktyp' || lower === 'k typ';
  });
  const existingKTyp =
    existingKTypKey && existingAttrs[existingKTypKey] != null
      ? String(existingAttrs[existingKTypKey]).trim()
      : '';

  if (typeof review.title === 'string' && review.title.trim().length >= 10) {
    product.identification.name = coerceTitleToPolicy(product, review.title, { minLen: 65, maxLen: 80, softMaxLen: 75 });
  }
  if (typeof review.short_description === 'string' && review.short_description.trim().length > 0) {
    const cleanedDescription = sanitizeListingText(review.short_description);
    if (cleanedDescription) {
      product.details.short_description = cleanedDescription;
    }
  }
  if (Array.isArray(review.highlights) && review.highlights.length) {
    product.details.key_features = sanitizeKeyFeatures(review.highlights);
  }
  if (Array.isArray(review.attributes) && review.attributes.length) {
    // Deduplicate attribute keys robustly (case/whitespace) and keep the most informative value.
    const attrsByNorm = new Map();
    const normalizeKey = (key) => String(key || '').replace(/\s+/g, ' ').trim();
    const normKey = (key) => normalizeKey(key).toLowerCase();
    const valueQuality = (value) => {
      const v = String(value || '').trim();
      return v.length;
    };

    review.attributes.forEach((entry) => {
      const key = normalizeKey(entry?.key);
      const value = String(entry?.value || '').trim();
      if (!key || !value) return;
      const nk = normKey(key);
      const existing = attrsByNorm.get(nk);
      if (!existing) {
        attrsByNorm.set(nk, { key, value });
        return;
      }
      // Keep longer/more informative value; preserve the first display key.
      if (valueQuality(value) > valueQuality(existing.value)) {
        attrsByNorm.set(nk, { key: existing.key || key, value });
      }
    });

    const attrs = {};
    for (const { key, value } of attrsByNorm.values()) {
      attrs[key] = value;
    }

    const hasKTyp = Object.keys(attrs).some((k) => {
      const lower = String(k || '').trim().toLowerCase();
      return lower === 'k-typ' || lower === 'ktyp' || lower === 'k typ';
    });
    if (!hasKTyp && existingKTyp) {
      attrs['K-Typ'] = existingKTyp;
    }

    product.details.attributes = sanitizeAttributesMap(attrs);
  }

  // Optional identifiers update (only when non-empty)
  if (review.identifiers && typeof review.identifiers === 'object') {
    const next = {};
    ['mpn', 'ean', 'gtin', 'upc'].forEach((k) => {
      const v = typeof review.identifiers[k] === 'string' ? review.identifiers[k].trim() : '';
      if (v) next[k] = v;
    });
    if (Object.keys(next).length) {
      Object.assign(product.details.identifiers, next);
    }
  }

  // Optional GPSR update (only when non-empty)
  if (review.gpsr && typeof review.gpsr === 'object') {
    const next = {};
    [
      'entity_country',
      'manufacturer_name',
      'manufacturer_address',
      'manufacturer_city',
      'manufacturer_postalcode',
      'manufacturer_state_province',
      'email',
      'manufacturer_phone',
      'url',
    ].forEach((k) => {
      const v = typeof review.gpsr[k] === 'string' ? review.gpsr[k].trim() : '';
      if (v) next[k] = v;
    });
    if (Object.keys(next).length) {
      Object.assign(product.details.gpsr, next);
    }
  }
  if (Array.isArray(review.warnings) && review.warnings.length) {
    const cleaned = Array.from(
      new Set(review.warnings.map((warn) => warn.replace(/\s+/g, ' ').trim()).filter(Boolean))
    );
    if (cleaned.length) {
      product.notes = product.notes || {};
      product.notes.warnings = Array.from(
        new Set([...(product.notes.warnings || []), ...cleaned])
      );
    }
  }

  // Final strict rulebook pass (no best-effort):
  // If the LLM output caused conflicts (e.g., semantic duplicate attributes or invalid highlights),
  // treat as an error so it cannot be propagated to saves/sync.
  const strict = normalizeProductStrict(product, { source: 'enrichment.applyReviewResult' });
  if (!strict.ok) {
    throw new Error(`LLM_RULEBOOK_VIOLATION: ${strict.issues.join('; ')}`);
  }
  Object.assign(product, strict.product);
}

async function runDatasheetReview(
  products = [],
  {
    locale = 'de-DE',
    webEvidence = null,
    qualityIssuesById = null,
    marketplaceEvidence = false,
    llmScopeId = null,
  } = {}
) {
  if (!Array.isArray(products) || !products.length) return;
  // Use Thinking model for deep quality assurance
  const reviewModel = resolveModel(null, 'REVIEW_MODEL', 'gemini-2.5-flash');

  const client = await getGeminiClient();
  const model = client.getGenerativeModel({ model: reviewModel });

  // Optional admin-managed prompt/rules overrides (Identify vs Improve can diverge).
  let llmConfig = null;
  try {
    const { getActiveLlmConfig } = require('../lib/llm-config');
    if (llmScopeId) {
      llmConfig = await getActiveLlmConfig(String(llmScopeId));
    }
  } catch {
    llmConfig = null;
  }

  const stripMarkdownFencesKeepContent = (text = '') => {
    return String(text)
      .replace(/```(?:json|javascript)?\s*/gi, '')
      .replace(/```/g, '')
      .trim();
  };

  const extractJsonPayload = (text = '') => {
    const s = stripMarkdownFencesKeepContent(text);
    const firstObj = s.indexOf('{');
    const firstArr = s.indexOf('[');
    if (firstObj === -1 && firstArr === -1) return s.trim();
    let start = -1;
    let open = '';
    let close = '';
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
    return s.slice(start).trim();
  };

  const safeString = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
  const pickBestBarcode = (product) => {
    const candidates = []
      .concat(Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : [])
      .concat(Array.isArray(product?.barcodes) ? product.barcodes : [])
      .concat([
        product?.details?.identifiers?.ean,
        product?.details?.identifiers?.gtin,
        product?.details?.identifiers?.upc,
        product?.identification?.ean,
        product?.identification?.gtin,
      ])
      .filter(Boolean)
      .map((c) => normalizeDigits(String(c || '')))
      .filter((c) => [8, 12, 13, 14].includes(c.length) && isValidGtin(c));
    return candidates[0] || '';
  };

  const pickMpn = (product) => {
    const attrs =
      product?.details?.attributes && typeof product.details.attributes === 'object'
        ? product.details.attributes
        : {};
    return (
      safeString(attrs?.Herstellernummer) ||
      safeString(product?.details?.identifiers?.mpn) ||
      safeString(attrs?.MPN) ||
      ''
    );
  };

  const pickProductType = (product) => {
    const attrs =
      product?.details?.attributes && typeof product.details.attributes === 'object'
        ? product.details.attributes
        : {};
    return safeString(attrs?.Produktart || attrs?.Produkttyp || attrs?.Artikeltyp || '');
  };

  const buildMarketplaceQuery = (product) => {
    const barcode = pickBestBarcode(product);
    if (barcode) return barcode;
    const brand = safeString(product?.identification?.brand);
    const mpn = pickMpn(product);
    const type = pickProductType(product);
    const title = safeString(product?.identification?.name);
    const parts = [];
    if (brand) parts.push(brand);
    if (type) parts.push(type);
    if (mpn) parts.push(mpn);
    const q = safeString(parts.join(' ')) || title || brand || mpn || '';
    return safeString(q).slice(0, 140);
  };

  const fetchSerpSummary = async (engine, params, limit = 5) => {
    // Prefer BrightData-backed search (via evidence-provider) to avoid SerpAPI dependency in Identify/Review.
    // Fallback to SerpAPI only if configured and the engine supports it.
    const engineLower = String(engine || '').toLowerCase();
    const locale = 'de-DE';
    const buildQuery = () => {
      if (engineLower === 'google') return String(params?.q || '').trim();
      if (engineLower === 'google_shopping') return String(params?.q || '').trim() + ' site:shopping.google.com';
      if (engineLower === 'ebay') return String(params?._nkw || '').trim() + ' site:ebay.de';
      if (engineLower === 'amazon') return String(params?.k || '').trim() + ' site:amazon.de';
      // Default: try a generic q param
      return String(params?.q || params?._nkw || params?.k || '').trim();
    };
    const q = buildQuery().trim();
    if (!q) return { engine, ok: false, summary: [], error: 'query_empty' };

    try {
      const web = await searchEvidence(q, { limit: Math.max(limit, 5), locale });
      const summary = Array.isArray(web?.results)
        ? web.results.slice(0, limit).map((r) => ({
            title: r?.title || '',
            source: engineLower,
            price: null,
            shipping: null,
            url: r?.url || '',
            snippet: r?.snippet || '',
          }))
        : [];
      if (summary.length) {
        return { engine, ok: true, summary };
      }
    } catch (e) {
      // continue to serpapi fallback
    }

    try {
      const raw = await callSerpApi(engine, params);
      const summary = summarizeSerpEntries(engine, raw, limit);
      return { engine, ok: true, summary };
    } catch (error) {
      return { engine, ok: false, summary: [], error: error?.message || String(error) };
    }
  };

  for (const product of products) {
    if (!product) continue;
    try {
      const generationConfig = {
        temperature: 0.2, // Low temperature for consistent reasoning
        topP: 0.95,
        topK: 64,
        responseMimeType: "application/json",
        responseSchema: cleanSchemaForGemini(DATASHEET_REVIEW_SCHEMA)
      };

      // Optional: attach marketplace evidence (eBay/Amazon/Kaufland/Shopping) so the LLM can validate plausibility
      // and fill missing specs based on sources, not guesses.
      let mergedEvidence = webEvidence;
      if (marketplaceEvidence) {
        const query = buildMarketplaceQuery(product);
        const barcode = pickBestBarcode(product);
        if (query) {
          // At least 5 marketplace sources (user requirement): eBay, Amazon, Google Shopping,
          // plus targeted site searches for Kaufland, hood.de and idealo.de.
          const [ebay, amazon, shopping, kaufland, hood, idealo] = await Promise.all([
            fetchSerpSummary('ebay', { _nkw: query }, 5),
            fetchSerpSummary('amazon', { k: query }, 5),
            fetchSerpSummary('google_shopping', { q: query, num: 10 }, 5),
            fetchSerpSummary('google', { q: `${query} site:kaufland.de`, num: 10 }, 5),
            fetchSerpSummary('google', { q: `${query} site:hood.de`, num: 10 }, 5),
            fetchSerpSummary('google', { q: `${query} site:idealo.de`, num: 10 }, 5),
          ]);
          const marketplace = {
            query,
            barcode: barcode || null,
            engines: {
              ebay: ebay.summary,
              amazon: amazon.summary,
              google_shopping: shopping.summary,
              kaufland: kaufland.summary,
              hood: hood.summary,
              idealo: idealo.summary,
            },
            errors: {
              ebay: ebay.ok ? null : ebay.error,
              amazon: amazon.ok ? null : amazon.error,
              google_shopping: shopping.ok ? null : shopping.error,
              kaufland: kaufland.ok ? null : kaufland.error,
              hood: hood.ok ? null : hood.error,
              idealo: idealo.ok ? null : idealo.error,
            },
          };
          mergedEvidence =
            webEvidence && typeof webEvidence === 'object' && !Array.isArray(webEvidence)
              ? { ...webEvidence, marketplace }
              : { raw: webEvidence || null, marketplace };
        }
      }

      const result = await model.generateContent({
        contents: [{
          role: "user",
          parts: [{
            text: buildReviewPrompt(product, locale, {
              webEvidence: mergedEvidence,
              qualityIssues: qualityIssuesById && product?.id ? (qualityIssuesById[product.id] || []) : [],
              llmOverrides: llmConfig
                ? {
                    promptText: llmConfig.promptText,
                    rulesText: llmConfig.rulesText,
                    promptMode: llmConfig.promptMode,
                    rulesMode: llmConfig.rulesMode,
                  }
                : null,
            })
          }]
        }],
        generationConfig
      });

      // @google/generative-ai can return multi-part text. Concatenate parts (no separators)
      // to avoid truncated JSON payloads.
      const resp = result?.response;
      const candidates = Array.isArray(resp?.candidates) ? resp.candidates : [];
      const parts = candidates[0]?.content?.parts || [];
      const textParts = Array.isArray(parts)
        ? parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).filter((t) => t && t.trim().length > 0)
        : [];
      const rawText = (textParts.join('') || (typeof resp?.text === 'function' ? resp.text() : '') || '').trim();
      const jsonPayload = extractJsonPayload(rawText);
      const review = JSON.parse(jsonPayload);
      applyReviewResult(product, review);
    } catch (error) {
      console.warn(
        `Datasheet review failed for product ${product?.id || 'unknown'}:`,
        error?.message || error
      );
    }
  }
}

function containsPackagingReference(text = '') {
  return /(etikett|karton|verpackung|sichtbar)/i.test(text || '');
}

function containsPriceReference(text = '') {
  return /(?:€|\beur\b|\bpreis(?:orientierung|empfehlung)?\b|\bprice\b)/i.test(text || '');
}

function stripPriceMentions(text = '') {
  // Backwards-compatible helper kept for logs/older call sites.
  // Central implementation lives in backend/lib/listing-sanitize.js
  return sanitizeListingText(text);
}

function looksLikePlaceholderTitle(text = '') {
  if (!text) return true;
  const trimmed = text.trim();
  if (trimmed.length < 35) return true; // Increased from 15 to 35 to catch "LED Hallenleuchte"
  if (/^(sku|item|model)?[-\w\s]+$/i.test(trimmed) && !/\s/.test(trimmed.replace(/[A-Za-z]+/g, ''))) {
    return true;
  }
  // "NEU" is a valid condition token and must NOT mark a title as placeholder.
  if (/unbekannt|unknown/i.test(trimmed)) return true;
  return false;
}

function needsMarketingRewrite(product) {
  const title = product?.identification?.name || '';
  const brand = product?.identification?.brand || '';
  const desc = product?.details?.short_description || '';
  const features = Array.isArray(product?.details?.key_features)
    ? product.details.key_features.filter(Boolean)
    : [];

  if (looksLikePlaceholderTitle(title)) return true;

  // If we know the brand, it MUST be in the title
  if (brand && brand.length > 2 && !/unbekannt/i.test(brand)) {
    if (!title.toLowerCase().includes(brand.toLowerCase())) {
      return true;
    }
  }

  if (desc.trim().length < 300 || containsPackagingReference(desc) || containsPriceReference(desc)) return true;
  if (features.length < 5) return true;
  if (features.some((item) => containsPackagingReference(item))) return true;
  return false;
}

function buildMarketingPrompt(product, locale = 'de-DE') {
  const brand = product?.identification?.brand || 'unbekannte Marke';
  const name = product?.identification?.name || '';
  const category = product?.identification?.category || '';
  const description = product?.details?.short_description || '';
  const features = Array.isArray(product?.details?.key_features)
    ? product.details.key_features.join('; ')
    : '';
  const attributes = collectAttributePairs(product);

  const parts = [
    `Schreibe alle Texte in ${locale} und im Stil eines professionellen Marketplace-Listings.`,
    `Produktname bisher: ${name || '–'}`,
    `Marke: ${brand}`,
    `Kategorie: ${category}`,
    `Vorhandene Beschreibung: ${description || 'keine'}`,
    `Features: ${features || 'keine'}`,
  ];

  if (attributes.length) {
    parts.push(`Attribute: ${attributes.join(', ')}`);
  }

  parts.push(
    `Anforderungen:`,
    buildCommonPolicyText({ locale, allowWebEvidence: false }),
    `- Kurzbeschreibung: 3 Absätze à 2 Sätze, klar & faktenbasiert. Keine erfundenen Versand-/Service-Versprechen.`,
    `- Highlights: 5–7 Bullets, je Bullet ca. 70–120 Zeichen (je Kategorie) und im Format "[Nutzen] – [konkrete Eigenschaft/Spec]" (Dash/En-Dash mit Leerzeichen). Faktenbasiert (keine erfundenen Versandzeiten, keine Preis-/Rabattaussagen).`,
    `Gib das Ergebnis als JSON mit { "title": "...", "description": "...", "highlights": ["...", ...] } zurück.`
  );

  return parts.join('\n');
}

function parseMarketingJson(response) {
  const text = (response.output_text || '').trim();
  if (!text) {
    throw new Error('Marketing rewrite response missing output_text');
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Marketing rewrite response invalid JSON: ${error.message}`);
  }
  if (!validateMarketingCopy(payload)) {
    const message =
      validateMarketingCopy.errors
        ?.map((err) => `${err.instancePath || 'value'} ${err.message}`)
        .join('; ') || 'unknown validation error';
    throw new Error(`Marketing copy failed schema validation: ${message}`);
  }
  return payload;
}

async function ensureMarketingCopy(products = [], locale = 'de-DE') {
  if (!Array.isArray(products) || !products.length) return;
  // Use experimental high-quality model for Marketing
  const targetModelName = resolveModel(null, 'MARKETING_MODEL', 'gemini-2.5-flash');
  const client = await getGeminiClient();
  const model = client.getGenerativeModel({ model: targetModelName });

  for (const product of products) {
    if (needsMarketingRewrite(product)) {
      try {
        const generationConfig = {
          temperature: 0.7, // Higher creativity for marketing
          topP: 0.95,
          topK: 64,
          responseMimeType: "application/json",
          responseSchema: cleanSchemaForGemini(marketingCopySchema)
        };

        const result = await model.generateContent({
          contents: [{ role: "user", parts: [{ text: buildMarketingPrompt(product, locale) }] }],
          generationConfig
        });

        const rewrite = JSON.parse(result.response.text());

        product.identification = {
          ...product.identification,
          name: coerceTitleToPolicy(product, rewrite.title, { minLen: 65, maxLen: 80, softMaxLen: 75 }),
        };
        product.details = product.details || {};
        const cleanedDescription = sanitizeListingText(rewrite.description || '');
        if (cleanedDescription) {
          product.details.short_description = cleanedDescription;
        }
        product.details.key_features = sanitizeKeyFeatures(rewrite.highlights.map((item) => item.trim()));
      } catch (error) {
        console.warn(
          `Marketing rewrite failed for ${product?.id || product?.identification?.name || 'unknown product'}:`,
          error.message
        );
      }
    }
    product.details = product.details || {};
    product.details.key_features = sanitizeKeyFeatures(product.details.key_features || []);
  }
}

function queryMatchesProduct(query, product, keywords = null) {
  if (!query) return false;
  const normalizedQuery = query.toLowerCase();
  const searchKeywords = keywords || collectProductKeywords(product);
  return searchKeywords.some((keyword) => {
    const token = keyword.slice(0, Math.min(keyword.length, 8));
    return token && normalizedQuery.includes(token);
  });
}

const USED_PRICE_HINT_REGEX =
  /\b(gebraucht|used|refurb|refurbished|renewed|b-ware|pre-owned|second hand|open box)\b/i;

const ACCESSORY_HINT_REGEX =
  /\b(zubeh[öo]r|accessor(?:y|ies)|ersatz|replacement|spare|teil(e)?|adapter|kabel|kabelsatz|netzteil|ladeger[aä]t|halter|halterung|cover|case|h[üu]lle)\b/i;

function normalizeMatchText(raw = '') {
  return String(raw || '')
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/[\u2010-\u2015-]/g, ' ')
    .replace(/[^\p{L}\p{N}\s.×x/]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNumLoose(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const cleaned = s.replace(/\s+/g, '').replace(',', '.').replace(/[^0-9.\-]/g, '');
  const v = parseFloat(cleaned);
  return Number.isFinite(v) ? v : null;
}

function toMm(value, unit) {
  const v = typeof value === 'number' ? value : parseNumLoose(value);
  if (!Number.isFinite(v)) return null;
  const u = String(unit || '').toLowerCase();
  if (u === 'mm') return v;
  if (u === 'cm') return v * 10;
  if (u === 'm') return v * 1000;
  return null;
}

function extractSpecsFromText(rawText = '') {
  const text = normalizeMatchText(rawText);
  const out = {
    watt: null,
    volt: null,
    weight_g: null,
    dims_mm: null, // sorted array [a,b,c?] in mm
    diameter_mm: null,
    color: null,
    shape: null,
  };

  // watt / volt
  const wattM = text.match(/\b(\d+(?:[.,]\d+)?)\s*w\b/i);
  if (wattM?.[1]) {
    const v = parseNumLoose(wattM[1]);
    if (Number.isFinite(v) && v > 0 && v < 50000) out.watt = v;
  }
  const voltM = text.match(/\b(\d+(?:[.,]\d+)?)\s*v\b/i);
  if (voltM?.[1]) {
    const v = parseNumLoose(voltM[1]);
    if (Number.isFinite(v) && v > 0 && v < 2000) out.volt = v;
  }

  // weight
  const wKg = text.match(/\b(\d+(?:[.,]\d+)?)\s*kg\b/i);
  const wG = text.match(/\b(\d+(?:[.,]\d+)?)\s*g\b/i);
  if (wKg?.[1]) {
    const v = parseNumLoose(wKg[1]);
    if (Number.isFinite(v) && v > 0 && v < 5000) out.weight_g = v * 1000;
  } else if (wG?.[1]) {
    const v = parseNumLoose(wG[1]);
    if (Number.isFinite(v) && v > 0 && v < 5_000_000) out.weight_g = v;
  }

  // diameter
  const dia = text.match(/\b(?:ø|durchmesser|diameter)\s*(\d+(?:[.,]\d+)?)\s*(mm|cm|m)\b/i);
  if (dia?.[1] && dia?.[2]) {
    const mm = toMm(dia[1], dia[2]);
    if (Number.isFinite(mm) && mm > 0) out.diameter_mm = mm;
  }

  // dimensions like 120x60x10 cm (or mm)
  const dim =
    text.match(/\b(\d+(?:[.,]\d+)?)\s*(mm|cm|m)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(mm|cm|m)(?:\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(mm|cm|m))?\b/i);
  if (dim?.[1] && dim?.[2] && dim?.[3] && dim?.[4]) {
    const a = toMm(dim[1], dim[2]);
    const b = toMm(dim[3], dim[4]);
    const c = dim?.[5] && dim?.[6] ? toMm(dim[5], dim[6]) : null;
    const arr = [a, b, c].filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);
    if (arr.length >= 2) out.dims_mm = arr.sort((x, y) => x - y);
  }

  // color (basic)
  const COLORS = [
    { canon: 'black', keys: ['schwarz', 'black'] },
    { canon: 'white', keys: ['weiss', 'weiß', 'white'] },
    { canon: 'grey', keys: ['grau', 'gray', 'grey', 'silber', 'silver'] },
    { canon: 'red', keys: ['rot', 'red'] },
    { canon: 'blue', keys: ['blau', 'blue'] },
    { canon: 'green', keys: ['grun', 'grün', 'green'] },
    { canon: 'yellow', keys: ['gelb', 'yellow'] },
    { canon: 'brown', keys: ['braun', 'brown'] },
    { canon: 'orange', keys: ['orange'] },
    { canon: 'pink', keys: ['pink', 'rosa'] },
    { canon: 'transparent', keys: ['transparent', 'klar'] },
  ];
  for (const c of COLORS) {
    if (c.keys.some((k) => text.includes(k))) {
      out.color = c.canon;
      break;
    }
  }

  // shape (basic)
  const SHAPES = [
    { canon: 'round', keys: ['rund', 'round', 'kreis'] },
    { canon: 'square', keys: ['quadrat', 'square'] },
    { canon: 'rect', keys: ['rechteck', 'rectangular', 'rectangle'] },
    { canon: 'oval', keys: ['oval'] },
  ];
  for (const s of SHAPES) {
    if (s.keys.some((k) => text.includes(k))) {
      out.shape = s.canon;
      break;
    }
  }

  return out;
}

function extractProductSpecs(product) {
  const attrs = product?.details?.attributes;
  let blob = '';
  if (attrs && typeof attrs === 'object') {
    if (Array.isArray(attrs)) {
      blob = attrs.map((e) => `${e?.key || ''}: ${e?.value || ''}`).join(' ');
    } else {
      blob = Object.entries(attrs)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' ');
    }
  }
  const title = safeString(product?.identification?.name);
  const brand = safeString(product?.identification?.brand);
  const idParts = [
    safeString(product?.details?.identifiers?.mpn),
    safeString(product?.details?.identifiers?.ean),
    safeString(product?.details?.identifiers?.gtin),
    safeString(product?.details?.identifiers?.upc),
  ].filter(Boolean);
  return extractSpecsFromText([brand, title, ...idParts, blob].filter(Boolean).join(' '));
}

function relDiff(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return Math.abs(a - b) / Math.max(a, b);
}

function scoreSpecSimilarity(productSpecs, offerText) {
  const ps = productSpecs || {};
  const os = extractSpecsFromText(offerText || '');
  let score = 0;

  // watt
  if (Number.isFinite(ps.watt) && Number.isFinite(os.watt)) {
    const d = relDiff(ps.watt, os.watt);
    if (d != null) score += d <= 0.05 ? 10 : d <= 0.12 ? 6 : -8;
  }

  // volt
  if (Number.isFinite(ps.volt) && Number.isFinite(os.volt)) {
    const d = relDiff(ps.volt, os.volt);
    if (d != null) score += d <= 0.05 ? 8 : d <= 0.12 ? 4 : -6;
  }

  // weight
  if (Number.isFinite(ps.weight_g) && Number.isFinite(os.weight_g)) {
    const d = relDiff(ps.weight_g, os.weight_g);
    if (d != null) score += d <= 0.10 ? 5 : d <= 0.20 ? 2 : -3;
  }

  // diameter
  if (Number.isFinite(ps.diameter_mm) && Number.isFinite(os.diameter_mm)) {
    const d = relDiff(ps.diameter_mm, os.diameter_mm);
    if (d != null) score += d <= 0.08 ? 6 : d <= 0.18 ? 3 : -4;
  }

  // dimensions (compare as sorted sets)
  if (Array.isArray(ps.dims_mm) && Array.isArray(os.dims_mm) && ps.dims_mm.length >= 2 && os.dims_mm.length >= 2) {
    const a = ps.dims_mm.slice(0, 3).sort((x, y) => x - y);
    const b = os.dims_mm.slice(0, 3).sort((x, y) => x - y);
    const n = Math.min(a.length, b.length);
    let acc = 0;
    let okCount = 0;
    for (let i = 0; i < n; i++) {
      const d = relDiff(a[i], b[i]);
      if (d == null) continue;
      acc += d;
      okCount += 1;
    }
    if (okCount >= 2) {
      const avg = acc / okCount;
      score += avg <= 0.06 ? 8 : avg <= 0.16 ? 4 : -6;
    }
  }

  // color / shape
  if (ps.color && os.color && ps.color === os.color) score += 3;
  if (ps.shape && os.shape && ps.shape === os.shape) score += 3;

  return score;
}

function collectPriceCandidates(product, serpTrace = [], existingKeywords = null) {
  if (!Array.isArray(serpTrace) || !serpTrace.length) return [];
  const keywords = existingKeywords || collectProductKeywords(product);
  const productSpecs = extractProductSpecs(product);

  const candidates = [];
  const brand = (product?.identification?.brand || '').toString().trim().toLowerCase();
  const mpn =
    (product?.details?.identifiers?.mpn ||
      product?.details?.attributes?.Herstellernummer ||
      product?.details?.attributes?.mpn ||
      '')
      .toString()
      .trim()
      .toLowerCase();
  const barcodeCandidates = []
    .concat(Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : [])
    .concat([
      product?.details?.identifiers?.ean,
      product?.details?.identifiers?.gtin,
      product?.details?.identifiers?.upc,
    ])
    .filter(Boolean)
    .map((v) => String(v).trim())
    .filter((v) => v.length >= 8);

  for (const entry of serpTrace) {
    if (!entry || !PRICE_TRACE_ENGINES.has(entry.engine)) continue;
    const queryIsRelevant = keywords.length ? queryMatchesProduct(entry.query || '', product, keywords) : false;
    for (const item of entry.summary || []) {
      const parsedPrice = normalizePriceString(item.price);
      if (!parsedPrice) continue;
      // Keep EUR only (SerpAPI may return mixed locales). If missing currency, we treat as EUR (DEFAULT).
      if (parsedPrice.currency && parsedPrice.currency !== DEFAULT_PRICE_CURRENCY) continue;
      const textBlob = normalizeMatchText([item.title, item.snippet].filter(Boolean).join(' '));
      // User requirement: prefer new price (Neuware) → drop obvious used/refurbished offers
      if (USED_PRICE_HINT_REGEX.test(textBlob)) continue;
      // Avoid obvious "accessory-only" results when we look for the product itself.
      if (ACCESSORY_HINT_REGEX.test(textBlob)) continue;

      const matches = keywords.length ? keywords.filter((keyword) => keyword && textBlob.includes(keyword)).length : 0;
      const hasBrand = brand && textBlob.includes(brand);
      const hasMpn = mpn && mpn.length >= 3 && textBlob.includes(mpn);
      const hasBarcode = barcodeCandidates.some((code) => textBlob.includes(code));

      const specScore = scoreSpecSimilarity(productSpecs, textBlob);
      const hasStrongId = hasMpn || hasBarcode;
      const okExact =
        (keywords.length &&
          ((queryIsRelevant && (matches >= 1 || hasBrand || hasStrongId)) || matches >= 2 || hasStrongId)) ||
        hasStrongId;
      // Fallback requirement: if exact product not found, accept highly similar offers by specs
      const okSimilar = !okExact && specScore >= 10;
      if (!okExact && !okSimilar) continue;

      candidates.push({
        amount: parsedPrice.amount,
        currency: parsedPrice.currency,
        source: item.source || entry.engine,
        url: item.url || '',
        engine: entry.engine,
        title: item.title || '',
        snippet: item.snippet || '',
        match_count: matches,
        has_brand: hasBrand,
        has_mpn: hasMpn,
        has_barcode: hasBarcode,
        spec_score: specScore,
        match_tier: okExact ? 'exact' : 'similar',
      });
    }
  }
  return candidates;
}

function median(values = []) {
  const nums = values.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function scorePriceCandidate(c) {
  let score = 0;
  score += Math.min(5, c.match_count || 0) * 5;
  if (c.has_brand) score += 12;
  if (c.has_mpn) score += 18;
  if (c.has_barcode) score += 22;
   if (typeof c.spec_score === 'number' && Number.isFinite(c.spec_score)) score += c.spec_score;
  if (c.engine === 'google_shopping') score += 4;
  if (c.engine === 'bing_shopping') score += 2;
  if (!c.url) score -= 3;
  return score;
}

function pickBestPriceCandidate(candidates = []) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const enriched = candidates
    // Never accept micro/placeholder prices (e.g. 0.01) as real offers.
    .filter((c) => typeof c.amount === 'number' && Number.isFinite(c.amount) && c.amount >= 1)
    .map((c) => ({ ...c, score: scorePriceCandidate(c) }));

  if (!enriched.length) return null;

  const exact = enriched.filter((c) => c.match_tier === 'exact' || c.has_mpn || c.has_barcode || (c.has_brand && (c.match_count || 0) >= 2));
  const pool = exact.length ? exact : enriched;

  const maxScore = Math.max(...pool.map((c) => c.score || 0));
  const top = pool.filter((c) => (c.score || 0) >= Math.max(0, maxScore - 10));

  // Outlier filter based on median of top matches (when enough data)
  const amounts = top.map((c) => c.amount);
  const med = median(amounts);
  let filtered = top;
  if (med && amounts.length >= 3) {
    const low = Math.max(1, med * 0.35);
    const high = med * 3.0;
    filtered = top.filter((c) => c.amount >= low && c.amount <= high);
    if (!filtered.length) {
      filtered = top; // fallback: don't drop everything
    }
  }

  // If we only have a single weak match and it's very high, fail-safe: don't set a price.
  if (filtered.length === 1) {
    const only = filtered[0];
    const weak = (only.score || 0) < 12 && !only.has_mpn && !only.has_barcode;
    if (weak && only.amount >= 300) {
      return null;
    }
  }

  // Safety: do NOT pick the cheapest offer. We want a robust "typical market price"
  // to avoid underpricing due to a single discounted/outlier listing.
  const target = median(filtered.map((c) => c.amount));
  if (typeof target === 'number' && Number.isFinite(target)) {
    filtered.sort(
      (a, b) =>
        Math.abs(a.amount - target) - Math.abs(b.amount - target) ||
        (b.score || 0) - (a.score || 0) ||
        a.amount - b.amount
    );
    return filtered[0] || null;
  }

  // Fallback: highest quality match.
  filtered.sort((a, b) => (b.score || 0) - (a.score || 0) || a.amount - b.amount);
  return filtered[0] || null;
}

async function fetchPriceTrace(product, keywords) {
  const condensedKeywords = (keywords || collectProductKeywords(product)).slice(0, 4);
  const query = condensedKeywords.join(' ').trim();
  if (!query) return null;
  const attempts = [
    { engine: 'google_shopping', params: { q: query, num: 20 } },
    { engine: 'bing_shopping', params: { q: query, count: 20 } },
    { engine: 'amazon', params: { k: query, page: 1 } },
  ];

  for (const attempt of attempts) {
    try {
      const raw = await callSerpApi(attempt.engine, attempt.params);
      const summary = summarizeSerpEntries(attempt.engine, raw, 15);
      if (!summary.length) continue;
      return {
        engine: attempt.engine,
        query,
        summary,
        params: attempt.params,
        error: null,
        fallback: true,
      };
    } catch (error) {
      console.warn(`Fallback ${attempt.engine} lookup fehlgeschlagen:`, error.message);
    }
  }
  return null;
}

async function ensurePriceCoverage(products = [], serpTrace = [], options = {}) {
  // Price enrichment requires SerpAPI in this codebase.
  // Make it opt-in and skip entirely when SerpAPI is disabled (default in BrightData-only setups).
  const SERPAPI_ENABLED = (process.env.SERPAPI_ENABLED || '').toString().trim().toLowerCase() === 'true';
  const PRICE_ENRICH =
    (process.env.PRICE_ENRICHMENT_ENABLED || '').toString().trim().toLowerCase() === 'true';
  if (!SERPAPI_ENABLED || !PRICE_ENRICH) return;
  if (!Array.isArray(products) || !products.length) return;

  const force = Boolean(options?.force);
  const maxAgeDays =
    options?.maxAgeDays != null && String(options.maxAgeDays).trim() !== ''
      ? Math.max(0, Number(options.maxAgeDays) || 0)
      : process.env.PRICE_MAX_AGE_DAYS != null && String(process.env.PRICE_MAX_AGE_DAYS).trim() !== ''
        ? Math.max(0, Number(process.env.PRICE_MAX_AGE_DAYS) || 0)
        : 0;
  const daysSinceIso = (iso) => {
    if (!iso) return Infinity;
    const t = Date.parse(String(iso));
    if (!Number.isFinite(t)) return Infinity;
    return (Date.now() - t) / (1000 * 60 * 60 * 24);
  };

  for (const product of products) {
    const lowest = product?.details?.pricing?.lowest_price;
    const hasPrice =
      lowest &&
      typeof lowest.amount === 'number' &&
      Number.isFinite(lowest.amount) &&
      lowest.amount > 0 &&
      Array.isArray(lowest.sources) &&
      lowest.sources.length > 0;
    const stale = maxAgeDays > 0 && lowest && daysSinceIso(lowest.last_checked_iso) > maxAgeDays;
    if (!force && hasPrice && !stale) continue;

    // Deterministic query building (more robust than a single LLM-crafted query).
    const negativeTerms = '-gebraucht -used -refurb -refurbished -renewed -b-ware -openbox';
    const brand = (product?.identification?.brand || '').toString().trim();
    const title = (product?.identification?.name || '').toString().trim();
    const mpn =
      (product?.details?.identifiers?.mpn ||
        product?.details?.attributes?.Herstellernummer ||
        product?.details?.attributes?.mpn ||
        '')
        .toString()
        .trim();
    const barcodes = []
      .concat(Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : [])
      .concat([
        product?.details?.identifiers?.ean,
        product?.details?.identifiers?.gtin,
        product?.details?.identifiers?.upc,
      ])
      .filter(Boolean)
      .map((v) => String(v).trim())
      .filter((v) => v.length >= 8);

    const keywords = collectProductKeywords(product); // tokens for matching verification

    const queryCandidates = [];
    if (barcodes.length) queryCandidates.push(`${barcodes[0]} neu preis ${negativeTerms}`);
    if (brand && mpn) queryCandidates.push(`${brand} ${mpn} neu preis ${negativeTerms}`);
    if (brand && title) queryCandidates.push(`${brand} ${title} neu preis ${negativeTerms}`);
    if (title) queryCandidates.push(`${title} neu preis ${negativeTerms}`);
    // Keep it bounded to reduce SerpAPI cost.
    const queries = Array.from(new Set(queryCandidates.map((q) => q.replace(/\s+/g, ' ').trim()))).slice(0, 3);

    let candidates = collectPriceCandidates(product, serpTrace, keywords);
    if (!candidates.length) {
      for (const q of queries) {
      try {
          const raw = await callSerpApi('google_shopping', { q, num: 20 });
        const summary = summarizeSerpEntries('google_shopping', raw, 15);
          if (!summary.length) continue;
          const traceEntry = {
            engine: 'google_shopping',
            query: q,
            summary,
            params: { q, num: 20 },
            error: null,
            fallback: true,
          };
          serpTrace.push(traceEntry);
      } catch (err) {
          console.warn('Price search failed:', err.message);
          serpTrace.push({
            engine: 'google_shopping',
            query: q,
            summary: [],
            params: { q, num: 20 },
            error: err.message,
            fallback: true,
          });
        }
      }
      candidates = collectPriceCandidates(product, serpTrace, keywords);
    }

    const best = pickBestPriceCandidate(candidates);
    if (!best) {
      product.notes = product.notes || {};
      product.notes.warnings = Array.from(
        new Set([...(product.notes.warnings || []), 'Preis konnte nicht zuverlässig ermittelt werden – bitte prüfen.'])
      );
      continue;
    }

    const timestamp = new Date().toISOString();

    product.details = product.details || {};
    const existingPricing = product.details.pricing || {};
    const baseSources = Array.isArray(existingPricing?.lowest_price?.sources)
      ? existingPricing.lowest_price.sources.filter(Boolean)
      : [];

    // If we had to fall back to "similar by specs", mark it as low-confidence and warn.
    const pickedSimilar = best?.match_tier === 'similar' && !best?.has_mpn && !best?.has_barcode;
    if (pickedSimilar) {
      product.notes = product.notes || {};
      product.notes.warnings = Array.from(
        new Set([
          ...(product.notes.warnings || []),
          'Preis basiert auf ähnlichem Produkt (Specs-Match) – bitte prüfen.',
        ])
      );
    }

    product.details.pricing = {
      ...existingPricing,
      lowest_price: {
        amount: best.amount,
        currency: best.currency || DEFAULT_PRICE_CURRENCY,
        sources: [
          {
            name: best.source || 'SerpAPI',
            url: best.url || '',
            price: best.amount,
            shipping: null,
            checked_at: timestamp,
          },
          ...baseSources,
        ].slice(0, 5),
        last_checked_iso: timestamp,
      },
      price_confidence:
        typeof existingPricing.price_confidence === 'number' && existingPricing.price_confidence > 0
          ? existingPricing.price_confidence
          : pickedSimilar
            ? Math.min(0.55, Math.max(0.25, (best.score || 0) / 60))
            : Math.min(0.95, Math.max(0.45, Math.min(1, (best.score || 0) / 45) + candidates.length / 14)),
    };
  }
}

const SMART_IMAGE_RECOVERY_ENABLED = true;

async function runProductIdentification({
  files = [],
  barcodes = '',
  locale = 'de-DE',
  modelOverride = null,
  improveContext = null,
  skipExternalSearch = false,
  onProgress = null,
}) {
  if ((!files || files.length === 0) && !barcodes) {
    throw new Error('Bitte mindestens ein Bild oder einen Barcode bereitstellen.');
  }

  if (onProgress) await onProgress('identifying');

  const manualBarcodes = normalizeBarcodeList(parseBarcodes(barcodes));
  const ocrPayload = await extractOcrPayload(files);

  // WEB CONFIRM (strict): OCR barcodes are only accepted when confirmed by web evidence.
  // This prevents random OCR numbers (dates/serials) from poisoning identifiers.
  const WEB_CONFIRM = (process.env.BARCODE_WEB_CONFIRM || 'true').toString().toLowerCase() !== 'false';
  const productHints = {
    brand: '',
    mpn: '',
    title: '',
  };
  if (improveContext && typeof improveContext === 'string') {
    // best-effort: improveContext includes "Aktueller Titel"/"Marke"
    const brandLine = improveContext.match(/Marke:\s*(.+)/i);
    const titleLine = improveContext.match(/Aktueller Titel:\s*(.+)/i);
    if (brandLine?.[1]) productHints.brand = String(brandLine[1]).trim();
    if (titleLine?.[1]) productHints.title = String(titleLine[1]).trim();
  }

  let ocrBarcodes = Array.isArray(ocrPayload?.barcodes) ? ocrPayload.barcodes : [];
  let webConfirmTrace = null;
  if (WEB_CONFIRM && !skipExternalSearch && ocrBarcodes.length) {
    if (onProgress) await onProgress('barcode_web_confirm');
    const { confirmed, trace } = await filterBarcodesByWebConfirm({
      barcodes: ocrBarcodes,
      brand: productHints.brand,
      mpn: productHints.mpn,
      title: productHints.title,
      locale,
      maxCandidates: parseInt(process.env.BARCODE_WEB_CONFIRM_MAX_CANDIDATES || '3', 10),
    });
    ocrBarcodes = confirmed;
    webConfirmTrace = trace;
  }

  const barcodeList = mergeBarcodeLists(manualBarcodes, ocrBarcodes || []);
  const { imageParts, hostedImages } = await prepareImages(files);

  // Gemini Multimodal Input Preparation
  const geminiParts = [];

  // 1. Add System Instructions (as text part first, or via systemInstruction if supported, but text part is safer for now)
  const systemPrompt = buildSystemPrompt(locale);
  geminiParts.push({ text: systemPrompt });

  // 2. Add Images (converted to inlineData)
  let validImageCount = 0;
  const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

  for (const file of files) {
    if (!file.buffer || file.buffer.length === 0) {
      console.warn('Skipping empty image buffer for Gemini input');
      continue;
    }

    // Strict MIME type check to prevent Gemini 400 errors
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      console.warn(`Skipping unsupported mimetype for Gemini input: ${file.mimetype} (Allowed: JPEG, PNG, WEBP, HEIC)`);
      continue;
    }

    // Double check base64 conversion safety?
    try {
      geminiParts.push(bufferToGenerativePart(file.buffer, file.mimetype));
      validImageCount++;
    } catch (err) {
      console.error(`Failed to convert image buffer to Gemini part: ${err.message}`);
    }
  }

  if (validImageCount === 0 && !barcodes) {
    // If we filtered out all images and have no barcodes, we can't reasonably identify.
    // But we will let it proceed (maybe text context is enough? unlikely for identification).
    // Warning meant for developer.
    console.warn('Warning: No valid images found for Gemini input after filtering.');
  }

  // 3. Add Context (Accessory Text)
  let userPrompt = buildUserPrompt({
    barcodeList,
    hostedImages,
    locale,
    fileCount: files.length,
    improveContext,
    ocrTextSnippets: ocrPayload.textSnippets || [],
    ocrNumericValues: ocrPayload.numericValues || [],
    webEvidence: webConfirmTrace ? JSON.stringify({ type: 'barcode_web_confirm', trace: webConfirmTrace }, null, 2) : null,
  });
  geminiParts.push({ text: userPrompt });

  // Helper to clean JSON schema for Gemini (remove invalid fields/types)
  function cleanSchemaForGemini(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(cleanSchemaForGemini);

    const cleaned = { ...schema };

    // Fix type arrays: type: ["string", "null"] -> type: "string"
    if (Array.isArray(cleaned.type)) {
      const validTypes = cleaned.type.filter(t => t !== 'null');
      cleaned.type = validTypes.length === 1 ? validTypes[0] : validTypes[0] || 'string';
    }

    // Recursively clean parameters/properties
    if (cleaned.properties) {
      const newProps = {};
      for (const [key, val] of Object.entries(cleaned.properties)) {
        newProps[key] = cleanSchemaForGemini(val);
      }
      cleaned.properties = newProps;
    }
    if (cleaned.items) {
      cleaned.items = cleanSchemaForGemini(cleaned.items);
    }

    // Remove keys invalid for Gemini schemas if present
    delete cleaned.additionalProperties;
    delete cleaned.default;
    delete cleaned.anyOf; // Gemini often struggles with anyOf in strict schemas, simplify if possible or leave if essential
    // Note: removing anyOf might break validation if the schema relies on it heavily. 
    // But product-schema.js uses anyOf specifically for value types which Gemini might accept as specific types.
    // Actually, Gemini supports `enum` well. `anyOf` for types is tricky.
    // For `value` property in attributeEntrySchema, it has anyOf: string, number, boolean, null.
    // Gemini prefers explicit types. Let's try to keeping anyOf but stripping nulls inside it?
    // Or better: relying on Gemini's loose JSON mode if strict schema fails? 
    // No, we are using `responseSchema` which triggers constrained decoding.

    return cleaned;
  }

  const client = await getGeminiClient();
  // Default model: stable high-throughput model (override via IDENTIFY_MODEL).
  const targetModelName = resolveModel(modelOverride, 'IDENTIFY_MODEL', 'gemini-2.5-flash');
  const model = client.getGenerativeModel({ model: targetModelName });

  const generationConfig = {
    temperature: 0.2,
    topP: 0.8,
    topK: 40,
    responseMimeType: "application/json",
    responseSchema: cleanSchemaForGemini(productBundleSchema)
  };

  let bundle;
  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts: geminiParts }],
      generationConfig,
    });

    const responseText = result.response.text();
    bundle = JSON.parse(responseText);
  } catch (error) {
    console.error("Gemini Identification Failed:", error);
    throw new Error(`Gemini Identification failed: ${error.message}`);
  }

  // If identification quality is poor and external search is allowed, run a second pass with WEB-EVIDENZ injected.
  if (!skipExternalSearch && bundle?.products?.some(isLowQualityIdentifyProduct)) {
    try {
      if (onProgress) await onProgress('web_enrich');
      const webEvidence = await prefetchWebEvidenceForIdentify({
        barcodeList,
        ocrTextSnippets: ocrPayload.textSnippets || [],
        locale,
      });
      if (webEvidence) {
        const secondParts = [];
        secondParts.push({ text: buildSystemPrompt(locale) });
        // reuse image parts from the first run (same files)
        for (const part of geminiParts) {
          if (part && part.inline_data) secondParts.push(part);
        }
        userPrompt = buildUserPrompt({
          barcodeList,
          hostedImages,
          locale,
          fileCount: files.length,
          improveContext,
          ocrTextSnippets: ocrPayload.textSnippets || [],
          ocrNumericValues: ocrPayload.numericValues || [],
          webEvidence,
        });
        secondParts.push({ text: userPrompt });
        const retry = await model.generateContent({
          contents: [{ role: 'user', parts: secondParts }],
          generationConfig,
        });
        const responseText = retry.response.text();
        bundle = JSON.parse(responseText);
      }
    } catch (err) {
      console.warn('[identify] web-enrich retry failed:', err?.message || err);
    }
  }

  // Pre-Validation Sanitization to handle AI artifacts
  if (bundle && Array.isArray(bundle.products)) {
    bundle.products = bundle.products.filter(p => p);
    for (const p of bundle.products) {
      if (!p.details) p.details = {};
      if (!p.details.pricing) p.details.pricing = {};
      if (!p.details.pricing.lowest_price) p.details.pricing.lowest_price = {};

      const lp = p.details.pricing.lowest_price;
      if (Array.isArray(lp.sources)) {
        // Remove sources with empty URLs (since schema now allows 0 length, but cleaner to remove)
        // Actually, we relaxed schema to allow empty string. But let's be safe and keep only "valid-looking" ones if possible, 
        // OR just ensure they meet the type `string`.
        // The error was "must NOT have fewer than 1 characters". Since we relaxed schema, it should pass.
        // But let's remove completely empty ones to be clean.
        lp.sources = lp.sources.filter(s => s && typeof s.url === 'string');
      } else {
        lp.sources = [];
      }

      // Ensure required fields for schema
      if (!lp.amount) lp.amount = 0;
      if (!lp.currency) lp.currency = 'EUR';
      if (!lp.last_checked_iso) lp.last_checked_iso = new Date().toISOString();

      if (!p.identification) p.identification = {};
      if (!p.identification.confidence) p.identification.confidence = 0.8;
    }
  }

  ensureSchema(bundle);
  normalizeBundle(bundle);
  attachReferenceImages(bundle.products, hostedImages);
  injectMissingBarcodes(bundle.products, barcodeList);

  // Smart Image Recovery (if no valid images found or only barcode/packaging) - DISABLED if skipExternalSearch is true
  if (SMART_IMAGE_RECOVERY_ENABLED && !skipExternalSearch) {
    await runSmartImageRecovery(bundle.products);
  }

  // SEO & Marketing Optimization (using Pro/Exp model for high quality text)
  await ensureMarketingCopy(bundle.products, locale);

  applyEbayTaxonomy(bundle);
  applyKauflandTaxonomy(bundle);
  await ensureCategories(bundle.products);

  // Pricing Coverage (using Thinking model for complex research if needed) - DISABLED if skipExternalSearch is true
  const serpTrace = [];
  if (!skipExternalSearch) {
    await ensurePriceCoverage(bundle.products, serpTrace);
  }

  // Final Review
  await runDatasheetReview(bundle.products, { locale });

  // Post-review repair pass (only for failing products).
  // Goal: make Identify strong enough so Improve isn't needed just to fill basic listing fields.
  const qualityById = {};
  const issuesById = {};
  const failing = [];
  for (const p of bundle.products || []) {
    const q = evaluateEbayReady(p);
    qualityById[p?.id || Math.random().toString(36)] = q;
    if (!q.ok) {
      failing.push(p);
      if (p?.id) issuesById[p.id] = q.issues;
    }
  }

  if (!skipExternalSearch && failing.length) {
    // Provide additional web evidence for the repair pass (based on OCR + any confirmed barcodes).
    let repairWebEvidence = null;
    try {
      repairWebEvidence = await prefetchWebEvidenceForIdentify({
        barcodeList,
        ocrTextSnippets: ocrPayload.textSnippets || [],
        locale,
      });
    } catch {
      repairWebEvidence = null;
    }

    await runDatasheetReview(failing, {
      locale,
      webEvidence: repairWebEvidence,
      qualityIssuesById: issuesById,
    });
  }

  return {
    bundle,
    serpTrace,
    modelUsed: targetModelName,
    qualityReport: (bundle.products || []).map((p) => {
      const q = evaluateEbayReady(p);
      return {
        id: p?.id,
        ok: q.ok,
        issues: q.issues,
        snapshot: q.snapshot,
      };
    }),
  };
}

// Helper for Smart Image Recovery
async function runSmartImageRecovery(products = []) {
  // This helper uses SerpAPI (google_images). Keep it hard opt-in.
  const SERPAPI_ENABLED = (process.env.SERPAPI_ENABLED || '').toString().trim().toLowerCase() === 'true';
  if (!SERPAPI_ENABLED) return;
  for (const product of products) {
    const features = product.details?.key_features || [];
    const isPackaging = features.some(f => containsPackagingReference(f));
    const hasImages = product.details?.images?.length > 0;

    if (!hasImages || isPackaging) {
      // Search for high-res images via SerpApi
      const query = `${product.identification?.brand || ''} ${product.identification?.name || ''} ${product.identification?.barcodes?.[0] || ''}`.trim();
      if (!query) continue;

      try {
        const images = await callSerpApi('google_images', { q: query, tbs: 'isz:l' }); // Large images
        const validImages = summarizeSerpEntries('google_images', images, 5);

        const recoveryImages = validImages.map((img, idx) => ({
          source: 'web_recovery',
          variant: 'gallery',
          url_or_base64: img.url,
          notes: `recovery_${idx}`,
          width: img.image_meta?.width,
          height: img.image_meta?.height
        }));

        product.details = product.details || {};
        product.details.images = [...(product.details.images || []), ...recoveryImages];
      } catch (e) {
        console.warn("Smart Image Recovery failed:", e.message);
      }
    }
  }
}

module.exports = {
  runProductIdentification,
  ensurePriceCoverage,
  runDatasheetReview,
  prefetchWebEvidenceForIdentify,
  applyEbayTaxonomy,
  applyKauflandTaxonomy,
  BARCODE_LIMIT_ERROR,
  IMAGE_PAYLOAD_ERROR,
  MAX_BARCODE_COUNT,
  MAX_IMAGE_PAYLOAD_BYTES,
  TOOL_ITERATION_ERROR,
  __test: {
    extractSpecsFromText,
    extractProductSpecs,
    scoreSpecSimilarity,
    collectPriceCandidates,
    pickBestPriceCandidate,
    normalizeMatchText,
  },
};
