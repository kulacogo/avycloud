'use strict';

const { isValidGtin } = require('./gtin');

const EAN_TIMEOUT_MS = parseInt(process.env.EAN_LOOKUP_TIMEOUT_MS || '3000', 10);

const EMPTY_RESULT = {
  found: false,
  source: null,
  productName: null,
  brand: null,
  category: null,
  description: null,
  imageUrl: null,
};

/**
 * Lookup product data by EAN/GTIN from external databases.
 * Best-effort: returns EMPTY_RESULT on any failure.
 *
 * @param {string} ean - EAN-13, GTIN-14, or UPC-12
 * @returns {Promise<{found: boolean, source: string|null, productName: string|null, brand: string|null, category: string|null, description: string|null, imageUrl: string|null}>}
 */
async function lookupEan(ean) {
  const code = String(ean || '').replace(/\D/g, '').trim();
  if (!code || !isValidGtin(code)) {
    return { ...EMPTY_RESULT };
  }

  // Try Open EAN DB first (community database, no rate limit)
  try {
    const result = await fetchWithTimeout(
      `https://opengtindb.org/api/v1/product/${code}?apikey=anonymous`,
      EAN_TIMEOUT_MS
    );
    if (result && result.name) {
      return {
        found: true,
        source: 'open_ean_db',
        productName: result.name || null,
        brand: result.brand || result.vendor || null,
        category: result.maincat || result.subcat || null,
        description: result.descr || null,
        imageUrl: result.img || null,
      };
    }
  } catch {
    // Fall through to next source
  }

  // Fallback: UPCItemDB (trial API, 100 calls/day)
  try {
    const result = await fetchWithTimeout(
      `https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`,
      EAN_TIMEOUT_MS
    );
    const item = result?.items?.[0];
    if (item) {
      return {
        found: true,
        source: 'upcitemdb',
        productName: item.title || null,
        brand: item.brand || null,
        category: item.category || null,
        description: item.description || null,
        imageUrl: Array.isArray(item.images) ? item.images[0] : null,
      };
    }
  } catch {
    // Best-effort
  }

  return { ...EMPTY_RESULT };
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'AvyCloud/1.0' },
    });
    if (!res.ok) return null;
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { lookupEan };
