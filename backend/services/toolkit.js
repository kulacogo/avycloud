const { callSerpApi, summarizeSerpEntries, ALLOWED_ENGINES } = require('../lib/serpapi');

const serpapiToolDefinition = {
  type: 'function',
  name: 'serpapi_web_search',
  description:
    'Greift auf SerpAPI zu (Google, Bing, Amazon, eBay, DuckDuckGo, Lens/Reverse-Image etc.), um Produktdaten, Preise, Bilder und Kategorien in Echtzeit abzurufen.',
  strict: false,
  parameters: {
    type: 'object',
    properties: {
      engine: {
        type: 'string',
        enum: [
          'google',
          'google_shopping',
          'google_shopping_ai_overview',
          'google_ai_overview',
          'google_ai_mode',
          'google_images',
          'google_images_shopping',
          'google_lens',
          'google_reverse_image',
          'google_product',
          'google_immersive_product',
          'bing',
          'bing_images',
          'bing_shopping',
          'bing_reverse_image',
          'duckduckgo',
          'yahoo',
          'yandex',
          'ebay',
          'ebay_product',
          'amazon',
        ],
        description: 'SerpAPI engine gemäß Dokumentation.',
      },
      query: {
        type: ['string', 'null'],
        description: 'Textbasierte Suchanfrage (q/k/_nkw je nach Engine).',
      },
      image_url: {
        type: ['string', 'null'],
        description: 'Öffentliche Bild-URL für Reverse-Image/Lens.',
      },
      product_id: {
        type: ['string', 'null'],
        description: 'Produkt-ID für google_product oder ebay_product.',
      },
      page_token: {
        type: ['string', 'null'],
        description: 'Page-Token für google_immersive_product.',
      },
      num: {
        type: ['number', 'null'],
        minimum: 1,
        maximum: 100,
        description: 'Anzahl gewünschter Ergebnisse (wird pro Engine gekappt).',
      },
      page: {
        type: ['number', 'null'],
        minimum: 1,
        maximum: 50,
        description: 'Seitennummer/Paginierung (ijn/_pgn etc.).',
      },
      start: {
        type: ['number', 'null'],
        minimum: 0,
        maximum: 500,
        description: 'Offset/Startindex für Ergebnisse.',
      },
      gl: { type: ['string', 'null'], description: 'Country code (2-letter).' },
      hl: { type: ['string', 'null'], description: 'Language code (2-letter).' },
      location: { type: ['string', 'null'], description: 'Freitext Location (z.B. Berlin, Germany).' },
      uule: { type: ['string', 'null'], description: 'Google UULE kodierter Standort.' },
      google_domain: { type: ['string', 'null'], description: 'Google-Domain (google.de etc.).' },
      domain: { type: ['string', 'null'], description: 'Shop/Engine Domain (amazon.de, ebay.de).' },
      sort_by: { type: ['string', 'null'], description: 'Sortierung (z.B. price_asc, price_desc).' },
      filters: {
        type: ['string', 'null'],
        description: 'Filter-String (rh für Amazon, filters für Bing Shopping, show_only für eBay).',
      },
      node: { type: ['string', 'number', 'null'], description: 'Kategorie-ID (Amazon node oder eBay category).' },
      tbs: { type: ['string', 'null'], description: 'Google Images/Shopping Filter-String.' },
      type: { type: ['string', 'null'], description: 'Suchtyp (Lens: products, text; Reverse/Bing: cat/cab).' },
      safe: { type: ['string', 'null'], description: 'Sicherheitslevel safe/active/off etc.' },
      count: { type: ['number', 'null'], minimum: 1, maximum: 100, description: 'Result count for Bing/DuckDuckGo.' },
      more_stores: { type: ['boolean', 'null'], description: 'Weitere Shops (google_immersive_product).' },
      next_page_token: { type: ['string', 'null'], description: 'Pagination token for immersive product/shopping ai.' },
    },
    required: ['engine'],
    additionalProperties: false,
  },
};

function clamp(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  return Math.min(Math.max(min, Math.floor(num)), max);
}

function ensureArg(args, field, engine) {
  const value = args?.[field];
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(`Missing required parameter "${field}" for engine ${engine}`);
  }
  return value;
}

function buildSerpParams(engine, args = {}) {
  const params = {};
  const query = (args.query || '').trim();

  switch (engine) {
    case 'google':
      params.q = ensureArg({ query }, 'query', engine);
      if (args.start != null) params.start = clamp(args.start, 0, 500);
      if (args.num != null) params.num = clamp(args.num, 1, 50);
      if (args.location) params.location = args.location;
      if (args.uule) params.uule = args.uule;
      if (args.gl) params.gl = args.gl;
      if (args.hl) params.hl = args.hl;
      if (args.google_domain) params.google_domain = args.google_domain;
      if (args.safe) params.safe = args.safe;
      if (args.tbs) params.tbs = args.tbs;
      break;
    case 'google_shopping':
    case 'google_shopping_ai_overview':
      params.q = ensureArg({ query }, 'query', engine);
      params.num = clamp(args.num ?? 12, 1, 100);
      if (args.start != null) params.start = clamp(args.start, 0, 200);
      if (args.sort_by) params.sort_by = args.sort_by;
      if (args.tbs) params.tbs = args.tbs;
      if (args.location) params.location = args.location;
      if (args.uule) params.uule = args.uule;
      if (args.gl) params.gl = args.gl;
      if (args.hl) params.hl = args.hl;
      if (args.google_domain) params.google_domain = args.google_domain;
      break;
    case 'google_ai_overview':
    case 'google_ai_mode':
      params.q = ensureArg({ query }, 'query', engine);
      if (args.gl) params.gl = args.gl;
      if (args.hl) params.hl = args.hl;
      if (args.location) params.location = args.location;
      if (args.uule) params.uule = args.uule;
      break;
    case 'google_images':
      params.q = ensureArg({ query }, 'query', engine);
      if (args.page != null) params.ijn = clamp(args.page - 1, 0, 50);
      if (args.num != null) params.num = clamp(args.num, 1, 100);
      if (args.tbs) params.tbs = args.tbs;
      if (args.location) params.location = args.location;
      if (args.uule) params.uule = args.uule;
      if (args.gl) params.gl = args.gl;
      if (args.hl) params.hl = args.hl;
      break;
    case 'google_images_shopping':
      params.q = ensureArg({ query }, 'query', engine);
      if (args.page != null) params.ijn = clamp(args.page - 1, 0, 50);
      if (args.tbs) params.tbs = args.tbs;
      if (args.num != null) params.num = clamp(args.num, 1, 100);
      if (args.gl) params.gl = args.gl;
      if (args.hl) params.hl = args.hl;
      break;
    case 'google_lens': {
      const url = ensureArg(args, 'image_url', engine);
      params.url = url;
      params.type = args.type || 'products';
      if (args.query) params.q = args.query;
      if (args.country) params.country = args.country;
      if (args.hl) params.hl = args.hl;
      break;
    }
    case 'google_reverse_image': {
      const imageUrl = ensureArg(args, 'image_url', engine);
      params.image_url = imageUrl;
      if (args.query) params.q = args.query;
      if (args.location) params.location = args.location;
      if (args.uule) params.uule = args.uule;
      if (args.gl) params.gl = args.gl;
      if (args.hl) params.hl = args.hl;
      if (args.num != null) params.num = clamp(args.num, 1, 50);
      if (args.start != null) params.start = clamp(args.start, 0, 200);
      if (args.safe) params.safe = args.safe;
      break;
    }
    case 'google_product': {
      params.product_id = ensureArg(args, 'product_id', engine);
      if (args.gl) params.gl = args.gl;
      if (args.hl) params.hl = args.hl;
      if (args.google_domain) params.google_domain = args.google_domain;
      break;
    }
    case 'google_immersive_product': {
      params.page_token = ensureArg(args, 'page_token', engine);
      if (args.more_stores != null) params.more_stores = args.more_stores ? 1 : 0;
      if (args.next_page_token) params.next_page_token = args.next_page_token;
      break;
    }
    case 'bing':
      params.q = ensureArg({ query }, 'query', engine);
      if (args.count != null) params.count = clamp(args.count, 1, 50);
      if (args.start != null) params.first = clamp(args.start, 0, 500);
      if (args.location) params.location = args.location;
      if (args.gl || args.cc) params.cc = args.gl || args.cc;
      if (args.safe) params.safeSearch = args.safe;
      if (args.filters) params.filters = args.filters;
      break;
    case 'bing_images':
      params.q = ensureArg({ query }, 'query', engine);
      if (args.count != null) params.count = clamp(args.count, 1, 100);
      if (args.start != null) params.first = clamp(args.start, 0, 500);
      if (args.gl || args.cc) params.cc = args.gl || args.cc;
      if (args.filters) params.filters = args.filters;
      if (args.type) params.photo = args.type;
      if (args.safe) params.safeSearch = args.safe;
      break;
    case 'bing_shopping':
      params.q = ensureArg({ query }, 'query', engine);
      if (args.start != null) params.efirst = clamp(args.start, 0, 500);
      if (args.filters) params.filters = args.filters;
      if (args.gl || args.cc) params.cc = args.gl || args.cc;
      break;
    case 'bing_reverse_image': {
      params.image_url = ensureArg(args, 'image_url', engine);
      if (args.type) params.cat = args.type;
      if (args.count != null) params.count = clamp(args.count, 1, 100);
      if (args.next_page_token) params.next_page_token = args.next_page_token;
      break;
    }
    case 'duckduckgo':
      params.q = ensureArg({ query }, 'query', engine);
      if (args.count != null) params.m = clamp(args.count, 1, 50);
      if (args.start != null) params.start = clamp(args.start, 0, 500);
      if (args.safe) params.safe = args.safe;
      if (args.gl || args.kl) params.kl = args.gl || args.kl;
      if (args.filters) params.df = args.filters;
      break;
    case 'ebay':
      params._nkw = ensureArg({ query }, 'query', engine);
      if (args.page != null) params._pgn = clamp(args.page, 1, 50);
      if (args.num != null) params._ipg = clamp(args.num, 1, 200);
      if (args.gl || args.cc) params._salic = args.gl || args.cc;
      if (args.node) params.category_id = args.node;
      if (args.filters) params.show_only = args.filters;
      if (args.sort_by) params._sop = args.sort_by;
      if (args.domain) params.ebay_domain = args.domain;
      break;
    case 'ebay_product':
      params.product_id = ensureArg(args, 'product_id', engine);
      if (args.domain) params.ebay_domain = args.domain;
      if (args.gl || args.locale) params.locale = args.gl || args.locale;
      if (args.hl || args.lang) params.lang = args.hl || args.lang;
      if (args.filters) params.shipping_country = args.filters;
      break;
    case 'amazon':
      params.k = ensureArg({ query }, 'query', engine);
      if (args.domain) params.amazon_domain = args.domain;
      if (args.hl || args.language) params.language = args.hl || args.language;
      if (args.page != null) params.page = clamp(args.page, 1, 50);
      if (args.sort_by) params.s = args.sort_by;
      if (args.filters) params.rh = args.filters;
      if (args.node) params.node = args.node;
      break;
    default:
      throw new Error(`Engine ${engine} is not supported by SerpAPI tool`);
  }

  return params;
}

async function executeSerpapiToolCall(toolCall) {
  const args = JSON.parse(toolCall.arguments || '{}');
  const { engine } = args;

  if (!ALLOWED_ENGINES.includes(engine)) {
    throw new Error(`Engine ${engine} is not supported by SerpAPI tool`);
  }

  let params;
  try {
    params = buildSerpParams(engine, args);
  } catch (buildError) {
    return {
      engine,
      query: args.query || args.image_url || args.product_id || args.page_token || engine,
      params: {},
      summary: [],
      raw: null,
      error: buildError.message || String(buildError),
    };
  }
  const traceQuery = args.query || args.image_url || args.product_id || args.page_token || engine;

  try {
    const raw = await callSerpApi(engine, params);
    const summary = summarizeSerpEntries(engine, raw, 8);

    return {
      engine,
      query: traceQuery,
      params,
      summary,
      raw,
    };
  } catch (error) {
    return {
      engine,
      query: traceQuery,
      params,
      summary: [],
      raw: null,
      error: error.message || String(error),
    };
  }
}

module.exports = {
  serpapiToolDefinition,
  executeSerpapiToolCall,
};
