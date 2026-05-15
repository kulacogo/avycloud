const { URLSearchParams } = require('url');
const { getSecretValue } = require('./secret-values');
const { instrumentExternalCall } = require('./external-api-tracker');

const SERPAPI_BASE_URL = 'https://serpapi.com/search.json';
const MIN_IMAGE_WIDTH = parseInt(process.env.MIN_IMAGE_WIDTH || '900', 10);
const MIN_IMAGE_HEIGHT = parseInt(process.env.MIN_IMAGE_HEIGHT || '900', 10);
const SERPAPI_TIMEOUT_MS = Math.max(5_000, parseInt(process.env.SERPAPI_TIMEOUT_MS || '20000', 10) || 20_000);

// ---------------------------------------------------------------------------
// Resilience layer — additive, all opt-out via ENV.
//
// Background: SerpAPI returns HTTP 200 with a body like
//   { "error": "Google hasn't returned any results for this query.",
//     "search_information": { "local_results_state": "Fully empty" } }
// for genuine empty searches. This is documented behavior
// (https://serpapi.com/api-status-and-error-codes) — NOT a server error.
// We must therefore distinguish empty-results from real errors and protect
// the upstream service via cache, rate-limit and circuit breaker.
// ---------------------------------------------------------------------------

const CACHE_DISABLED = String(process.env.SERPAPI_DISABLE_CACHE || '').toLowerCase() === 'true';
const POS_CACHE_TTL_MS = Math.max(0, parseInt(process.env.SERPAPI_CACHE_TTL_MS || `${6 * 60 * 60 * 1000}`, 10) || 0);
const NEG_CACHE_TTL_MS = Math.max(0, parseInt(process.env.SERPAPI_NEG_CACHE_TTL_MS || `${60 * 60 * 1000}`, 10) || 0);
const POS_CACHE_MAX = Math.max(0, parseInt(process.env.SERPAPI_CACHE_MAX || '500', 10) || 0);
const NEG_CACHE_MAX = Math.max(0, parseInt(process.env.SERPAPI_NEG_CACHE_MAX || '1000', 10) || 0);

const RATE_DISABLED = String(process.env.SERPAPI_DISABLE_RATE_LIMIT || '').toLowerCase() === 'true';
const MAX_PER_SECOND = Math.max(1, parseInt(process.env.SERPAPI_MAX_PER_SECOND || '5', 10) || 5);
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.SERPAPI_MAX_CONCURRENT || '20', 10) || 20);
const RATE_QUEUE_MAX = Math.max(0, parseInt(process.env.SERPAPI_RATE_QUEUE_MAX || '1000', 10) || 0);

const BREAKER_DISABLED = String(process.env.SERPAPI_DISABLE_BREAKER || '').toLowerCase() === 'true';
const BREAKER_THRESHOLD = Math.max(1, parseInt(process.env.SERPAPI_BREAKER_THRESHOLD || '5', 10) || 5);
const BREAKER_OPEN_MS = Math.max(1_000, parseInt(process.env.SERPAPI_BREAKER_OPEN_MS || '60000', 10) || 60_000);

const LOG_THROTTLE_MS = Math.max(0, parseInt(process.env.SERPAPI_LOG_THROTTLE_MS || '60000', 10) || 0);

const ALLOWED_ENGINES = [
  'google',
  'google_shopping',
  'google_shopping_ai_overview',
  'google_ai_overview',
  'google_ai_mode',
  'google_images',
  'google_images_shopping',
  'google_lens',
  'google_reverse_image',
  'google_immersive_product',
  'google_product',
  'bing',
  'bing_images',
  'bing_shopping',
  'bing_reverse_image',
  'duckduckgo',
  'yahoo',
  'yandex',
  'ebay',
  'ebay_product',
  'walmart',
  'home_depot',
  'naver',
  'amazon',
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
    case 'google_images_shopping':
    case 'google_reverse_image':
    case 'google_shopping':
    case 'google_shopping_ai_overview':
    case 'google_ai_overview':
    case 'google_ai_mode':
    case 'google_lens':
    case 'google_immersive_product':
    case 'google_product':
      return {
        gl: process.env.SERPAPI_GL || 'de',
        hl: process.env.SERPAPI_HL || 'de',
        google_domain: process.env.SERPAPI_GOOGLE_DOMAIN || 'google.de',
      };
    case 'bing':
    case 'bing_images':
    case 'bing_shopping':
    case 'bing_reverse_image':
      return {
        cc: process.env.SERPAPI_CC || 'DE',
        mkt: process.env.SERPAPI_MARKET || 'de-DE',
      };
    case 'duckduckgo':
      return {
        kl: process.env.SERPAPI_KL || 'de-de',
      };
    case 'ebay':
    case 'ebay_product':
      return {
        ebay_domain: process.env.SERPAPI_EBAY_DOMAIN || 'ebay.de',
      };
    case 'amazon':
      return {
        amazon_domain: process.env.SERPAPI_AMAZON_DOMAIN || 'amazon.de',
      };
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Empty-result detection.
//
// SerpAPI signals "no results" via either:
//   - error: "Google hasn't returned any results for this query."
//   - error: "We couldn't find any matching results for your search."
//   - search_information.local_results_state: "Fully empty"
// All of these are HTTP 200 successes — NOT server errors.
// "We couldn't get valid results … Please try again later." IS a real error.
// ---------------------------------------------------------------------------

const EMPTY_ERROR_PATTERNS = [
  /hasn'?t returned any results/i,
  /couldn'?t find any matching results/i,
  /no results found/i,
];

function isEmptyResultPayload(data) {
  if (!data || typeof data !== 'object') return false;
  const errMsg = typeof data.error === 'string' ? data.error : '';
  if (errMsg && EMPTY_ERROR_PATTERNS.some((re) => re.test(errMsg))) return true;
  const state = data.search_information?.local_results_state;
  if (typeof state === 'string' && /fully empty/i.test(state)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// LRU + Negative cache (size-bounded, TTL-based).
// ---------------------------------------------------------------------------

const _posCache = new Map(); // key -> { value, expiresAt }
const _negCache = new Map();

function _cacheKey(engine, params) {
  // Stable JSON serialization (sorted keys, omit api_key + output)
  const omit = new Set(['api_key', 'output']);
  const entries = Object.keys(params || {})
    .filter((k) => !omit.has(k))
    .sort()
    .map((k) => [k, params[k] == null ? '' : String(params[k])]);
  return `${engine}|${JSON.stringify(entries)}`;
}

function _cacheGet(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    map.delete(key);
    return null;
  }
  // LRU touch: re-insert to move to tail
  map.delete(key);
  map.set(key, entry);
  return entry.value;
}

function _cachePut(map, max, key, value, ttlMs) {
  if (CACHE_DISABLED || ttlMs <= 0 || max <= 0) return;
  if (map.has(key)) map.delete(key);
  map.set(key, { value, expiresAt: Date.now() + ttlMs });
  while (map.size > max) {
    const firstKey = map.keys().next().value;
    if (firstKey === undefined) break;
    map.delete(firstKey);
  }
}

function _cacheClear() {
  _posCache.clear();
  _negCache.clear();
}

// ---------------------------------------------------------------------------
// Rate limiter — token bucket per second + concurrency semaphore.
// ---------------------------------------------------------------------------

const _slotTimestamps = []; // sliding window of granted slots (last 1s)
let _activeCalls = 0;
const _waitQueue = []; // [{ resolve, reject, enqueuedAt }]

function _pruneSlots(now) {
  while (_slotTimestamps.length && now - _slotTimestamps[0] >= 1000) {
    _slotTimestamps.shift();
  }
}

function _tryGrant() {
  while (_waitQueue.length) {
    const now = Date.now();
    _pruneSlots(now);
    if (_slotTimestamps.length >= MAX_PER_SECOND) {
      const waitMs = 1000 - (now - _slotTimestamps[0]) + 1;
      setTimeout(_tryGrant, Math.max(1, waitMs));
      return;
    }
    if (_activeCalls >= MAX_CONCURRENT) {
      // Wait for a release event (see _release)
      return;
    }
    const head = _waitQueue.shift();
    _slotTimestamps.push(now);
    _activeCalls += 1;
    head.resolve();
  }
}

function _acquireSlot() {
  if (RATE_DISABLED) return Promise.resolve(() => {});
  if (RATE_QUEUE_MAX > 0 && _waitQueue.length >= RATE_QUEUE_MAX) {
    return Promise.reject(new Error('SerpAPI rate-limit queue is full'));
  }
  return new Promise((resolve, reject) => {
    _waitQueue.push({ resolve: () => resolve(_release), reject, enqueuedAt: Date.now() });
    _tryGrant();
  });
}

function _release() {
  if (RATE_DISABLED) return;
  _activeCalls = Math.max(0, _activeCalls - 1);
  if (_waitQueue.length) _tryGrant();
}

// ---------------------------------------------------------------------------
// Circuit breaker — opens after N consecutive *real* errors (not empty-result).
// ---------------------------------------------------------------------------

const _breaker = {
  state: 'closed', // 'closed' | 'open' | 'half_open'
  consecutiveErrors: 0,
  openedAt: 0,
};

function _breakerCheck() {
  if (BREAKER_DISABLED) return;
  if (_breaker.state === 'open') {
    if (Date.now() - _breaker.openedAt >= BREAKER_OPEN_MS) {
      _breaker.state = 'half_open';
      return;
    }
    const err = new Error('SerpAPI circuit breaker is open');
    err.code = 'SERPAPI_CIRCUIT_OPEN';
    throw err;
  }
}

function _breakerOnSuccess() {
  if (BREAKER_DISABLED) return;
  _breaker.consecutiveErrors = 0;
  _breaker.state = 'closed';
}

function _breakerOnError() {
  if (BREAKER_DISABLED) return;
  _breaker.consecutiveErrors += 1;
  if (_breaker.consecutiveErrors >= BREAKER_THRESHOLD || _breaker.state === 'half_open') {
    _breaker.state = 'open';
    _breaker.openedAt = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Log throttling — at most one warn per (key) per LOG_THROTTLE_MS.
// ---------------------------------------------------------------------------

const _logTimes = new Map();

function _shouldLog(key) {
  if (LOG_THROTTLE_MS <= 0) return true;
  const last = _logTimes.get(key) || 0;
  const now = Date.now();
  if (now - last < LOG_THROTTLE_MS) return false;
  _logTimes.set(key, now);
  // Soft-bound the map
  if (_logTimes.size > 2000) {
    const cutoff = now - LOG_THROTTLE_MS;
    for (const [k, t] of _logTimes) {
      if (t < cutoff) _logTimes.delete(k);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Raw fetch — unchanged behavior aside from empty-result handling.
// ---------------------------------------------------------------------------

async function _fetchSerpApiRaw(engine, params) {
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERPAPI_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { method: 'GET', signal: controller.signal });
  } catch (error) {
    const isAbort = error?.name === 'AbortError' || String(error?.message || '').toLowerCase().includes('abort');
    if (isAbort) {
      throw new Error(`SerpAPI request timed out after ${SERPAPI_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SerpAPI request failed (${response.status}): ${body}`);
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

async function callSerpApi(engine, params = {}) {
  if (!engine || !ALLOWED_ENGINES.includes(engine)) {
    throw new Error(`Unsupported SerpAPI engine: ${engine}`);
  }

  const key = _cacheKey(engine, params);

  // Cache hits skip rate-limit + breaker entirely.
  const posHit = _cacheGet(_posCache, key);
  if (posHit) return posHit;
  const negHit = _cacheGet(_negCache, key);
  if (negHit) return negHit;

  _breakerCheck();

  let release = () => {};
  try {
    release = await _acquireSlot();
  } catch (err) {
    // queue full — surface as throw, callers already wrap in try/catch.
    throw err;
  }

  let data;
  try {
    // Wrap the actual network call so cache-hits aren't counted as external calls
    // (those skipped past the cache check at the top of this function).
    data = await instrumentExternalCall('serpapi', engine, () => _fetchSerpApiRaw(engine, params));
  } catch (err) {
    _breakerOnError();
    if (_shouldLog(`err|${key}`)) {
      console.warn(`[serpapi] ${engine} request failed: ${err.message}`);
    }
    throw err;
  } finally {
    if (typeof release === 'function') release();
  }

  if (isEmptyResultPayload(data)) {
    // Treat as a *successful* empty response — do NOT throw, do NOT trip breaker.
    const sanitized = { ...data, _empty: true };
    _cachePut(_negCache, NEG_CACHE_MAX, key, sanitized, NEG_CACHE_TTL_MS);
    _breakerOnSuccess();
    if (_shouldLog(`empty|${key}`)) {
      const reason = typeof data.error === 'string'
        ? data.error
        : (data.search_information?.local_results_state || 'empty');
      console.info(`[serpapi] ${engine} returned no results: ${reason}`);
    }
    return sanitized;
  }

  // Any *other* `error` field is a real failure — preserve historic behavior.
  if (typeof data?.error === 'string' && data.error) {
    _breakerOnError();
    if (_shouldLog(`apierr|${key}`)) {
      console.warn(`[serpapi] ${engine} reported error: ${data.error}`);
    }
    const e = new Error(`SerpAPI error: ${data.error}`);
    e.code = 'SERPAPI_API_ERROR';
    throw e;
  }

  _cachePut(_posCache, POS_CACHE_MAX, key, data, POS_CACHE_TTL_MS);
  _breakerOnSuccess();
  return data;
}

/**
 * Object-style alias used by `atomic-tools.js` and `ebay-sold-listings.js`.
 *
 * Equivalent to `callSerpApi(engine, restOfParams)` but accepts a single
 * `{ engine, ...params }` object to match the established convention used
 * by the SerpAPI JavaScript SDK and our internal V4 worker contracts.
 */
async function fetchSerpApi(opts = {}) {
  if (!opts || typeof opts !== 'object') {
    throw new Error('fetchSerpApi: options object is required');
  }
  const { engine, ...params } = opts;
  return callSerpApi(engine, params);
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

    // Prefer numeric prices when SerpAPI provides them (extracted_* fields).
    // This avoids dropping results when `price` is a range string (e.g. "€19.99 - €29.99"),
    // while still keeping a readable price string when no numeric field exists.
    const numericPrice =
      (typeof entry.extracted_price === 'number' && Number.isFinite(entry.extracted_price) && entry.extracted_price > 0
        ? entry.extracted_price
        : null) ||
      (typeof entry.extracted_lowest === 'number' && Number.isFinite(entry.extracted_lowest) && entry.extracted_lowest > 0
        ? entry.extracted_lowest
        : null);

    items.push({
      title: entry.title || entry.product_title || entry.name || entry.heading || 'Untitled',
      price: numericPrice ?? entry.price,
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
  } else if (engine === 'google_shopping_ai_overview' && Array.isArray(data.shopping_results)) {
    fill(data.shopping_results);
  } else if (engine === 'google_ai_overview' && Array.isArray(data.products)) {
    fill(data.products);
  } else if (engine === 'google' && Array.isArray(data.organic_results)) {
    fill(data.organic_results);
  } else if (engine === 'google_images' && Array.isArray(data.images_results)) {
    fill(data.images_results);
  } else if (engine === 'google_images_shopping' && Array.isArray(data.shopping_results)) {
    fill(data.shopping_results);
  } else if (engine === 'google_lens' && Array.isArray(data.visual_matches)) {
    fill(data.visual_matches);
  } else if ((engine === 'google_reverse_image' || engine === 'bing_images' || engine === 'bing_reverse_image') && Array.isArray(data.image_results)) {
    fill(data.image_results);
  } else if (engine === 'duckduckgo' && Array.isArray(data.organic_results)) {
    fill(data.organic_results);
  } else if (engine === 'ebay' && Array.isArray(data.shopping_results)) {
    fill(data.shopping_results);
  } else if (engine === 'ebay' && Array.isArray(data.organic_results)) {
    fill(data.organic_results);
  } else if (engine === 'ebay_product' && Array.isArray(data.offers)) {
    fill(data.offers);
  } else if (engine === 'amazon') {
    if (Array.isArray(data.images_results)) {
      fill(data.images_results);
    } else if (Array.isArray(data.organic_results)) {
      fill(data.organic_results);
    }
  } else if (engine === 'bing_shopping' && Array.isArray(data.shopping_results)) {
    fill(data.shopping_results);
  } else if (Array.isArray(data.organic_results)) {
    fill(data.organic_results);
  }

  if (items.length === 0) {
    const fallbackFill = (entries) =>
      entries.slice(0, limit).forEach((entry) => pushItem(entry, true));

    if (engine === 'google_images' && Array.isArray(data.images_results)) {
      fallbackFill(data.images_results);
    } else if (engine === 'google_images_shopping' && Array.isArray(data.shopping_results)) {
      fallbackFill(data.shopping_results);
    } else if (engine === 'google_lens' && Array.isArray(data.visual_matches)) {
      fallbackFill(data.visual_matches);
    } else if (
      (engine === 'google_reverse_image' || engine === 'bing_images' || engine === 'bing_reverse_image') &&
      Array.isArray(data.image_results)
    ) {
      fallbackFill(data.image_results);
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Test helpers (not part of the public contract).
// ---------------------------------------------------------------------------

function _resetState() {
  _cacheClear();
  _slotTimestamps.length = 0;
  _activeCalls = 0;
  _waitQueue.length = 0;
  _breaker.state = 'closed';
  _breaker.consecutiveErrors = 0;
  _breaker.openedAt = 0;
  _logTimes.clear();
}

function _getStats() {
  return {
    cache: { positive: _posCache.size, negative: _negCache.size },
    rate: { active: _activeCalls, queued: _waitQueue.length, slotsLastSec: _slotTimestamps.length },
    breaker: { ..._breaker },
    config: {
      POS_CACHE_TTL_MS,
      NEG_CACHE_TTL_MS,
      MAX_PER_SECOND,
      MAX_CONCURRENT,
      BREAKER_THRESHOLD,
      BREAKER_OPEN_MS,
    },
  };
}

module.exports = {
  callSerpApi,
  fetchSerpApi,
  summarizeSerpEntries,
  ALLOWED_ENGINES,
  extractImageMeta,
  isLowResImage,
  isEmptyResultPayload,
  MIN_IMAGE_WIDTH,
  MIN_IMAGE_HEIGHT,
  _internal: {
    resetState: _resetState,
    getStats: _getStats,
    cacheKey: _cacheKey,
  },
};
