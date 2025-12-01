const { getOpenAIClient } = require('../lib/openai-client');
const {
  serpapiToolDefinition,
  webFetchToolDefinition,
  executeSerpapiToolCall,
  executeWebFetchToolCall,
} = require('./toolkit');
const { resolveModel } = require('../lib/model-select');
const { fetchMarketingImages } = require('../lib/marketing-images');
const { generateImagesForProduct } = require('./image-generation');

const MAX_CHAT_ITERATIONS = 5;

const updateDatasheetTool = {
  type: 'function',
  name: 'update_product_datasheet',
  description: 'Propose structured changes to the currently visible product datasheet. Do not persist automatically – the user must confirm.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      short_description: { type: 'string' },
      key_features: {
        type: 'array',
        items: { type: 'string' },
      },
      attributes: {
        type: 'array',
        items: {
          type: 'object',
          required: ['key', 'value', 'value_type'],
          additionalProperties: false,
          properties: {
            key: { type: 'string' },
            value: { type: ['string', 'number', 'boolean'] },
            value_type: {
              type: 'string',
              enum: ['string', 'number', 'boolean'],
              default: 'string',
            },
          },
        },
      },
      pricing: {
        type: 'object',
        additionalProperties: false,
        required: ['lowest_price', 'price_confidence'],
        properties: {
          lowest_price: {
            type: 'object',
            additionalProperties: false,
            required: ['amount', 'currency', 'sources', 'last_checked_iso'],
            properties: {
              amount: { type: 'number' },
              currency: { type: 'string' },
              sources: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['name', 'url', 'price', 'shipping', 'checked_at'],
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string' },
                    url: { type: 'string' },
                    price: { type: ['number', 'null'] },
                    shipping: { type: ['number', 'null'] },
                    checked_at: { type: ['string', 'null'] },
                  },
                },
              },
              last_checked_iso: { type: ['string', 'null'] },
            },
          },
          price_confidence: { type: 'number' },
        },
      },
      notes: {
        type: 'object',
        additionalProperties: false,
        required: ['unsure', 'warnings'],
        properties: {
          unsure: {
            type: 'array',
            items: { type: 'string' },
          },
          warnings: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    },
    additionalProperties: false,
  },
};

const suggestImagesTool = {
  type: 'function',
  name: 'suggest_product_images',
  description: 'Provide marketing-ready image URLs for the current product.',
  parameters: {
    type: 'object',
    properties: {
      rationale: { type: 'string' },
      images: {
        type: 'array',
        items: {
          type: 'object',
          required: ['url', 'source', 'variant', 'notes'],
          additionalProperties: false,
          properties: {
            url: { type: 'string' },
            source: { type: 'string' },
            variant: { type: 'string' },
            notes: { type: 'string' },
          },
        },
      },
    },
    required: ['images'],
  },
};

const generateAiImagesTool = {
  type: 'function',
  name: 'generate_ai_images',
  description:
    'Generate new marketing-ready product renders via the approved GPT Image 1 pipeline. Provide a reference image from the current product plus the desired style.',
  parameters: {
    type: 'object',
    properties: {
      reference_image_url: {
        type: 'string',
        description: 'URL of an existing product image to guide the edit/background swap.',
      },
      reference_variant: {
        type: 'string',
        description: 'Fallback: use a product image with this variant (front, angle, detail, pack, other).',
      },
      mode: {
        type: 'string',
        enum: ['studio', 'lifestyle', 'detail', 'all'],
        description: 'Desired render style. Defaults to all.',
      },
      sample_count: {
        type: 'number',
        minimum: 1,
        maximum: 4,
        description: 'How many variations should be generated (1-4).',
      },
      rationale: {
        type: 'string',
        description: 'Short note describing the creative goal or usage (e.g., Amazon hero, lifestyle social ad).',
      },
    },
    additionalProperties: false,
  },
};

const DIMENSION_KEYWORDS = {
  length: ['length', 'länge', 'longueur', 'largo', 'lange', 'len'],
  width: ['width', 'breite', 'larghezza', 'ancho', 'largeur'],
  height: ['height', 'höhe', 'alto', 'hauteur'],
  depth: ['depth', 'tiefe', 'profondità', 'profundidad'],
  weight: ['weight', 'gewicht', 'peso', 'poids', 'masse'],
  diameter: ['diameter', 'durchmesser', 'ø', 'diametre'],
};

function attributeArrayToObject(entries = []) {
  if (!Array.isArray(entries)) return {};
  return entries.reduce((acc, entry) => {
    if (!entry?.key) return acc;
    acc[entry.key] = entry.value ?? '';
    return acc;
  }, {});
}

function toAttributesObject(attributes = []) {
  if (!attributes) return {};
  if (Array.isArray(attributes)) {
    return attributeArrayToObject(attributes);
  }
  if (typeof attributes === 'object') {
    return Object.entries(attributes).reduce((acc, [key, value]) => {
      if (!key) return acc;
      acc[key] = value;
      return acc;
    }, {});
  }
  return {};
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

function sanitizeImageForContext(image = {}, index = 0) {
  const raw = typeof image?.url_or_base64 === 'string' ? image.url_or_base64 : '';
  const isInline = raw.startsWith('data:');
  return {
    index,
    id: image?.id || null,
    source: image?.source || 'unknown',
    variant: image?.variant || null,
    url: isInline ? `[inline-${image?.mimeType || 'image'}]` : raw,
    has_inline_data: isInline,
    width: image?.width ?? null,
    height: image?.height ?? null,
    notes: image?.notes || null,
  };
}

function ensureStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry === null || entry === undefined) return null;
      return String(entry);
    })
    .filter(Boolean);
}

function findAttributeValue(attrs = {}, keywords = []) {
  const loweredKeywords = keywords.map((keyword) => keyword.toLowerCase());
  for (const [key, value] of Object.entries(attrs)) {
    const loweredKey = key.toLowerCase();
    if (loweredKeywords.some((keyword) => loweredKey.includes(keyword))) {
      return value;
    }
  }
  return null;
}

function extractDimensionsFromAttributes(attrs = {}) {
  const dimensions = {};
  Object.entries(DIMENSION_KEYWORDS).forEach(([metric, keywords]) => {
    const match = findAttributeValue(attrs, keywords);
    if (match !== null && match !== undefined && match !== '') {
      dimensions[metric] = match;
    }
  });
  return dimensions;
}

function collectOcrData(product) {
  const ops = product?.ops || {};
  const textHints = ensureStringArray(ops.ocr_text || ops.ocrText);
  const numericHints = ensureStringArray(ops.ocr_numbers || ops.ocrNumbers);
  const barcodeSet = new Set();
  (Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : []).forEach((code) => {
    if (code) barcodeSet.add(code);
  });
  const identifiers = product?.details?.identifiers || {};
  ['ean', 'gtin', 'upc', 'mpn', 'sku'].forEach((key) => {
    if (identifiers?.[key]) {
      barcodeSet.add(identifiers[key]);
    }
  });
  return {
    text: textHints,
    numbers: numericHints,
    barcodes: Array.from(barcodeSet),
  };
}

function buildProductContext(product) {
  const attributes = toAttributesObject(product?.details?.attributes);
  const dimensions = extractDimensionsFromAttributes(attributes);
  const identifiers = {
    sku: product?.identification?.sku || product?.details?.identifiers?.sku || null,
    ean: product?.details?.identifiers?.ean || null,
    gtin: product?.details?.identifiers?.gtin || null,
    upc: product?.details?.identifiers?.upc || null,
    mpn: product?.details?.identifiers?.mpn || null,
    barcodes: Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : [],
  };

  const context = {
    identity: {
      id: product?.id || null,
      title: product?.identification?.name || null,
      brand: product?.identification?.brand || null,
      category: product?.identification?.category || null,
      sku: identifiers.sku,
    },
    copy: {
      short_description: product?.details?.short_description || '',
      key_features: Array.isArray(product?.details?.key_features) ? product.details.key_features : [],
    },
    attributes,
    dimensions,
    identifiers,
    pricing: product?.details?.pricing || null,
    ocr: collectOcrData(product),
    warehouse: {
      primary: product?.storage || null,
      bins: Array.isArray(product?.storageBins) ? product.storageBins : [],
    },
    inventory: {
      quantity: product?.inventory?.quantity ?? null,
      unit: product?.inventory?.unit || null,
      pending_intake: product?.ops?.pending_intake_quantity || 0,
    },
    images: (product?.details?.images || []).map((img, index) => sanitizeImageForContext(img, index)),
    notes: product?.notes || { unsure: [], warnings: [] },
    ops: {
      sync_status: product?.ops?.sync_status || 'pending',
      revision: product?.ops?.revision ?? 0,
      last_saved_iso: product?.ops?.last_saved_iso || null,
      last_synced_iso: product?.ops?.last_synced_iso || null,
    },
    locale: product?.locale || 'de-DE',
  };

  return context;
}

function buildContextImageParts(product) {
  const images = Array.isArray(product?.details?.images) ? product.details.images : [];
  return images
    .map((img) => (typeof img?.url_or_base64 === 'string' ? img.url_or_base64 : null))
    .filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url))
    .map((url) => ({
      type: 'input_image',
      image_url: url,
    }));
}

function clamp(value, min, max) {
  if (typeof value !== 'number' || Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function selectReferenceImage(product, { reference_image_url, reference_variant } = {}) {
  const images = Array.isArray(product?.details?.images) ? product.details.images : [];
  if (!images.length) {
    return null;
  }
  if (reference_image_url) {
    const targetKey = normalizeImageKey(reference_image_url);
    if (targetKey) {
      const match = images.find((img) => normalizeImageKey(img?.url_or_base64) === targetKey);
      if (match) return match;
    }
  }
  if (reference_variant) {
    const match = images.find((img) => (img?.variant || 'other') === reference_variant);
    if (match) return match;
  }
  return images[0];
}

function buildSystemPrompt(locale = 'de-DE') {
  return [
    'You are the AvyStock Product CoPilot. You always operate with full product awareness, including images, text, identifiers, warehouse data and OCR trails.',
    'Primary duties: audit and improve catalog data, detect inconsistencies, repair wrong identifications, fill missing specs, optimise SEO copy, and ensure marketplace compliance.',
    'Always cross-check highlights, descriptions, attributes, pricing, logistics data and warehouse status. Flag mismatches (e.g., weight vs. dimensions, bin quantity vs. inventory) and recommend concrete fixes.',
    'Interpret every supplied image: mention the angles, materials, packaging or defects you observe. If imagery is missing or weak, describe what should be captured next.',
    'Use BrightData via the provided web_fetch tool whenever external product, competitor or attribute data is required. Use serpapi_web_search for structured search. State when external evidence influenced your answer.',
    'Image capability: craft campaign-ready prompt ideas and, when new renders would help, call generate_ai_images with a matching reference image (prefer hero/front) plus the desired mode (studio, lifestyle, detail, all). Use suggest_product_images for curated third-party references.',
    'Editing rights: you may propose structured edits via update_product_datasheet or inline JSON. When you do so, include a valid JSON block exactly like {"edit": { "fieldName": "new value", ... }} in addition to prose. Keep JSON minimal and valid.',
    'Output style: respond in the user locale (default German: ' + locale + '). Structure replies with clear sections such as OVERVIEW, DIAGNOSTICS, RECOMMENDATIONS, NEXT-STEPS. Use bullet lists and cite data sources.',
    'Never hallucinate. If data is missing or doubtful, say so explicitly and suggest how to validate it (barcode scan, BrightData fetch, warehouse recount, etc.).',
  ].join('\n');
}

function buildUserPrompt(message, locale = 'de-DE') {
  return [
    `Nutzeranfrage (${locale}): ${message}`,
    'Erfülle die Anfrage unter Berücksichtigung aller Kontextdaten. Falls zusätzliche Aktionen nötig sind (BrightData Recherche, Bild-Generierung, Datenblatt-Update), nutze die bereitgestellten Werkzeuge.',
    'Halte dich an das geforderte Ausgabeschema und bleibe faktenbasiert.',
  ].join('\n\n');
}

function sanitizeImageSuggestions(entry) {
  if (!Array.isArray(entry?.images)) return [];
  return entry.images
    .filter((img) => typeof img.url === 'string' && img.url.startsWith('http'))
    .map((img) => ({
      url_or_base64: img.url,
      source: img.source || 'web',
      variant: img.variant || 'other',
      notes: img.notes || 'Vorschlag aus GPT-Chat',
    }));
}

function sanitizeDatasheetChange(entry) {
  const result = {};
  if (entry.summary) result.summary = entry.summary;
  if (entry.short_description) result.short_description = entry.short_description;
  if (Array.isArray(entry.key_features)) {
    result.key_features = entry.key_features.filter(Boolean);
  }
  if (Array.isArray(entry.attributes)) {
    result.attributes = attributeArrayToObject(entry.attributes);
  }
  if (entry.pricing) {
    result.pricing = entry.pricing;
  }
  if (entry.notes) {
    result.notes = entry.notes;
  }
  return result;
}

async function runProductChat(product, userMessage, { modelOverride = null } = {}) {
  const client = await getOpenAIClient();
  const targetModel = resolveModel(modelOverride, 'CHAT_MODEL', 'gpt-5-mini-2025-08-07');
  const locale = product?.locale || 'de-DE';
  const productContext = buildProductContext(product);
  const serializedContext = JSON.stringify(productContext, null, 2);
  const contextImageParts = buildContextImageParts(product);
  const inputMessages = [
    {
      role: 'system',
      content: [{ type: 'input_text', text: buildSystemPrompt(locale) }],
    },
    {
      role: 'system',
      content: [{ type: 'input_text', text: `system.context\n${serializedContext}` }, ...contextImageParts],
    },
    {
      role: 'user',
      content: [{ type: 'input_text', text: buildUserPrompt(userMessage, locale) }],
    },
  ];

  const datasheetChanges = [];
  const imageSuggestions = [];
  const serpTrace = [];
  const existingImageKeys = new Set(
    (product?.details?.images || [])
      .map((img) => normalizeImageKey(img?.url_or_base64 || img?.url))
      .filter(Boolean)
  );
  const existingImageUrls = (product?.details?.images || [])
    .map((img) => (typeof img?.url_or_base64 === 'string' ? img.url_or_base64 : null))
    .filter(Boolean);

  for (let iteration = 0; iteration < MAX_CHAT_ITERATIONS; iteration++) {
    const response = await client.responses.create({
      model: targetModel,
      input: inputMessages,
      tools: [
        serpapiToolDefinition,
        webFetchToolDefinition,
        updateDatasheetTool,
        suggestImagesTool,
        generateAiImagesTool,
      ],
      reasoning: { effort: 'low' },
      text: { verbosity: 'medium' },
    });

    const toolCalls = response.output.filter((item) => item.type === 'function_call');
    if (!toolCalls.length) {
      return {
        message: response.output_text?.trim() || 'Keine Antwort erhalten.',
        datasheetChanges,
        imageSuggestions,
        serpTrace,
        modelUsed: targetModel,
      };
    }

    inputMessages.push(...response.output);

    for (const toolCall of toolCalls) {
      let toolResult = null;
      if (toolCall.name === 'serpapi_web_search') {
        const result = await executeSerpapiToolCall(toolCall);
        serpTrace.push({
          type: 'serpapi',
          engine: result.engine,
          query: result.query,
          summary: result.summary,
          error: result.error || null,
        });
        toolResult = {
          summary: result.summary,
          error: result.error || null,
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
        toolResult = fetchResult;
      } else if (toolCall.name === 'update_product_datasheet') {
        const args = JSON.parse(toolCall.arguments || '{}');
        const sanitized = sanitizeDatasheetChange(args);
        datasheetChanges.push(sanitized);
        toolResult = { acknowledged: true, applied_fields: Object.keys(sanitized) };
      } else if (toolCall.name === 'suggest_product_images') {
        const args = JSON.parse(toolCall.arguments || '{}');
        const chatImages = sanitizeImageSuggestions(args).filter((img) => {
          const key = normalizeImageKey(img.url_or_base64);
          if (!key || existingImageKeys.has(key)) {
            return false;
          }
          existingImageKeys.add(key);
          existingImageUrls.push(img.url_or_base64);
          return true;
        });

        let marketingImages = [];
        try {
          const { images: fetchedImages, trace } = await fetchMarketingImages({
            brand: product?.identification?.brand,
            name: product?.identification?.name,
            exclude: existingImageUrls,
            limit: 8,
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
          marketingImages = fetchedImages
            .map((img) => ({
              url_or_base64: img.url,
              source: img.source || 'web',
              variant: 'marketing',
              notes: img.title || 'Marketing Bild',
            }))
            .filter((img) => {
              const key = normalizeImageKey(img.url_or_base64);
              if (!key || existingImageKeys.has(key)) {
                return false;
              }
              existingImageKeys.add(key);
              existingImageUrls.push(img.url_or_base64);
              return true;
            });
        } catch (error) {
          console.warn('Failed to fetch marketing images for chat:', error.message);
        }

        const combined = [...marketingImages, ...chatImages];
        if (combined.length) {
          imageSuggestions.push({
            rationale: args.rationale || '',
            images: combined,
          });
        }
        toolResult = { acknowledged: true, count: combined.length };
      } else if (toolCall.name === 'generate_ai_images') {
        const args = JSON.parse(toolCall.arguments || '{}');
        const referenceImage = selectReferenceImage(product, args);
        if (!referenceImage) {
          toolResult = {
            success: false,
            error: 'Kein geeignetes Referenzbild gefunden. Bitte gib eine bestehende Bild-URL oder Variante an.',
          };
        } else {
          try {
            const mode = args.mode || 'all';
            const sampleCount = clamp(Math.round(args.sample_count || 2), 1, 4);
            const generation = await generateImagesForProduct(product, {
              referenceImage,
              sampleCount,
              mode,
            });
            const aiImages = generation.images.filter((img) => {
              const key = normalizeImageKey(img?.url_or_base64);
              if (!key || existingImageKeys.has(key)) {
                return false;
              }
              existingImageKeys.add(key);
              existingImageUrls.push(img.url_or_base64);
              return true;
            });
            if (aiImages.length) {
              imageSuggestions.push({
                rationale: args.rationale || `KI-Render (${mode})`,
                images: aiImages,
              });
            }
            toolResult = {
              success: true,
              generated: aiImages.length,
              prompts: generation.prompts,
            };
          } catch (error) {
            console.error('Failed to generate AI images from chat:', error);
            toolResult = { success: false, error: error.message || 'Image generation failed' };
          }
        }
      } else {
        toolResult = { error: `Unknown tool ${toolCall.name}` };
      }

      inputMessages.push({
        type: 'function_call_output',
        call_id: toolCall.call_id,
        output: JSON.stringify(toolResult),
      });
    }
  }

  const err = new Error('Chat workflow exceeded maximum number of tool iterations.');
  err.modelUsed = targetModel;
  throw err;
}

module.exports = {
  runProductChat,
};

