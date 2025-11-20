const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { productBundleSchema } = require('../lib/product-schema');
const { getOpenAIClient } = require('../lib/openai-client');
const { uploadImage } = require('../lib/storage');
const { serpapiToolDefinition, executeSerpapiToolCall } = require('./toolkit');
const { callSerpApi, summarizeSerpEntries } = require('../lib/serpapi');
const { resolveModel } = require('../lib/model-select');
const { fetchMarketingImages } = require('../lib/marketing-images');

const MAX_TOOL_ITERATIONS = 8;
const MAX_BARCODE_COUNT = 10000;
const MAX_IMAGE_PAYLOAD_BYTES = 25 * 1024 * 1024;
const BARCODE_LIMIT_ERROR = 'BARCODE_LIMIT_EXCEEDED';
const IMAGE_PAYLOAD_ERROR = 'IMAGE_PAYLOAD_LIMIT_EXCEEDED';
const TOOL_ITERATION_ERROR = 'TOOL_ITERATION_LIMIT';
const MIN_ENRICHED_IMAGE_COUNT = parseInt(process.env.MIN_ENRICHED_IMAGE_COUNT || '4', 10);
const DEFAULT_PRICE_CURRENCY = process.env.DEFAULT_PRICE_CURRENCY || 'EUR';
const PRICE_TRACE_ENGINES = new Set(['google_shopping', 'google', 'ebay']);
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateProductBundle = ajv.compile(productBundleSchema);

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
  let totalBytes = 0;

  await Promise.all(
    files.map(async (file, idx) => {
      totalBytes += file.size;
      if (totalBytes > MAX_IMAGE_PAYLOAD_BYTES) {
        const error = new Error(IMAGE_PAYLOAD_ERROR);
        error.code = IMAGE_PAYLOAD_ERROR;
        throw error;
      }
      const base64 = file.buffer.toString('base64');
      const dataUrl = `data:${file.mimetype};base64,${base64}`;
      imageParts.push({
        type: 'input_image',
        image_url: dataUrl,
      });

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
    })
  );

  return { imageParts, hostedImages };
}

function buildSystemPrompt(locale = 'de-DE') {
  return [
    `Du bist GPT-5 mini (Release 2025-08-07) und agierst als Product Intelligence Brain.`,
    `Pflichtregeln:`,
    `1. Nutze ausschließlich bereitgestellte Bilder/Barcodes + SerpAPI-Toolcalls.`,
    `2. Führe mindestens einen SerpAPI-Call aus, bevor du ein Ergebnis zurückgibst.`,
    `3. Erfinde niemals Marken, Preise oder Bilder.`,
    `4. Wenn Informationen fehlen, setze das Feld leer und füge eine Notiz in notes.unsure hinzu.`,
    `5. Gib die Ausgabe strikt im ProductBundle-Schema zurück (keine Freitexte).`,
    `6. Sprich Deutsch (${locale}), Währung EUR.`,
    `7. Produktbilder nur übernehmen, wenn Quelle eindeutig verifiziert ist.`,
    `8. Nutze SerpAPI engines exakt nach Dokumentation (keine eigenen Parameter).`,
  ].join('\n');
}

function buildUserPrompt({ barcodeList, hostedImages, locale }) {
  const parts = [];
  if (barcodeList.length) {
    parts.push(`Barcodes: ${barcodeList.join(', ')}`);
  } else {
    parts.push('Barcodes: keine angegeben');
  }

  if (hostedImages.length) {
    parts.push(
      'Öffentlich abrufbare Bild-URLs (für Google Lens/Reverse Image):',
      hostedImages
        .map((img, idx) => `${idx + 1}. ${img.url} (${img.mimeType}, ${img.filename || 'upload'})`)
        .join('\n')
    );
  } else {
    parts.push('Es liegen keine vorab gehosteten Bilder vor.');
  }

  parts.push(
    `Aufgabe:`,
    `1. Analysiere die Vision-Eingaben (input_image) um Marke/Modell zu erkennen.`,
    `2. Verwende SerpAPI-Toolcalls für alle Fakten (Produktname, Preise, Händler, Bilder, Spezifikationen).`,
    `3. Pflicht: Führe zuerst eine Google-Shopping-Suche (engine=google_shopping, num>=12) laut SerpAPI-Doku aus und erfasse Händlerpreise in EUR mit URL.`,
    `4. Pflicht: Führe mindestens eine Bildsuche über google_images oder google_lens (num>=20) durch und wähle nur Bilder >=900px Breite.`,
    `5. Nutze zusätzlich ebay oder google, falls Shopping keine Preise liefert.`,
    `6. Validiere Bilder: stelle sicher, dass Links öffentlich und eindeutig sind.`,
    `7. Liefere ein vollständiges Produktdatenblatt. Attribute müssen als Liste ausgegeben werden: [{ "key": "Material", "value": "100% Baumwolle", "value_type": "string" }, ...].`,
    `8. Wenn mehrere Produkte gefunden werden, gib jedes separat im products Array mit eindeutiger id (bevorzugt EAN/GTIN) zurück.`,
    `9. pricing.lowest_price.sources benötigt echte Händler-URLs inkl. checked_at.`,
    `10. key_features >= 5, spezifisch für das Produkt.`,
    `11. images array: min. 3 Einträge sofern SerpAPI passende Quellen liefert.`,
    `12. Notiere Unsicherheiten in notes.unsure.`,
    `13. Nutze nur Informationen aus Vision, Barcodes oder SerpAPI – keine sonstigen Wissensbestände.`,
    `Sprache für Texte: Deutsch (${locale}).`
  );

  return parts.join('\n\n');
}

function assertSerpUsage(trace) {
  if (!trace.length) {
    throw new Error('SerpAPI was not used. The workflow requires at least one SerpAPI call.');
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
    return cloned;
  });
  return bundle;
}

function normalizeImageKey(url = '') {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase() || null;
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
  try {
    const raw = await callSerpApi('google_shopping', { q: query, num: 12 });
    const summary = summarizeSerpEntries('google_shopping', raw, 12);
    if (!summary.length) return null;
    return {
      engine: 'google_shopping',
      query,
      summary,
      params: { q: query, num: 12 },
      error: null,
      fallback: true,
    };
  } catch (error) {
    console.warn('Fallback Google Shopping lookup fehlgeschlagen:', error.message);
    return null;
  }
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

async function enrichProductImages(products = [], serpTrace = []) {
  if (!Array.isArray(products) || !products.length) return;

  for (const product of products) {
    const name = product?.identification?.name?.trim();
    if (!name) continue;
    const brand = product?.identification?.brand?.trim() || '';
    const existingImages = Array.isArray(product?.details?.images) ? product.details.images : [];
    const existingUrls = existingImages
      .map((img) => img?.url_or_base64 || img?.url)
      .filter((url) => typeof url === 'string' && url.startsWith('http'));
    const desiredCount = Math.max(3, MIN_ENRICHED_IMAGE_COUNT);
    const missingImages = Math.max(0, desiredCount - existingUrls.length);
    if (missingImages === 0) continue;

    try {
      const { images, trace } = await fetchMarketingImages({
        brand,
        name,
        limit: missingImages,
        exclude: existingUrls,
      });

      if (trace?.length) {
        trace.forEach((entry) => {
          serpTrace.push({
            engine: entry.engine,
            query: entry.query,
            summary: entry.images.slice(0, 5),
            error: null,
          });
        });
      }

      if (!images.length) continue;
      const seenKeys = new Set(
        existingUrls
          .map((url) => normalizeImageKey(url))
          .filter(Boolean)
      );

      const mapped = images
        .map((img) => ({
          source: img.source || 'web',
          variant: 'marketing',
          url_or_base64: img.url,
          width: img.width || null,
          height: img.height || null,
          notes: img.title || 'Marketing Bild',
        }))
        .filter((img) => {
          const key = normalizeImageKey(img.url_or_base64);
          if (!key || seenKeys.has(key)) return false;
          seenKeys.add(key);
          return true;
        });

      if (!mapped.length) continue;
      product.details = product.details || {};
      product.details.images = [...(product.details.images || []), ...mapped];
    } catch (error) {
      console.warn('Failed to fetch marketing images:', error.message);
    }
  }
}

async function runProductIdentification({ files = [], barcodes = '', locale = 'de-DE', modelOverride = null }) {
  if ((!files || files.length === 0) && !barcodes) {
    throw new Error('Bitte mindestens ein Bild oder einen Barcode bereitstellen.');
  }

  const barcodeList = parseBarcodes(barcodes);
  const { imageParts, hostedImages } = await prepareImages(files);
  const client = await getOpenAIClient();
  const targetModel = resolveModel(modelOverride, 'IDENTIFY_MODEL', 'gpt-5-mini-2025-08-07');
  const systemPrompt = buildSystemPrompt(locale);
  const userPrompt = buildUserPrompt({ barcodeList, hostedImages, locale });

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

  const serpTrace = [];
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
      tools: disableTools ? [] : [serpapiToolDefinition],
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
      await enrichProductImages(bundle.products, serpTrace);
      ensurePriceCoverage(bundle.products, serpTrace);
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
      const toolResult = await executeSerpapiToolCall(toolCall);
      serpTrace.push({
        engine: toolResult.engine,
        query: toolResult.query,
        summary: toolResult.summary,
        params: toolResult.params,
        error: toolResult.error || null,
      });

      inputMessages.push({
        type: 'function_call_output',
        call_id: toolCall.call_id,
        output: JSON.stringify({
          engine: toolResult.engine,
          query: toolResult.query,
          summary: toolResult.summary,
            error: toolResult.error || null,
        }),
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
  BARCODE_LIMIT_ERROR,
  IMAGE_PAYLOAD_ERROR,
  MAX_BARCODE_COUNT,
  MAX_IMAGE_PAYLOAD_BYTES,
  TOOL_ITERATION_ERROR,
};

