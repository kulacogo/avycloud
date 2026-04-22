'use strict';

/**
 * ebay-catalog.js
 *
 * Abstraction over eBay Catalog API (GTIN→ePID) + Browse API fallback for
 * catalog-level product data. Used by category-worker + attributes-worker
 * to ground eBay category + aspect suggestions in the official catalog.
 *
 * API approaches:
 *   1. Catalog API `GET /commerce/catalog/v1_beta/product_summary/search?gtin=...`
 *      — beta, limited region support, requires `https://api.ebay.com/oauth/api_scope/commerce.catalog.readonly` scope
 *   2. Browse API `item_summary/search?gtin=<GTIN>&fieldgroups=ASPECT_REFINEMENTS`
 *      — broader availability, extracts ePID + aspects from top result
 *
 * We try (1) then (2). Graceful fallback on error.
 *
 * Public API:
 *   lookupByGtin({ gtin, marketplaceId?, env? })
 *   extractCatalogAspects(catalogResponse)
 *
 * Network I/O: YES. Tests mock the fetch layer + dependencies.
 */

const DEFAULT_MARKETPLACE = 'EBAY_DE';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h — ePID mappings are stable
const REQUEST_TIMEOUT_MS = 15000;

const CACHE = new Map();
const CACHE_MAX = 500;

let _browseImpl = null;

function getEbayBrowse() {
  if (_browseImpl) return _browseImpl;
  try {
    _browseImpl = require('./ebay-browse-title-insights');
  } catch (err) {
    _browseImpl = null;
  }
  return _browseImpl;
}

function cacheKey(gtin, marketplaceId) {
  return `${String(marketplaceId || DEFAULT_MARKETPLACE).toLowerCase()}|${String(gtin || '').trim()}`;
}

function cacheGet(key) {
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    CACHE.delete(key);
    return null;
  }
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

function withTimeout(promise, timeoutMs = REQUEST_TIMEOUT_MS, label = 'ebay-catalog') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

function normalizeCatalogProduct(raw, source) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    ebayProductId:
      raw.epid || raw.ebayProductId || raw.epidValue || raw.productId || null,
    title: String(raw.title || raw.productTitle || '').trim(),
    brand: String(raw.brand || '').trim() || null,
    gtin: String(raw.gtin || raw.ean || '').trim() || null,
    categoryId:
      raw.categoryId || raw.primaryCategory?.categoryId || raw.primaryCategoryId || null,
    categoryName:
      raw.categoryName ||
      raw.primaryCategory?.categoryName ||
      (Array.isArray(raw.categoryAncestorIds) ? raw.categoryAncestorIds.slice(-1)[0] : null) ||
      null,
    imageUrl: raw.image?.imageUrl || raw.thumbnailImages?.[0]?.imageUrl || null,
    aspects: extractCatalogAspects(raw),
    source,
  };
}

/**
 * Extracts aspects from various eBay response shapes:
 *   - Catalog: productSpecificRecommendations or aspects[]
 *   - Browse: aspectDistributions → aspectValues[]
 */
function extractCatalogAspects(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const aspects = [];

  // Catalog API shape
  if (Array.isArray(raw.aspects)) {
    for (const a of raw.aspects) {
      const name = String(a?.localizedName || a?.name || '').trim();
      const values = Array.isArray(a?.localizedValues)
        ? a.localizedValues
        : Array.isArray(a?.values)
        ? a.values
        : [];
      const value = String(values[0] || '').trim();
      if (name && value) aspects.push({ key: name, value });
    }
  }

  // Browse API aspectDistributions shape
  if (Array.isArray(raw.aspectDistributions)) {
    for (const d of raw.aspectDistributions) {
      const name = String(d?.localizedAspectName || '').trim();
      const top = Array.isArray(d?.aspectValueDistributions)
        ? d.aspectValueDistributions[0]
        : null;
      const value = String(top?.localizedAspectValue || '').trim();
      if (name && value) aspects.push({ key: name, value });
    }
  }

  return aspects;
}

/**
 * Try eBay Catalog API v1_beta.
 */
async function tryCatalogApi({ gtin, marketplaceId, env }) {
  const browse = getEbayBrowse();
  if (!browse || typeof browse.getAppToken !== 'function') return null;

  const token = await browse.getAppToken({ env }).catch(() => null);
  if (!token) return null;

  const url = `https://api.ebay.com/commerce/catalog/v1_beta/product_summary/search?gtin=${encodeURIComponent(gtin)}&limit=1`;

  try {
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
      'catalog-api'
    );
    if (!res.ok) return null;
    const data = await res.json();
    const first = Array.isArray(data?.productSummaries) ? data.productSummaries[0] : null;
    if (!first) return null;
    return normalizeCatalogProduct(first, 'ebay_catalog');
  } catch (err) {
    return null;
  }
}

/**
 * Fallback: Browse API `item_summary/search?gtin=...` and extract ePID + aspects
 * from the top-ranked result.
 */
async function tryBrowseFallback({ gtin, marketplaceId, env }) {
  const browse = getEbayBrowse();
  if (!browse || typeof browse.getAppToken !== 'function') return null;

  const token = await browse.getAppToken({ env }).catch(() => null);
  if (!token) return null;

  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?gtin=${encodeURIComponent(gtin)}&fieldgroups=ASPECT_REFINEMENTS,EXTENDED&limit=1`;

  try {
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
      'browse-fallback'
    );
    if (!res.ok) return null;
    const data = await res.json();
    const first = Array.isArray(data?.itemSummaries) ? data.itemSummaries[0] : null;
    if (!first) return null;

    // Prefer the full search response for aspects
    const aspectsSource = {
      ...first,
      aspectDistributions: data.aspectDistributions || first.aspectDistributions || [],
    };

    return normalizeCatalogProduct(
      {
        epid: first.epid || first.ebayProductId,
        title: first.title,
        brand: first.brand || first.seller?.brandName,
        gtin,
        categoryId: first.categoryId || first.primaryCategoryId,
        categoryName: first.categoryPath,
        image: first.image,
        aspectDistributions: aspectsSource.aspectDistributions,
      },
      'ebay_browse_gtin'
    );
  } catch (err) {
    return null;
  }
}

/**
 * lookupByGtin({ gtin, marketplaceId?, env? }) → normalized product or null.
 */
async function lookupByGtin(input = {}) {
  const { gtin, marketplaceId = DEFAULT_MARKETPLACE, env } = input;

  if (!gtin || typeof gtin !== 'string' || gtin.trim().length < 8) {
    return { ok: false, product: null, reason: 'invalid_gtin' };
  }

  const key = cacheKey(gtin, marketplaceId);
  const cached = cacheGet(key);
  if (cached) {
    return { ok: true, product: cached, cached: true, source: cached.source };
  }

  const catalogResult = await tryCatalogApi({ gtin: gtin.trim(), marketplaceId, env });
  if (catalogResult) {
    cacheSet(key, catalogResult);
    return { ok: true, product: catalogResult, cached: false, source: 'ebay_catalog' };
  }

  const browseResult = await tryBrowseFallback({ gtin: gtin.trim(), marketplaceId, env });
  if (browseResult) {
    cacheSet(key, browseResult);
    return { ok: true, product: browseResult, cached: false, source: 'ebay_browse_gtin' };
  }

  return { ok: false, product: null, reason: 'no_catalog_match' };
}

module.exports = {
  DEFAULT_MARKETPLACE,
  CACHE_TTL_MS,
  lookupByGtin,
  extractCatalogAspects,
  _internal: {
    normalizeCatalogProduct,
    cacheKey,
    cacheGet,
    cacheSet,
    CACHE,
    tryCatalogApi,
    tryBrowseFallback,
  },
};
