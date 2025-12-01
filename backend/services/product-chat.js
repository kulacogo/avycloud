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
const DEEP_MODE_REGEX =
  /(mehr details|mehr detailliert|ausf(?:ue|ü)hrlich|voller report|lange analyse|bitte detailliert|detailliert|full report|detailed|long analysis)/i;
const MARKETING_IMAGE_REGEX =
  /(marketing|kampagne|kampagnen|werben|promo|produktfoto|produktbild|referenzbild|referenzbilder|imgurl|img url)/i;
const IMAGE_KEYWORDS = /(bild|bilder|image|images|foto|photos?|shot|render|packshot|url)/i;
const TEXT_LIKE_MIME = new Set(['text/plain', 'text/csv', 'application/json', 'text/json']);
const MAX_ATTACHMENT_PREVIEW_CHARS = 6000;
const MARKETING_MIN_RESULTS = 3;
const MARKETING_MAX_RESULTS = 6;

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

function detectConversationMode(message = '') {
  if (!message) return 'short';
  return DEEP_MODE_REGEX.test(message) ? 'deep' : 'short';
}

function isMarketingImageRequest(message = '') {
  if (!message) return false;
  if (!MARKETING_IMAGE_REGEX.test(message)) return false;
  return IMAGE_KEYWORDS.test(message);
}

function bufferToDataUrl(buffer, mimetype) {
  if (!buffer) return null;
  const base64 = buffer.toString('base64');
  return `data:${mimetype || 'application/octet-stream'};base64,${base64}`;
}

function normalizeChatAttachments(attachments = []) {
  if (!Array.isArray(attachments) || !attachments.length) {
    return { summary: [], imageParts: [] };
  }
  const summary = [];
  const imageParts = [];
  attachments.forEach((attachment, idx) => {
    if (!attachment?.buffer) return;
    const mimetype = attachment.mimetype || 'application/octet-stream';
    const entry = {
      name: attachment.originalname || `attachment_${idx + 1}`,
      mimetype,
      size: attachment.size || attachment.buffer.length || 0,
    };
    if (mimetype.startsWith('image/')) {
      const dataUrl = bufferToDataUrl(attachment.buffer, mimetype);
      if (dataUrl) {
        imageParts.push({
          type: 'input_image',
          image_url: dataUrl,
        });
        entry.inline_reference = `image_${imageParts.length}`;
      }
    } else if (TEXT_LIKE_MIME.has(mimetype)) {
      const textPreview = attachment.buffer.toString('utf8').slice(0, MAX_ATTACHMENT_PREVIEW_CHARS);
      entry.text_preview = textPreview;
    } else if (mimetype === 'application/pdf') {
      entry.note = 'PDF attachment available (not inlined).';
    } else {
      entry.note = 'Binary attachment provided.';
    }
    summary.push(entry);
  });
  return { summary, imageParts };
}

function buildExistingImageInventory(product) {
  const keys = new Set();
  const urls = [];
  (product?.details?.images || []).forEach((img) => {
    const value = typeof img?.url_or_base64 === 'string' ? img.url_or_base64 : null;
    if (!value) return;
    urls.push(value);
    const key = normalizeImageKey(value);
    if (key) {
      keys.add(key);
    }
  });
  return { keys, urls };
}

function convertTraceEntryToSerpInsight(entry) {
  if (!entry) return null;
  const summary =
    Array.isArray(entry.images) && entry.images.length
      ? entry.images.slice(0, 5).map((img) => ({
          title: img.source || entry.engine,
          url: img.url,
          source: img.source,
          snippet: img.width && img.height ? `${img.width}x${img.height}` : undefined,
        }))
      : undefined;
  return {
    engine: entry.engine || 'unknown',
    query: entry.query || '',
    summary,
    error: entry.error || null,
  };
}

function inferVariantFromText(text = '') {
  const lower = text.toLowerCase();
  if (/(pack|box|karton)/.test(lower)) return 'pack';
  if (/(front|hero)/.test(lower)) return 'front';
  if (/(angle|45|three|seitlich)/.test(lower)) return 'angle';
  if (/(detail|close|macro)/.test(lower)) return 'detail';
  return 'other';
}

function truncateWords(text = '', limit = 5) {
  if (!text) return '';
  const words = text.trim().split(/\s+/).slice(0, limit);
  return words.join(' ');
}

function labelForMarketingImage(image, index) {
  const variantLabels = {
    front: 'Hero front',
    angle: '45° angle',
    detail: 'Detail close-up',
    pack: 'Packshot',
    other: 'Lifestyle view',
  };
  if (image?.variant && variantLabels[image.variant]) {
    return variantLabels[image.variant];
  }
  if (image?.notes) {
    const snippet = truncateWords(image.notes, 5);
    if (snippet) return snippet;
  }
  return `Shot ${index + 1}`;
}

function mapWebImageToProductImage(entry) {
  if (!entry?.url) return null;
  return {
    source: 'web',
    variant: inferVariantFromText(entry.title || entry.source || ''),
    url_or_base64: entry.url,
    notes: entry.title || entry.source || 'Marketing Referenz',
    width: entry.width || null,
    height: entry.height || null,
  };
}

async function tryFetchWebMarketingImages(product, { limit, excludeUrls, existingKeys }) {
  const response = {
    images: [],
    trace: [],
  };
  const brand = product?.identification?.brand;
  const name = product?.identification?.name;
  const querySeed = [brand, name].filter(Boolean).join(' ').trim();
  if (!querySeed) {
    return response;
  }
  try {
    const { images, trace } = await fetchMarketingImages({
      brand,
      name,
      limit,
      exclude: excludeUrls,
    });
    if (Array.isArray(trace)) {
      trace.forEach((entry) => {
        const insight = convertTraceEntryToSerpInsight(entry);
        if (insight) response.trace.push(insight);
      });
    }
    images.forEach((img) => {
      const productImage = mapWebImageToProductImage(img);
      if (!productImage) return;
      const key = normalizeImageKey(productImage.url_or_base64);
      if (!key || existingKeys.has(key)) return;
      existingKeys.add(key);
      response.images.push(productImage);
    });
    return response;
  } catch (error) {
    console.warn('Failed to fetch marketing images:', error.message);
    response.trace.push({
      engine: 'marketing-images',
      query: querySeed,
      error: error.message,
    });
    return response;
  }
}

async function tryGenerateFallbackImages(product, existingKeys, neededCount = 1) {
  const referenceImage = selectReferenceImage(product);
  if (!referenceImage) {
    return { images: [], trace: [] };
  }
  try {
    const generation = await generateImagesForProduct(product, {
      referenceImage,
      sampleCount: Math.max(neededCount, 1),
      mode: 'all',
    });
    const aiImages = [];
    generation.images?.forEach((img) => {
      if (!img?.url_or_base64) return;
      const key = normalizeImageKey(img.url_or_base64);
      if (!key || existingKeys.has(key)) return;
      existingKeys.add(key);
      aiImages.push({
        ...img,
        source: 'generated',
      });
    });
    const trace = generation.prompts
      ? [
          {
            engine: 'gemini-2.5-flash-image',
            query: 'Gemini renders',
            summary: Object.entries(generation.prompts).map(([variant, prompt]) => ({
              title: variant,
              snippet: truncateWords(prompt, 20),
            })),
          },
        ]
      : [];
    return { images: aiImages, trace };
  } catch (error) {
    console.warn('Gemini fallback failed:', error.message);
    return {
      images: [],
      trace: [
        {
          engine: 'gemini-2.5-flash-image',
          query: 'Gemini renders',
          error: error.message,
        },
      ],
    };
  }
}

async function fulfillMarketingImageRequest(product) {
  const { keys: existingKeys, urls: existingUrls } = buildExistingImageInventory(product);
  const serpTrace = [];
  const webResult = await tryFetchWebMarketingImages(product, {
    limit: MARKETING_MAX_RESULTS + 2,
    excludeUrls: existingUrls,
    existingKeys,
  });
  serpTrace.push(...webResult.trace);

  let suggestions = webResult.images;
  if (suggestions.length < MARKETING_MIN_RESULTS) {
    const needed = MARKETING_MIN_RESULTS - suggestions.length;
    const fallback = await tryGenerateFallbackImages(product, existingKeys, needed);
    serpTrace.push(...fallback.trace);
    suggestions = suggestions.concat(fallback.images);
  }

  if (!suggestions.length) {
    return {
      message:
        'Keine externen Marketingbilder gefunden – ich brauche Herstellerlinks oder zusätzliche Produktfotos, dann suche ich erneut.',
      datasheetChanges: [],
      imageSuggestions: [],
      serpTrace,
      modelUsed: 'marketing-direct',
    };
  }

  const limited = suggestions.slice(0, MARKETING_MAX_RESULTS);
  const intro = `Hier ${limited.length} neue Marketing-Referenzen (keine deiner Uploads).`;
  const bullets = limited
    .map((img, idx) => `- ${img.url_or_base64} — ${labelForMarketingImage(img, idx)}`)
    .join('\n');
  const scarcityNote =
    limited.length < MARKETING_MIN_RESULTS
      ? '\nMehr Quellen finde ich erst mit Hersteller-Daten oder neuen Fotos.'
      : '';
  const message = `${intro}\n${bullets}${scarcityNote}\nLizenz prüfen, bevor du sie veröffentlichst.`;

  return {
    message,
    datasheetChanges: [],
    imageSuggestions: [
      {
        rationale: 'Marketingbilder',
        images: limited,
      },
    ],
    serpTrace,
    modelUsed: 'marketing-direct',
  };
}

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

function buildProductContext(product, { attachments = [], mode = 'short', marketingFocus = false } = {}) {
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
    attachments,
    meta: {
      conversation_mode: mode,
      marketing_focus: marketingFocus,
    },
  };

  return context;
}

function buildContextImageParts(product, extraImageParts = []) {
  const images = Array.isArray(product?.details?.images) ? product.details.images : [];
  const baseParts = images
    .map((img) => (typeof img?.url_or_base64 === 'string' ? img.url_or_base64 : null))
    .filter(Boolean)
    .map((url) => ({
      type: 'input_image',
      image_url: url,
    }));
  return [...baseParts, ...extraImageParts];
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
    'You are the AvyStock Product CoPilot.',
    'You always respond in SHORT, ACTIONABLE messages by default (≤10 short sentences or ~1000 characters, ≤3 bullets, no section headers).',
    'You have full product context (data, images, OCR, identifiers, inventory, warehouse info) and must cross-check for inconsistencies or missing facts.',
    'Use BrightData web_fetch only when external validation (competitors, specs) is truly needed; cite when you do.',
    'Interpret every supplied image (product gallery + user attachments) in concise wording; if imagery is weak, state what to shoot next.',
    'When the user explicitly asks for "mehr Details", "ausführlich", "voller Report", "lange Analyse" or similar, switch to DEEP MODE with structured sections and long explanations. Otherwise stay in SHORT MODE.',
    'Marketing-image requests must return exactly: one short sentence + a list of 3–6 concrete image URLs with 3–5 word labels (hero, lifestyle, detail, packshot, etc.). No long strategy unless explicitly asked.',
    'Never recycle the customer’s existing gallery URLs for marketing-image answers; prefer fresh web sources or new AI renders and state if none exist.',
    'When proposing product updates, explain briefly (1–2 sentences) and include a minimal JSON snippet called "edit" that only contains the changed fields.',
    'You can craft new render prompts and call generate_ai_images when fresh material would help; note variant and intent.',
    'Default language: ' + locale + '. Keep responses direct, avoid filler, offer deeper details only on request.',
  ].join('\n');
}

function buildUserPrompt({ message, locale = 'de-DE', mode = 'short', marketingFocus = false }) {
  const lines = [
    `User request (${locale}, mode=${mode}): ${message}`,
    mode === 'short'
      ? 'SHORT MODE active: keep answer ≤10 short sentences (~1000 chars), ≤3 bullet points, no section headings.'
      : 'DEEP MODE requested: structured sections and in-depth analysis are permitted for this reply.',
  ];
  if (!mode || mode === 'short') {
    lines.push("Offer a follow-up such as \"Wenn du Details willst, sag z.B. 'mehr Details'\" only if additional depth might help.");
  }
  if (marketingFocus) {
    lines.push(
      'Marketing images requested: respond with one short intro sentence and a bullet list of 3–6 concrete URLs labelled with 3–5 words (hero, lifestyle, detail, packshot, etc.). No extra analysis unless asked.'
    );
  }
  lines.push('If you propose edits, remember the {"edit": {...}} JSON rule.');
  return lines.join('\n\n');
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

async function runProductChat(product, userMessage, { modelOverride = null, attachments = [] } = {}) {
  const client = await getOpenAIClient();
  const targetModel = resolveModel(modelOverride, 'CHAT_MODEL', 'gpt-5.1');
  const locale = product?.locale || 'de-DE';
  const conversationMode = detectConversationMode(userMessage || '');
  const marketingFocus = isMarketingImageRequest(userMessage || '');
  const attachmentPayload = normalizeChatAttachments(attachments);
  if (marketingFocus) {
    const marketingResponse = await fulfillMarketingImageRequest(product);
    if (marketingResponse) {
      return marketingResponse;
    }
  }
  const productContext = buildProductContext(product, {
    attachments: attachmentPayload.summary,
    mode: conversationMode,
    marketingFocus,
  });
  const serializedContext = JSON.stringify(productContext, null, 2);
  const contextImageParts = buildContextImageParts(product, attachmentPayload.imageParts);
  const inputMessages = [
    {
      role: 'system',
      content: [{ type: 'input_text', text: buildSystemPrompt(locale) }],
    },
    {
      role: 'system',
      content: [{ type: 'input_text', text: `system.context\n${serializedContext}` }],
    },
  ];

  if (contextImageParts.length) {
    inputMessages.push({
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: 'Referenzbilder des Produkts (verwende sie zur visuellen Analyse, nicht neu generieren):',
        },
        ...contextImageParts,
      ],
    });
  }

  inputMessages.push({
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: buildUserPrompt({
          message: userMessage,
          locale,
          mode: conversationMode,
          marketingFocus,
        }),
      },
    ],
  });

  if (conversationMode === 'short') {
    inputMessages.push({
      role: 'system',
      content: [
        {
          type: 'input_text',
          text: 'SHORT MODE reminder: keep answers ≤10 short sentences (~1000 chars), ≤3 bullet points, no headings. Offer detailed follow-up only if the user requests it.',
        },
      ],
    });
  } else {
    inputMessages.push({
      role: 'system',
      content: [
        {
          type: 'input_text',
          text: 'DEEP MODE enabled: provide structured sections (Overview, Diagnostics, Recommendations, etc.) and cover all relevant insights thoroughly.',
        },
      ],
    });
  }

  if (marketingFocus) {
    inputMessages.push({
      role: 'system',
      content: [
        {
          type: 'input_text',
          text: 'Marketing-image request detected: respond with one short intro sentence and a bullet list of 3–6 concrete URLs labelled with 3–5 word descriptions (Hero, Lifestyle, Detail, Packshot, etc.).',
    },
      ],
    });
  }

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

