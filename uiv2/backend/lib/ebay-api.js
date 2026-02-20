const fetchImpl = global.fetch || require('node-fetch');
const { getValidEbayAccessToken } = require('./ebay-oauth');

async function fetchWithTimeout(url, init, timeoutMs = 25000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function ebayGetJson(path, { query = null, timeoutMs = null } = {}) {
  const { accessToken, apiBaseUrl } = await getValidEbayAccessToken();
  const url = new URL(path, apiBaseUrl);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      const s = String(v).trim();
      if (!s) continue;
      url.searchParams.set(k, s);
    }
  }

  const res = await fetchWithTimeout(
    url.toString(),
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    },
    typeof timeoutMs === 'number'
      ? timeoutMs
      : parseInt(process.env.EBAY_API_TIMEOUT_MS || '25000', 10)
  );

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    let reason = text;
    try {
      const parsed = JSON.parse(text);
      reason = parsed?.errors?.[0]?.message || parsed?.message || JSON.stringify(parsed);
    } catch {
      // ignore
    }
    const err = new Error(`eBay API failed (${res.status}) ${url.pathname}: ${reason}`);
    err.code = 'EBAY_API_ERROR';
    err.statusCode = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

async function getOffersBySku(sku) {
  const cleaned = String(sku || '').trim();
  if (!cleaned) {
    const err = new Error('SKU is required');
    err.code = 'EBAY_SKU_REQUIRED';
    throw err;
  }
  // Per eBay docs: GET /sell/inventory/v1/offer?sku=...
  return await ebayGetJson('/sell/inventory/v1/offer', { query: { sku: cleaned } });
}

module.exports = {
  ebayGetJson,
  getOffersBySku,
};

