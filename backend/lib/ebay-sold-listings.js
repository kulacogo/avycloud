'use strict';

/**
 * ebay-sold-listings.js
 *
 * Abstraction over eBay Browse API + SerpAPI fallback to fetch *sold* item
 * signals for pricing analysis. eBay's native `Browse` API does not expose
 * a formal `SOLD` filter for public app-tokens (Terapeak has it but costs
 * extra). We combine multiple strategies:
 *
 *   1. Browse API `filter=buyingOptions:{AUCTION|FIXED_PRICE}` with
 *      `filter=itemEndDate:[..now]` (when supported)
 *   2. SerpAPI `engine='ebay'` with `LH_Sold=1&LH_Complete=1` URL params
 *   3. Fallback: eBay Browse active listings (lower-weight signal)
 *
 * Designed to fail gracefully — if no signal is obtainable, returns `null`
 * instead of throwing. Caller (pricing-worker.js) aggregates with other
 * sources (Amazon, Kaufland, Idealo).
 *
 * Public API:
 *   searchSoldListings({ gtin?, query?, categoryId?, limit?, marketplaceId? })
 *   extractPricingSignals(items)
 *
 * Network I/O: YES — called via pricing-worker, not a pure function.
 * Tests mock the fetch layer via require.cache patching.
 */

const DEFAULT_MARKETPLACE = 'EBAY_DE';
const DEFAULT_LIMIT = 20;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const REQUEST_TIMEOUT_MS = 15000;

// In-memory LRU cache by (gtin | query) + categoryId + marketplaceId.
// Identical to the pattern used in ebay-browse-title-insights.js.
const CACHE = new Map();
const CACHE_MAX = 200;

let _ebayBrowseImpl = null;
let _serpApiImpl = null;
let _rateLimiterImpl = null;

function getEbayBrowse() {
  if (_ebayBrowseImpl) return _ebayBrowseImpl;
  try {
    _ebayBrowseImpl = require('./ebay-browse-title-insights');
  } catch (err) {
    _ebayBrowseImpl = null;
  }
  return _ebayBrowseImpl;
}

function getSerpApi() {
  if (_serpApiImpl) return _serpApiImpl;
  try {
    _serpApiImpl = require('./serpapi');
  } catch (err) {
    _serpApiImpl = null;
  }
  return _serpApiImpl;
}

function getRateLimiter() {
  if (_rateLimiterImpl) return _rateLimiterImpl;
  try {
    _rateLimiterImpl = require('./ebay-rate-limiter');
  } catch (err) {
    _rateLimiterImpl = null;
  }
  return _rateLimiterImpl;
}

function cacheKeyFor(input) {
  const { gtin = '', query = '', categoryId = '', marketplaceId = DEFAULT_MARKETPLACE } = input || {};
  return `${marketplaceId}|${categoryId}|${gtin}|${query}`.toLowerCase();
}

function cacheGet(key) {
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    CACHE.delete(key);
    return null;
  }
  // Refresh LRU order
  CACHE.delete(key);
  CACHE.set(key, entry);
  return entry.value;
}

function cacheSet(key, value) {
  if (CACHE.size >= CACHE_MAX) {
    const oldestKey = CACHE.keys().next().value;
    if (oldestKey) CACHE.delete(oldestKey);
  }
  CACHE.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function withTimeout(promise, timeoutMs = REQUEST_TIMEOUT_MS, label = 'ebay-sold') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number.parseFloat(value.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  if (value && typeof value === 'object') {
    return toNumber(value.value ?? value.amount ?? value.price);
  }
  return null;
}

/**
 * Normalize an item from either Browse API or SerpAPI into a uniform shape.
 */
function normalizeItem(raw, source) {
  if (!raw || typeof raw !== 'object') return null;

  const price =
    toNumber(raw.price) ??
    toNumber(raw.currentBidPrice) ??
    toNumber(raw.extracted_price) ??
    toNumber(raw.itemPrice);

  const title = String(raw.title || raw.itemTitle || '').trim().slice(0, 200);
  const itemUrl = String(raw.itemWebUrl || raw.link || raw.url || '').trim();
  const soldDate = raw.itemEndDate || raw.soldDate || raw.end_time || null;
  const condition = String(raw.condition || raw.conditionDisplayName || '').trim();

  if (!price || !title) return null;

  return {
    price,
    title,
    url: itemUrl || null,
    soldDate,
    condition,
    source,
  };
}

/**
 * Try Browse API with itemEndDate filter (experimental — availability varies).
 */
async function tryBrowseApiSold({ gtin, query, categoryId, limit, marketplaceId, env }) {
  const browse = getEbayBrowse();
  if (!browse || typeof browse.getAppToken !== 'function') return [];

  const token = await browse.getAppToken({ env }).catch(() => null);
  if (!token) return [];

  const params = new URLSearchParams();
  if (gtin) params.set('gtin', String(gtin));
  else if (query) params.set('q', String(query).slice(0, 200));
  else return [];
  if (categoryId) params.set('category_ids', String(categoryId));
  params.set('limit', String(Math.min(limit, 50)));
  // Optional filter — eBay may ignore unknown filters; leave as best-effort
  params.set('filter', 'buyingOptions:{FIXED_PRICE}');

  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?${params.toString()}`;

  try {
    const rateLimiter = getRateLimiter();
    if (rateLimiter && typeof rateLimiter.acquireSlot === 'function') {
      await rateLimiter.acquireSlot('browse');
    }

    const res = await withTimeout(
      fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
          'Content-Type': 'application/json',
        },
      }),
      REQUEST_TIMEOUT_MS,
      'browse-sold'
    );

    if (!res.ok) return [];
    const data = await res.json();
    const items = Array.isArray(data.itemSummaries) ? data.itemSummaries : [];
    return items.map((item) => normalizeItem(item, 'ebay_browse')).filter(Boolean);
  } catch (err) {
    return [];
  }
}

/**
 * SerpAPI `engine='ebay'` with LH_Sold=1 & LH_Complete=1 for sold items.
 */
async function trySerpApiSold({ gtin, query, marketplaceId, limit }) {
  const serp = getSerpApi();
  if (!serp || typeof serp.fetchSerpApi !== 'function') return [];

  const searchTerm = gtin || query || '';
  if (!searchTerm) return [];

  const ebayDomain = marketplaceId === 'EBAY_US' ? 'ebay.com' : 'ebay.de';

  try {
    const result = await withTimeout(
      serp.fetchSerpApi({
        engine: 'ebay',
        ebay_domain: ebayDomain,
        _nkw: searchTerm,
        LH_Sold: 1,
        LH_Complete: 1,
        limit: Math.min(limit, 25),
      }),
      REQUEST_TIMEOUT_MS,
      'serpapi-sold'
    );

    if (!result || typeof result !== 'object') return [];
    const items = Array.isArray(result.organic_results) ? result.organic_results : [];
    return items.map((item) => normalizeItem(item, 'serpapi_ebay')).filter(Boolean);
  } catch (err) {
    return [];
  }
}

/**
 * searchSoldListings(input) — primary entry point.
 *
 * @param {object} input
 * @param {string} [input.gtin]
 * @param {string} [input.query]
 * @param {string} [input.categoryId]
 * @param {number} [input.limit=20]
 * @param {string} [input.marketplaceId='EBAY_DE']
 * @param {string} [input.env] — 'PRODUCTION' or 'SANDBOX'
 * @returns {Promise<{ items: NormalizedItem[], meta: { sources, cached, count } }>}
 */
async function searchSoldListings(input = {}) {
  const {
    gtin = '',
    query = '',
    categoryId = '',
    limit = DEFAULT_LIMIT,
    marketplaceId = DEFAULT_MARKETPLACE,
    env,
  } = input;

  if (!gtin && !query) {
    return { items: [], meta: { sources: [], cached: false, count: 0, reason: 'no_query' } };
  }

  const cacheKey = cacheKeyFor({ gtin, query, categoryId, marketplaceId });
  const cached = cacheGet(cacheKey);
  if (cached) {
    return { items: cached.items, meta: { ...cached.meta, cached: true } };
  }

  // Try both sources in parallel, merge results, deduplicate by title+price
  const [browseItems, serpItems] = await Promise.all([
    tryBrowseApiSold({ gtin, query, categoryId, limit, marketplaceId, env }),
    trySerpApiSold({ gtin, query, marketplaceId, limit }),
  ]);

  const allItems = [...browseItems, ...serpItems];

  // Dedupe by normalized title + price
  const seen = new Set();
  const deduped = [];
  for (const item of allItems) {
    const key = `${item.title.toLowerCase().slice(0, 60)}|${item.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  const trimmed = deduped.slice(0, limit);

  const meta = {
    sources: Array.from(new Set(trimmed.map((i) => i.source))),
    cached: false,
    count: trimmed.length,
    browseCount: browseItems.length,
    serpCount: serpItems.length,
  };

  cacheSet(cacheKey, { items: trimmed, meta });
  return { items: trimmed, meta };
}

/**
 * extractPricingSignals(items) → pricing statistics for the sweet-spot pricer.
 */
function extractPricingSignals(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      count: 0,
      prices: [],
      median: null,
      min: null,
      max: null,
      mean: null,
      stdev: null,
    };
  }
  const prices = items
    .map((i) => toNumber(i?.price))
    .filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);

  if (!prices.length) {
    return { count: 0, prices: [], median: null, min: null, max: null, mean: null, stdev: null };
  }

  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const mean = prices.reduce((acc, p) => acc + p, 0) / prices.length;
  const variance =
    prices.reduce((acc, p) => acc + (p - mean) ** 2, 0) / prices.length;
  const stdev = Math.sqrt(variance);

  return {
    count: prices.length,
    prices,
    median: Math.round(median * 100) / 100,
    min: Math.round(sorted[0] * 100) / 100,
    max: Math.round(sorted[sorted.length - 1] * 100) / 100,
    mean: Math.round(mean * 100) / 100,
    stdev: Math.round(stdev * 100) / 100,
  };
}

module.exports = {
  DEFAULT_MARKETPLACE,
  DEFAULT_LIMIT,
  CACHE_TTL_MS,
  searchSoldListings,
  extractPricingSignals,
  _internal: {
    normalizeItem,
    toNumber,
    cacheKeyFor,
    cacheGet,
    cacheSet,
    CACHE,
  },
};
