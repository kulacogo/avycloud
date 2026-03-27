const { getGeminiClient } = require('../lib/gemini-client');
const {
  serpapiToolDefinition,
  brightdataSearchToolDefinition,
  webFetchToolDefinition,
  executeSerpapiToolCall,
  executeBrightdataSearchToolCall,
  executeWebFetchToolCall,
} = require('./toolkit');
const { resolveModel } = require('../lib/model-select');
const { fetchMarketingImages } = require('../lib/marketing-images');
const { generateImagesForProduct } = require('./image-generation');
const { normalizeDigits, isValidGtin } = require('../lib/gtin');
const { coerceTitleToPolicy } = require('../lib/title-policy');
const { inferTitleCategory } = require('../lib/title-policy');
const { buildCommonPolicyText } = require('../lib/llm-policy-pack');
const { getActiveLlmConfig } = require('../lib/llm-config');
const { sanitizeListingText, sanitizeDescriptionToHtml, sanitizeHighlights } = require('../lib/listing-sanitize');
const { normalizeHighlightsStrict } = require('../lib/highlights-policy');
const {
  canonicalizeAttributeKey,
  canonicalizeAttributesStrict,
  coerceAttributeValueToPolicy,
  isBlockedAttributeKey,
} = require('../lib/attribute-policy');
const {
  getRequiredAspects,
  getCategoryAspectCatalog,
  buildRequiredAspectMeta,
  getRequiredAspectCatalogStats,
} = require('../lib/ebay-taxonomy');
const { getVehicleFitmentMode } = require('../lib/vehicle-fitment');
const { getRulebookConfigCached } = require('../lib/rulebook-config');
const { fetchCategoryTitleInsights } = require('../lib/ebay-browse-title-insights');
const { htmlToText } = require('../lib/web-search-html');
const { decodeHtmlEntitiesDeep } = require('../lib/html-entities');

const MAX_CHAT_ITERATIONS = 5;
const DEEP_MODE_REGEX =
  /(mehr details|mehr detailliert|ausf(?:ue|ü)hrlich|voller report|lange analyse|bitte detailliert|detailliert|full report|detailed|long analysis)/i;
// IMPORTANT: Be strict here. The chat prompts may contain the word "Marketing" (e.g. "keine Marketingfloskeln")
// even when the user wants a full datasheet rewrite. We only treat as "marketing image request" when the
// user explicitly asks for marketing/reference images or URLs.
const MARKETING_IMAGE_REGEX =
  /(marketingbild|marketingbilder|kampagne|kampagnen|werben|promo|produktfoto|produktbild|referenzbild|referenzbilder|imgurl|img url|web[-\s]?produktbild|web[-\s]?bild)/i;
const IMAGE_KEYWORDS = /(bild|bilder|image|images|foto|photos?|shot|render|packshot|url|produktbild)/i;
const WEB_ONLY_IMAGE_REGEX = /(nur\s+web|nur\s+internet|im\s+internet|web[-\s]?only|keine\s+ai|ohne\s+ai|no\s+ai|keine\s+generierung|ohne\s+generierung|web[-\s]?produktbild)/i;
const TEXT_LIKE_MIME = new Set(['text/plain', 'text/csv', 'application/json', 'text/json']);
const MAX_ATTACHMENT_PREVIEW_CHARS = 6000;
const MARKETING_MIN_RESULTS = 3;
const MARKETING_MAX_RESULTS = 6;
const BARCODE_INTENT_REGEX = /\b(ean|gtin|upc)\b/i;

/**
 * Regex-based intent detection (fast fallback).
 */
function detectIntentRegex(message) {
  const msg = String(message || '');
  const INFO_PATTERNS = [
    /\b(was ist|was sind|was bedeutet|wie ist|wie viel|wie viele|wie teuer|wann|wo|warum|welche|welcher|welches)\b/i,
    /\b(erkläre|erklär|beschreib|vergleiche|vergleich|unterschied|info|information)\b/i,
    /\b(preis|preise|kosten|marktpreis|wettbewerb|konkurrenz|markt|angebot)\b/i,
    /\b(gibt es|kann man|ist das|hat das|besitzt|enthält|beinhaltet)\b/i,
    /\b(what is|explain|how much|compare|difference|price|cost)\b/i,
  ];
  const ANALYSIS_PATTERNS = [
    /\b(analysiere|analyse|analysier|prüfe|prüf|bewerte|bewertet|überprüfe|überprüf)\b/i,
    /\b(qualität|datenqualität|vollständigkeit|check|checke|checklist|audit)\b/i,
    /\b(was fehlt|was ist falsch|was stimmt nicht|fehler|problem|probleme)\b/i,
    /\b(bericht|report|zusammenfassung|übersicht|wie gut|wie vollständig)\b/i,
  ];
  if (INFO_PATTERNS.some((p) => p.test(msg))) return 'info';
  if (ANALYSIS_PATTERNS.some((p) => p.test(msg))) return 'analysis';
  return 'change';
}

/**
 * LLM-based intent detection with regex fallback.
 * Uses a fast model to classify user intent into change/info/analysis.
 * Falls back to regex if LLM call fails or takes too long.
 */
async function detectIntent(message) {
  const msg = String(message || '').trim();
  if (!msg) return 'change';

  try {
    const genAI = getGeminiClient();
    const model = genAI.getGenerativeModel({
      model: resolveModel(null, 'CHAT_INTENT_MODEL', 'gemini-3-flash-preview'),
      generationConfig: { temperature: 0, maxOutputTokens: 10 },
    });

    const result = await Promise.race([
      model.generateContent(
        `Classify the user message intent for a product data assistant. Reply ONLY with one word: change, info, or analysis.

- "change": User wants to modify/update/improve product data (title, description, attributes, images, etc.)
- "info": User wants information, explanation, comparison, or pricing details
- "analysis": User wants a quality check, audit, or evaluation of the product data

User message: "${msg.slice(0, 500)}"

Intent:`
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Intent detection timeout')), 3000)),
    ]);

    const text = (result?.response?.text?.() || '').trim().toLowerCase();
    if (text === 'info' || text === 'analysis' || text === 'change') return text;
    // If LLM returned something unexpected, fall through to regex
  } catch (err) {
    // Silently fall back to regex on any error (timeout, API failure, etc.)
  }

  return detectIntentRegex(msg);
}

function strictRulesEnabled() {
  // Default is "no rules" per user request. Opt-in only.
  const b = (v) => {
    const s = (v || '').toString().trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes';
  };
  // Chat-specific switch. Defaults to ON for consistent quality.
  // Can be disabled via CHAT_STRICT_RULES_ENABLED=false if needed.
  const v = process.env.CHAT_STRICT_RULES_ENABLED;
  if (v !== undefined) return b(v);
  return b(process.env.STRICT_RULES_ENABLED) || true;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeSpaces(value = '') {
  return safeString(value).replace(/\s+/g, ' ').trim();
}

const WEDDING_TERM_RE = /\b(hochzeit|braut|bräutigam|braeutigam|wedding|bride|groom)\b/gi;
const WEDDING_TERM_TEST_RE = /\b(hochzeit|braut|bräutigam|braeutigam|wedding|bride|groom)\b/i;
const UMLAUT_TITLE_REPLACEMENTS = [
  [/\bBraeutigam\b/gi, 'Bräutigam'],
  [/\bBraeute\b/gi, 'Bräute'],
  [/\bBrautigam\b/gi, 'Bräutigam'],
  [/\bBräeutigam\b/gi, 'Bräutigam'],
  [/\bGroesse\b/gi, 'Größe'],
  [/\bHoehe\b/gi, 'Höhe'],
  [/\bFuer\b/gi, 'Für'],
  [/\bfuer\b/gi, 'für'],
];

function hasWeddingEvidenceInProduct(product) {
  const attrs = product?.details?.attributes && typeof product.details.attributes === 'object'
    ? product.details.attributes
    : {};
  const corpus = [
    product?.identification?.name,
    product?.identification?.category,
    product?.details?.short_description,
    ...Object.keys(attrs || {}),
    ...Object.values(attrs || {}).map((v) => (typeof v === 'string' ? v : '')),
  ]
    .filter(Boolean)
    .join(' ');
  return WEDDING_TERM_TEST_RE.test(corpus);
}

function normalizeGermanTitleLanguage(rawTitle = '', product = null) {
  let title = normalizeSpaces(rawTitle);
  if (!title) return '';
  for (const [pattern, replacement] of UMLAUT_TITLE_REPLACEMENTS) {
    title = title.replace(pattern, replacement);
  }
  if (!hasWeddingEvidenceInProduct(product)) {
    title = normalizeSpaces(title.replace(WEDDING_TERM_RE, ' '));
  }
  title = title.replace(/\s+([,.;:!?])/g, '$1').replace(/[,\-–—:;]+$/g, '').trim();
  return normalizeSpaces(title);
}

const TITLE_INSIGHT_TOKEN_RE = /^[0-9a-zA-ZäöüÄÖÜß+\-_/().]{2,24}$/;

function normalizeTitleInsightToken(raw) {
  return safeString(raw)
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isValidTitleInsightToken(token) {
  if (!token || !TITLE_INSIGHT_TOKEN_RE.test(token)) return false;
  if (/^(ean|gtin|upc|isbn)$/i.test(token)) return false;
  if (/^\d{8,14}$/.test(token)) return false;
  return true;
}

function extractTitleCandidateFromAssistantMessage(text = '') {
  const raw = safeString(text);
  if (!raw) return '';
  const lines = raw
    .split(/\r?\n/g)
    .map((line) => safeString(line))
    .filter(Boolean);
  for (const line of lines) {
    const m = line.match(/titel[-\s]?vorschlag(?:\s*\(\d+\/80\))?\s*:\s*(.+)$/i);
    if (m && m[1]) return safeString(m[1]);
  }
  for (const line of lines) {
    const cleaned = safeString(line.replace(/^[-*•\d.)\s]+/, ''));
    if (!cleaned) continue;
    if (cleaned.length < 12 || cleaned.length > 140) continue;
    if (/^\{/.test(cleaned) || /^\[/.test(cleaned)) continue;
    if (/^(hinweis|begruendung|begründung|analyse|summary)\b/i.test(cleaned)) continue;
    return cleaned;
  }
  return '';
}

function extractTitleInsightTokens(insights, { maxTokens = 8 } = {}) {
  const raw = Array.isArray(insights?.topTokens) ? insights.topTokens : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const candidate =
      typeof item === 'string'
        ? item
        : item && typeof item === 'object'
          ? item.token || item.value || item.word || ''
          : '';
    const normalized = normalizeTitleInsightToken(candidate);
    if (!isValidTitleInsightToken(normalized)) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= Math.max(1, Math.min(20, Number(maxTokens) || 8))) break;
  }
  return out;
}

async function loadTitleInsightsForProduct(product, { limit = 80, maxTokens = 8 } = {}) {
  const categoryId = resolveProductCategoryId(product);
  const output = {
    categoryId: categoryId || null,
    topTokens: [],
    sampledTitles: [],
    error: null,
  };
  if (!categoryId) return output;
  try {
    const insights = await fetchCategoryTitleInsights({ categoryId, limit: Math.max(10, Math.min(200, Number(limit) || 80)) });
    output.topTokens = extractTitleInsightTokens(insights, { maxTokens });
    output.sampledTitles = Array.isArray(insights?.sampleTitles)
      ? insights.sampleTitles.map((t) => safeString(t)).filter(Boolean).slice(0, 5)
      : [];
  } catch (e) {
    output.error = safeString(e?.message || e) || 'title_insights_unavailable';
  }
  return output;
}

function decodePlainText(value) {
  return decodeHtmlEntitiesDeep(value).replace(/\s+/g, ' ').trim();
}

const EVIDENCE_URL_BONUS_TOKENS = [
  'datenblatt',
  'datasheet',
  'manual',
  'bedienungsanleitung',
  'spec',
  'specs',
  'specification',
  'technical',
  'produktseite',
];

function scoreEvidenceUrl({ url = '', title = '', snippet = '' } = {}) {
  const u = safeString(url).toLowerCase();
  const t = safeString(title).toLowerCase();
  const s = safeString(snippet);
  if (!u.startsWith('http')) return -999;

  let score = 0;
  if (u.endsWith('.pdf')) score += 4;
  if (EVIDENCE_URL_BONUS_TOKENS.some((tok) => u.includes(tok) || t.includes(tok))) score += 2;
  if (s.length >= 140) score += 1;
  if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(u)) score -= 5;
  return score;
}

function pickBestUrl(results = []) {
  const list = Array.isArray(results) ? results : [];
  const scored = list
    .map((r, idx) => ({
      url: r?.url || '',
      title: r?.title || '',
      snippet: r?.snippet || '',
      score: scoreEvidenceUrl({ url: r?.url, title: r?.title, snippet: r?.snippet }),
      idx,
    }))
    .filter((r) => safeString(r.url).startsWith('http'));
  scored.sort((a, b) => (b.score || 0) - (a.score || 0) || (a.idx || 0) - (b.idx || 0));
  return scored[0] || null;
}

async function forceOneEvidencePass(product, userMessage, { scope = null, notesOnly = false, titleHintTokens = [] } = {}) {
  const locale = 'de-DE';
  const title = safeString(product?.identification?.name);
  const brand = safeString(product?.identification?.brand);
  const sku = safeString(product?.identification?.sku || product?.details?.identifiers?.sku);
  const barcodes = Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : [];
  const barcode = safeString(barcodes.find(Boolean));
  const userHint = safeString(userMessage);

  // Build product-specific query candidates (do NOT rely on userMessage, which may be generic like "Titel verbessern").
  // Prefer short, high-signal queries to reduce SERP failures.
  const candidates = [
    barcode || null,
    barcode && brand ? `${barcode} ${brand}` : null,
    brand && title ? `${brand} ${title}` : null,
    title || null,
    sku || null,
    userHint || null,
  ]
    .filter(Boolean)
    .map((q) => String(q).trim())
    .filter(Boolean)
    .map((q) => q.slice(0, 120));
  const traces = [];

  let results = [];
  let usedQuery = '';

  for (const query of candidates) {
    // Broad web search (no site-limits). We do NOT prefer marketplaces over the wider web.
    const broad = await executeBrightdataSearchToolCall({
      arguments: JSON.stringify({ query, locale, limit: 8 }),
    });
    traces.push({
      type: 'brightdata',
      engine: broad.engine,
      query: broad.query,
      summary: (broad.results || []).slice(0, 8).map((r) => ({
        title: r.title || '',
        source: r.site || 'web',
        url: r.url || '',
        snippet: r.snippet || '',
        price: null,
      })),
      error: broad.error || null,
    });
    results = broad?.results || [];
    usedQuery = query;

    if (Array.isArray(results) && results.length > 0) {
      break;
    }
  }

  const best = pickBestUrl(results);
  if (!best?.url) {
    // Ensure we still return *one* structured change (notes) so the UI always has "Übernehmen".
    return {
      datasheetChanges: [
        {
          summary: 'Web-Recherche (BrightData): keine Treffer',
          notes: {
            unsure: [
              `Keine verwertbaren Web-Treffer gefunden (broad web search). Query candidates tried: ${candidates.slice(0, 4).join(' | ')}`,
            ],
            warnings: [],
          },
        },
      ],
      traces,
    };
  }

  // 3) Fetch 1 page via Unlocker
  const fetched = await executeWebFetchToolCall({
    arguments: JSON.stringify({ url: best.url, method: 'GET', format: 'raw', timeout_ms: 45000 }),
  });
  traces.push({
    type: 'web_fetch',
    url: fetched.url,
    status: fetched.status,
    error: fetched.error || null,
  });

  const html = typeof fetched?.body === 'string' ? fetched.body : '';
  const text = html ? htmlToText(html).slice(0, 20000) : '';

  // 4) Deterministic: force ONE update_product_datasheet tool call using evidence
  const client = await getGeminiClient();
  const updateOnlyTools = [{ functionDeclarations: [toGeminiTool(updateDatasheetTool)] }];
  const updateOnlyModel = client.getGenerativeModel({
    model: resolveModel(null, 'CHAT_MODEL', 'gemini-3-pro-preview'),
    tools: updateOnlyTools,
    toolConfig: {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: ['update_product_datasheet'],
      },
    },
    systemInstruction: [
      'You are a strict executor.',
      'You MUST call update_product_datasheet exactly once.',
      'Do not output any plain text.',
      'Use only facts you can back with the provided WEB EVIDENCE snippet.',
      ...(notesOnly
        ? [
            'IMPORTANT: notesOnly=true. You MUST ONLY write to the top-level "notes" field (unsure/warnings).',
            'Do not change title, identity, attributes, pricing, key_features, short_description, gpsr, images, category.',
          ]
        : ['If evidence is insufficient, set notes.unsure and avoid changing title/attributes/specs.']),
    ].join('\n'),
  });

  const prompt = [
    `User goal: ${safeString(userMessage)}`,
    scope ? `SCOPE=${String(scope)}` : '',
    '',
    'WEB EVIDENCE SOURCE URL:',
    best.url,
    '',
    'WEB EVIDENCE (text excerpt):',
    text || '(empty)',
  ].filter(Boolean).join('\n');

  const updateResp = await updateOnlyModel.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });
  const calls = updateResp.response.functionCalls?.() || [];
  const call = calls.find((c) => c?.name === 'update_product_datasheet');
  const changeArgs = call?.args && typeof call.args === 'object' ? call.args : {};
  const sanitized = sanitizeDatasheetChange(changeArgs, product, { scope, titleHintTokens });
  const nextChange = sanitized?.change && typeof sanitized.change === 'object' ? sanitized.change : {};
  if (!Object.keys(nextChange).length) {
    // Ensure at least notes exist
    return {
      datasheetChanges: [
        {
          summary: 'Web-Recherche (BrightData): keine sicheren Änderungen',
          notes: {
            unsure: [
              `Quelle gelesen, aber keine sicheren extrahierbaren Daten gefunden: ${best.url}`,
            ],
            warnings: [],
          },
        },
      ],
      traces,
    };
  }
  return { datasheetChanges: [nextChange], traces };
}

// Helper to recursively clean JSON schema for Gemini (e.g. remove null types)
function cleanSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(cleanSchemaForGemini);

  const cleaned = { ...schema };

  // Fix type arrays: type: ["string", "null"] -> type: "string"
  if (Array.isArray(cleaned.type)) {
    const validTypes = cleaned.type.filter(t => t !== 'null');
    cleaned.type = validTypes.length === 1 ? validTypes[0] : validTypes[0] || 'string'; // Fallback to first non-null or string
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

  // Remove keys invalid for Gemini function schemas if present
  delete cleaned.additionalProperties;
  delete cleaned.default;

  return cleaned;
}

function toGeminiTool(def) {
  return {
    name: def.name,
    description: def.description,
    parameters: cleanSchemaForGemini(def.parameters),
  };
}

const updateDatasheetTool = {
  name: 'update_product_datasheet',
  description: 'Propose structured changes to the currently visible product datasheet. Do not persist automatically – the user must confirm.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      // Title policy is enforced in code; keep schema flexible to avoid blocking tool calls.
      title: { type: 'string', minLength: 10, maxLength: 140 },
      // Identity patches (used for title/brand/category/sku/barcodes; EAN/GTIN/UPC are accepted and mapped to barcodes).
      identity: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 10, maxLength: 140 },
          name: { type: 'string', minLength: 10, maxLength: 140 },
          brand: { type: 'string' },
          category: { type: 'string' },
          sku: { type: 'string' },
          barcodes: {
            type: 'array',
            items: { type: 'string' },
          },
          // Allow direct barcode identifiers; we normalize+validate and store them in barcodes.
          ean: { type: 'string' },
          gtin: { type: 'string' },
          upc: { type: 'string' },
        },
      },
      short_description: { type: 'string' },
      key_features: {
        type: 'array',
        items: { type: 'string' },
      },
      // GPSR/Compliance: MUST be stored under details.gpsr (never as attributes).
      gpsr: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entity_country: { type: 'string' },
          country_code: { type: 'string' },
          manufacturer_name: { type: 'string' },
          manufacturer_address: { type: 'string' },
          manufacturer_city: { type: 'string' },
          manufacturer_postalcode: { type: 'string' },
          manufacturer_state_province: { type: 'string' },
          email: { type: 'string' },
          manufacturer_phone: { type: 'string' },
          url: { type: 'string' },
        },
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
  name: 'generate_ai_images',
  description:
    'Generate exactly 4 photorealistic studio packshots (front, 45° angle, top-down, detail) using a reference image from the current product. No lifestyle / real-world scenes.',
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
      rationale: {
        type: 'string',
        description: 'Short note describing the goal (e.g., eBay hero packshot).',
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
      // Gemini expects inline data differently usually, but we can pass base64
      // For prompt construction
      const dataUrl = bufferToDataUrl(attachment.buffer, mimetype);
      if (dataUrl) {
        imageParts.push({
          inlineData: {
            data: attachment.buffer.toString("base64"),
            mimeType: mimetype
          }
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

function summarizePromptMap(promptMap) {
  if (!promptMap || typeof promptMap !== 'object') {
    return [];
  }
  const summaries = [];
  Object.entries(promptMap).forEach(([group, value]) => {
    if (value && typeof value === 'object') {
      Object.entries(value).forEach(([key, text]) => {
        if (typeof text === 'string' && text.trim()) {
          summaries.push({
            title: `${group}.${key}`,
            snippet: truncateWords(text, 20),
          });
        }
      });
    } else if (typeof value === 'string' && value.trim()) {
      summaries.push({
        title: group,
        snippet: truncateWords(value, 20),
      });
    }
  });
  return summaries;
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
  // Extract category for search context — helps disambiguate generic brands (e.g. "Bader" sells everything)
  const rawCategory = product?.identification?.category || '';
  const categoryParts = String(rawCategory).split(/[>\/,;]/).map((s) => s.trim()).filter(Boolean);
  // Use the most specific (last) category segment, e.g. "Möbel > Sofas & Sessel" → "Sofas & Sessel"
  const category = categoryParts.length > 0 ? categoryParts[categoryParts.length - 1] : '';

  const identifiers = [];
  const barcodes = Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : [];
  barcodes.forEach((code) => {
    if (code) identifiers.push(String(code).trim());
  });
  const detIds = product?.details?.identifiers || {};
  ['ean', 'gtin', 'upc', 'mpn', 'sku'].forEach((key) => {
    if (detIds[key]) identifiers.push(String(detIds[key]).trim());
  });
  // MPN/model helps a lot for web image search when brand+title are generated/normalized.
  const mpnCandidate =
    detIds?.mpn ||
    product?.details?.attributes?.mpn ||
    product?.details?.attributes?.model ||
    product?.details?.attributes?.modell ||
    '';
  try {
    const { images, trace } = await fetchMarketingImages({
      brand,
      name,
      category,
      identifiers,
      mpn: mpnCandidate,
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
          summary: summarizePromptMap(generation.prompts),
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

async function fulfillMarketingImageRequest(product, { allowGeneratedFallback = true } = {}) {
  const { keys: existingKeys, urls: existingUrls } = buildExistingImageInventory(product);
  const serpTrace = [];
  const webResult = await tryFetchWebMarketingImages(product, {
    limit: MARKETING_MAX_RESULTS + 2,
    excludeUrls: existingUrls,
    existingKeys,
  });
  serpTrace.push(...webResult.trace);

  let suggestions = webResult.images;
  if (allowGeneratedFallback && suggestions.length === 0) {
    const needed = MARKETING_MIN_RESULTS;
    const fallback = await tryGenerateFallbackImages(product, existingKeys, needed);
    serpTrace.push(...fallback.trace);
    suggestions = suggestions.concat(fallback.images);
  }

  if (!suggestions.length) {
    const errors = serpTrace
      .filter((t) => t && typeof t === 'object' && t.error)
      .map((t) => `${t.engine || 'engine'}: ${t.error}`)
      .slice(0, 2);
    const tried = serpTrace
      .filter((t) => t && typeof t === 'object' && t.engine && t.query)
      .map((t) => `${t.engine}: ${t.query}`)
      .slice(0, 3);
    const help =
      (tried.length ? `\nTried: ${tried.join(' | ')}` : '') +
      (errors.length ? `\nErrors: ${errors.join(' | ')}` : '') +
      '\nTipp: EAN/GTIN oder Hersteller-/Shop-Link erhöht Trefferquote stark.';
    return {
      message:
        'Keine externen Web-Bilder gefunden.' + help,
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
    const key = decodePlainText(entry.key);
    if (!key) return acc;
    const value = typeof entry.value === 'string' ? decodePlainText(entry.value) : entry.value ?? '';
    acc[key] = value;
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
      const cleanedKey = decodePlainText(key);
      if (!cleanedKey) return acc;
      acc[cleanedKey] = typeof value === 'string' ? decodePlainText(value) : value;
      return acc;
    }, {});
  }
  return {};
}

function applyDatasheetChangeToProductPreview(product, change) {
  if (!product || typeof product !== 'object') return;
  const c = change && typeof change === 'object' ? change : {};
  const identity = c.identity && typeof c.identity === 'object' ? c.identity : {};

  product.identification = product.identification || {};
  product.details = product.details || {};
  product.details.identifiers = product.details.identifiers || {};

  const nextTitle = safeString(c.title || identity.name || identity.title);
  if (nextTitle) {
    product.identification.name = nextTitle;
  }

  const nextBrand = safeString(identity.brand);
  if (nextBrand) {
    product.identification.brand = nextBrand;
  }

  const nextCategory = safeString(identity.category);
  if (nextCategory) {
    product.identification.category = nextCategory;
  }

  const barcodeCandidates = []
    .concat(Array.isArray(identity.barcodes) ? identity.barcodes : [])
    .concat([identity.ean, identity.gtin, identity.upc])
    .map((v) => safeString(v))
    .filter(Boolean);
  if (barcodeCandidates.length) {
    const existing = Array.isArray(product.identification.barcodes) ? product.identification.barcodes : [];
    const merged = Array.from(new Set(existing.concat(barcodeCandidates)));
    product.identification.barcodes = merged;
  }

  if (typeof c.short_description === 'string') {
    product.details.short_description = c.short_description;
  }

  if (Array.isArray(c.key_features)) {
    product.details.key_features = c.key_features.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
  }

  if (c.attributes && typeof c.attributes === 'object' && !Array.isArray(c.attributes)) {
    const existingAttrs =
      product.details.attributes && typeof product.details.attributes === 'object' && !Array.isArray(product.details.attributes)
        ? product.details.attributes
        : {};
    product.details.attributes = { ...existingAttrs, ...c.attributes };
  }

  if (c.pricing && typeof c.pricing === 'object' && !Array.isArray(c.pricing)) {
    const existingPricing = product.details.pricing && typeof product.details.pricing === 'object' ? product.details.pricing : {};
    product.details.pricing = { ...existingPricing, ...c.pricing };
  }
}

function resolveProductCategoryId(product, attributes = null) {
  const attrs = attributes && typeof attributes === 'object' ? attributes : toAttributesObject(product?.details?.attributes);
  return (
    [
      product?.details?.categoryId,
      product?.details?.ebayCategoryId,
      product?.classification?.ebayCategoryId,
      product?.marketplace?.ebay?.categoryId,
      attrs?.ebay_category_id,
      attrs?.ebayCategoryId,
      attrs?.category_id,
      attrs?.categoryId,
      attrs?.['ebay.category_id'],
    ]
      .map((value) => safeString(value))
      .find((value) => /^\d+$/.test(value)) || null
  );
}

function normalizeAspectToken(value) {
  const token = safeString(value)
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '');
  if (!token) return '';
  if (token === 'groesse' || token === 'size') return 'size';
  if (
    token === 'marke' ||
    token === 'brand' ||
    token === 'hersteller' ||
    token === 'manufacturer' ||
    token === 'herstellername' ||
    token === 'manufacturername'
  ) {
    return 'brand';
  }
  if (token === 'ean' || token === 'gtin') return 'gtin';
  if (token === 'herstellernummer' || token === 'manufacturerpartnumber' || token === 'mpn') return 'mpn';
  if (
    token === 'hoehe' ||
    token === 'height' ||
    token === 'dicke' ||
    token === 'staerke' ||
    token === 'materialstaerke' ||
    token === 'thickness'
  ) {
    return 'hoehe';
  }
  if (token.includes('fahrradtyp')) return 'fahrradtyp';
  if (token.includes('fahrradgroesse') || token.includes('fahrradsize')) return 'fahrradgroesse';
  return token;
}

function remapAttributesToRequiredAspects(attributes = {}, requiredAspects = []) {
  const input = attributes && typeof attributes === 'object' && !Array.isArray(attributes) ? attributes : {};
  const requiredByToken = new Map();
  (Array.isArray(requiredAspects) ? requiredAspects : []).forEach((aspect) => {
    const label = safeString(aspect);
    const token = normalizeAspectToken(label);
    if (!label || !token || requiredByToken.has(token)) return;
    requiredByToken.set(token, label);
  });
  if (!requiredByToken.size) return input;

  const out = {};
  Object.entries(input).forEach(([key, value]) => {
    const token = normalizeAspectToken(key);
    const canonicalKey = requiredByToken.get(token) || key;
    const existing = out[canonicalKey];
    const existingText = safeString(existing);
    const nextText = safeString(value);
    if (existing === undefined || !existingText) {
      out[canonicalKey] = value;
      return;
    }
    if (!nextText) return;
    if (existingText.toLowerCase() === nextText.toLowerCase()) return;
    // Keep first value deterministic and surface conflicts in notes later if needed.
  });
  return out;
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

function hasValidLocalBarcode(product) {
  const codes = [];
  if (Array.isArray(product?.identification?.barcodes)) {
    codes.push(...product.identification.barcodes);
  }
  const ids = product?.details?.identifiers || {};
  ['ean', 'gtin', 'upc', 'mpn', 'sku'].forEach((key) => {
    if (ids[key]) codes.push(ids[key]);
  });
  return codes.some((code) => {
    const digits = normalizeDigits(code);
    return !!digits && isValidGtin(digits);
  });
}

function buildProductContext(product, { attachments = [], mode = 'short', marketingFocus = false, titleInsights = null } = {}) {
  const attributes = toAttributesObject(product?.details?.attributes);
  const dimensions = extractDimensionsFromAttributes(attributes);
  const categoryIdRaw = resolveProductCategoryId(product, attributes);
  const requiredAspects = categoryIdRaw ? getRequiredAspects(categoryIdRaw) : [];
  const aspectCatalog = categoryIdRaw ? getCategoryAspectCatalog(categoryIdRaw) : null;
  const requiredMeta = buildRequiredAspectMeta(categoryIdRaw, product?.details?.attributes || {});
  const aspectStats = getRequiredAspectCatalogStats();
  const vehicleFitmentMode = categoryIdRaw ? getVehicleFitmentMode(categoryIdRaw) : null;
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
      categoryId: categoryIdRaw,
      sku: identifiers.sku,
    },
    ebay: {
      categoryId: categoryIdRaw,
      required_aspects: Array.isArray(requiredAspects) ? requiredAspects : [],
      allowed_aspects:
        aspectCatalog && Array.isArray(aspectCatalog.allAspects) ? aspectCatalog.allAspects : Array.isArray(requiredAspects) ? requiredAspects : [],
      aspect_catalog_meta: {
        has_catalog_entry: Boolean(aspectCatalog?.hasCatalogEntry),
        has_aspect_data: Boolean(aspectCatalog?.hasAspectData),
        counts: {
          required: Array.isArray(aspectCatalog?.requiredAspects) ? aspectCatalog.requiredAspects.length : 0,
          recommended: Array.isArray(aspectCatalog?.recommendedAspects) ? aspectCatalog.recommendedAspects.length : 0,
          optional: Array.isArray(aspectCatalog?.optionalAspects) ? aspectCatalog.optionalAspects.length : 0,
          allowed: Array.isArray(aspectCatalog?.allAspects) ? aspectCatalog.allAspects.length : 0,
        },
      },
      aspect_catalog: {
        required: Array.isArray(aspectCatalog?.requiredAspects) ? aspectCatalog.requiredAspects : [],
        recommended: Array.isArray(aspectCatalog?.recommendedAspects) ? aspectCatalog.recommendedAspects : [],
        optional: Array.isArray(aspectCatalog?.optionalAspects) ? aspectCatalog.optionalAspects : [],
      },
      required_aspects_meta: {
        category_known: Boolean(requiredMeta?.categoryKnown),
        has_aspect_data: Boolean(requiredMeta?.hasAspectData),
        coverage_status: requiredMeta?.coverageStatus || null,
        missing_required_aspects: Array.isArray(requiredMeta?.missingAspects) ? requiredMeta.missingAspects : [],
        provided_required_aspects: Array.isArray(requiredMeta?.providedRequiredAspects) ? requiredMeta.providedRequiredAspects : [],
        catalog_coverage: `${aspectStats.categoriesWithAspectData}/${aspectStats.totalCategories}`,
      },
      vehicle_fitment_mode: vehicleFitmentMode,
      title_insights: {
        category_id: titleInsights?.categoryId || categoryIdRaw || null,
        top_tokens: Array.isArray(titleInsights?.topTokens) ? titleInsights.topTokens : [],
        sampled_titles: Array.isArray(titleInsights?.sampledTitles) ? titleInsights.sampledTitles : [],
        error: titleInsights?.error || null,
      },
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
      primary: product?.warehouse?.storage || product?.storage || null,
      bins: Array.isArray(product?.warehouse?.storageBins) ? product.warehouse.storageBins : (Array.isArray(product?.storageBins) ? product.storageBins : []),
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
    timestamp: new Date().toISOString(),
  };

  return context;
}

function buildContextImageParts(product, extraImageParts = []) {
  const images = Array.isArray(product?.details?.images) ? product.details.images : [];
  // Use a max of 4 images for context to avoid overloading
  const baseParts = images
    .slice(0, 4)
    .map((img) => (typeof img?.url_or_base64 === 'string' ? img.url_or_base64 : null))
    .filter(Boolean)
    // Filter out data URLs if they are too large, but Gemini handles them. 
    // Ideally we fetch them and convert to inlineData, yet here we might pass URLs if Gemini supports them?
    // Gemini supports URLs in some contexts (Vertex), but in AI Studio / standard SDK:
    // If it's a public URL, we might need to fetch it.
    // However, simplified approach: we rely on text descriptions for now unless we have base64.
    // Wait, the original code had 'image_url'.
    // We will attempt to use text descriptions for URLs to be safe, or if available, pass inline data.
    // For now, let's skip image URLs in 'user' parts and rely on the context description unless we are sure.
    // Actually, let's keep it simple: we rely on the textual description in 'buildProductContext'.
    // If the user uploaded attachments (extraImageParts), we use those (inlineData).
    .map((url) => null) // Placeholder to disable efficient URL handling for now
    .filter(Boolean);

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
  const policyEnabled = (process.env.LLM_POLICY_ENABLED || '').toString().trim().toLowerCase();
  const rulesOn = policyEnabled === '1' || policyEnabled === 'true' || policyEnabled === 'yes';
  return [
    'You are the AvyStock Product CoPilot.',
    'Primary objective: make the product data marketplace-ready (complete, factual, compliant). Prioritize evidence-backed identifiers/specs and filling missing required aspects.',
    'You always respond in SHORT, ACTIONABLE messages by default (≤10 short sentences or ~1000 characters, ≤3 bullets, no section headers).',
    'You have full product context (data, images, OCR, identifiers, inventory, warehouse info) and must cross-check for inconsistencies or missing facts.',
    'For category work: use only valid eBay category IDs/breadcrumbs and treat ebay.required_aspects_meta.missing_required_aspects as mandatory enrichment backlog.',
    'Best-Match focus: optimize for relevance + completeness + listing quality, not for keyword stuffing.',
    'Title rule: build search-native eBay titles (70-80 chars). Structure: [Brand] [Product Type] [Model] [Key Specs] [Condition]. Front-load brand + product type for mobile. Never include EAN/GTIN, SKU, company names/legal forms (GmbH, Sp. K, Ltd.), marketing fluff, or competitor brands.',
    'Description rule: provide structured HTML listing copy (<p>, <ul>, <li>, <strong>) and keep it substantial (target around 180-240 words when evidence is sufficient).',
    'Auto-parts title rule: prioritize part type + OE/MPN + installation position; keep compatibility mainly in K-Typ/item specifics.',
    'Aspect naming rule: when proposing attributes for eBay, use ONLY exact keys from ebay.allowed_aspects (fallback: ebay.required_aspects). Never invent new attribute keys.',
    'Encoding rule: return plain UTF-8 text values (e.g. "60 °C", "Öko-Tex"), never HTML entities like "&deg;" or "&Ouml;".',
    'German spelling rule: use real umlauts (ä, ö, ü, ß) in German words; avoid transliterations like ae/oe/ue unless the source explicitly uses them as a brand token.',
    'Relevance rule: do not add wedding terms (e.g. Hochzeit, Bräutigam) unless they are explicitly evidenced by the product data or fetched source.',
    'Use BrightData web_fetch only when external validation (competitors, specs) is truly needed; cite when you do.',
    'Interpret every supplied image (product gallery + user attachments) in concise wording; if imagery is weak, state what to shoot next.',
    'When the user explicitly asks for "mehr Details", "ausführlich", "voller Report", "lange Analyse" or similar, switch to DEEP MODE with structured sections and long explanations. Otherwise stay in SHORT MODE.',
    'Marketing-image requests must return exactly: one short sentence + a list of 3–6 concrete image URLs with 3–5 word labels (hero, lifestyle, detail, packshot, etc.). No long strategy unless explicitly asked.',
    "Never recycle the customer's existing gallery URLs for marketing-image answers; prefer fresh web sources. Do NOT call generate_ai_images unless the user EXPLICITLY asks for AI-generated/rendered images.",
    'When the user asks for "Web-Produktbilder", "Produktbilder", or "Bilder suchen", ALWAYS use web search (brightdata_web_search) to find REAL product photos from shops/marketplaces. Never substitute with AI-generated images.',
    'When proposing product updates, explain briefly (1–2 sentences) and include a minimal JSON snippet called "edit" that only contains the changed fields.',
    ...(rulesOn
      ? [
          'QUALITY RULES:',
          '- Title: search-native & searchable, preferably 70–80 chars, never exceed 80.',
          '- No marketing fluff, no emojis, no duplicates, no leading symbols, no SKU/internal IDs.',
        ]
      : [
          'QUALITY RULES:',
          '- Prefer evidence-backed, search-native titles; keep them searchable and ≤80 chars.',
        ]),
    'Only call generate_ai_images when the user EXPLICITLY requests AI-rendered images (e.g. "erstelle KI-Bilder", "generiere Bilder"). For "Web-Produktbilder" or "Produktbilder suchen", always use web search tools instead.',
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
  lines.push('Vehicle fitment rule: If ebay.vehicle_fitment_mode is set, do NOT invent K-Typ. Only propose K-Typ if it is present in OCR/attachments or provided WEB-EVIDENZ.');
  lines.push('Category rule: use only valid eBay category IDs/breadcrumbs; do not propose non-eBay categories.');
  lines.push('Title rule: prioritize ebay.title_insights.top_tokens as buyer search keywords; keep title <=80 chars and factual.');
  lines.push('Consistency rule: never mix conflicting identity tokens (e.g. Damen + Herren, mixed brands) in one title.');
  lines.push('Title rule: first 3-5 words are CTR-critical; front-load brand + product type + key differentiator.');
  lines.push('Keyword governance: use 2-3 primary buyer-intent keywords + max 1-2 synonyms; avoid keyword stuffing/chains.');
  lines.push('Description rule: return HTML structure (<p>, <ul>, <li>, <strong>) and keep it substantial (target around 180-240 words when evidence is sufficient).');
  lines.push('Auto-parts title rule: prioritize part type + OE/MPN + installation position; keep compatibility mainly in K-Typ/item specifics.');
  lines.push('Never include EAN/GTIN/UPC/ISBN or unverifiable claims in titles.');
  lines.push('Aspect rule: prioritize filling ebay.required_aspects_meta.missing_required_aspects with evidence-backed values, and use ONLY exact aspect names from ebay.allowed_aspects (fallback: ebay.required_aspects).');
  lines.push('Output encoding rule: never use HTML entities in attribute values; use plain UTF-8 characters.');
  lines.push('German spelling rule: use real umlauts (ä, ö, ü, ß); avoid ae/oe/ue transliterations unless they are part of an official brand token.');
  lines.push('Relevance rule: do not inject wedding terms like "Hochzeit/Bräutigam" unless product context or web evidence explicitly supports them.');
  lines.push('If you propose edits, remember the {"edit": {...}} JSON rule.');
  return lines.join('\n\n');
}

function buildDescriptionFallbackFacts(product, entry = {}) {
  const attrs = toAttributesObject(entry?.attributes || product?.details?.attributes);
  const facts = [];
  const pushFact = (value) => {
    const text = safeString(value);
    if (!text) return;
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    facts.push(normalized);
  };

  const brand = safeString(entry?.identity?.brand || product?.identification?.brand);
  const productType = safeString(attrs?.Produktart || attrs?.Produkttyp || attrs?.Artikeltyp);
  const modelOrRef = safeString(
    attrs?.Modell ||
      attrs?.Model ||
      attrs?.Herstellernummer ||
      attrs?.MPN ||
      product?.details?.identifiers?.mpn
  );
  const dimensions = safeString(
    attrs?.['Maße'] ||
      attrs?.['Abmessungen'] ||
      [attrs?.['Länge'], attrs?.['Breite'], attrs?.['Höhe'] || attrs?.['Dicke']].filter(Boolean).join(' x ')
  );
  const material = safeString(attrs?.Material || attrs?.Werkstoff || attrs?.Obermaterial);
  const usage = safeString(
    attrs?.Anwendung ||
      attrs?.['Geeignet für'] ||
      attrs?.Verwendungszweck ||
      attrs?.Kompatibilität ||
      [attrs?.Fahrzeugmarke, attrs?.Fahrzeugmodell].filter(Boolean).join(' ')
  );

  if (brand || productType) {
    pushFact(`${[brand, productType].filter(Boolean).join(' ')} wird als passgenauer Artikel angeboten.`);
  }
  if (modelOrRef) {
    pushFact(`Modell bzw. Referenznummer: ${modelOrRef}.`);
  }
  if (dimensions) {
    pushFact(`Wichtige Maße/Formfaktoren: ${dimensions}.`);
  }
  if (material) {
    pushFact(`Material und Verarbeitung: ${material}.`);
  }
  if (usage) {
    pushFact(`Einsatzbereich bzw. Kompatibilität: ${usage}.`);
  }

  const highlights = Array.isArray(entry?.key_features) && entry.key_features.length
    ? entry.key_features
    : Array.isArray(product?.details?.key_features)
      ? product.details.key_features
      : [];
  highlights.slice(0, 5).forEach((item) => pushFact(item));

  return Array.from(new Set(facts));
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

function parseScopeSet(scope = null) {
  const raw = safeString(scope).toLowerCase();
  if (!raw) return new Set();
  const out = new Set();
  raw
    .split(/[,\s|;]+/g)
    .map((token) => safeString(token))
    .filter(Boolean)
    .forEach((tokenRaw) => {
      const token = tokenRaw.toLowerCase();
      if (token === 'all' || token === 'full') {
        out.add('datasheet');
        return;
      }
      if (token === 'ean' || token === 'barcode' || token === 'barcodes') {
        out.add('gtin');
        return;
      }
      if (token === 'attr' || token === 'attrs') {
        out.add('attributes');
        return;
      }
      out.add(token);
    });
  return out;
}

function mergeUniqueStringList(...lists) {
  const out = [];
  const seen = new Set();
  lists.forEach((list) => {
    (Array.isArray(list) ? list : []).forEach((value) => {
      const item = safeString(value);
      if (!item) return;
      const key = item.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(item);
    });
  });
  return out;
}

function consolidateDatasheetChanges(changes = []) {
  const list = Array.isArray(changes) ? changes : [];
  if (!list.length) return null;

  const merged = {};
  let summary = '';

  list.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    if (typeof entry.summary === 'string' && safeString(entry.summary)) {
      summary = safeString(entry.summary);
    }
    if (typeof entry.title === 'string' && safeString(entry.title)) {
      merged.title = safeString(entry.title);
    }
    if (typeof entry.short_description === 'string' && safeString(entry.short_description)) {
      merged.short_description = entry.short_description;
    }
    if (Array.isArray(entry.key_features) && entry.key_features.length) {
      merged.key_features = entry.key_features.filter((x) => safeString(x));
    }
    if (entry.attributes && typeof entry.attributes === 'object' && !Array.isArray(entry.attributes)) {
      merged.attributes = { ...(merged.attributes || {}), ...entry.attributes };
    }
    if (entry.pricing && typeof entry.pricing === 'object' && !Array.isArray(entry.pricing)) {
      merged.pricing = entry.pricing;
    }
    if (entry.gpsr && typeof entry.gpsr === 'object' && !Array.isArray(entry.gpsr)) {
      merged.gpsr = { ...(merged.gpsr || {}), ...entry.gpsr };
    }
    if (entry.notes && typeof entry.notes === 'object' && !Array.isArray(entry.notes)) {
      merged.notes = {
        unsure: mergeUniqueStringList(merged?.notes?.unsure, entry?.notes?.unsure),
        warnings: mergeUniqueStringList(merged?.notes?.warnings, entry?.notes?.warnings),
      };
    }
    if (entry.identity && typeof entry.identity === 'object' && !Array.isArray(entry.identity)) {
      const nextIdentity = { ...(merged.identity || {}), ...entry.identity };
      nextIdentity.barcodes = mergeUniqueStringList(merged?.identity?.barcodes, entry?.identity?.barcodes);
      if (!nextIdentity.barcodes.length) {
        delete nextIdentity.barcodes;
      }
      merged.identity = nextIdentity;
    }
  });

  if (merged.title && (!merged.identity || !safeString(merged.identity.name))) {
    merged.identity = { ...(merged.identity || {}), name: merged.title };
  }
  if (!merged.title && merged.identity && typeof merged.identity.name === 'string' && safeString(merged.identity.name)) {
    merged.title = safeString(merged.identity.name);
  }
  if (merged.attributes && !Object.keys(merged.attributes).length) delete merged.attributes;
  if (merged.gpsr && !Object.keys(merged.gpsr).length) delete merged.gpsr;
  if (merged.notes && !merged.notes.unsure?.length && !merged.notes.warnings?.length) delete merged.notes;

  const meaningfulKeys = Object.keys(merged).filter((key) => key !== 'summary');
  if (!meaningfulKeys.length) return null;
  merged.summary = summary || 'Änderung aus Chat';
  return merged;
}

function sanitizeDatasheetChange(entry, product, { scope = null, titleHintTokens = [] } = {}) {
  const result = {};
  const policyIssues = [];
  const strict = strictRulesEnabled();
  const isValidSku = (value) => {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (trimmed.length > 64) return false;
    return /^[A-Za-z0-9._\\-\\/]+$/.test(trimmed);
  };

  const scopeSet = parseScopeSet(scope);
  const unrestrictedScope = scopeSet.size === 0 || scopeSet.has('datasheet');
  const scopeAllows = (...tokens) =>
    unrestrictedScope || tokens.some((token) => scopeSet.has(String(token || '').toLowerCase()));
  const allow = {
    title: scopeAllows('title'),
    brand: scopeAllows('datasheet'),
    category: scopeAllows('category'),
    sku: scopeAllows('datasheet'),
    barcodes: scopeAllows('gtin'),
    pricing: scopeAllows('pricing'),
    description: scopeAllows('description'),
    highlights: scopeAllows('highlights'),
    attributes: scopeAllows('attributes'),
    gpsr: scopeAllows('gpsr'),
    notes: true,
  };

  if (entry.summary) result.summary = entry.summary;
  if (allow.description && typeof entry.short_description === 'string') {
    const cleaned = sanitizeListingText(entry.short_description, { maxLen: 2600 });
    const htmlDescription = sanitizeDescriptionToHtml(entry.short_description || cleaned, {
      maxLen: 2600,
      minVisibleChars: 320,
      fallbackFacts: buildDescriptionFallbackFacts(product, entry),
    });
    if (htmlDescription) {
      result.short_description = htmlDescription;
      const visibleLen = safeString(htmlDescription.replace(/<[^>]+>/g, ' ')).length;
      if (strict && visibleLen < 220) {
        policyIssues.push('description:too_short_after_html_policy');
      }
    } else {
      if (strict) policyIssues.push('description:rejected_empty_after_sanitize');
    }
  }
  if (allow.attributes && entry.attributes) {
    if (Array.isArray(entry.attributes)) {
      result.attributes = attributeArrayToObject(entry.attributes);
    } else if (typeof entry.attributes === 'object') {
      result.attributes = entry.attributes;
    }
  }
  if (allow.pricing && entry.pricing) {
    result.pricing = entry.pricing;
  }
  if (allow.notes && entry.notes) {
    result.notes = entry.notes;
  }

  // GPSR: accept only known keys, trim strings, never invent.
  if (allow.gpsr && entry.gpsr && typeof entry.gpsr === 'object') {
    const next = {};
    [
      'entity_country',
      'country_code',
      'manufacturer_name',
      'manufacturer_address',
      'manufacturer_city',
      'manufacturer_postalcode',
      'manufacturer_state_province',
      'email',
      'manufacturer_phone',
      'url',
    ].forEach((k) => {
      const v = typeof entry.gpsr[k] === 'string' ? entry.gpsr[k].trim() : '';
      if (v) next[k] = v;
    });
    // If GPSR fields exist but manufacturer_name is missing, fill from product brand.
    // This keeps data consistent with listing expectations (brand-known but manufacturer blank).
    if (!next.manufacturer_name) {
      const brand = typeof product?.identification?.brand === 'string' ? product.identification.brand.trim() : '';
      if (brand) {
        const hasAnyGpsrField = Object.entries(next).some(([k, v]) => k !== 'manufacturer_name' && typeof v === 'string' && v.trim());
        if (hasAnyGpsrField) {
          next.manufacturer_name = brand;
        }
      }
    }
    if (Object.keys(next).length) {
      result.gpsr = next;
    }
  }

  const identityPatch = {};
  const barcodeSet = new Set();
  const pushBarcode = (value) => {
    if (!value) return;
    const digits = normalizeDigits(value);
    if (digits && isValidGtin(digits)) {
      barcodeSet.add(digits);
    }
  };

  const normalizeLower = (v) => (v == null ? '' : String(v).trim().toLowerCase());
  const isMarketplaceKey = (key) => {
    const k = normalizeLower(key);
    if (!k) return false;
    // Any marketplace-specific attribute must never be stored.
    if (k.includes('ebay')) return true;
    if (k.includes('kaufland')) return true;
    return false;
  };
  const isBarcodeAttrKey = (key) => {
    const k = normalizeLower(key);
    if (!k) return false;
    return (
      k === 'ean' ||
      k === 'gtin' ||
      k === 'upc' ||
      k === 'barcode' ||
      k === 'barcodes' ||
      k === 'ean/gtin' ||
      k.includes('ean') ||
      k.includes('gtin') ||
      k.includes('upc')
    );
  };

  if (allow.barcodes && Array.isArray(entry.barcodes)) {
    entry.barcodes.forEach(pushBarcode);
  }
  // IMPORTANT:
  // Title must be coerced AFTER we apply identity/attribute patches, otherwise we get mismatches like:
  // - brand/model updated (e.g. IKEA/RANARP), but title still computed from old product state
  // - SKU tokens leaking from attribute values/title hints
  let rawTitleCandidate = null;
  const considerTitleCandidate = (value) => {
    if (!allow.title) return;
    if (typeof value !== 'string') return;
    const t = value.trim();
    if (!t) return;
    rawTitleCandidate = t;
  };

  if (typeof entry.title === 'string') {
    considerTitleCandidate(entry.title);
  }
  if (entry.identity && typeof entry.identity === 'object') {
    if (typeof entry.identity.title === 'string') {
      considerTitleCandidate(entry.identity.title);
    }
    if (typeof entry.identity.name === 'string') {
      considerTitleCandidate(entry.identity.name);
    }
    if (allow.brand && typeof entry.identity.brand === 'string' && entry.identity.brand.trim()) {
      identityPatch.brand = entry.identity.brand.trim();
    }
    if (allow.category && typeof entry.identity.category === 'string' && entry.identity.category.trim()) {
      identityPatch.category = entry.identity.category.trim();
    }
    if (allow.sku && typeof entry.identity.sku === 'string' && isValidSku(entry.identity.sku)) {
      identityPatch.sku = entry.identity.sku.trim();
    }
    if (allow.barcodes && Array.isArray(entry.identity.barcodes)) {
      entry.identity.barcodes.forEach(pushBarcode);
    }
    if (allow.barcodes && typeof entry.identity.gtin === 'string') {
      pushBarcode(entry.identity.gtin);
    }
    if (allow.barcodes && typeof entry.identity.ean === 'string') {
      pushBarcode(entry.identity.ean);
    }
    if (allow.barcodes && typeof entry.identity.upc === 'string') {
      pushBarcode(entry.identity.upc);
    }
  }
  if (allow.sku && entry.sku && isValidSku(entry.sku)) {
    identityPatch.sku = entry.sku.trim();
  }

  // Sanitize attributes:
  // - Drop marketplace-specific keys (ebay/kaufland*)
  // - Move barcode-like attribute keys into barcodes (never keep them as attributes)
  if (result.attributes && typeof result.attributes === 'object') {
    const cleaned = {};
    for (const [rawKey, rawValue] of Object.entries(result.attributes)) {
      const key = decodePlainText(rawKey);
      if (!key) continue;
      if (isMarketplaceKey(key)) continue;
      if (isBarcodeAttrKey(key)) {
        pushBarcode(rawValue);
        continue;
      }
      if (isBlockedAttributeKey(key)) {
        // Never store internal/meta keys as attributes (delete-only).
        continue;
      }
      const value = typeof rawValue === 'string' ? decodePlainText(rawValue) : rawValue;
      const coerced = coerceAttributeValueToPolicy(key, value, { maxLen: 60 });
      if (!coerced) continue;
      cleaned[key] = coerced;
    }
    let normalizedAttrs = cleaned;
    const categoryIdForAspects = resolveProductCategoryId(product);
    if (categoryIdForAspects) {
      const requiredAspects = getRequiredAspects(categoryIdForAspects);
      if (Array.isArray(requiredAspects) && requiredAspects.length) {
        normalizedAttrs = remapAttributesToRequiredAspects(cleaned, requiredAspects);
      }
    }
    if (Object.keys(normalizedAttrs).length) {
      result.attributes = normalizedAttrs;
    } else {
      delete result.attributes;
    }
  }

  // Attributes strict: canonicalize + prevent conflicts against existing datasheet.
  // We keep this best-effort (per-key) so one conflict doesn't block all other attribute improvements.
  if (allow.attributes && result.attributes && typeof result.attributes === 'object' && !Array.isArray(result.attributes)) {
    if (!strict) {
      // No-rules mode: keep sanitized attributes as-is (we already removed marketplace/meta keys above).
      // Do not canonicalize and do not reject conflicts.
      // (We still prevent barcodes/marketplace keys from being stored as attributes.)
    } else {
    // 1) Canonicalize incoming-only first (detect self-conflicts).
    const incomingStrict = canonicalizeAttributesStrict(result.attributes);
    if (!incomingStrict.ok) {
      policyIssues.push(...incomingStrict.issues.map((x) => `attributes:${x}`));
      delete result.attributes;
    } else {
      const canonicalIncoming = incomingStrict.attributes || {};

      // 2) Build a tolerant canonical view of existing attributes (no rejection; we just need conflict detection).
      const existing = (product?.details?.attributes && typeof product.details.attributes === 'object' && !Array.isArray(product.details.attributes))
        ? product.details.attributes
        : {};
      const existingCanonical = new Map(); // canonicalKeyLower -> valueLower
      for (const [rawKey, rawVal] of Object.entries(existing)) {
        if (!rawKey) continue;
        if (isBlockedAttributeKey(rawKey)) continue;
        const ck = canonicalizeAttributeKey(rawKey);
        const ckLower = normalizeLower(ck);
        if (!ckLower) continue;
        const valLower = normalizeLower(rawVal);
        if (!valLower) continue;
        if (!existingCanonical.has(ckLower)) {
          existingCanonical.set(ckLower, valLower);
        }
      }

      // 3) Reject incoming keys that would conflict with existing canonical value.
      const accepted = {};
      for (const [k, v] of Object.entries(canonicalIncoming)) {
        const ckLower = normalizeLower(k);
        const incomingValLower = normalizeLower(v);
        const existingValLower = existingCanonical.get(ckLower);
        if (existingValLower && incomingValLower && existingValLower !== incomingValLower) {
          policyIssues.push(`attributes:conflict_with_existing:${k}`);
          continue;
        }
        accepted[k] = v;
      }
      if (Object.keys(accepted).length) {
        result.attributes = accepted;
      } else {
        delete result.attributes;
      }
    }
    }
  }

  // Highlights strict: enforce category-aware bullet rules (count/length/template, no banned text).
  if (allow.highlights && Array.isArray(entry.key_features)) {
    const list = entry.key_features.filter(Boolean);
    if (!strict) {
      // No-rules mode: keep non-empty bullets after delete-only sanitization
      result.key_features = sanitizeHighlights(list, { minLen: 8, maxItems: 7 });
    } else {
      const draftProduct = {
        ...product,
        identification: {
          ...(product?.identification || {}),
          ...(identityPatch || {}),
        },
      };
      const hi = normalizeHighlightsStrict(draftProduct, list);
      if (!hi.ok) {
        policyIssues.push(...hi.issues.map((x) => `highlights:${x}`));
      } else {
        result.key_features = hi.highlights;
      }
    }
  }

  // Now coerce title using a draft product with merged patches (so brand/model/category/attributes are considered).
  const shouldForceTitleCoercion = allow.title;
  if (!rawTitleCandidate && shouldForceTitleCoercion) {
    rawTitleCandidate = safeString(product?.identification?.name || '');
  }

  if (rawTitleCandidate) {
    const baseAttrs = toAttributesObject(product?.details?.attributes);
    const patchAttrs = result.attributes && typeof result.attributes === 'object' ? result.attributes : {};
    const mergedAttrs = { ...baseAttrs, ...patchAttrs };
    const draftProduct = {
      ...product,
      identification: {
        ...(product?.identification || {}),
        ...(identityPatch || {}),
      },
      details: {
        ...(product?.details || {}),
        attributes: mergedAttrs,
      },
    };
    // Title policy is handled in `coerceTitleToPolicy` and is rule-free by default in this setup.
    // In strict mode we keep historical bucket-based min/soft limits; in no-rules mode we only enforce maxLen.
    let minLen = 70;
    let maxLen = 80;
    let softMaxLen = 80;
    if (strict) {
      const cfg = getRulebookConfigCached();
      const bucket = inferTitleCategory(draftProduct);
      const rule =
        (cfg?.title?.rulesBySchema && cfg.title.rulesBySchema[bucket]) || cfg?.title || {};
      minLen = Number(rule?.minLen || 70);
      maxLen = Number(rule?.maxLen || 80);
      softMaxLen = Number(rule?.softMaxLen || 80);
    }
    const extraHintTokens = Array.isArray(titleHintTokens)
      ? titleHintTokens.map(normalizeTitleInsightToken).filter(isValidTitleInsightToken).slice(0, 12)
      : [];
    const coerced = coerceTitleToPolicy(draftProduct, rawTitleCandidate, {
      minLen,
      maxLen,
      softMaxLen,
      extraHintTokens,
      forcePolicy: false,
    });
    const normalizedTitle = normalizeGermanTitleLanguage(coerced, draftProduct);
    identityPatch.name = normalizedTitle || coerced;
    // Keep an explicit title field so the frontend can display/apply it directly.
    result.title = normalizedTitle || coerced;
  }

  if (Object.keys(identityPatch).length) {
    if (barcodeSet.size) {
      identityPatch.barcodes = Array.from(barcodeSet);
    }
    result.identity = identityPatch;
  } else if (barcodeSet.size && allow.barcodes) {
    result.identity = { barcodes: Array.from(barcodeSet) };
  }
  return { change: result, policyIssues };
}

// --- Main Chat Function (Gemini) ---

async function runProductChat(product, userMessage, {
  modelOverride = null,
  attachments = [],
  scope = null,
  history = [],      // Conversation history: [{role, parts}] from chat-sessions.getGeminiHistory()
  onProgress = null, // Progress callback for SSE streaming: (event) => void
} = {}) {
  const client = await getGeminiClient();
  const modelName = resolveModel(modelOverride, 'CHAT_MODEL', 'gemini-3-pro-preview');

  const locale = 'de-DE';
  const intent = await detectIntent(userMessage || '');
  const conversationMode = detectConversationMode(userMessage || '');
  const marketingFocus = isMarketingImageRequest(userMessage || '');
  const webOnlyImages = marketingFocus && WEB_ONLY_IMAGE_REGEX.test(userMessage || '');
  const barcodeIntent = BARCODE_INTENT_REGEX.test(userMessage || '');
  const hasLocalValidBarcode = hasValidLocalBarcode(product);
  const attachmentPayload = normalizeChatAttachments(attachments);

  if (marketingFocus) {
    const marketingResponse = await fulfillMarketingImageRequest(product, {
      // If the user asks explicitly for web-only images, do not generate fallback AI renders.
      allowGeneratedFallback: !webOnlyImages,
    });
    if (marketingResponse) {
      return marketingResponse;
    }
  }

  // K-Typ enrichment fallback for chat (auto parts) so the assistant can propose K-Typ in updates.
  try {
    // Ensure eBay category normalization is applied (some products only have legacy category meta fields).
    const { applyEbayTaxonomy } = require('./enrichment');
    applyEbayTaxonomy(product);

    const { enrichKTypIfPossible } = require('../lib/ktype-enrichment');
    await enrichKTypIfPossible(product, { reason: 'chat' });
  } catch (e) {
    // Never block chat due to enrichment issues.
    try {
      product.notes = product.notes || {};
      product.notes.warnings = Array.from(
        new Set([
          ...(product.notes.warnings || []),
          `K-Typ nicht angereichert: interner Fehler (chat).`,
        ])
      );
    } catch {
      // ignore
    }
    if (process.env.DEBUG_KTYPE) {
      console.warn('[chat] K-Typ enrichment failed (continuing):', e?.message || e);
    }
  }

  const titleInsights = await loadTitleInsightsForProduct(product, {
    limit: Math.max(10, Math.min(200, Number(process.env.CHAT_TITLE_INSIGHTS_LIMIT) || 80)),
    maxTokens: Math.max(1, Math.min(20, Number(process.env.CHAT_TITLE_INSIGHTS_MAX_TOKENS) || 8)),
  });
  const titleHintTokens = Array.isArray(titleInsights?.topTokens) ? titleInsights.topTokens : [];

  const productContext = buildProductContext(product, {
    attachments: attachmentPayload.summary,
    mode: conversationMode,
    marketingFocus,
    titleInsights,
  });
  const serializedContext = JSON.stringify(productContext, null, 2);

  // Prepare tools
  const SERPAPI_ENABLED = (process.env.SERPAPI_ENABLED || '').toString().trim().toLowerCase() === 'true';
  const tools = [
    {
      functionDeclarations: [
        toGeminiTool(brightdataSearchToolDefinition),
        ...(SERPAPI_ENABLED ? [toGeminiTool(serpapiToolDefinition)] : []),
        toGeminiTool(webFetchToolDefinition),
        toGeminiTool(updateDatasheetTool),
        toGeminiTool(suggestImagesTool),
        toGeminiTool(generateAiImagesTool),
      ],
    },
  ];

  // Enhanced System Prompt for Autonomy (with optional admin-managed overrides)
  const baseSystemPrompt = buildSystemPrompt(locale);
  const baseRules = buildCommonPolicyText({ locale, allowWebEvidence: true });

  const llmConfig = await getActiveLlmConfig('chat.product');
  const promptMode = llmConfig?.promptMode === 'replace' ? 'replace' : 'append';
  const rulesMode = llmConfig?.rulesMode === 'replace' ? 'replace' : 'append';
  const promptOverride = typeof llmConfig?.promptText === 'string' ? llmConfig.promptText : '';
  const rulesOverride = typeof llmConfig?.rulesText === 'string' ? llmConfig.rulesText : '';

  const effectivePrompt =
    promptOverride && promptMode === 'replace'
      ? promptOverride
      : [baseSystemPrompt, promptOverride].filter(Boolean).join('\n\n');
  const effectiveRules =
    rulesOverride && rulesMode === 'replace'
      ? rulesOverride
      : [baseRules, rulesOverride].filter(Boolean).join('\n\n');

  const systemPromptText = effectivePrompt + `
  
  ${effectiveRules}

  CRITICAL RULES:
  1. DO NOT ASK the user for search queries or "what marketplace to check". derivation of queries is YOUR job.
  2. Web research strategy (BrightData):
     - Start with brightdata_web_search (unrestricted web). Use the "sites" parameter to scope to specific domains when useful.
     - If results are empty/insufficient: refine the query (barcode/EAN, brand + model, MPN) and search again.
     - Use serpapi_web_search with engines like google_images, bing_images, amazon, ebay when you need marketplace-specific data or image results.
  3. After you found candidate URLs, fetch the best 1-2 pages via 'web_fetch' and extract facts from them (no guessing).
  4. Never say "I can search if you want". JUST SEARCH.
  5. **ALWAYS** use the 'update_product_datasheet' tool when you propose ANY data changes (title, description, attributes, etc.). Do NOT just output JSON text. The tool call IS the way to propose changes.
  6. DO NOT ASK for confirmation ("Should I update?"). Just CALL THE TOOL. The user's UI acts as the confirmation. Asking is a failure.
  7. GPSR updates MUST be returned under the top-level "gpsr" object (not in attributes). Never create keys like "GPSR Manufacturer name" inside attributes.
  8. IMAGE RULES:
     - When the user asks for "Web-Produktbilder", "Produktbilder" or any image search: use serpapi_web_search with engine "google_images" or "bing_images" to find REAL product images. Then return them via suggest_product_images.
     - Alternatively, use brightdata_web_search to find product pages and extract image URLs from them.
     - NEVER call generate_ai_images as a response to image search requests. AI image generation is ONLY for explicit requests like "erstelle KI-Bilder" or "generiere Render".
     - Product images must be REAL photos from manufacturer sites, shops, or marketplaces.
  10. SCOPE COMPLIANCE: Read the user's request carefully. If they ask for specific things (e.g. only images, only price, only title), do EXACTLY that. Do not add unrequested changes or commentary.
  11. ATTRIBUTE LENGTH: Attribute/item-specific values must be ≤60 characters (EXCEPTION: K-Typ). Titles are governed separately (≤80 chars).

  QUALITY RULES:
  - Titles MUST be searchable and ≤80 chars.
  - Key features MUST be non-duplicative and factual.
  `;

  const model = client.getGenerativeModel({
    model: modelName,
    tools: tools,
    systemInstruction: systemPromptText,
  });

  // Build Gemini history: product context first, then conversation history, then image turns.
  // The product context is always rebuilt fresh (user may have applied changes between messages).
  const geminiHistory = [
    {
      role: 'user',
      parts: [{ text: `System Context:\n${serializedContext}` }],
    },
    {
      role: 'model',
      parts: [{ text: 'Acknowledged. I have the product context and am ready to act autonomously.' }],
    },
    // Inject previous conversation turns (last N pairs from Firestore)
    ...(Array.isArray(history) ? history : []),
    // Image attachments for the current request
    ...(attachmentPayload.imageParts.length ? [{
      role: 'user',
      parts: [
        { text: 'Referenzbilder des Produkts:' },
        ...attachmentPayload.imageParts
      ]
    }, {
      role: 'model',
      parts: [{ text: 'Bilder empfangen.' }]
    }] : [])
  ];

  const chat = model.startChat({ history: geminiHistory });

  let currentMessageParts = [
    {
      text: buildUserPrompt({
        message: scope && String(scope).trim()
          ? `${userMessage}\n\nSCOPE=${String(scope).trim()} (STRICT: only propose edits inside this scope; do not change title unless scope=datasheet or scope=title; do not change category unless scope=datasheet or scope=category.)`
          : userMessage,
        locale,
        mode: conversationMode,
        marketingFocus,
      })
    }
  ];

  if (barcodeIntent && !hasLocalValidBarcode) {
    currentMessageParts.push({
      text: `
      IMPORTANT: The user explicitly wants a barcode/EAN. None is in the context.
      ACTION REQUIRED: Do NOT ask questions. Immediately run brightdata_web_search (unrestricted, no sites) for "${product?.identification?.brand || ''} ${product?.identification?.name || ''} EAN".
      Then extract the EAN from results and return it via update_product_datasheet.
      `});
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


  try {
    onProgress?.({ type: 'start', text: 'Starte Analyse…' });

    let response = await chat.sendMessage(currentMessageParts);
    let responseText = response.response.text();
    let functionCalls = response.response.functionCalls();

    let iterations = 0;
    while (functionCalls && functionCalls.length > 0 && iterations < MAX_CHAT_ITERATIONS) {
      iterations++;
      const functionResponses = [];

      for (const call of functionCalls) {
        let toolResult = {};
        const { name, args } = call;

        if (name === 'brightdata_web_search') {
          const cleanedArgs = args && typeof args === 'object' ? { ...args } : {};
          onProgress?.({ type: 'tool_start', tool: 'brightdata_web_search', query: cleanedArgs.query || '' });
          const result = await executeBrightdataSearchToolCall({ arguments: JSON.stringify(cleanedArgs) });
          onProgress?.({ type: 'tool_done', tool: 'brightdata_web_search', count: (result.results || []).length });
          serpTrace.push({
            type: 'brightdata',
            engine: result.engine,
            query: result.query,
            summary: (result.results || []).slice(0, 8).map((r) => ({
              title: r.title || '',
              source: r.site || 'brightdata',
              price: null,
              url: r.url || '',
              snippet: r.snippet || '',
            })),
            error: result.error || null,
          });
          toolResult = { results: result.results || [], error: result.error || null };
        }
        else if (name === 'serpapi_web_search') {
          const cleanedArgs = args && typeof args === 'object' ? { ...args } : {};
          onProgress?.({ type: 'tool_start', tool: 'serpapi_web_search', query: cleanedArgs.query || '' });
          const result = await executeSerpapiToolCall({ arguments: JSON.stringify(cleanedArgs) });
          onProgress?.({ type: 'tool_done', tool: 'serpapi_web_search', count: (result.summary || []).length });
          serpTrace.push({
            type: 'serpapi',
            engine: result.engine,
            query: result.query,
            summary: result.summary,
            error: result.error || null,
          });
          toolResult = { summary: result.summary, error: result.error };
        }
        else if (name === 'web_fetch') {
          onProgress?.({ type: 'tool_start', tool: 'web_fetch', url: args?.url || '' });
          const result = await executeWebFetchToolCall({ arguments: JSON.stringify(args) });
          onProgress?.({ type: 'tool_done', tool: 'web_fetch', status: result.status || 0 });
          serpTrace.push({
            type: 'web_fetch',
            url: result.url,
            status: result.status,
            error: result.error
          });
          toolResult = result;
        }
        else if (name === 'update_product_datasheet') {
          const sanitized = sanitizeDatasheetChange(args, product, { scope, titleHintTokens });
          const nextChange = sanitized?.change && typeof sanitized.change === 'object' ? sanitized.change : {};
          const issues = Array.isArray(sanitized?.policyIssues) ? sanitized.policyIssues : [];
          if (issues.length) {
            product.ops = product.ops || {};
            product.ops.chat_policy_issues = Array.from(new Set([...(product.ops.chat_policy_issues || []), ...issues]));
          }
          if (Object.keys(nextChange).length) {
            datasheetChanges.push(nextChange);
            onProgress?.({ type: 'tool_done', tool: 'update_product_datasheet', fields: Object.keys(nextChange).length });
          }
          toolResult = { acknowledged: true, applied_fields: Object.keys(nextChange), policy_issues: issues.slice(0, 20) };
        }
        else if (name === 'suggest_product_images') {
          const chatImages = sanitizeImageSuggestions(args).filter((img) => {
            const key = normalizeImageKey(img.url_or_base64);
            if (!key || existingImageKeys.has(key)) return false;
            existingImageKeys.add(key);
            existingImageUrls.push(img.url_or_base64);
            return true;
          });
          // Fetch marketing images logic... reused from logic above but simplified for tool
          // Note: Reuse logic from previous implementation if possible, or simplified
          // For brevity, we just acknowledge the user suggestions. 
          // Real implementation would call fetchMarketingImages again if needed.
          imageSuggestions.push({ rationale: args.rationale, images: chatImages });
          toolResult = { acknowledged: true, count: chatImages.length };
        }
        else if (name === 'generate_ai_images') {
          const referenceImage = selectReferenceImage(product, args);
          if (!referenceImage) {
            toolResult = { success: false, error: 'No reference image found' };
          } else {
            try {
              const generation = await generateImagesForProduct(product, {
                referenceImage,
              });
              // Add to imageSuggestions...
              const aiImages = generation.images.filter(img => {
                const key = normalizeImageKey(img.url_or_base64);
                if (!key || existingImageKeys.has(key)) return false;
                existingImageKeys.add(key);
                return true;
              });
              imageSuggestions.push({ rationale: args.rationale || 'AI Render', images: aiImages });
              toolResult = { success: true, count: aiImages.length };
            } catch (e) {
              toolResult = { success: false, error: e.message };
            }
          }
        }

        functionResponses.push({
          functionResponse: {
            name: name,
            response: toolResult
          }
        });
      }

      // Send function responses back to model
      response = await chat.sendMessage(functionResponses);
      responseText = response.response.text();
      functionCalls = response.response.functionCalls();
    }

    // Fallback: Sometimes Gemini answers without calling update_product_datasheet.
    // This makes "Übernahme" in the UI feel sporadic because no structured change exists to apply.
    // For info/analysis intent, skip forced fallbacks — the text response IS the answer.
    if (intent !== 'change') {
      // No forced change card for info/analysis intent — just return the text.
    } else if ((!datasheetChanges || datasheetChanges.length === 0) && responseText) {
      try {
        const updateOnlyTools = [
          {
            functionDeclarations: [toGeminiTool(updateDatasheetTool)],
          },
        ];

        const updateOnlyModel = client.getGenerativeModel({
          model: modelName,
          tools: updateOnlyTools,
          toolConfig: {
            functionCallingConfig: {
              mode: 'ANY',
              allowedFunctionNames: ['update_product_datasheet'],
            },
          },
          systemInstruction: [
            'You are a strict converter.',
            'CRITICAL: You MUST call update_product_datasheet exactly once.',
            'CRITICAL: Do NOT output any plain text.',
            'If the assistant message implies NO concrete datasheet edits, call update_product_datasheet with {}.',
          ].join('\n'),
        });

        const updatePrompt = [
          'System Context:',
          serializedContext,
          '',
          'Assistant message to convert:',
          responseText,
          '',
          'Task:',
          '- Convert any implied concrete datasheet edits into a SINGLE update_product_datasheet tool call.',
          '- If no edits are implied, call update_product_datasheet with {}.',
        ].join('\n');

        const updateResponse = await updateOnlyModel.generateContent({
          contents: [{ role: 'user', parts: [{ text: updatePrompt }] }],
        });
        const updateCalls = updateResponse.response.functionCalls?.() || [];
        const updateCall = updateCalls.find((call) => call?.name === 'update_product_datasheet');
        if (updateCall?.args && typeof updateCall.args === 'object') {
          const sanitized = sanitizeDatasheetChange(updateCall.args, product, { scope, titleHintTokens });
          const nextChange = sanitized?.change && typeof sanitized.change === 'object' ? sanitized.change : {};
          const issues = Array.isArray(sanitized?.policyIssues) ? sanitized.policyIssues : [];
          if (issues.length) {
            product.ops = product.ops || {};
            product.ops.chat_policy_issues = Array.from(new Set([...(product.ops.chat_policy_issues || []), ...issues]));
          }
          if (nextChange && Object.keys(nextChange).length > 0) {
            datasheetChanges.push(nextChange);
          }
        }
      } catch (fallbackError) {
        console.warn('Chat fallback update_product_datasheet conversion failed:', fallbackError?.message || fallbackError);
      }
    }

    const hasWebFetch = Array.isArray(serpTrace) && serpTrace.some((t) => t?.type === 'web_fetch');

    // Guarantee: if the model proposed changes without fetching any page, attach at least one fetched-evidence note.
    // We do not overwrite its changes; we only add a notes-only card + traces.
    if (!hasWebFetch && Array.isArray(datasheetChanges) && datasheetChanges.length > 0) {
      try {
        const forcedNotes = await forceOneEvidencePass(product, userMessage, { scope, notesOnly: true, titleHintTokens });
        if (forcedNotes?.traces?.length) serpTrace.push(...forcedNotes.traces);
        if (Array.isArray(forcedNotes?.datasheetChanges) && forcedNotes.datasheetChanges.length) {
          datasheetChanges.push(...forcedNotes.datasheetChanges);
        }
      } catch (e) {
        // ignore; we still return the original changes
      }
    }

    // Hard guarantee: if we STILL have no datasheetChanges, run one forced BrightData search+fetch+update pass.
    // Only for 'change' intent — info/analysis responses don't need a forced change card.
    if (intent === 'change' && (!datasheetChanges || datasheetChanges.length === 0)) {
      try {
        const forced = await forceOneEvidencePass(product, userMessage, { scope, titleHintTokens });
        if (forced?.traces?.length) serpTrace.push(...forced.traces);
        if (Array.isArray(forced?.datasheetChanges) && forced.datasheetChanges.length) {
          forced.datasheetChanges.forEach((c) => datasheetChanges.push(c));
        }
      } catch (e) {
        // As a last resort, still return notes.
        datasheetChanges.push({
          summary: 'Web-Recherche (BrightData): interner Fehler',
          notes: {
            unsure: ['Automatischer Evidence-Fallback ist fehlgeschlagen. Bitte erneut versuchen.'],
            warnings: [String(e?.message || e)],
          },
        });
      }
    }

    // Only append "policy rejection" hints when strict rules are enabled.
    if (strictRulesEnabled()) {
      const policyIssues = Array.isArray(product?.ops?.chat_policy_issues) ? product.ops.chat_policy_issues : [];
      if (policyIssues.length) {
        const preview = policyIssues.slice(0, 6);
        const suffix = policyIssues.length > preview.length ? ` … (+${policyIssues.length - preview.length} mehr)` : '';
        const note = `\n\nHinweis: Einige Vorschläge wurden wegen Regelwerk verworfen: ${preview.join(', ')}${suffix}`;
        responseText = `${(responseText || '').trim()}${note}`;
      }
    }

    // Only in "title" scope: make the user-visible message reflect EXACTLY ONE title (the structured, coerced one).
    // For non-title scopes we must NOT overwrite the assistant message with a title suggestion.
    const lastTitleChange = [...(datasheetChanges || [])]
      .reverse()
      .find((change) => {
        if (!change || typeof change !== 'object') return false;
        if (typeof change.title === 'string' && change.title.trim()) return true;
        if (change.identity && typeof change.identity === 'object' && typeof change.identity.name === 'string' && change.identity.name.trim()) {
          return true;
        }
        return false;
      });
    const finalTitleRaw =
      (lastTitleChange && (lastTitleChange.title || lastTitleChange.identity?.name)) || '';
    let finalTitle = typeof finalTitleRaw === 'string' ? finalTitleRaw.trim() : '';
    const scopeSet = parseScopeSet(scope);
    const titleOnlyScope = scopeSet.size === 1 && scopeSet.has('title');
    if (!finalTitle && titleOnlyScope) {
      const rawCandidate =
        extractTitleCandidateFromAssistantMessage(responseText) ||
        safeString(product?.identification?.name) ||
        safeString(userMessage);
      const coerced = coerceTitleToPolicy(product, rawCandidate, {
        minLen: 70,
        maxLen: 80,
        softMaxLen: 80,
        extraHintTokens: Array.isArray(titleHintTokens) ? titleHintTokens : [],
        forcePolicy: false,
      });
      if (coerced) {
        const normalizedTitle = normalizeGermanTitleLanguage(coerced, product);
        finalTitle = normalizedTitle || coerced;
        datasheetChanges.push({
          summary: 'Titel-Vorschlag (normalisiert)',
          title: finalTitle,
          identity: { name: finalTitle },
        });
      }
    }
    if (finalTitle && titleOnlyScope) {
      responseText = `Titel-Vorschlag (${finalTitle.length}/80): ${finalTitle}`;
    }

    const consolidatedChange = consolidateDatasheetChanges(datasheetChanges);
    const finalDatasheetChanges = consolidatedChange ? [consolidatedChange] : [];
    const imageOnlyScope = scopeSet.size > 0 && Array.from(scopeSet).every((token) => token === 'images');
    // Only push the "no changes" placeholder for 'change' intent — info/analysis responses just return text.
    if (!finalDatasheetChanges.length && !imageOnlyScope && intent === 'change') {
      finalDatasheetChanges.push({
        summary: 'Keine sicheren Änderungen',
        notes: {
          unsure: ['Keine sicheren, scope-konformen Änderungen erkannt. Bitte Anfrage präzisieren oder Scope anpassen.'],
          warnings: [],
        },
      });
    }

    let ebayReadiness = null;
    try {
      const { evaluateEbayReady } = require('../lib/datasheet-quality');
      const before = evaluateEbayReady(product, { force: true });
      const preview = JSON.parse(JSON.stringify(product));
      finalDatasheetChanges.forEach((c) => applyDatasheetChangeToProductPreview(preview, c));
      const after = evaluateEbayReady(preview, { force: true });
      ebayReadiness = {
        before: {
          ok: Boolean(before?.ok),
          issues: Array.isArray(before?.issues) ? before.issues.slice(0, 40) : [],
          issuesDetailed: Array.isArray(before?.issuesDetailed) ? before.issuesDetailed.slice(0, 40) : [],
          snapshot: before?.snapshot || null,
        },
        after: {
          ok: Boolean(after?.ok),
          issues: Array.isArray(after?.issues) ? after.issues.slice(0, 40) : [],
          issuesDetailed: Array.isArray(after?.issuesDetailed) ? after.issuesDetailed.slice(0, 40) : [],
          snapshot: after?.snapshot || null,
        },
      };
    } catch {
      ebayReadiness = null;
    }

    return {
      message: responseText || 'Antwort generiert.',
      datasheetChanges: finalDatasheetChanges,
      imageSuggestions,
      serpTrace,
      ebayReadiness,
      modelUsed: modelName,
      intent,
    };

  } catch (error) {
    console.error('Gemini Chat Error:', error);
    throw error;
  }
}

module.exports = {
  runProductChat,
};
