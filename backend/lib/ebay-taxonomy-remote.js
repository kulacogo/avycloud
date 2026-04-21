/* eslint-disable no-console */
'use strict';

/**
 * eBay Taxonomy + Catalog remote wrappers used by the Category Resolver v2.
 *
 * Exposes two primary functions:
 *   - getCategorySuggestions(queryText, { treeId, marketplaceId }) — Taxonomy API
 *       `get_category_suggestions` endpoint. Returns ranked category suggestions
 *       with full breadcrumbs.
 *   - searchCatalogByGtin(gtin, { marketplaceId }) — Catalog API
 *       `product_summary/search` by GTIN. Aggregates the most frequent
 *       primaryCategory across product summaries to derive a categoryId.
 *
 * Both functions:
 *   - reuse getAppToken() from ebay-browse-title-insights (client credentials OAuth)
 *   - respect the global eBay rate limiter (acquireSlot)
 *   - share an in-memory 24h TTL cache keyed by (query|gtin, marketplaceId)
 */

const { getAppToken } = require('./ebay-browse-title-insights');
const { acquireSlot } = require('./ebay-rate-limiter');

const DEFAULT_MARKETPLACE_ID = (process.env.EBAY_MARKETPLACE_ID || 'EBAY_DE').toString().trim();
const DEFAULT_TREE_ID = (process.env.EBAY_TAXONOMY_TREE_ID || '77').toString().trim();
const DEFAULT_ENV = (process.env.EBAY_TAXONOMY_ENV || process.env.EBAY_BROWSE_ENV || 'production')
  .toString()
  .trim()
  .toLowerCase();

const CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.EBAY_TAXONOMY_REMOTE_CACHE_MS || 24 * 60 * 60 * 1000) || 24 * 60 * 60 * 1000
);
const CACHE_MAX_ENTRIES = 2000;

const suggestionCache = new Map();
const catalogCache = new Map();

function safeString(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeDigits(value = '') {
  return safeString(value).replace(/\D+/g, '');
}

function getIdentityBase(env = DEFAULT_ENV) {
  return env === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
}

function pruneCache(cache) {
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt < now) cache.delete(key);
  }
  if (cache.size > CACHE_MAX_ENTRIES) {
    const overflow = cache.size - CACHE_MAX_ENTRIES;
    const it = cache.keys();
    for (let i = 0; i < overflow; i += 1) {
      const next = it.next();
      if (next.done) break;
      cache.delete(next.value);
    }
  }
}

function readCache(cache, key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function writeCache(cache, key, value) {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  pruneCache(cache);
}

function buildBreadcrumbFromAncestors(category, ancestors = []) {
  const parts = [];
  const sorted = Array.isArray(ancestors)
    ? ancestors
        .filter((a) => a && typeof a === 'object')
        .slice()
        .sort((a, b) => {
          const la = Number(a?.categoryTreeNodeLevel ?? a?.level ?? 0);
          const lb = Number(b?.categoryTreeNodeLevel ?? b?.level ?? 0);
          return la - lb;
        })
    : [];
  for (const anc of sorted) {
    const name = safeString(anc?.categoryName);
    if (name) parts.push(name);
  }
  const leaf = safeString(category?.categoryName);
  if (leaf) parts.push(leaf);
  return parts.join(' > ');
}

/**
 * Fetch eBay category suggestions for a free-form query text.
 *
 * @param {string} queryText
 * @param {{ treeId?: string, marketplaceId?: string, env?: string, forceRefresh?: boolean }} [options]
 * @returns {Promise<Array<{ categoryId: string, breadcrumb: string, relevancy: number }>>}
 */
async function getCategorySuggestions(queryText, options = {}) {
  const q = safeString(queryText);
  if (!q) return [];

  const treeId = safeString(options.treeId || DEFAULT_TREE_ID) || DEFAULT_TREE_ID;
  const marketplaceId = safeString(options.marketplaceId || DEFAULT_MARKETPLACE_ID).toUpperCase();
  const env = safeString(options.env || DEFAULT_ENV).toLowerCase() || DEFAULT_ENV;
  const cacheKey = `${treeId}|${marketplaceId}|${env}|${q.toLowerCase().slice(0, 200)}`;

  if (!options.forceRefresh) {
    const cached = readCache(suggestionCache, cacheKey);
    if (cached) return cached;
  }

  let token;
  try {
    token = await getAppToken({ env });
  } catch (err) {
    console.warn('[ebay-taxonomy-remote] getAppToken failed:', err?.message || err);
    return [];
  }

  const params = new URLSearchParams({ q: q.slice(0, 200) });
  const url = `${getIdentityBase(env)}/commerce/taxonomy/v1/category_tree/${encodeURIComponent(
    treeId
  )}/get_category_suggestions?${params.toString()}`;

  try {
    await acquireSlot();
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
        'Accept-Language': 'de-DE',
      },
    });
    const text = await response.text();
    if (!response.ok) {
      console.warn(
        `[ebay-taxonomy-remote] get_category_suggestions failed (${response.status}): ${text.slice(0, 200)}`
      );
      return [];
    }
    const payload = text ? JSON.parse(text) : {};
    const raw = Array.isArray(payload?.categorySuggestions) ? payload.categorySuggestions : [];
    const out = raw
      .map((entry) => {
        const category = entry?.category || {};
        const categoryId = safeString(category?.categoryId);
        if (!categoryId) return null;
        const breadcrumb = buildBreadcrumbFromAncestors(
          category,
          entry?.categoryTreeNodeAncestors
        );
        const relevancyRaw = entry?.relevancy;
        const relevancy = Number.isFinite(Number(relevancyRaw))
          ? Math.max(0, Math.min(1, Number(relevancyRaw)))
          : 0;
        return { categoryId, breadcrumb, relevancy };
      })
      .filter(Boolean);

    writeCache(suggestionCache, cacheKey, out);
    return out;
  } catch (err) {
    console.warn('[ebay-taxonomy-remote] getCategorySuggestions error:', err?.message || err);
    return [];
  }
}

/**
 * Resolve the most likely eBay categoryId for a GTIN via the Catalog API.
 * Uses a voting approach across all matching product summaries.
 *
 * @param {string} gtin
 * @param {{ marketplaceId?: string, env?: string, forceRefresh?: boolean }} [options]
 * @returns {Promise<{ categoryId: string, breadcrumb: string, confidence: number, votes: number, total: number } | null>}
 */
async function searchCatalogByGtin(gtin, options = {}) {
  const g = normalizeDigits(gtin);
  if (!g) return null;

  const marketplaceId = safeString(options.marketplaceId || DEFAULT_MARKETPLACE_ID).toUpperCase();
  const env = safeString(options.env || DEFAULT_ENV).toLowerCase() || DEFAULT_ENV;
  const cacheKey = `${marketplaceId}|${env}|${g}`;

  if (!options.forceRefresh) {
    const cached = readCache(catalogCache, cacheKey);
    if (cached !== null && cached !== undefined) return cached;
  }

  let token;
  try {
    token = await getAppToken({ env });
  } catch (err) {
    console.warn('[ebay-taxonomy-remote] getAppToken failed:', err?.message || err);
    return null;
  }

  const params = new URLSearchParams({ gtin: g });
  const url = `${getIdentityBase(env)}/commerce/catalog/v1_beta/product_summary/search?${params.toString()}`;

  try {
    await acquireSlot();
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
        'Accept-Language': 'de-DE',
      },
    });
    const text = await response.text();
    if (!response.ok) {
      console.warn(
        `[ebay-taxonomy-remote] catalog search failed (${response.status}): ${text.slice(0, 200)}`
      );
      writeCache(catalogCache, cacheKey, null);
      return null;
    }
    const payload = text ? JSON.parse(text) : {};
    const summaries = Array.isArray(payload?.productSummaries) ? payload.productSummaries : [];
    const total = summaries.length;
    if (!total) {
      writeCache(catalogCache, cacheKey, null);
      return null;
    }

    const counts = new Map();
    const firstBreadcrumbById = new Map();
    for (const s of summaries) {
      const primary = s?.primaryCategory || {};
      const id = safeString(primary?.categoryId);
      if (!id) continue;
      counts.set(id, (counts.get(id) || 0) + 1);
      if (!firstBreadcrumbById.has(id)) {
        const bc =
          buildBreadcrumbFromAncestors(primary, primary?.categoryAncestors) ||
          safeString(primary?.categoryName);
        firstBreadcrumbById.set(id, bc);
      }
    }

    if (!counts.size) {
      writeCache(catalogCache, cacheKey, null);
      return null;
    }

    let winnerId = '';
    let winnerVotes = 0;
    for (const [id, votes] of counts.entries()) {
      if (votes > winnerVotes) {
        winnerId = id;
        winnerVotes = votes;
      }
    }

    const result = {
      categoryId: winnerId,
      breadcrumb: firstBreadcrumbById.get(winnerId) || '',
      confidence: total > 0 ? Number((winnerVotes / total).toFixed(4)) : 0,
      votes: winnerVotes,
      total,
    };
    writeCache(catalogCache, cacheKey, result);
    return result;
  } catch (err) {
    console.warn('[ebay-taxonomy-remote] searchCatalogByGtin error:', err?.message || err);
    return null;
  }
}

function _resetCaches() {
  suggestionCache.clear();
  catalogCache.clear();
}

module.exports = {
  getCategorySuggestions,
  searchCatalogByGtin,
  _resetCaches,
};
