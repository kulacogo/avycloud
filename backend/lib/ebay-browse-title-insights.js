/* eslint-disable no-console */
const { getSecretValue } = require('./secret-values');
const { decodeHtmlEntitiesDeep } = require('./html-entities');
const { acquireSlot } = require('./ebay-rate-limiter');

const DEFAULT_MARKETPLACE_ID = (process.env.EBAY_MARKETPLACE_ID || 'EBAY_DE').toString().trim();
const DEFAULT_ENV = (process.env.EBAY_BROWSE_ENV || process.env.EBAY_TAXONOMY_ENV || 'production')
  .toString()
  .trim()
  .toLowerCase();
const INSIGHT_CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.EBAY_BROWSE_TITLE_INSIGHTS_CACHE_MS || 6 * 60 * 60 * 1000) || 6 * 60 * 60 * 1000
);

const tokenCache = {
  token: '',
  expiresAt: 0,
  env: '',
};

const insightCache = new Map();

const STOP_WORDS = new Set([
  'der',
  'die',
  'das',
  'dem',
  'den',
  'des',
  'ein',
  'eine',
  'einer',
  'eines',
  'einen',
  'und',
  'oder',
  'mit',
  'ohne',
  'fur',
  'fuer',
  'für',
  'vom',
  'von',
  'zur',
  'zum',
  'im',
  'am',
  'in',
  'an',
  'auf',
  'aus',
  'set',
  'neu',
  'new',
  'original',
  'top',
  'super',
  'premium',
  'sale',
  'angebot',
]);

function safeString(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeToken(raw = '') {
  return decodeHtmlEntitiesDeep(String(raw || ''))
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

function isBarcodeLikeToken(token = '') {
  const digits = safeString(token).replace(/[^\d]/g, '');
  if (!digits || !/^\d+$/.test(digits)) return false;
  return digits.length === 8 || digits.length === 12 || digits.length === 13 || digits.length === 14;
}

function isNoiseToken(token = '') {
  const normalized = normalizeToken(token);
  if (!normalized) return true;
  if (STOP_WORDS.has(normalized)) return true;
  if (isBarcodeLikeToken(normalized)) return true;
  if (normalized === 'ean' || normalized === 'gtin' || normalized === 'upc' || normalized === 'sku') return true;
  if (normalized.length < 3) return true;
  if (/^\d+$/.test(normalized)) return true;
  return false;
}

function tokenizeTitle(title = '') {
  const plain = decodeHtmlEntitiesDeep(safeString(title));
  if (!plain) return [];
  const cleaned = plain
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[^\p{L}\p{N}\s\-+./]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  const out = [];
  const seen = new Set();
  cleaned.split(/\s+/g).forEach((part) => {
    const token = safeString(part);
    const norm = normalizeToken(token);
    if (!norm || seen.has(norm) || isNoiseToken(norm)) return;
    seen.add(norm);
    out.push(norm);
  });
  return out;
}

function getIdentityBase(env = DEFAULT_ENV) {
  return env === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
}

async function resolveCredential(nameCandidates = []) {
  for (const name of nameCandidates) {
    const direct = safeString(process.env[name]);
    if (direct) return direct;
  }
  for (const name of nameCandidates) {
    try {
      const secret = safeString(await getSecretValue(name));
      if (secret) return secret;
    } catch {
      // best effort
    }
  }
  return '';
}

async function getAppToken({ env = DEFAULT_ENV } = {}) {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now + 60_000 && tokenCache.env === env) {
    return tokenCache.token;
  }

  const clientId = await resolveCredential(['EBAY_TRADING_APP_ID', 'EBAY_APP_ID', 'EBAY_CLIENT_ID']);
  const clientSecret = await resolveCredential(['EBAY_TRADING_CERT_ID', 'EBAY_CERT_ID', 'EBAY_CLIENT_SECRET']);
  if (!clientId || !clientSecret) {
    throw new Error('Missing eBay app credentials for Browse API (client id/secret).');
  }

  const tokenUrl = `${getIdentityBase(env)}/identity/v1/oauth2/token`;
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'https://api.ebay.com/oauth/api_scope',
  });

  await acquireSlot();
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`eBay OAuth token failed (${response.status}): ${text.slice(0, 300)}`);
  }
  const payload = JSON.parse(text);
  const token = safeString(payload?.access_token);
  const expiresInSec = Math.max(60, Number(payload?.expires_in || 7200));
  if (!token) {
    throw new Error('eBay OAuth token response missing access_token');
  }
  tokenCache.token = token;
  tokenCache.expiresAt = now + expiresInSec * 1000;
  tokenCache.env = env;
  return token;
}

function buildInsightCacheKey({ categoryId, query, marketplaceId, env, limit }) {
  return [
    safeString(env || DEFAULT_ENV).toLowerCase(),
    safeString(marketplaceId || DEFAULT_MARKETPLACE_ID).toUpperCase(),
    safeString(categoryId),
    safeString(query).toLowerCase(),
    String(limit || 0),
  ].join('|');
}

function buildTopTokens(titles = [], { maxTokens = 12 } = {}) {
  const frequencies = new Map();
  const titleCount = Math.max(1, titles.length);
  titles.forEach((title) => {
    const perTitle = tokenizeTitle(title);
    perTitle.forEach((token) => {
      frequencies.set(token, (frequencies.get(token) || 0) + 1);
    });
  });

  return Array.from(frequencies.entries())
    .filter(([token, count]) => {
      if (!token || count < 2) return false;
      const coverage = count / titleCount;
      return coverage >= 0.08;
    })
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(1, Math.min(30, Number(maxTokens) || 12)))
    .map(([token, count]) => ({ token, count, coverage: Number((count / titleCount).toFixed(3)) }));
}

async function fetchBrowseTitles({
  categoryId,
  marketplaceId = DEFAULT_MARKETPLACE_ID,
  query = '',
  limit = 80,
  env = DEFAULT_ENV,
} = {}) {
  const token = await getAppToken({ env });
  const cappedLimit = Math.max(20, Math.min(200, Number(limit) || 80));
  const q = safeString(query).slice(0, 100);

  const params = new URLSearchParams();
  // Only set category_ids when non-empty — allows keyword-only queries
  const catStr = safeString(categoryId).replace(/\D+/g, '');
  if (catStr) params.set('category_ids', catStr);
  params.set('limit', String(cappedLimit));
  params.set('offset', '0');
  if (q) params.set('q', q);

  const url = `${getIdentityBase(env)}/buy/browse/v1/item_summary/search?${params.toString()}`;
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
    throw new Error(`Browse search failed (${response.status}): ${text.slice(0, 300)}`);
  }

  const payload = JSON.parse(text);
  const itemSummaries = Array.isArray(payload?.itemSummaries) ? payload.itemSummaries : [];
  const titles = itemSummaries
    .map((item) => safeString(item?.title))
    .filter(Boolean)
    .slice(0, cappedLimit);

  return {
    href: safeString(payload?.href),
    total: Number(payload?.total || itemSummaries.length || 0),
    titles,
  };
}

async function fetchBrowsePriceSamples({
  categoryId,
  marketplaceId = DEFAULT_MARKETPLACE_ID,
  query = '',
  gtin = '',
  limit = 80,
  env = DEFAULT_ENV,
} = {}) {
  const token = await getAppToken({ env });
  const cappedLimit = Math.max(20, Math.min(200, Number(limit) || 80));
  const q = safeString(query).slice(0, 100);
  const g = safeString(gtin).replace(/[^\d]/g, '').slice(0, 14);
  const cat = safeString(categoryId);

  const params = new URLSearchParams();
  if (cat) params.set('category_ids', cat);
  params.set('limit', String(cappedLimit));
  params.set('offset', '0');
  if (g) {
    params.set('gtin', g);
  } else if (q) {
    params.set('q', q);
  }

  const url = `${getIdentityBase(env)}/buy/browse/v1/item_summary/search?${params.toString()}`;
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
    throw new Error(`Browse search failed (${response.status}): ${text.slice(0, 300)}`);
  }

  const payload = JSON.parse(text);
  const itemSummaries = Array.isArray(payload?.itemSummaries) ? payload.itemSummaries : [];
  const samples = itemSummaries
    .map((item) => {
      const url = safeString(item?.itemWebUrl);
      const valueRaw = item?.price?.value;
      const currency = safeString(item?.price?.currency).toUpperCase();
      const value =
        typeof valueRaw === 'number' && Number.isFinite(valueRaw)
          ? valueRaw
          : typeof valueRaw === 'string'
            ? Number(String(valueRaw).trim())
            : NaN;
      return {
        itemId: safeString(item?.itemId),
        title: safeString(item?.title),
        url,
        value: Number.isFinite(value) ? value : null,
        currency: currency || null,
      };
    })
    .filter((x) => x && x.url && typeof x.value === 'number' && Number.isFinite(x.value));

  return {
    href: safeString(payload?.href),
    total: Number(payload?.total || itemSummaries.length || 0),
    samples: samples.slice(0, cappedLimit),
  };
}

async function fetchCategoryTitleInsights({
  categoryId,
  query = '',
  marketplaceId = DEFAULT_MARKETPLACE_ID,
  limit = 80,
  env = DEFAULT_ENV,
  forceRefresh = false,
} = {}) {
  const cat = safeString(categoryId).replace(/\D+/g, '');
  const q = safeString(query).slice(0, 100);
  // Allow query-only requests (no category_ids) — eBay Browse API supports keyword-only search
  if (!cat && !q) {
    return {
      ok: false,
      categoryId: '',
      query: '',
      marketplaceId: safeString(marketplaceId).toUpperCase(),
      titles: [],
      topTokens: [],
      error: 'missing_category_id_and_query',
      fromCache: false,
    };
  }

  const cacheKey = buildInsightCacheKey({
    categoryId: cat,
    query,
    marketplaceId,
    env,
    limit,
  });
  const now = Date.now();
  if (!forceRefresh && insightCache.has(cacheKey)) {
    const cached = insightCache.get(cacheKey);
    if (cached?.expiresAt > now) {
      return { ...cached.payload, fromCache: true };
    }
    insightCache.delete(cacheKey);
  }

  try {
    const primary = await fetchBrowseTitles({
      categoryId: cat,
      marketplaceId,
      query,
      limit,
      env,
    });

    let titles = Array.isArray(primary?.titles) ? primary.titles : [];
    // Only fall back to category-only if we have a categoryId — query-only searches have no useful fallback
    if (!titles.length && q && cat) {
      const fallback = await fetchBrowseTitles({
        categoryId: cat,
        marketplaceId,
        query: '',
        limit,
        env,
      });
      titles = Array.isArray(fallback?.titles) ? fallback.titles : [];
    }

    const topTokens = buildTopTokens(titles, { maxTokens: 16 });
    const payload = {
      ok: true,
      categoryId: cat,
      query: safeString(query),
      marketplaceId: safeString(marketplaceId).toUpperCase(),
      titles: titles.slice(0, 30),
      topTokens,
      error: null,
      fromCache: false,
    };
    insightCache.set(cacheKey, {
      expiresAt: now + INSIGHT_CACHE_TTL_MS,
      payload,
    });
    return payload;
  } catch (error) {
    return {
      ok: false,
      categoryId: cat,
      query: safeString(query),
      marketplaceId: safeString(marketplaceId).toUpperCase(),
      titles: [],
      topTokens: [],
      error: error?.message || String(error),
      fromCache: false,
    };
  }
}

/**
 * Convenience wrapper: returns up to `limit` real eBay listing titles for a category.
 * Used for few-shot injection into LLM prompts.
 *
 * @param {string} categoryId - eBay category ID
 * @param {number} [limit=5] - Max titles to return
 * @returns {Promise<string[]>} Array of title strings, empty on error
 */
async function fetchTopTitlesForCategory(categoryId, limit = 5) {
  try {
    const result = await fetchCategoryTitleInsights({ categoryId, limit: Math.max(20, limit * 4) });
    return Array.isArray(result?.titles) ? result.titles.slice(0, limit) : [];
  } catch {
    return [];
  }
}

module.exports = {
  fetchCategoryTitleInsights,
  fetchBrowsePriceSamples,
  fetchTopTitlesForCategory,
  tokenizeTitle,
  getAppToken,
  getIdentityBase,
};
