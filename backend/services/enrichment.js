const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const sharp = require('sharp');
const crypto = require('crypto');
const { productBundleSchema } = require('../lib/product-schema');
const { getOpenAIClient } = require('../lib/openai-client');
const { uploadImage } = require('../lib/storage');
const {
  serpapiToolDefinition,
  webFetchToolDefinition,
  executeSerpapiToolCall,
  executeWebFetchToolCall,
} = require('./toolkit');
const { callSerpApi, summarizeSerpEntries } = require('../lib/serpapi');
const { resolveModel } = require('../lib/model-select');
const { findEbayCategory, getRequiredAspects } = require('../lib/ebay-taxonomy');

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
      `Inline image payload ${Math.round(payloadBytes / (1024 * 1024))} MB (soft limit ${
        SOFT_IMAGE_PAYLOAD_BYTES / (1024 * 1024)
      } MB) - remaining images are provided via hosted URLs for Lens.`
    );
  }

  return { imageParts, hostedImages };
}

async function fetchBarcodeSerpData(barcode, serpTrace = []) {
  const engines = [
    { engine: 'google_shopping', params: { q: barcode, num: 20 } },
    { engine: 'google', params: { q: barcode, num: 10 } },
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

async function prefetchBarcodeResearch(barcodes = [], serpTrace = []) {
  const uniqueCodes = [...new Set(barcodes)]
    .map((code) => code.trim())
    .filter(Boolean)
    .slice(0, MAX_BARCODE_PREFETCH);
  if (!uniqueCodes.length) {
    return [];
  }

  const research = [];
  for (const code of uniqueCodes) {
    const note = await fetchBarcodeSerpData(code, serpTrace);
    if (note) {
      research.push(note);
    }
  }
  return research;
}

function buildSystemPrompt(locale = 'de-DE') {
  return [
    `Du bist GPT-5 mini (Release 2025-08-07) und agierst als Product Intelligence Brain.`,
    `Pflichtregeln:`,
    `1. Nutze ausschließlich bereitgestellte Bilder/Barcodes + SerpAPI-Toolcalls (keine Halluzinationen).`,
    `2. Mindestens 2 SerpAPI-Calls: (a) google_shopping mit num>=20, (b) zweiter Preis-/Bild-Call z.B. google_images_shopping oder bing_shopping/amazon/ebay.`,
    `3. Für Bilder immer Qualitätsfilter (nur >=900px Breite) und Reverse-Image/Lens mit den bereitgestellten URLs nutzen.`,
    `4. Wenn Shopping-Resultate product_id liefern: google_product oder google_immersive_product nachladen für Spezifikationen.`,
    `5. Google_AI_overview/AI_mode nur zum Validieren, nicht als einzige Quelle; immer Händler-Quellen mit URL/Preis angeben.`,
    `6. Wenn Informationen fehlen, setze das Feld leer und füge eine Notiz in notes.unsure hinzu.`,
    `7. Gib die Ausgabe strikt im ProductBundle-Schema zurück (keine Freitexte).`,
    `8. Sprache Deutsch (${locale}), Währung EUR, Preise nur mit echter Händler-URL und checked_at.`,
    `9. Produktbilder nur übernehmen, wenn Quelle eindeutig verifiziert ist; Dubletten vermeiden.`,
    `10. Ordne das Produkt einer passenden eBay.de Kategorie zu (Breadcrumb) und liefere die Pflicht-Item-Specifics als Keys (Werte leer wenn unbekannt).`,
  ].join('\n');
}

function buildUserPrompt({
  barcodeList,
  hostedImages,
  locale,
  barcodeResearch = [],
  fileCount = 0,
  improveContext = null,
}) {
  const parts = [];
  if (barcodeList.length) {
    parts.push(`Barcodes: ${barcodeList.join(', ')}`);
  } else {
    parts.push('Barcodes: keine angegeben');
  }

  if (Array.isArray(barcodeResearch) && barcodeResearch.length) {
    parts.push(
      'Barcode-Recherche (SerpAPI Vorab-Calls – nutze diese Treffer und erweitere sie bei Bedarf):',
      barcodeResearch
        .map((entry, idx) => {
          const items = entry.items
            .map((item) => {
              const priceFragment = item.price ? ` | Preis: ${item.price}` : '';
              const sourceFragment = item.source ? ` (${item.source})` : '';
              return `- ${item.title}${priceFragment}${sourceFragment}`;
            })
            .join('\n');
          return `${idx + 1}. ${entry.barcode} (${entry.engine}):\n${items}`;
        })
        .join('\n\n')
    );
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
    `Aufgabe:`,
    `1. Analysiere die Vision-Eingaben (input_image) um Marke/Modell zu erkennen.`,
    `2. SerpAPI-Calls für alle Fakten (Name, Preise, Händler, Bilder, Spezifikationen). Start immer mit google_shopping (num>=20).`,
    `3. Danach mindestens eine Bild-/Reverse-Suche: google_images_shopping oder google_lens/google_reverse_image mit den bereitgestellten URLs.`,
    `4. Wenn Shopping-Ergebnis product_id liefert: google_product oder google_immersive_product nachladen; bei fehlenden Preisen zusätzlich bing_shopping/amazon/ebay.`,
    `5. Titel & Copy müssen marketplace-ready sein:`,
    `   - Titel: <=70 Zeichen, beginnt mit Marke + Produkttyp + Nutzen (keine SKU-only Titel).`,
    `   - short_description: mind. 3 Absätze à 2 Sätze, inkl. Einsatzzwecke, Produktnutzen, Ausstattung, Material/Verarbeitung, Lieferumfang, Montage/Bedienung, Pflege/Service.`,
    `   - key_features: 5-7 Nutzen-Bullets (6-12 Wörter, kein „laut Etikett“/„auf Karton“).`,
    `6. Validiere Bilder: nur öffentlich zugängliche, eindeutige, Auflösung >=900px; Dubletten entfernen.`,
    `7. Attribute als Liste ausgeben: [{ "key": "Material", "value": "100% Baumwolle", "value_type": "string" }, ...].`,
    `8. Wenn mehrere unterschiedliche Produkte erkannt werden, lege für jedes ein separates Objekt im products-Array an (eindeutige id, bevorzugt EAN/GTIN). Keine Zusammenfassung.`,
    `9. Pro Produkt nur EIN Barcode/EAN/GTIN zulassen (keine Mehrfach-Barcodes).`,
    `10. pricing.lowest_price.sources benötigt echte Händler-URLs inkl. checked_at.`,
    `11. images array: min. 3 verifizierte Einträge sofern SerpAPI passende Quellen liefert.`,
    `12. Notiere Unsicherheiten in notes.unsure.`,
    `13. Nutze nur Informationen aus Vision, Barcodes oder SerpAPI – keine sonstigen Wissensbestände.`,
    `Sprache für Texte: Deutsch (${locale}).`
  );
  if (improveContext) {
    parts.push(
      'Stelle sicher, dass der Output gegenüber dem bestehenden Datensatz eine Verbesserung darstellt (keine Verkürzungen oder Auslassungen).'
    );
  }

  return parts.join('\n\n');
}

function assertSerpUsage(trace) {
  if (!trace.length) {
    throw new Error('Mindestens ein Search/FETCH-Tool (SerpAPI oder Web-Fetch) muss verwendet werden.');
  }
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

function applyEbayTaxonomy(bundle) {
  if (!bundle?.products) return bundle;
  bundle.products = bundle.products.map((product) => {
    const cloned = { ...product };
    const attributes = { ...(cloned.details?.attributes || {}) };
    const rawCategory =
      cloned.details?.ebayCategory ||
      cloned.identification?.category ||
      attributes?.Kategorie ||
      attributes?.category;

    let ebayCategory = null;
    const fromId = parseCategoryIdFromString(rawCategory);
    if (fromId) {
      ebayCategory = findEbayCategory(fromId);
    }
    if (!ebayCategory) {
      ebayCategory = findEbayCategory(rawCategory);
    }

    if (ebayCategory) {
      cloned.identification = {
        ...(cloned.identification || {}),
        category: ebayCategory.breadcrumb,
      };
      cloned.details = {
        ...(cloned.details || {}),
        ebayCategoryId: ebayCategory.id,
        ebayCategoryBreadcrumb: ebayCategory.breadcrumb,
      };

      const required = getRequiredAspects(ebayCategory.id);
      required.forEach((aspect) => {
        if (attributes[aspect] === undefined) {
          attributes[aspect] = '';
        }
      });
    }

    cloned.details = cloned.details || {};
    cloned.details.attributes = attributes;
    return cloned;
  });
  return bundle;
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
    product?.identification?.name,
    product?.identification?.brand,
    product?.identification?.sku,
    product?.details?.identifiers?.sku,
    product?.details?.identifiers?.ean,
    product?.details?.identifiers?.gtin,
  ];
  return values
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase())
    .filter((value) => value.length >= 3);
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
          value: { type: 'string', minLength: 2, maxLength: 140 },
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
    '- Titel <= 70 Zeichen, beginnt mit Marke + Produktart + wichtigster Vorteil.',
    '- Beschreibung: exakt 3 Absätze mit jeweils 2 Sätzen. Enthält Nutzen, Ausstattung, Materialien, Lieferumfang, Service/Hinweise. Keine Aufzählungen.',
    '- Highlights: 5-7 Bulletpoints mit je 6-12 Wörtern, nur Nutzen/USPs, keine Verpackungshinweise, keine Dubletten.',
    '- Attribute: strukturierte Key-Value-Paare, keine ausschweifenden Sätze. Entferne Wiederholungen, korrigiere Schreibweisen (z. B. „Farbe“ statt „Farbton“).',
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
  const client = await getOpenAIClient();
  const reviewModel = resolveModel(null, 'REVIEW_MODEL', 'gpt-5.1');
  for (const product of products) {
    if (!product) continue;
    try {
      const response = await client.responses.create({
        model: reviewModel,
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: buildReviewPrompt(product, locale) }],
          },
        ],
        reasoning: { effort: 'medium' },
        text: {
          verbosity: 'high',
          format: {
            type: 'json_schema',
            name: 'DatasheetQualityReview',
            description: 'Marketingfertige Produktdatenblätter',
            schema: DATASHEET_REVIEW_SCHEMA,
            strict: true,
          },
        },
      });
      const review = parseModelJson(response);
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
  if (trimmed.length < 15) return true;
  if (/^(sku|item|model)?[-\w\s]+$/i.test(trimmed) && !/\s/.test(trimmed.replace(/[A-Za-z]+/g, ''))) {
    return true;
  }
  if (/unbekannt/i.test(trimmed)) return true;
  return false;
}

function needsMarketingRewrite(product) {
  const title = product?.identification?.name || '';
  const desc = product?.details?.short_description || '';
  const features = Array.isArray(product?.details?.key_features)
    ? product.details.key_features.filter(Boolean)
    : [];

  if (looksLikePlaceholderTitle(title)) return true;
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
    `- Titel max. 70 Zeichen, beginnt mit Marke + Produktkategorie + Nutzen.`,
    `- Keine Erwähnungen von Verpackung, Etikett oder "sichtbar".`,
    `- Kurzbeschreibung mind. 3 Absätze à 2 Sätze, beschreibt Einsatzzwecke, Vorteile, Material, Lieferumfang, Montage/Pflege.`,
    `- Hauptmerkmale: 5-7 Bulletpoints, 6-12 Wörter, nutzenorientiert (keine Wiederholungen, keine Verpackungs-Hinweise).`,
    `- Ton: verkaufsfördernd, seriös, faktenbasiert.`,
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
  const targetModel = resolveModel(null, 'MARKETING_MODEL', 'gpt-5-mini-2025-08-07');
  const client = await getOpenAIClient();

  for (const product of products) {
    if (needsMarketingRewrite(product)) {
      try {
      const response = await client.responses.create({
        model: targetModel,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: buildMarketingPrompt(product, locale),
              },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'MarketingCopy',
            schema: marketingCopySchema,
            strict: true,
          },
        },
      });
      const rewrite = parseMarketingJson(response);
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
  return searchKeywords.some((keyword) => normalizedQuery.includes(keyword.slice(0, Math.min(keyword.length, 8))));
}

function collectPriceCandidates(product, serpTrace = [], existingKeywords = null) {
  if (!Array.isArray(serpTrace) || !serpTrace.length) return [];
  const keywords = existingKeywords || collectProductKeywords(product);
  if (!keywords.length) return [];

  const candidates = [];
  for (const entry of serpTrace) {
    if (!entry || !PRICE_TRACE_ENGINES.has(entry.engine)) continue;
    const queryIsRelevant = queryMatchesProduct(entry.query || '', product, keywords);
    for (const item of entry.summary || []) {
      const parsedPrice = normalizePriceString(item.price);
      if (!parsedPrice) continue;
      const textBlob = [item.title, item.snippet].filter(Boolean).join(' ').toLowerCase();
      const textMatches = keywords.some((keyword) => textBlob.includes(keyword));
      if (!queryIsRelevant && !textMatches) continue;
      candidates.push({
        amount: parsedPrice.amount,
        currency: parsedPrice.currency,
        source: item.source || entry.engine,
        url: item.url || '',
        engine: entry.engine,
      });
    }
  }
  return candidates;
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
    const keywords = collectProductKeywords(product);
    if (!keywords.length) continue;

    let candidates = collectPriceCandidates(product, serpTrace, keywords);
    if (!candidates.length) {
      const fallbackTrace = await fetchPriceTrace(product, keywords);
      if (fallbackTrace) {
        serpTrace.push(fallbackTrace);
        candidates = collectPriceCandidates(product, [fallbackTrace], keywords);
      }
    }
    if (!candidates.length) continue;
    candidates.sort((a, b) => a.amount - b.amount);
    const best = candidates[0];
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
          : Math.min(0.95, Math.max(0.4, candidates.length / 5)),
    };
  }
}

async function runProductIdentification({
  files = [],
  barcodes = '',
  locale = 'de-DE',
  modelOverride = null,
  improveContext = null,
}) {
  if ((!files || files.length === 0) && !barcodes) {
    throw new Error('Bitte mindestens ein Bild oder einen Barcode bereitstellen.');
  }

  const barcodeList = parseBarcodes(barcodes);
  const { imageParts, hostedImages } = await prepareImages(files);
  const serpTrace = [];
  const barcodeResearch = await prefetchBarcodeResearch(barcodeList, serpTrace);
  const client = await getOpenAIClient();
  const targetModel = resolveModel(modelOverride, 'IDENTIFY_MODEL', 'gpt-5-mini-2025-08-07');
  const systemPrompt = buildSystemPrompt(locale);
  const userPrompt = buildUserPrompt({
    barcodeList,
    hostedImages,
    locale,
    barcodeResearch,
    fileCount: files.length,
    improveContext,
  });

  const inputMessages = [
    {
      role: 'system',
      content: [{ type: 'input_text', text: systemPrompt }],
    },
    {
      role: 'user',
      content: [...imageParts, { type: 'input_text', text: userPrompt }],
    },
  ];

  let finalizationHintInjected = false;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    let disableTools = finalizationHintInjected;
    if (!finalizationHintInjected && iteration === MAX_TOOL_ITERATIONS - 1) {
      inputMessages.push({
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: 'Du hast die maximale Anzahl an SerpAPI-Toolcalls erreicht. Nutze jetzt ausschließlich die bereits vorliegenden Informationen (Vision, Barcodes, vorhandene SerpAPI-Ergebnisse) und gib das vollständige ProductBundle zurück – keine weiteren Toolcalls.',
          },
        ],
      });
      finalizationHintInjected = true;
      disableTools = true;
    }

    const response = await client.responses.create({
      model: targetModel,
      input: inputMessages,
      tools: disableTools ? [] : [serpapiToolDefinition, webFetchToolDefinition],
      reasoning: { effort: 'low' },
      text: {
        verbosity: 'medium',
        format: {
          type: 'json_schema',
          name: 'ProductBundle',
          description: 'Komplettes Produktdatenblatt laut types.ts',
          schema: productBundleSchema,
          strict: true,
        },
      },
      metadata: {
        domain: 'product-intelligence-hub',
      },
    });

    const toolCalls = response.output.filter((item) => item.type === 'function_call');
    if (!toolCalls.length) {
      const bundle = parseModelJson(response);
      ensureSchema(bundle);
      normalizeBundle(bundle);
      await ensureMarketingCopy(bundle.products, locale);
      applyEbayTaxonomy(bundle);
      ensurePriceCoverage(bundle.products, serpTrace);
      await runDatasheetReview(bundle.products, { locale });
      assertSerpUsage(serpTrace);
      return {
        bundle,
        serpTrace,
        modelResponse: response,
        modelUsed: targetModel,
      };
    }

    // Append model reasoning/tool call metadata
    inputMessages.push(...response.output);

    for (const toolCall of toolCalls) {
      let responsePayload = null;
      if (toolCall.name === 'serpapi_web_search') {
        const toolResult = await executeSerpapiToolCall(toolCall);
        serpTrace.push({
          type: 'serpapi',
          engine: toolResult.engine,
          query: toolResult.query,
          summary: toolResult.summary,
          params: toolResult.params,
          error: toolResult.error || null,
        });
        responsePayload = {
          engine: toolResult.engine,
          query: toolResult.query,
          summary: toolResult.summary,
          error: toolResult.error || null,
        };
      } else if (toolCall.name === 'web_fetch') {
        const fetchResult = await executeWebFetchToolCall(toolCall);
        serpTrace.push({
          type: 'web_fetch',
          url: fetchResult.url,
          status: fetchResult.status,
          contentType: fetchResult.contentType,
          bytes: fetchResult.bytes,
          error: fetchResult.error || null,
        });
        responsePayload = fetchResult;
      } else {
        responsePayload = { ignored: true };
      }

      inputMessages.push({
        type: 'function_call_output',
        call_id: toolCall.call_id,
        output: JSON.stringify(responsePayload),
      });
    }
  }

  const iterationError = new Error('SerpAPI/GPT workflow exceeded the maximum number of tool iterations.');
  iterationError.code = TOOL_ITERATION_ERROR;
  iterationError.serpTrace = serpTrace;
  iterationError.modelUsed = targetModel;
  throw iterationError;
}

module.exports = {
  runProductIdentification,
  runDatasheetReview,
  BARCODE_LIMIT_ERROR,
  IMAGE_PAYLOAD_ERROR,
  MAX_BARCODE_COUNT,
  MAX_IMAGE_PAYLOAD_BYTES,
  TOOL_ITERATION_ERROR,
};
