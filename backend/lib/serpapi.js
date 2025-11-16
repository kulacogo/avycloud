const { URLSearchParams } = require('url');
const { getSecretValue } = require('./secret-values');

const SERPAPI_BASE_URL = 'https://serpapi.com/search.json';
const MIN_IMAGE_WIDTH = parseInt(process.env.MIN_IMAGE_WIDTH || '900', 10);
const MIN_IMAGE_HEIGHT = parseInt(process.env.MIN_IMAGE_HEIGHT || '900', 10);
const ALLOWED_ENGINES = [
  'google',
  'google_shopping',
  'google_images',
  'google_lens',
  'google_reverse_image',
  'bing',
  'bing_images',
  'duckduckgo',
  'yahoo',
  'yandex',
  'ebay',
  'walmart',
  'home_depot',
  'naver',
];

let cachedKey = null;

async function getSerpApiKey() {
  if (cachedKey) return cachedKey;
  const direct = process.env.SERPAPI_KEY;
  if (direct) {
    cachedKey = direct;
    return direct;
  }
  const secret = await getSecretValue('SERPAPI_KEY');
  if (!secret) {
    throw new Error('SERPAPI_KEY is not configured');
  }
  cachedKey = secret;
  return secret;
}

function buildDefaultParams(engine) {
  switch (engine) {
    case 'google':
    case 'google_images':
    case 'google_reverse_image':
    case 'google_shopping':
    case 'google_lens':
      return {
        gl: process.env.SERPAPI_GL || 'de',
        hl: process.env.SERPAPI_HL || 'de',
        google_domain: process.env.SERPAPI_GOOGLE_DOMAIN || 'google.de',
      };
    case 'bing':
    case 'bing_images':
      return {
        cc: process.env.SERPAPI_CC || 'DE',
        mkt: process.env.SERPAPI_MARKET || 'de-DE',
      };
    case 'duckduckgo':
      return {
        kl: process.env.SERPAPI_KL || 'de-de',
      };
    case 'ebay':
      return {
        ebay_domain: process.env.SERPAPI_EBAY_DOMAIN || 'ebay.de',
      };
    default:
      return {};
  }
}

async function callSerpApi(engine, params = {}) {
  if (!engine || !ALLOWED_ENGINES.includes(engine)) {
    throw new Error(`Unsupported SerpAPI engine: ${engine}`);
  }

  const apiKey = await getSerpApiKey();
  const finalParams = {
    ...buildDefaultParams(engine),
    ...params,
    engine,
    api_key: apiKey,
    output: 'json',
  };

  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(finalParams)) {
    if (value === undefined || value === null) continue;
    searchParams.append(key, String(value));
  }

  const url = `${SERPAPI_BASE_URL}?${searchParams.toString()}`;
  const response = await fetch(url, { method: 'GET' });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SerpAPI request failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(`SerpAPI error: ${data.error}`);
  }

  return data;
}

function parseDimension(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = parseInt(value.replace(/[^\d]/g, ''), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractImageMeta(entry) {
  const url =
    entry?.original ||
    entry?.image ||
    entry?.original_image ||
    entry?.link ||
    entry?.thumbnail ||
    entry?.image_url;
  const width =
    parseDimension(entry?.original_width) ||
    parseDimension(entry?.width) ||
    parseDimension(entry?.thumbnail_width);
  const height =
    parseDimension(entry?.original_height) ||
    parseDimension(entry?.height) ||
    parseDimension(entry?.thumbnail_height);
  return url
    ? {
        url,
        width,
        height,
      }
    : null;
}

function isLowResImage(meta) {
  if (!meta) return false;
  if (meta.width && meta.width < MIN_IMAGE_WIDTH) return true;
  if (meta.height && meta.height < MIN_IMAGE_HEIGHT) return true;
  return false;
}

function summarizeSerpEntries(engine, data, limit = 5) {
  const items = [];

  if (!data) {
    return items;
  }

  const pushItem = (entry, skipQualityCheck = false) => {
    if (!entry) return;
    const imageMeta = extractImageMeta(entry);
    if (!skipQualityCheck && imageMeta && isLowResImage(imageMeta)) {
      return;
    }

    items.push({
      title: entry.title || entry.product_title || entry.name || entry.heading || 'Untitled',
      price: entry.price || entry.extracted_price,
      source: entry.source || entry.displayed_link || entry.merchant || entry.store || engine,
      url: imageMeta?.url || entry.link || entry.product_link || entry.url,
      thumbnail: entry.thumbnail || entry.image || imageMeta?.url,
      snippet: entry.snippet || entry.description || entry.excerpt,
      image_meta: imageMeta,
    });
  };

  const fill = (entries) => entries.slice(0, limit).forEach((entry) => pushItem(entry));

  if (engine === 'google_shopping' && Array.isArray(data.shopping_results)) {
    fill(data.shopping_results);
  } else if (engine === 'google' && Array.isArray(data.organic_results)) {
    fill(data.organic_results);
  } else if (engine === 'google_images' && Array.isArray(data.images_results)) {
    fill(data.images_results);
  } else if (engine === 'google_lens' && Array.isArray(data.visual_matches)) {
    fill(data.visual_matches);
  } else if ((engine === 'google_reverse_image' || engine === 'bing_images') && Array.isArray(data.image_results)) {
    fill(data.image_results);
  } else if (engine === 'duckduckgo' && Array.isArray(data.organic_results)) {
    fill(data.organic_results);
  } else if (engine === 'ebay' && Array.isArray(data.shopping_results)) {
    fill(data.shopping_results);
  } else if (Array.isArray(data.organic_results)) {
    fill(data.organic_results);
  }

  if (items.length === 0) {
    const fallbackFill = (entries) =>
      entries.slice(0, limit).forEach((entry) => pushItem(entry, true));

    if (engine === 'google_images' && Array.isArray(data.images_results)) {
      fallbackFill(data.images_results);
    } else if (engine === 'google_lens' && Array.isArray(data.visual_matches)) {
      fallbackFill(data.visual_matches);
    } else if ((engine === 'google_reverse_image' || engine === 'bing_images') && Array.isArray(data.image_results)) {
      fallbackFill(data.image_results);
    }
  }

  return items;
}

module.exports = {
  callSerpApi,
  summarizeSerpEntries,
  ALLOWED_ENGINES,
};

