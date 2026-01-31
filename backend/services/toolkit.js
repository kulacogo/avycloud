const { callSerpApi, summarizeSerpEntries, ALLOWED_ENGINES } = require('../lib/serpapi');
const { fetchWithUnlocker } = require('../lib/web-unlocker');
const { search, searchSite } = require('../lib/evidence-provider');

const AMAZON_DOMAIN_BY_HINT = {
  de: 'amazon.de',
  'de-de': 'amazon.de',
  at: 'amazon.de',
  ch: 'amazon.de',
  'de-at': 'amazon.de',
  'de-ch': 'amazon.de',
  'en-de': 'amazon.de',
  'en-us': 'amazon.com',
  us: 'amazon.com',
  'en-ca': 'amazon.ca',
  ca: 'amazon.ca',
  'fr-fr': 'amazon.fr',
  fr: 'amazon.fr',
  'it-it': 'amazon.it',
  it: 'amazon.it',
  'es-es': 'amazon.es',
  es: 'amazon.es',
  'nl-nl': 'amazon.nl',
  nl: 'amazon.nl',
  'pl-pl': 'amazon.pl',
  pl: 'amazon.pl',
  'se-se': 'amazon.se',
  se: 'amazon.se',
  'en-gb': 'amazon.co.uk',
  gb: 'amazon.co.uk',
  uk: 'amazon.co.uk',
  'en-au': 'amazon.com.au',
  au: 'amazon.com.au',
  'ja-jp': 'amazon.co.jp',
  jp: 'amazon.co.jp',
  'zh-cn': 'amazon.cn',
  cn: 'amazon.cn',
  'in': 'amazon.in',
  'en-in': 'amazon.in',
};

const AMAZON_LOCATION_KEYWORDS = [
  { keyword: 'germany', domain: 'amazon.de' },
  { keyword: 'deutsch', domain: 'amazon.de' },
  { keyword: 'austria', domain: 'amazon.de' },
  { keyword: 'österreich', domain: 'amazon.de' },
  { keyword: 'switzerland', domain: 'amazon.de' },
  { keyword: 'schweiz', domain: 'amazon.de' },
  { keyword: 'france', domain: 'amazon.fr' },
  { keyword: 'français', domain: 'amazon.fr' },
  { keyword: 'italy', domain: 'amazon.it' },
  { keyword: 'spain', domain: 'amazon.es' },
  { keyword: 'united kingdom', domain: 'amazon.co.uk' },
  { keyword: 'england', domain: 'amazon.co.uk' },
  { keyword: 'uk', domain: 'amazon.co.uk' },
  { keyword: 'canada', domain: 'amazon.ca' },
  { keyword: 'australia', domain: 'amazon.com.au' },
  { keyword: 'japan', domain: 'amazon.co.jp' },
  { keyword: 'india', domain: 'amazon.in' },
  { keyword: 'usa', domain: 'amazon.com' },
  { keyword: 'united states', domain: 'amazon.com' },
];

const DEFAULT_AMAZON_DOMAIN =
  process.env.SERPAPI_DEFAULT_AMAZON_DOMAIN ||
  process.env.SERPAPI_AMAZON_DOMAIN ||
  'amazon.de';

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
      locale: { type: ['string', 'null'], description: 'Locales im Format de-DE, en-US usw.' },
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

const brightdataSearchToolDefinition = {
  type: 'function',
  name: 'brightdata_web_search',
  description:
    'Websuche über BrightData SERP (und interne Evidence-Provider Logik). Nutze dies, um Marketplace-Produktseiten (ebay.de, kaufland.de, hood.de) zu finden.',
  strict: false,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Suchanfrage (z.B. "Marke MPN EAN").' },
      locale: { type: ['string', 'null'], description: 'Locale (z.B. de-DE).' },
      limit: { type: ['number', 'null'], minimum: 1, maximum: 20, description: 'Max. Ergebnisse.' },
      sites: {
        type: ['array', 'null'],
        description: 'Optional: Liste von Domains für site:-Suche (z.B. ["ebay.de","kaufland.de","hood.de"]).',
        items: { type: 'string' },
      },
    },
  },
};

const webFetchToolDefinition = {
  type: 'function',
  name: 'web_fetch',
  description:
    'Ruft Webseiten über Bright Data Web Unlocker ab (HTML/JSON/Screenshot) und umgeht dabei Bot-Abwehrmaßnahmen. Nutze dies für direkte Produktseiten oder Preisverifikationen.',
  parameters: {
    type: 'object',
    required: ['url'],
    additionalProperties: false,
    properties: {
      url: { type: 'string', description: 'Vollständige Ziel-URL.' },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        description: 'HTTP-Methode (Standard GET).',
      },
      headers: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Optionale Zusatz-Header (erfordert Custom Web Unlocker API).',
      },
      body: { type: 'string', description: 'Roh-Body für POST/PUT/PATCH Requests.' },
      format: {
        type: 'string',
        enum: ['raw'],
        description: 'Unlocker-Format (raw lässt Antwort unverändert).',
      },
      data_format: {
        type: 'string',
        enum: ['raw', 'markdown', 'screenshot'],
        description: 'Serverseitige Weiterverarbeitung (z. B. Markdown, Screenshot).',
      },
      country: {
        type: 'string',
        description: 'ISO-Ländercode für Geotargeting (z. B. de, us, fr).',
      },
      mobile: {
        type: 'boolean',
        description: 'true = mobiler User-Agent (entspricht -ua-mobile).',
      },
      expect_element: {
        type: 'string',
        description: 'CSS-Selector, der vorhanden sein muss (x-unblock-expect).',
      },
      expect_text: {
        type: 'string',
        description: 'Text, der vorhanden sein muss (x-unblock-expect).',
      },
      timeout_ms: {
        type: 'number',
        minimum: 1000,
        maximum: 60000,
        description: 'Timeout für den Unlocker-Request in Millisekunden.',
      },
    },
  },
};

function clamp(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  return Math.min(Math.max(min, Math.floor(num)), max);
}

function normalizeHint(value) {
  if (!value) return '';
  return value.toString().trim().toLowerCase().replace('_', '-');
}

function matchAmazonDomainFromHint(hint) {
  if (!hint) return null;
  const normalized = normalizeHint(hint);
  if (!normalized) return null;
  if (AMAZON_DOMAIN_BY_HINT[normalized]) {
    return AMAZON_DOMAIN_BY_HINT[normalized];
  }
  const short = normalized.split('-')[0];
  if (AMAZON_DOMAIN_BY_HINT[short]) {
    return AMAZON_DOMAIN_BY_HINT[short];
  }
  return null;
}

function inferAmazonDomain(args = {}) {
  const hints = [
    args.domain,
    args.amazon_domain,
    args.locale,
    args.gl,
    args.hl,
    args.language,
    args.lang,
  ];

  for (const hint of hints) {
    const domain = matchAmazonDomainFromHint(hint);
    if (domain) return domain;
  }

  const location = normalizeHint(args.location || '');
  if (location) {
    const match = AMAZON_LOCATION_KEYWORDS.find(({ keyword }) => location.includes(keyword));
    if (match) return match.domain;
  }

  const query = args.query ? args.query.toString().toLowerCase() : '';
  const queryDomainMatch = query.match(/amazon\.(com\.au|co\.uk|co\.jp|de|fr|it|es|nl|pl|se|ca|in|com)/);
  if (queryDomainMatch) {
    return `amazon.${queryDomainMatch[1]}`;
  }

  return DEFAULT_AMAZON_DOMAIN;
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
  const engine = args.engine && ALLOWED_ENGINES.includes(args.engine)
    ? args.engine
    : 'google_shopping'; // default fallback

  if (!ALLOWED_ENGINES.includes(engine)) {
    throw new Error(`Engine ${engine} is not supported by SerpAPI tool`);
  }

  const normalizedArgs = { ...args };
  if (engine === 'amazon') {
    const inferredDomain = inferAmazonDomain(normalizedArgs);
    normalizedArgs.domain = normalizedArgs.domain || normalizedArgs.amazon_domain || inferredDomain;
  }

  let params;
  try {
    params = buildSerpParams(engine, normalizedArgs);
  } catch (buildError) {
    return {
      engine,
      query:
        normalizedArgs.query ||
        normalizedArgs.image_url ||
        normalizedArgs.product_id ||
        normalizedArgs.page_token ||
        engine,
      params: {},
      summary: [],
      raw: null,
      error: buildError.message || String(buildError),
    };
  }
  const traceQuery =
    normalizedArgs.query ||
    normalizedArgs.image_url ||
    normalizedArgs.product_id ||
    normalizedArgs.page_token ||
    engine;

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

async function executeBrightdataSearchToolCall(toolCall) {
  let args = {};
  try {
    args = JSON.parse(toolCall.arguments || '{}');
  } catch (error) {
    return { ok: false, engine: 'brightdata', query: '', results: [], error: `Invalid arguments: ${error.message}` };
  }
  const q = (args.query || '').toString().trim();
  if (!q) {
    return { ok: false, engine: 'brightdata', query: '', results: [], error: 'query is required' };
  }
  const locale = (args.locale || 'de-DE').toString().trim() || 'de-DE';
  const limit = Math.max(1, Math.min(20, Math.floor(Number(args.limit || 8))));
  const sites = Array.isArray(args.sites) ? args.sites.map((s) => String(s || '').trim()).filter(Boolean) : [];

  const combined = [];
  const seen = new Set();
  const push = (r, site = null) => {
    const url = (r?.url || '').toString().trim();
    if (!url) return;
    if (seen.has(url)) return;
    seen.add(url);
    combined.push({
      title: (r?.title || '').toString().trim(),
      url,
      snippet: (r?.snippet || '').toString().trim(),
      site,
    });
  };

  if (sites.length) {
    for (const site of sites.slice(0, 6)) {
      // eslint-disable-next-line no-await-in-loop
      const res = await searchSite(q, site, { limit, locale });
      (res?.results || []).forEach((r) => push(r, site));
      if (combined.length >= limit) break;
    }
  } else {
    const res = await search(q, { limit, locale });
    (res?.results || []).forEach((r) => push(r, null));
  }

  return {
    ok: combined.length > 0,
    engine: 'brightdata',
    query: q,
    results: combined.slice(0, limit),
    error: combined.length ? null : 'no_results',
  };
}

async function executeWebFetchToolCall(toolCall) {
  let args = {};
  try {
    args = JSON.parse(toolCall.arguments || '{}');
  } catch (error) {
    return { success: false, url: null, error: `Invalid arguments: ${error.message}` };
  }

  if (!args.url) {
    return { success: false, url: null, error: 'url is required' };
  }

  try {
    const result = await fetchWithUnlocker({
      url: args.url,
      method: args.method || 'GET',
      headers: args.headers,
      body: args.body,
      format: args.format || 'raw',
      dataFormat: args.data_format || null,
      country: args.country || null,
      mobile: Boolean(args.mobile),
      expect:
        args.expect_element || args.expect_text
          ? { element: args.expect_element, text: args.expect_text }
          : null,
      timeoutMs: args.timeout_ms || undefined,
    });
    return result;
  } catch (error) {
    return {
      success: false,
      url: args.url,
      error: error.message || String(error),
    };
  }
}

module.exports = {
  serpapiToolDefinition,
  brightdataSearchToolDefinition,
  webFetchToolDefinition,
  executeSerpapiToolCall,
  executeBrightdataSearchToolCall,
  executeWebFetchToolCall,
};
