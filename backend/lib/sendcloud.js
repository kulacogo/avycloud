
'use strict';

const { getSecretValue } = require('./secret-values');

const SENDCLOUD_BASE_URL = 'https://panel.sendcloud.sc/api/v2';

// Cache per date-range key: Map<string, { atMs, data }>
const SHIPPING_CACHE = new Map();
const SHIPPING_TTL_MS = 15 * 60 * 1000; // 15 min

let _cachedAuth = null;

async function getSendCloudAuthHeader() {
  if (_cachedAuth) return _cachedAuth;
  const [pub, sec] = await Promise.all([
    getSecretValue('SENDCLOUD_PUBLIC_KEY'),
    getSecretValue('SENDCLOUD_SECRET_KEY'),
  ]);
  if (!pub || !sec) throw new Error('SENDCLOUD_PUBLIC_KEY / SENDCLOUD_SECRET_KEY not configured');
  _cachedAuth = 'Basic ' + Buffer.from(`${pub}:${sec}`).toString('base64');
  return _cachedAuth;
}

/**
 * Returns total shipping costs for the given date range.
 * Paginates through all parcels and sums parcel `price` values.
 *
 * @param {string} fromDate - 'YYYY-MM-DD'
 * @param {string} toDate   - 'YYYY-MM-DD'
 * @returns {Promise<{ total_cost: number, parcel_count: number, currency: string }>}
 */
async function getShippingCostsSummary(fromDate, toDate, { timeoutMs = 30000, forceRefresh = false } = {}) {
  const cacheKey = `${fromDate}:${toDate}`;
  const now = Date.now();
  const cached = SHIPPING_CACHE.get(cacheKey);
  if (!forceRefresh && cached && now - cached.atMs < SHIPPING_TTL_MS) {
    return cached.data;
  }

  const authHeader = await getSendCloudAuthHeader();
  const deadline = Date.now() + timeoutMs;

  let totalCost = 0;
  let parcelCount = 0;
  let page = 1;
  const limit = 100;

  while (true) {
    if (Date.now() > deadline) break;

    const params = new URLSearchParams({
      from_date: fromDate,
      to_date: toDate,
      limit: String(limit),
      page: String(page),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(15000, deadline - Date.now()));

    let parcels = [];
    try {
      const response = await fetch(`${SENDCLOUD_BASE_URL}/parcels?${params}`, {
        headers: { Authorization: authHeader },
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`SendCloud API returned ${response.status}: ${body.slice(0, 200)}`);
      }

      const data = await response.json();
      parcels = Array.isArray(data?.parcels) ? data.parcels : [];
    } finally {
      clearTimeout(timer);
    }

    for (const parcel of parcels) {
      // SendCloud v2: price is a string like "5.99"
      // Multiple possible field names depending on version / configuration
      const priceRaw =
        parcel.price ??
        parcel.shipment_cost?.price ??
        parcel.shipment_cost?.amount ??
        parcel.insured_value ??
        0;
      const price = parseFloat(String(priceRaw || '0').replace(',', '.')) || 0;
      totalCost += price;
      parcelCount++;
    }

    // SendCloud paginates: stop if fewer results than limit
    if (parcels.length < limit) break;

    // Safety cap to avoid infinite loops
    if (parcelCount > 10000) break;
    page++;
  }

  const result = {
    total_cost: Math.round(totalCost * 100) / 100,
    parcel_count: parcelCount,
    currency: 'EUR',
  };

  SHIPPING_CACHE.set(cacheKey, { atMs: now, data: result });
  return result;
}

module.exports = { getShippingCostsSummary };
