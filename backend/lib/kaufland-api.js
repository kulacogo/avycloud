const crypto = require('crypto');
const fetch = require('node-fetch');
const { getSecretValue } = require('./secret-values');

const DEFAULT_BASE_URL = 'https://sellerapi.kaufland.com/v2';
const DEFAULT_USER_AGENT = process.env.KAUFLAND_USER_AGENT || 'Inhouse_development';
const DEFAULT_TIMEOUT_MS = Math.max(1_000, parseInt(process.env.KAUFLAND_API_TIMEOUT_MS || '25_000', 10) || 25_000);
const MAX_RETRIES = Math.max(0, parseInt(process.env.KAUFLAND_API_MAX_RETRIES || '4', 10) || 4);

let cachedConfig = null;

function safeString(value) {
  return value == null ? '' : String(value).trim();
}

function toInteger(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function toPriceCents(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(Math.round(n * 100));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt) {
  const base = 500;
  const cap = 8_000;
  const raw = Math.min(base * 2 ** attempt, cap);
  return raw + Math.floor(Math.random() * 250);
}

function buildAbsoluteUrl(baseUrl, requestPath, query = null) {
  const normalizedBase = safeString(baseUrl).replace(/\/+$/, '');
  const normalizedPath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
  const url = new URL(`${normalizedBase}${normalizedPath}`);
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function signRequest({ method, absoluteUrl, rawBody, timestamp, secretKey }) {
  const payload = [
    String(method || '').toUpperCase(),
    String(absoluteUrl || ''),
    typeof rawBody === 'string' ? rawBody : '',
    String(timestamp || ''),
  ].join('\n');

  return crypto
    .createHmac('sha256', String(secretKey || ''))
    .update(payload, 'utf8')
    .digest('hex');
}

async function getConfig() {
  if (cachedConfig) return cachedConfig;

  const [clientKey, secretKey] = await Promise.all([
    getSecretValue('KAUFLAND_CLIENT_KEY'),
    getSecretValue('KAUFLAND_SECRET_KEY'),
  ]);

  if (!safeString(clientKey) || !safeString(secretKey)) {
    const err = new Error('Missing Kaufland API credentials (KAUFLAND_CLIENT_KEY / KAUFLAND_SECRET_KEY).');
    err.code = 'KAUFLAND_CONFIG_MISSING';
    throw err;
  }

  cachedConfig = {
    baseUrl: DEFAULT_BASE_URL,
    clientKey: safeString(clientKey),
    secretKey: safeString(secretKey),
    userAgent: DEFAULT_USER_AGENT,
  };
  return cachedConfig;
}

async function kauflandRequest(method, requestPath, { query = null, body = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cfg = await getConfig();
  const absoluteUrl = buildAbsoluteUrl(cfg.baseUrl, requestPath, query);
  const rawBody = body == null ? '' : JSON.stringify(body);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signRequest({
      method,
      absoluteUrl: absoluteUrl.toString(),
      rawBody,
      timestamp,
      secretKey: cfg.secretKey,
    });

    const headers = {
      Accept: 'application/json',
      'User-Agent': cfg.userAgent,
      'Shop-Client-Key': cfg.clientKey,
      'Shop-Timestamp': String(timestamp),
      'Shop-Signature': signature,
    };
    if (rawBody) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));

    try {
      const response = await fetch(absoluteUrl.toString(), {
        method: String(method || 'GET').toUpperCase(),
        headers,
        body: rawBody || undefined,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const text = await response.text();
      const json = text ? (() => {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      })() : null;

      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        await sleep(backoffDelay(attempt));
        continue;
      }

      if (!response.ok) {
        const err = new Error(
          json?.message ||
            json?.error?.message ||
            `Kaufland API request failed (${response.status})`
        );
        err.code = `KAUFLAND_HTTP_${response.status}`;
        err.status = response.status;
        err.payload = json || text || null;
        throw err;
      }

      return { status: response.status, data: json, headers: response.headers };
    } catch (error) {
      clearTimeout(timeout);
      if (attempt < MAX_RETRIES && (error?.name === 'AbortError' || String(error?.code || '').includes('ECONN'))) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Kaufland request failed after retries.');
}

function pickUnitData(product, { mode = 'create', storefront = 'de' } = {}) {
  const idOffer =
    safeString(product?.identification?.sku) ||
    safeString(product?.details?.identifiers?.sku) ||
    safeString(product?.id);
  const eanFromIdentifiers = safeString(product?.details?.identifiers?.ean);
  const barcodes = Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : [];
  const eanFromBarcodes = barcodes
    .map((v) => String(v || '').replace(/\D+/g, ''))
    .find((v) => v.length === 13 || v.length === 14) || '';
  const ean = eanFromIdentifiers || eanFromBarcodes;

  const rawPrice =
    product?.details?.pricing?.lowest_price?.amount ??
    product?.details?.pricing?.amount ??
    null;
  const listingPrice = toPriceCents(rawPrice);

  const quantityRaw =
    product?.inventory?.availableQuantity ??
    product?.inventory?.quantity ??
    product?.storage?.quantity ??
    0;
  const amount = Math.max(0, toInteger(quantityRaw) || 0);
  const handlingTime = Math.max(1, toInteger(product?.details?.handling_time) || 1);

  if (!idOffer) {
    const err = new Error(`Missing SKU/id_offer for product ${safeString(product?.id) || 'n/a'}`);
    err.code = 'KAUFLAND_ID_OFFER_MISSING';
    throw err;
  }
  if (!ean && mode === 'create') {
    const err = new Error(`Missing EAN for Kaufland create (${idOffer})`);
    err.code = 'KAUFLAND_EAN_MISSING';
    throw err;
  }
  if (!listingPrice || listingPrice <= 0) {
    const err = new Error(`Missing/invalid listing price for ${idOffer}`);
    err.code = 'KAUFLAND_PRICE_INVALID';
    throw err;
  }

  return {
    storefront: storefront || 'de',
    unitData: {
      id_offer: idOffer,
      ean: ean || undefined,
      amount,
      handling_time: handlingTime,
      listing_price: listingPrice,
      status: amount > 0 ? 'AVAILABLE' : 'ONHOLD',
      note: safeString(product?.details?.condition) || undefined,
    },
  };
}

async function findUnit({ storefront = 'de', idOffer, ean }) {
  const query = {
    storefront,
    limit: 1,
    offset: 0,
    id_offer: idOffer || undefined,
    ean: ean || undefined,
  };
  const res = await kauflandRequest('GET', '/units', { query });
  const list = Array.isArray(res?.data?.data) ? res.data.data : [];
  return list[0] || null;
}

async function listUnits({ storefront = 'de', limit = 100, maxPages = 200 } = {}) {
  const pageSize = Math.max(1, Math.min(100, Number(limit) || 100));
  const pages = Math.max(1, Number(maxPages) || 200);
  const items = [];
  let offset = 0;

  for (let page = 0; page < pages; page += 1) {
    const res = await kauflandRequest('GET', '/units', {
      query: {
        storefront,
        limit: pageSize,
        offset,
      },
    });
    const rows = Array.isArray(res?.data?.data) ? res.data.data : [];
    if (!rows.length) break;
    items.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  return items;
}

async function createUnit(product, { storefront = 'de' } = {}) {
  const picked = pickUnitData(product, { mode: 'create', storefront });
  const res = await kauflandRequest('POST', '/units', {
    query: { storefront: picked.storefront },
    body: picked.unitData,
  });
  return { created: true, data: res.data };
}

async function updateUnit(unitId, product, { storefront = 'de' } = {}) {
  const picked = pickUnitData(product, { mode: 'update', storefront });
  const res = await kauflandRequest('PATCH', `/units/${encodeURIComponent(String(unitId))}`, {
    query: { storefront: picked.storefront },
    body: picked.unitData,
  });
  return { updated: true, data: res.data };
}

module.exports = {
  kauflandRequest,
  findUnit,
  listUnits,
  createUnit,
  updateUnit,
  pickUnitData,
};
