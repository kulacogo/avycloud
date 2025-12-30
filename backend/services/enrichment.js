const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const sharp = require('sharp');
const crypto = require('crypto');
const { productBundleSchema } = require('../lib/product-schema');
const { getGeminiClient } = require('../lib/gemini-client'); // Replaced OpenAI
const { uploadImage } = require('../lib/storage');
const { extractOcrPayload } = require('../lib/vision-ocr');
const { callSerpApi, summarizeSerpEntries } = require('../lib/serpapi');
const { resolveModel } = require('../lib/model-select');
const path = require('path');
const { findEbayCategory, getRequiredAspects } = require('../lib/ebay-taxonomy');
const { findKauflandCategory, getKauflandAttributes } = require('../lib/kaufland-taxonomy');
const { MarketplaceLookup } = require('../lib/marketplace-lookup');
const { isValidGtin } = require('../lib/gtin');

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
    const model = client.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const attrs = product?.details?.attributes || {};
    const prompt = `
Du bist ein Kategorisierungs-Assistent. Finde einen passenden Kategorie-PFAD (deutsch)
für ${target === 'ebay' ? 'eBay (inventory 85403)' : 'Kaufland (inventory 85404)'}.
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
    const id =
      target === 'ebay'
        ? marketplaceLookup.lookupEbay(pathText)
        : marketplaceLookup.lookupKaufland(pathText);
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
    title: { type: 'string', minLength: 20, maxLength: 120 },
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
    `Du bist GPT-5 mini (Release 2025-08-07) und agierst als Product Intelligence Brain.`,
    `Pflichtregeln:`,
    `1. Nutze ausschließlich bereitgestellte Bilder/Barcodes/OCR (keine Halluzinationen, keine externen Web- oder SerpAPI-Calls).`,
    `2. Wenn Informationen fehlen, setze das Feld leer und füge eine Notiz in notes.unsure hinzu.`,
    `3. Gib die Ausgabe strikt im ProductBundle-Schema zurück (keine Freitexte).`,
    `4. Sprache Deutsch (${locale}), Währung EUR. Preise nur, wenn aus den gelieferten Daten sicher ableitbar, sonst leer lassen.`,
    `5. Produktbilder nur übernehmen, wenn Quelle eindeutig verifiziert ist; Dubletten vermeiden.`,
    `6. Ordne das Produkt einer passenden eBay.de Kategorie zu (Breadcrumb) und liefere die Pflichtattribute (Item Specifics) als Keys OHNE Prefix (Werte leer wenn unbekannt).`,
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

  parts.push(
    `Aufgabe (ohne externe Suche):`,
    `1. Analysiere Bilder/OCR/Barcodes, um Marke/Modell zu erkennen.`,
    `2. Titel & Copy marketplace-ready:`,
    `   - Titel: <=70 Zeichen, Marke + Produkttyp + Nutzen.`,
    `   - short_description: mind. 3 Absätze à 2 Sätze (Einsatz, Nutzen, Ausstattung, Material/Verarbeitung, Lieferumfang, Bedienung/Pflege).`,
    `   - key_features: 5-7 Nutzen-Bullets (6-12 Wörter).`,
    `3. Bilder: nur eindeutige, Dubletten entfernen.`,
    `4. Attribute als Liste ausgeben: [{ "key": "Material", "value": "100% Baumwolle", "value_type": "string" }, ...].`,
    `5. Bei mehreren Produkten: für jedes ein separates Objekt im products-Array (eindeutige id, bevorzugt EAN/GTIN).`,
    `6. Pro Produkt nur EIN Barcode/EAN/GTIN zulassen (keine Mehrfach-Barcodes).`,
    `7. Preise nur, wenn sicher aus gelieferten Daten ableitbar, sonst leer lassen.`,
    `8. Unsicherheiten in notes.unsure dokumentieren.`,
    `9. Ordne eBay.de Kategorie (Breadcrumb) zu und füge die Pflichtattribute (Item Specifics) als Keys OHNE Prefix (leer bei Unbekannt) hinzu.`,
    `10. Bestimme eine passende Kaufland-Kategorie (z.B. "Küche & Haushalt > ...") UND wähle passende Attribute aus der folgenden Liste gültiger Kaufland-Attribute (Format: "key (Label)") aus:`,
    getKauflandAttributes().map(a => `- ${a.name} (${a.label})`).join('\n'),
    `   Füge diese als Attribute hinzu (nur wenn sie zum Produkt passen).`,
    `Sprache: Deutsch (${locale}).`
  );
  if (improveContext) {
    parts.push(
      'Stelle sicher, dass der Output gegenüber dem bestehenden Datensatz eine Verbesserung darstellt (keine Verkürzungen oder Auslassungen).'
    );
  }

  return parts.join('\n\n');
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
    cloned.identification.brand = (cloned.identification.brand || '').trim() || 'unknown';
    cloned.identification.name =
      (cloned.identification.name || '').trim() || 'Unbekanntes Produkt';
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
  const hasName = name.length >= 3 && !/^unbekannt$/i.test(name);
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
  const remaining = [...new Set(barcodeList.map((code) => code.trim()).filter(Boolean))];
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
    product.details = product.details || {};
    product.details.identifiers = {
      ...(product.details.identifiers || {}),
    };
    if (!product.details.identifiers.ean) {
      product.details.identifiers.ean = nextBarcode;
    }
    if (!product.details.identifiers.gtin) {
      product.details.identifiers.gtin = nextBarcode;
    }
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
  const attributes = { ...(cloned.details?.attributes || {}) };

  const resolved = resolveEbayCategory({
    details: cloned.details,
    attributes,
    identification: cloned.identification,
  });

  if (resolved) {
    cloned.details = {
      ...(cloned.details || {}),
      ebayCategoryId: resolved.id,
      ebayCategoryBreadcrumb: resolved.path || cloned.details?.ebayCategoryBreadcrumb || resolved.id,
      ebayCategoryPath: resolved.path || cloned.details?.ebayCategoryPath || resolved.id,
    };

    attributes.ebay_category_id = resolved.id;
    attributes.ebay_category_path = resolved.path || resolved.id;

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

    if (!p.details.ebayCategoryId || !marketplaceLookup.isValidEbayId(String(p.details.ebayCategoryId))) {
      const g = await resolveCategoryWithGemini(p, 'ebay');
      if (g?.id) {
        p.details.ebayCategoryId = g.id;
        p.details.ebayCategoryPath = g.path;
        attrs.ebay_category_id = g.id;
        attrs.ebay_category_path = g.path;
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
        attrs.kaufland_category_id = g.id;
        attrs.kaufland_category_path = g.path;
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

  const primary = candidateList.find((v) => v.length >= 6) || null;
  const unique = primary ? [primary] : [];

  // Write back a single barcode everywhere
  if (cloned.identification) {
    cloned.identification.barcodes = unique;
  }
  PRIMARY_BARCODE_KEYS.forEach((key) => {
    identifiers[key] = primary || null;
  });
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
    title: { type: 'string', minLength: 15, maxLength: 90 },
    short_description: { type: 'string', minLength: 180, maxLength: 2000 },
    highlights: {
      type: 'array',
      minItems: 5,
      maxItems: 7,
      items: { type: 'string', minLength: 10, maxLength: 160 },
    },
    attributes: {
      type: 'array',
      minItems: 5,
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
  },
};

function buildReviewPrompt(product, locale) {
  const snapshot = {
    id: product?.id,
    brand: product?.identification?.brand,
    title: product?.identification?.name,
    category: product?.identification?.category,
    description: product?.details?.short_description,
    highlights: product?.details?.key_features,
    attributes: product?.details?.attributes,
    ebayCategoryId: product?.details?.ebayCategoryId,
  };

  return [
    'Du bist ein Marketplace-Quality-Inspector für eBay und Amazon. Deine Aufgabe: prüfe das vorliegende Produktdatenblatt und liefere eine korrigierte, maximal verkaufsstarke Version.',
    'Richtlinien:',
    '- Titel (TECHNISCH) <= 80 Zeichen, beginnt mit Marke + Produktart und enthält – falls vorhanden – Modell/Herstellernummer sowie 1–2 technische Kerndaten (z. B. Spannung/Leistung/Größe/Volumen). Keine Marketingfloskeln, keine Dubletten.',
    '- Beschreibung: exakt 3 Absätze mit jeweils 2 Sätzen. Enthält Nutzen, Ausstattung, Materialien, Lieferumfang, Service/Hinweise. Keine Aufzählungen.',
    '- Highlights: 5-7 Bulletpoints mit je 6-12 Wörtern, technisch/faktenbasiert, keine Verpackungshinweise, keine Dubletten.',
    '- Attribute: strukturierte Key-Value-Paare (kundenverständlich). Entferne Wiederholungen und halte die Sprache konsistent.',
    '- K-Typ (nur Auto/KFZ/Motorrad-Teile): Wenn im Datensatz vorhanden, beibehalten. Wenn du es eindeutig ableiten kannst, setze Attribut "K-Typ" im Format "19974|57446|57448" (optional je Eintrag "19974,Kommentar"). Wenn unsicher: NICHT raten; stattdessen in warnings markieren.',
    '- WICHTIG: Keine internen/technischen Meta-Keys als Attribute ausgeben (z. B. product-id, Produkt-ID, category_id, *_id, ebay_category_id/path, kaufland_category_id/path, text_*, features|*). Solche Daten gehören NICHT in die Attribut-Tabelle.',
    '- WICHTIG: Keine Platzhalter-Werte erzeugen (z. B. "Not Provided, EU", "info@example.com"). Wenn etwas fehlt: weglassen und als warning markieren.',
    '- Ergänze technische Daten nur, wenn sie aus dem Datensatz eindeutig ableitbar sind. Wenn unsicher: warning statt raten.',
    '- Entferne widersprüchliche oder doppelte Aussagen. Markiere offene Punkte in warnings.',
    `- Sprache: ${locale}.`,
    'Rückgabe ausschließlich gemäß JSON Schema.',
    'Vorliegender Datensatz:',
    JSON.stringify(snapshot, null, 2),
  ].join('\n\n');
}

function applyReviewResult(product, review) {
  if (!product || !review) return;
  product.identification = product.identification || {};
  product.details = product.details || {};

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
    product.identification.name = review.title.trim();
  }
  if (typeof review.short_description === 'string' && review.short_description.trim().length > 0) {
    product.details.short_description = review.short_description.trim();
  }
  if (Array.isArray(review.highlights) && review.highlights.length) {
    product.details.key_features = sanitizeKeyFeatures(review.highlights);
  }
  if (Array.isArray(review.attributes) && review.attributes.length) {
    const attrs = {};
    review.attributes.forEach((entry) => {
      const key = entry?.key?.trim();
      const value = entry?.value?.trim();
      if (key && value) {
        attrs[key] = value;
      }
    });

    const hasKTyp = Object.keys(attrs).some((k) => {
      const lower = String(k || '').trim().toLowerCase();
      return lower === 'k-typ' || lower === 'ktyp' || lower === 'k typ';
    });
    if (!hasKTyp && existingKTyp) {
      attrs['K-Typ'] = existingKTyp;
    }

    product.details.attributes = sanitizeAttributesMap(attrs);
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
}

async function runDatasheetReview(products = [], { locale = 'de-DE' } = {}) {
  if (!Array.isArray(products) || !products.length) return;
  // Use Thinking model for deep quality assurance
  const reviewModel = resolveModel(null, 'REVIEW_MODEL', 'gemini-2.5-flash');

  const client = await getGeminiClient();
  const model = client.getGenerativeModel({ model: reviewModel });

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

      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: buildReviewPrompt(product, locale) }] }],
        generationConfig
      });

      const review = JSON.parse(result.response.text());
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

function looksLikePlaceholderTitle(text = '') {
  if (!text) return true;
  const trimmed = text.trim();
  if (trimmed.length < 35) return true; // Increased from 15 to 35 to catch "LED Hallenleuchte"
  if (/^(sku|item|model)?[-\w\s]+$/i.test(trimmed) && !/\s/.test(trimmed.replace(/[A-Za-z]+/g, ''))) {
    return true;
  }
  if (/unbekannt|unknown|neu|new/i.test(trimmed)) return true;
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

  if (desc.trim().length < 300 || containsPackagingReference(desc)) return true;
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
    `- Titel (SEO, TECHNISCH): max. 80 Zeichen, starte mit Marke + Produktart, ergänze Modell/Herstellernummer + 1–2 technische Kerndaten (z. B. Spannung/Leistung/Größe/Volumen), keine Marketingfloskeln, keine Dubletten.`,
    `- Kurzbeschreibung: 3 Absätze à 2 Sätze, verkaufsstark, Nutzen & Materialien, Pflege/Montage, Social Proof/Trust, klarer CTA ("Jetzt kaufen", "Nur begrenzte Stückzahl").`,
    `- Highlights: 6-8 Bullets, 6-12 Wörter, nutzenorientiert. Enthalten: Versanddetails (DHL, kostenloser Versand, Versand bis 14 Uhr am selben Werktag), Rückgaberecht 14 Tage, Sonderangebote/Limitierung. Keine Wiederholungen, kein Verpackungstext.`,
    `- Ton: aggressiv verkaufsfördernd, faktenbasiert, aber ohne Übertreibungen; klare Kaufaufforderung.`,
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
          name: rewrite.title.trim(),
        };
        product.details = product.details || {};
        product.details.short_description = rewrite.description.trim();
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

function collectPriceCandidates(product, serpTrace = [], existingKeywords = null) {
  if (!Array.isArray(serpTrace) || !serpTrace.length) return [];
  const keywords = existingKeywords || collectProductKeywords(product);
  if (!keywords.length) return [];

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
    const queryIsRelevant = queryMatchesProduct(entry.query || '', product, keywords);
    for (const item of entry.summary || []) {
      const parsedPrice = normalizePriceString(item.price);
      if (!parsedPrice) continue;
      // Keep EUR only (SerpAPI may return mixed locales). If missing currency, we treat as EUR (DEFAULT).
      if (parsedPrice.currency && parsedPrice.currency !== DEFAULT_PRICE_CURRENCY) continue;
      const textBlob = [item.title, item.snippet].filter(Boolean).join(' ').toLowerCase();
      // User requirement: prefer new price (Neuware) → drop obvious used/refurbished offers
      if (USED_PRICE_HINT_REGEX.test(textBlob)) continue;
      const matches = keywords.filter((keyword) => keyword && textBlob.includes(keyword)).length;
      const hasBrand = brand && textBlob.includes(brand);
      const hasMpn = mpn && mpn.length >= 3 && textBlob.includes(mpn);
      const hasBarcode = barcodeCandidates.some((code) => textBlob.includes(code));
      // Require at least SOME signal that the item refers to the product (avoid "cheapest accessory" matches).
      const ok = (queryIsRelevant && (matches >= 1 || hasBrand || hasMpn || hasBarcode)) || matches >= 2 || hasMpn || hasBarcode;
      if (!ok) continue;
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
  if (c.engine === 'google_shopping') score += 4;
  if (c.engine === 'bing_shopping') score += 2;
  if (!c.url) score -= 3;
  return score;
}

function pickBestPriceCandidate(candidates = []) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const enriched = candidates
    .filter((c) => typeof c.amount === 'number' && Number.isFinite(c.amount) && c.amount > 0)
    .map((c) => ({ ...c, score: scorePriceCandidate(c) }));

  if (!enriched.length) return null;

  const maxScore = Math.max(...enriched.map((c) => c.score || 0));
  const top = enriched.filter((c) => (c.score || 0) >= Math.max(0, maxScore - 8));

  // Outlier filter based on median of top matches (when enough data)
  const amounts = top.map((c) => c.amount);
  const med = median(amounts);
  let filtered = top;
  if (med && amounts.length >= 3) {
    const low = Math.max(0.5, med * 0.35);
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

  filtered.sort((a, b) => {
    const s = (b.score || 0) - (a.score || 0);
    if (s) return s;
    return a.amount - b.amount;
  });
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

async function ensurePriceCoverage(products = [], serpTrace = []) {
  if (!Array.isArray(products) || !products.length) return;

  for (const product of products) {
    const lowest = product?.details?.pricing?.lowest_price;
    const hasPrice =
      lowest &&
      typeof lowest.amount === 'number' &&
      Number.isFinite(lowest.amount) &&
      lowest.amount > 0 &&
      Array.isArray(lowest.sources) &&
      lowest.sources.length > 0;
    if (hasPrice) continue;

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
          : Math.min(0.95, Math.max(0.4, Math.min(1, (best.score || 0) / 40) + candidates.length / 12)),
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
  const barcodeList = mergeBarcodeLists(manualBarcodes, ocrPayload.barcodes || []);
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
  const userPrompt = buildUserPrompt({
    barcodeList,
    hostedImages,
    locale,
    fileCount: files.length,
    improveContext,
    ocrTextSnippets: ocrPayload.textSnippets || [],
    ocrNumericValues: ocrPayload.numericValues || [],
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
  // Use Gemini 2.5 Flash as requested (Fast + Vision)
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

  return {
    bundle,
    serpTrace,
    modelUsed: targetModelName,
  };
}

// Helper for Smart Image Recovery
async function runSmartImageRecovery(products = []) {
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
  applyEbayTaxonomy,
  applyKauflandTaxonomy,
  BARCODE_LIMIT_ERROR,
  IMAGE_PAYLOAD_ERROR,
  MAX_BARCODE_COUNT,
  MAX_IMAGE_PAYLOAD_BYTES,
  TOOL_ITERATION_ERROR,
};
