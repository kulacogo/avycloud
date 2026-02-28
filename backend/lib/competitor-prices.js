/* eslint-disable no-console */

/**
 * Competitor price lookup — fetches competing listings for a given EAN/GTIN
 * from eBay (Browse API) and Kaufland (Seller API).
 *
 * Relies on existing auth infrastructure:
 *   - eBay: getAppToken() from ebay-browse-title-insights.js (client credentials)
 *   - Kaufland: kauflandRequest() from kaufland-api.js (HMAC signing)
 */

const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const CACHE_MAX_SIZE = 2000;

/** @type {Map<string, { data: any, expiresAt: number }>} */
const cache = new Map();

function safeString(value) {
  return value == null ? '' : String(value).trim();
}

function normalizeEan(value) {
  return safeString(value).replace(/\D+/g, '');
}

function pruneCache() {
  if (cache.size <= CACHE_MAX_SIZE) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt < now) cache.delete(key);
  }
  // If still too large, remove oldest entries
  if (cache.size > CACHE_MAX_SIZE) {
    const entries = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    const toRemove = entries.slice(0, entries.length - CACHE_MAX_SIZE);
    for (const [key] of toRemove) cache.delete(key);
  }
}

// ---------------------------------------------------------------------------
// eBay Browse API — competitor listings
// ---------------------------------------------------------------------------

async function fetchEbayCompetitorListings(ean) {
  const { getAppToken } = require('./ebay-browse-title-insights');

  const env = (process.env.EBAY_BROWSE_ENV || process.env.EBAY_TAXONOMY_ENV || 'production')
    .toString().trim().toLowerCase();
  const base = env === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
  const marketplaceId = (process.env.EBAY_MARKETPLACE_ID || 'EBAY_DE').toString().trim();

  const token = await getAppToken({ env });

  const params = new URLSearchParams();
  params.set('gtin', ean);
  params.set('filter', 'conditions:{NEW}');
  params.set('limit', '40');
  params.set('offset', '0');

  const url = `${base}/buy/browse/v1/item_summary/search?${params.toString()}`;
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
    console.error(`[competitor-prices] eBay Browse API error (${response.status}): ${text.slice(0, 300)}`);
    return [];
  }

  const payload = JSON.parse(text);
  const items = Array.isArray(payload?.itemSummaries) ? payload.itemSummaries : [];

  return items
    .map((item) => {
      const priceRaw = item?.price?.value;
      const price = typeof priceRaw === 'number' ? priceRaw
        : typeof priceRaw === 'string' ? parseFloat(priceRaw)
          : NaN;
      const currency = safeString(item?.price?.currency).toUpperCase() || 'EUR';
      const itemUrl = safeString(item?.itemWebUrl);

      // Extract shipping cost if available
      const shippingOptions = Array.isArray(item?.shippingOptions) ? item.shippingOptions : [];
      const shippingCostRaw = shippingOptions[0]?.shippingCost?.value;
      const shippingCost = typeof shippingCostRaw === 'string' ? parseFloat(shippingCostRaw)
        : typeof shippingCostRaw === 'number' ? shippingCostRaw
          : undefined;

      return {
        marketplace: 'ebay',
        seller: safeString(item?.seller?.username) || undefined,
        title: safeString(item?.title),
        price: Number.isFinite(price) ? price : null,
        currency,
        shippingCost: Number.isFinite(shippingCost) ? shippingCost : undefined,
        url: /^https?:\/\//i.test(itemUrl) ? itemUrl : undefined,
      };
    })
    .filter((x) => x.price !== null && x.price >= 1 && x.currency === 'EUR')
    .sort((a, b) => a.price - b.price);
}

// ---------------------------------------------------------------------------
// Kaufland Seller API — competitor listings
// ---------------------------------------------------------------------------

async function fetchKauflandCompetitorListings(ean) {
  const { kauflandRequest } = require('./kaufland-api');

  try {
    // Try fetching product with embedded units (may include other sellers' offers)
    const res = await kauflandRequest('GET', `/products/ean/${encodeURIComponent(ean)}`, {
      query: { storefront: 'de', embedded: 'units' },
    });

    const product = res?.data?.data || res?.data || null;
    if (!product) return [];

    // Units may be embedded in the product response
    const units = Array.isArray(product?.units)
      ? product.units
      : Array.isArray(product?.embedded?.units)
        ? product.embedded.units
        : [];

    if (!units.length) return [];

    const now = new Date().toISOString();
    return units
      .filter((u) => {
        // Only NEW condition, active status
        const condition = u?.condition || u?.condition_code;
        const isNew = condition === 100 || condition === 'NEW' || condition === 'new';
        const isActive = !u?.status || u?.status === 'active' || u?.status === 1;
        return isNew && isActive;
      })
      .map((u) => {
        const price = Number(u?.listing_price || u?.amount || u?.price || 0) / 100; // Kaufland uses cents
        const idProduct = product?.id_product || product?.id || '';
        return {
          marketplace: 'kaufland',
          seller: safeString(u?.seller_name || u?.shop_name) || undefined,
          title: safeString(product?.title || ''),
          price: Number.isFinite(price) && price > 0 ? price : null,
          currency: 'EUR',
          shippingCost: undefined,
          url: idProduct
            ? `https://www.kaufland.de/product/${idProduct}/`
            : undefined,
        };
      })
      .filter((x) => x.price !== null && x.price >= 1)
      .sort((a, b) => a.price - b.price);
  } catch (err) {
    // Graceful fallback — Kaufland API may not support embedded units for other sellers
    const status = err?.status || err?.code || '';
    if (String(status).includes('404') || String(status).includes('400')) {
      // Product not found or bad request — expected for EANs not on Kaufland
      return [];
    }
    console.error(`[competitor-prices] Kaufland API error: ${err.message || err}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Combined: fan-out + cache
// ---------------------------------------------------------------------------

async function getCompetitorPrices(ean) {
  const normalizedEan = normalizeEan(ean);
  if (!normalizedEan || normalizedEan.length < 8) {
    return { ebay: [], kaufland: [], cached: false, fetched_at: new Date().toISOString() };
  }

  // Check cache
  const cached = cache.get(normalizedEan);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.data, cached: true };
  }

  // Fan out to both marketplaces in parallel
  const [ebayResult, kauflandResult] = await Promise.allSettled([
    fetchEbayCompetitorListings(normalizedEan),
    fetchKauflandCompetitorListings(normalizedEan),
  ]);

  const fetchedAt = new Date().toISOString();
  const data = {
    ebay: ebayResult.status === 'fulfilled' ? ebayResult.value : [],
    kaufland: kauflandResult.status === 'fulfilled' ? kauflandResult.value : [],
    cached: false,
    fetched_at: fetchedAt,
  };

  // Log errors but don't fail
  if (ebayResult.status === 'rejected') {
    console.error('[competitor-prices] eBay fetch failed:', ebayResult.reason?.message || ebayResult.reason);
  }
  if (kauflandResult.status === 'rejected') {
    console.error('[competitor-prices] Kaufland fetch failed:', kauflandResult.reason?.message || kauflandResult.reason);
  }

  // Cache the result
  pruneCache();
  cache.set(normalizedEan, { data, expiresAt: Date.now() + CACHE_TTL_MS });

  return data;
}

module.exports = { getCompetitorPrices, fetchEbayCompetitorListings, fetchKauflandCompetitorListings };
