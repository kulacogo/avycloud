const crypto = require('crypto');
const fetch = require('node-fetch');

const DEFAULT_BASE_URL = 'https://sellerapi.kaufland.com/v2';
const DEFAULT_USER_AGENT = process.env.KAUFLAND_USER_AGENT || 'Inhouse_development';
const DEFAULT_TIMEOUT_MS = Math.max(1_000, parseInt(process.env.KAUFLAND_API_TIMEOUT_MS || '25000', 10) || 25_000);
const MAX_RETRIES = Math.max(0, parseInt(process.env.KAUFLAND_API_MAX_RETRIES || '4', 10) || 4);

const CONDITION_CODE_MAP = {
  100: 'NEW',
  110: 'REFURBISHED___AS_NEW',
  120: 'REFURBISHED___VERY_GOOD',
  130: 'REFURBISHED___GOOD',
  140: 'REFURBISHED___ACCEPTABLE',
  200: 'USED___AS_NEW',
  300: 'USED___VERY_GOOD',
  400: 'USED___GOOD',
  500: 'USED___ACCEPTABLE',
};
const CONDITION_VALUES = new Set(Object.values(CONDITION_CODE_MAP));
const VAT_INDICATORS = new Set([
  'standard_rate',
  'reduced_rate_1',
  'reduced_rate_2',
  'super_reduced_rate',
  'zero_rate',
]);

function safeString(value) {
  return value == null ? '' : String(value).trim();
}

function normalizeProductDataAttributeToken(value) {
  return safeString(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s._:;,\-/\\()[\]{}]+/g, '');
}

function normalizeProductDataEans(ean) {
  return (Array.isArray(ean) ? ean : [ean])
    .map((value) => String(value || '').replace(/\D+/g, '').trim())
    .filter((value) => value.length >= 13 && value.length <= 15);
}

function normalizeProductDataComplianceContact(rawValue) {
  if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) return null;
  const contact = {
    name: safeString(rawValue?.name),
    email_address: safeString(rawValue?.email_address),
    address: safeString(rawValue?.address),
    phone_number: safeString(rawValue?.phone_number),
    url: safeString(rawValue?.url),
  };
  if (!contact.name || !contact.address) return null;
  if (!contact.email_address) delete contact.email_address;
  if (!contact.phone_number) delete contact.phone_number;
  if (!contact.url) delete contact.url;
  return contact;
}

function isComplianceContactAttributeKey(key) {
  const token = normalizeProductDataAttributeToken(key);
  if (!token) return false;
  if (token === 'productsafetycontact') return true;
  if (token.includes('productsafety')) return true;
  if (token.includes('compliancecontact')) return true;
  if (token.includes('herstellername') && token.includes('verantwortlicheperson')) return true;
  if (token.includes('manufacturername') && token.includes('responsibleperson')) return true;
  return false;
}

function toInteger(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

// GS1 GTIN validation. A Kaufland unit ("Angebot") can only bind to a catalog
// item keyed by a valid, globally-unique GTIN. Returns true only for
// structurally listable EANs. Rejects (incident 2026-06-02):
//   - wrong length (must be 13 = EAN-13 or 14 = GTIN-14 digits)
//   - failed mod-10 check digit (malformed / fabricated codes)
//   - EAN-13 with GS1 prefix 2xx / 02x — "restricted distribution" in-store
//     codes (e.g. 2001166900003, 2452014202112) that are never globally
//     unique and are always rejected by Kaufland.
// The restricted-prefix rule only applies to EAN-13: in a GTIN-14 the leading
// digit is a packaging indicator, not part of the GS1 prefix.
function isValidGtin(value) {
  const digits = String(value || '').replace(/\D+/g, '');
  if (digits.length !== 13 && digits.length !== 14) return false;
  if (digits.length === 13 && (digits[0] === '2' || (digits[0] === '0' && digits[1] === '2'))) {
    return false;
  }
  const body = digits.slice(0, -1);
  const check = Number(digits[digits.length - 1]);
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    const d = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  const computed = (10 - (sum % 10)) % 10;
  return computed === check;
}

// Detect Kaufland's own "this EAN is not acceptable" responses so we can
// surface a clear, actionable error instead of the downstream cryptic
// "Parameter [item] is missing or has wrong value" from POST /units.
// Kaufland phrases it as "Invalid EAN provided" (GET /products/ean) and
// 'EAN "<x>" is not valid' (PUT /product-data).
function isEanRejectionError(message) {
  const m = String(message || '').toLowerCase();
  return m.includes('invalid ean') || (m.includes('ean') && m.includes('not valid'));
}

function normalizeCondition(value) {
  const raw = safeString(value).toUpperCase();
  if (!raw) return 'NEW';
  if (CONDITION_VALUES.has(raw)) return raw;
  const asInt = toInteger(raw);
  if (asInt != null && CONDITION_CODE_MAP[asInt]) return CONDITION_CODE_MAP[asInt];
  return 'NEW';
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

function extractUnitIdFromLocation(locationHeader) {
  const raw = safeString(locationHeader);
  if (!raw) return null;
  const match = raw.match(/\/units\/(\d+)\/?$/i);
  if (!match) return null;
  const unitId = Number(match[1]);
  if (!Number.isFinite(unitId) || unitId <= 0) return null;
  return unitId;
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
  // Self-Service-Zugangsdaten (IntegrationWizard) gewinnen; ENV/Secret Manager
  // bleibt Fallback. Kein Für-immer-Cache mehr: der Resolver cached 60s,
  // damit "Neu verbinden" ohne Neustart greift.
  const { resolveProviderCredentials } = require('../services/integration-store');
  const creds = await resolveProviderCredentials('kaufland');
  const clientKey = safeString(creds?.clientKey);
  const secretKey = safeString(creds?.secretKey);

  if (!clientKey || !secretKey) {
    const err = new Error('Missing Kaufland API credentials (KAUFLAND_CLIENT_KEY / KAUFLAND_SECRET_KEY).');
    err.code = 'KAUFLAND_CONFIG_MISSING';
    throw err;
  }

  return {
    baseUrl: DEFAULT_BASE_URL,
    clientKey,
    secretKey,
    userAgent: DEFAULT_USER_AGENT,
  };
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
  // EAN-Selection: Kaufland akzeptiert nur EAN-13 oder EAN-14 (GTIN-14).
  // Frühere Logik nahm `details.identifiers.ean` blind — auch wenn dort eine
  // 12-stellige UPC stand (z.B. "442922550988"). Kaufland antwortet dann mit
  // dem kryptischen "Parameter [item] is missing or has wrong value" statt
  // einer sauberen EAN-Fehlermeldung. Fix: nur akzeptieren wenn 13 oder 14
  // Digits; sonst auf identification.barcodes ausweichen die oft den korrekten
  // EAN-13 enthalten.
  const eanFromIdentifiersDigits = safeString(product?.details?.identifiers?.ean).replace(/\D+/g, '');
  const eanFromIdentifiers = (eanFromIdentifiersDigits.length === 13 || eanFromIdentifiersDigits.length === 14)
    ? eanFromIdentifiersDigits
    : '';
  const barcodes = Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : [];
  const eanFromBarcodes = barcodes
    .map((v) => String(v || '').replace(/\D+/g, ''))
    .find((v) => v.length === 13 || v.length === 14) || '';
  // Letzter Fallback: 12-stellige UPC mit führender 0 zu EAN-13 padden
  // (UPC → EAN-13 ist legitimer Standard-Konversionspfad).
  const eanFromUpcPad = eanFromIdentifiersDigits.length === 12 ? '0' + eanFromIdentifiersDigits : '';
  const ean = eanFromIdentifiers || eanFromBarcodes || eanFromUpcPad;

  const rawPrice =
    product?.details?.pricing?.sellPrice ??
    product?.pricing?.kaufland?.price ??
    product?.pricing?.sellPrice ??
    product?.details?.pricing?.lowest_price?.amount ??
    product?.details?.pricing?.amount ??
    null;
  const listingPrice = toPriceCents(rawPrice);
  const rawMinimumPrice =
    product?.details?.pricing?.minimum_price?.amount ??
    product?.details?.pricing?.minimum_price ??
    product?.details?.pricing?.minimumPrice ??
    null;
  const minimumPrice = toPriceCents(rawMinimumPrice);

  // Marketplaces müssen den verfügbaren Bestand sehen (= physical - reserved),
  // nicht die rohe Bin-Summe — sonst werden offene Reservierungen ignoriert
  // und Kaufland kann mehr verkaufen als wirklich frei ist (Oversell).
  // availableQuantity wird vom stock-sync-dispatcher pre-berechnet (computeAvailableQuantity).
  const binStock = Array.isArray(product?.storageBins)
    ? product.storageBins.reduce((sum, b) => sum + (Number(b?.quantity) || 0), 0)
    : null;
  const quantityRaw = product?.inventory?.availableQuantity
    ?? product?.inventory?.quantity
    ?? binStock
    ?? product?.storage?.quantity
    ?? 0;
  const amount = Math.max(0, toInteger(quantityRaw) || 0);
  const handlingTime = Math.max(1, toInteger(product?.details?.handling_time) || 1);
  const condition = normalizeCondition(product?.details?.condition);
  const note = safeString(
    product?.details?.kaufland?.note ||
      product?.details?.marketplaces?.kaufland?.note ||
      product?.details?.kaufland_note
  )
    .replace(/\s+/g, ' ')
    .slice(0, 250);
  const idShippingGroup = toInteger(
    product?.details?.kaufland?.id_shipping_group ??
      product?.details?.marketplaces?.kaufland?.id_shipping_group ??
      product?.details?.kaufland_shipping_group ??
      null
  );
  const idWarehouse = toInteger(
    product?.details?.kaufland?.id_warehouse ??
      product?.details?.marketplaces?.kaufland?.id_warehouse ??
      product?.details?.kaufland_warehouse ??
      null
  );
  const vatIndicatorRaw = safeString(
    product?.details?.kaufland?.vat_indicator ||
      product?.details?.marketplaces?.kaufland?.vat_indicator ||
      product?.details?.kaufland_vat_indicator
  ).toLowerCase();
  const vatIndicator = VAT_INDICATORS.has(vatIndicatorRaw) ? vatIndicatorRaw : '';
  const safeMinimumPrice = minimumPrice && minimumPrice > 0 ? minimumPrice : undefined;
  const optionalShippingGroup = idShippingGroup != null && idShippingGroup > 0 ? idShippingGroup : undefined;
  const optionalWarehouse = idWarehouse != null && idWarehouse > 0 ? idWarehouse : undefined;

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
    idOffer,
    ean,
    unitData: {
      id_offer: idOffer,
      ean: ean || undefined,
      condition,
      amount,
      handling_time: handlingTime,
      listing_price: listingPrice,
      minimum_price: safeMinimumPrice,
      note: note || undefined,
      id_shipping_group: optionalShippingGroup,
      id_warehouse: optionalWarehouse,
      vat_indicator: vatIndicator || undefined,
    },
    patchData: {
      status: amount > 0 ? 'AVAILABLE' : 'ONHOLD',
      amount,
      handling_time: handlingTime,
      listing_price: listingPrice,
      minimum_price: safeMinimumPrice,
      note: note || undefined,
      id_shipping_group: optionalShippingGroup,
      id_warehouse: optionalWarehouse,
      vat_indicator: vatIndicator || undefined,
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

async function getProductByEan(ean, { storefront = 'de' } = {}) {
  const normalizedEan = String(ean || '').replace(/\D+/g, '').trim();
  if (!normalizedEan) return null;
  const res = await kauflandRequest('GET', `/products/ean/${encodeURIComponent(normalizedEan)}`, {
    query: { storefront: storefront || 'de' },
  });
  return res?.data?.data || null;
}

async function getUnit(unitId, { storefront = 'de', embedded = [] } = {}) {
  const normalizedUnitId = toInteger(unitId);
  if (!normalizedUnitId || normalizedUnitId <= 0) {
    const err = new Error('unitId is required');
    err.code = 'KAUFLAND_UNIT_ID_REQUIRED';
    throw err;
  }
  const embeddedList = Array.isArray(embedded)
    ? embedded.map((value) => safeString(value)).filter(Boolean)
    : [safeString(embedded)].filter(Boolean);
  const query = {
    storefront: storefront || 'de',
    embedded: embeddedList.length ? embeddedList.join(',') : undefined,
  };
  const res = await kauflandRequest('GET', `/units/${encodeURIComponent(String(normalizedUnitId))}`, { query });
  return res?.data?.data || null;
}

async function getProductDataStatus(ean, { locale = 'de-DE' } = {}) {
  const normalizedEan = String(ean || '').replace(/\D+/g, '').trim();
  if (!normalizedEan) {
    const err = new Error('ean is required');
    err.code = 'KAUFLAND_EAN_REQUIRED';
    throw err;
  }
  const normalizedLocale = safeString(locale) || 'de-DE';
  const res = await kauflandRequest('GET', `/product-data/status/${encodeURIComponent(normalizedEan)}`, {
    query: { locale: normalizedLocale },
  });
  return res?.data?.data || null;
}

function normalizeProductDataAttributeValues(value) {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((entry) => safeString(entry))
    .filter(Boolean);
}

function normalizeProductDataAttributes(attributes = {}) {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return {};
  const out = {};
  Object.entries(attributes).forEach(([rawKey, rawValue]) => {
    const key = safeString(rawKey);
    if (!key || rawValue == null) return;

    if (isComplianceContactAttributeKey(key)) {
      const contact = normalizeProductDataComplianceContact(rawValue);
      if (contact) {
        out[key] = contact;
        if (key !== 'product_safety_contact' && !out.product_safety_contact) {
          out.product_safety_contact = contact;
        }
      }
      return;
    }

    const values = normalizeProductDataAttributeValues(rawValue);
    if (values.length) out[key] = values;
  });
  return out;
}

async function getProductData(ean, { locale = 'de-DE' } = {}) {
  const normalizedEan = normalizeProductDataEans(ean)[0] || '';
  if (!normalizedEan) {
    const err = new Error('ean is required');
    err.code = 'KAUFLAND_EAN_REQUIRED';
    throw err;
  }
  const normalizedLocale = safeString(locale) || 'de-DE';
  const res = await kauflandRequest('GET', `/product-data/${encodeURIComponent(normalizedEan)}`, {
    query: { locale: normalizedLocale },
  });
  return res?.data?.data || null;
}

// Kaufland validates product-data against the category schema of the bound
// catalog product. EANs that auto-resolve to category=46001 "Sonstiges-
// Sonstiges" (catch-all stub) cannot be validated because that category has
// no real required-attribute set — the validator silently leaves
// attribute_values empty. Passing ?id_category=<X> as query param forces
// Kaufland to validate against that category instead. Live-verified
// 2026-05-22 against EAN 4060413606127 (stub product 559526566): without
// id_category attribute_values=[], with id_category=52671 attribute_values
// contained TRANSFORMED states for manufacturer + product_safety_contact.
//
// This query param is undocumented in swagger.json (which only lists
// `locale`) but accepted by the production API. Both PUT and PATCH support
// it. Omit it for EANs that already have a real catalog category — passing a
// conflicting id_category there could mis-route the data.
async function putProductData({ ean, attributes = {}, locale = 'de-DE', idCategory } = {}) {
  const eans = normalizeProductDataEans(ean);
  if (!eans.length) {
    const err = new Error('ean is required for product-data put');
    err.code = 'KAUFLAND_PRODUCT_DATA_EAN_REQUIRED';
    throw err;
  }

  const normalizedAttributes = normalizeProductDataAttributes(attributes);
  if (!Object.keys(normalizedAttributes).length) {
    const err = new Error('No product-data attributes provided');
    err.code = 'KAUFLAND_PRODUCT_DATA_ATTRIBUTES_REQUIRED';
    throw err;
  }

  const normalizedLocale = safeString(locale) || 'de-DE';
  const query = { locale: normalizedLocale };
  const idCat = toInteger(idCategory);
  if (idCat && idCat > 0) query.id_category = idCat;

  const res = await kauflandRequest('PUT', '/product-data', {
    query,
    body: {
      ean: eans,
      attributes: normalizedAttributes,
    },
  });
  return res?.data?.data || res?.data || null;
}

async function patchProductData({ ean, attributes = {}, locale = 'de-DE', idCategory } = {}) {
  const eans = normalizeProductDataEans(ean);
  if (!eans.length) {
    const err = new Error('ean is required for product-data patch');
    err.code = 'KAUFLAND_PRODUCT_DATA_EAN_REQUIRED';
    throw err;
  }

  const normalizedAttributes = normalizeProductDataAttributes(attributes);
  if (!Object.keys(normalizedAttributes).length) {
    const err = new Error('No product-data attributes provided');
    err.code = 'KAUFLAND_PRODUCT_DATA_ATTRIBUTES_REQUIRED';
    throw err;
  }

  const normalizedLocale = safeString(locale) || 'de-DE';
  const query = { locale: normalizedLocale };
  const idCat = toInteger(idCategory);
  if (idCat && idCat > 0) query.id_category = idCat;

  const res = await kauflandRequest('PATCH', '/product-data', {
    query,
    body: {
      ean: eans,
      attributes: normalizedAttributes,
    },
  });
  return res?.data?.data || res?.data || null;
}

// POST /categories/decide — Kaufland's category-suggestion endpoint. Given
// item.{title,description,manufacturer} + price (in eurocents), returns an
// ordered array of leaf categories ranked by likelihood. First element is
// the best match. Used to predict id_category for EANs that would otherwise
// auto-resolve to the 46001 "Sonstiges-Sonstiges" stub.
async function decideCategory({ title, description, manufacturer, priceCents = 1000, storefront = 'de', locale = 'de-DE' } = {}) {
  const t = safeString(title);
  const d = safeString(description);
  const m = safeString(manufacturer);
  if (!t || !d || !m) {
    const err = new Error('decideCategory requires non-empty title, description, manufacturer');
    err.code = 'KAUFLAND_DECIDE_INPUT_REQUIRED';
    throw err;
  }
  const price = Number(priceCents);
  if (!Number.isFinite(price) || price <= 0) {
    const err = new Error('decideCategory requires positive priceCents');
    err.code = 'KAUFLAND_DECIDE_PRICE_REQUIRED';
    throw err;
  }
  const res = await kauflandRequest('POST', '/categories/decide', {
    query: { storefront: storefront || 'de', locale: locale || 'de-DE' },
    body: {
      item: { title: t, description: d, manufacturer: m },
      price,
    },
  });
  const list = Array.isArray(res?.data?.data) ? res.data.data : [];
  return list.map((c) => ({
    id_category: Number(c.id_category) || 0,
    name: safeString(c.name),
    title_singular: safeString(c.title_singular),
    is_leaf: c.is_leaf !== false,
    level: Number(c.level) || 0,
  }));
}

async function createUnit(product, { storefront = 'de', autoCreateProductData = true } = {}) {
  const picked = pickUnitData(product, { mode: 'create', storefront });
  const createData = { ...(picked.unitData || {}) };
  let productDataSubmitted = false;
  let catalogMatched = false;
  // Tracks whether Kaufland actively rejected the EAN (lookup/product-data).
  // Used to short-circuit before the doomed POST /units and surface a clear
  // KAUFLAND_EAN_INVALID instead of "Parameter [item] is missing or has
  // wrong value". See incident 2026-06-02.
  let eanRejectedByKaufland = false;

  // Pre-flight: structurally invalid or GS1 restricted-distribution EANs can
  // never bind to a Kaufland catalog item — reject immediately with a clear,
  // actionable message instead of wasting 3 API calls that all end in the
  // cryptic "Parameter [item] is missing or has wrong value".
  if (picked.ean && !isValidGtin(picked.ean)) {
    const err = new Error(
      `EAN "${picked.ean}" ist keine gueltige GTIN — Kaufland benoetigt eine ` +
      `registrierte EAN/GTIN zum Listen. Bitte eine gueltige EAN hinterlegen.`
    );
    err.code = 'KAUFLAND_EAN_INVALID';
    throw err;
  }

  if (picked.ean) {
    // Step 1: Resolve catalog state FIRST so we know whether Kaufland already
    // has a real category for this EAN, or whether it sits in the 46001
    // "Sonstiges-Sonstiges" stub bucket. This drives both:
    //  - id_product binding (Step 3, unchanged purpose)
    //  - idCategory hint for putProductData (Step 2, new — see decideCategory)
    let catalogIdCategory = 0;
    let catalogIsValid = false;
    try {
      const productData = await getProductByEan(picked.ean, { storefront: picked.storefront });
      const idProduct = Number(productData?.id_product || 0);
      if (Number.isFinite(idProduct) && idProduct > 0) {
        createData.id_product = idProduct;
        catalogMatched = true;
      }
      catalogIdCategory = Number(productData?.id_category || 0) || 0;
      catalogIsValid = !!productData?.is_valid;
    } catch (lookupErr) {
      // Lookup failed — not fatal, POST /units accepts EAN alone. But if
      // Kaufland says the EAN itself is invalid, remember it: the unit can
      // never be created and we want a clear error, not the cryptic one.
      if (isEanRejectionError(lookupErr?.message)) eanRejectedByKaufland = true;
      console.warn(`[createUnit] EAN lookup failed for ${picked.ean}: ${lookupErr?.message || lookupErr}`);
    }

    // Step 2: ALWAYS push full product data — regardless of catalog match.
    //
    // Old behaviour: when Kaufland catalog already had the EAN (id_product
    // match) we set createData.id_product and skipped putProductData entirely.
    // Kaufland then used its own catalog entry — which is often incomplete
    // (missing GPSR Verantwortliche Person, Manufacturer, full image set,
    // Material). Result: Kaufland's validator left the listing as
    // `product.is_valid=false` → Portal bucket "Angebotsdaten fehlen".
    //
    // Always submit our authoritative attribute set via putProductData BEFORE
    // creating the unit. Kaufland merges; our data wins over a sparse catalog
    // entry. Lazy-require breaks the circular dependency with
    // services/kaufland-product-data-repair.js (which itself calls
    // patchProductData from this module).
    //
    // For EANs that resolve to a 46001-stub (or no catalog entry at all),
    // we predict the real id_category via POST /categories/decide and pass
    // it as ?id_category=X to PUT /product-data. Without that hint, Kaufland
    // validates against the empty 46001 schema and silently rejects
    // everything (attribute_values stays []). Verified 2026-05-22 against
    // EAN 4060413606127: same payload, with idCategory=52671 the validator
    // accepted manufacturer + product_safety_contact (TRANSFORMED) and
    // surfaced specific issues (DECLINED: media_not_downloadable) instead of
    // the silent-ignore behaviour.
    if (autoCreateProductData) {
      let fullAttrs = {};
      try {
        const { buildKauflandProductDataAttributes } = require('../services/kaufland-product-data-repair');
        fullAttrs = (await buildKauflandProductDataAttributes(product, { storefront: picked.storefront })) || {};
      } catch (buildErr) {
        console.warn(`[createUnit] buildKauflandProductDataAttributes failed for EAN ${picked.ean}: ${buildErr?.message || buildErr}`);
      }
      // Defensive title-trim (255-char Kaufland limit)
      if (Array.isArray(fullAttrs.title) && fullAttrs.title[0]) {
        fullAttrs.title = [String(fullAttrs.title[0]).slice(0, 255).trim()];
      }

      // Predict id_category for stubs / unknown EANs.
      // Skip prediction when Kaufland already has a real, validated category
      // — passing a conflicting hint there could mis-route data.
      let predictedIdCategory = 0;
      const isStubOrUnknown = !catalogMatched || !catalogIsValid || catalogIdCategory === 46001;
      if (isStubOrUnknown && fullAttrs.title?.[0] && fullAttrs.description?.[0] && fullAttrs.manufacturer?.[0]) {
        const priceCents = toPriceCents(
          product?.details?.pricing?.sellPrice
          ?? product?.pricing?.kaufland?.price
          ?? product?.pricing?.sellPrice
          ?? product?.details?.pricing?.lowest_price?.amount
          ?? product?.details?.pricing?.amount
        );
        try {
          const suggestions = await decideCategory({
            title: fullAttrs.title[0],
            description: fullAttrs.description[0],
            manufacturer: fullAttrs.manufacturer[0],
            priceCents: priceCents && priceCents > 0 ? priceCents : 1000,
            storefront: picked.storefront,
          });
          const top = suggestions.find((s) => s.is_leaf && s.id_category && s.id_category !== 46001);
          if (top) {
            predictedIdCategory = top.id_category;
            console.log(`[createUnit] Category predicted for EAN ${picked.ean}: id=${top.id_category} (${top.title_singular}) — catalogStub=${catalogIdCategory}, matched=${catalogMatched}`);
          }
        } catch (decideErr) {
          console.warn(`[createUnit] decideCategory failed for EAN ${picked.ean}: ${decideErr?.message || decideErr}`);
        }
      }

      if (Object.keys(fullAttrs).length > 0) {
        try {
          await putProductData({
            ean: picked.ean,
            attributes: fullAttrs,
            locale: 'de-DE',
            idCategory: predictedIdCategory || undefined,
          });
          productDataSubmitted = true;
          console.log(`[createUnit] Full product data submitted for EAN ${picked.ean} — keys: ${Object.keys(fullAttrs).join(',')}${predictedIdCategory ? `, idCategory=${predictedIdCategory}` : ''}`);
        } catch (pdErr) {
          if (isEanRejectionError(pdErr?.message)) eanRejectedByKaufland = true;
          console.warn(`[createUnit] putProductData failed for EAN ${picked.ean}: ${pdErr?.message || pdErr}`);
        }
      }
    }
  }

  // Short-circuit: Kaufland already rejected this EAN as invalid AND we have
  // neither a catalog match nor a successful product-data submission to bind
  // to. POST /units would fail with the cryptic "Parameter [item] is missing
  // or has wrong value" — throw a clear, actionable error instead and skip
  // the doomed call. See incident 2026-06-02.
  if (eanRejectedByKaufland && !catalogMatched && !productDataSubmitted) {
    const err = new Error(
      `EAN "${picked.ean}" wurde von Kaufland als ungueltig abgelehnt — ` +
      `Kaufland benoetigt eine registrierte EAN/GTIN zum Listen. ` +
      `Bitte eine gueltige EAN hinterlegen.`
    );
    err.code = 'KAUFLAND_EAN_INVALID';
    throw err;
  }

  // Step 3: Create the unit — Kaufland accepts EAN without id_product
  try {
    const res = await kauflandRequest('POST', '/units', {
      query: { storefront: picked.storefront },
      body: createData,
    });
    const location = typeof res?.headers?.get === 'function' ? res.headers.get('location') : null;
    const bodyUnitId = Number(res?.data?.data?.id_unit || 0);
    const idFromBody = Number.isFinite(bodyUnitId) && bodyUnitId > 0 ? bodyUnitId : null;
    const idFromLocation = extractUnitIdFromLocation(location);
    return {
      created: true,
      productDataSubmitted,
      data: res.data,
      location: location || null,
      id_unit: idFromBody || idFromLocation || null,
    };
  } catch (unitErr) {
    // If unit creation fails and we submitted product data, provide a clear message
    if (productDataSubmitted) {
      const err = new Error(
        `Produktdaten fuer EAN ${picked.ean} bei Kaufland eingereicht. ` +
        `Kaufland verarbeitet neue Produktdaten asynchron (bis zu 24h). ` +
        `Bitte spaeter erneut versuchen.`
      );
      err.code = 'KAUFLAND_PRODUCT_DATA_PENDING';
      err.productDataSubmitted = true;
      throw err;
    }
    // Re-throw original error with context
    const message = safeString(unitErr?.message).toLowerCase();
    if (message.includes('invalid ean') || message.includes('ean') && message.includes('not valid')) {
      const err = new Error(`EAN "${picked.ean}" is not valid`);
      err.code = 'KAUFLAND_EAN_INVALID';
      throw err;
    }
    throw unitErr;
  }
}

async function updateUnit(unitId, product, { storefront = 'de' } = {}) {
  const picked = pickUnitData(product, { mode: 'update', storefront });
  const res = await kauflandRequest('PATCH', `/units/${encodeURIComponent(String(unitId))}`, {
    query: { storefront: picked.storefront },
    body: picked.patchData,
  });
  const parsedUnitId = Number(unitId);
  return {
    updated: true,
    data: res.data,
    id_unit: Number.isFinite(parsedUnitId) && parsedUnitId > 0 ? parsedUnitId : null,
  };
}

/**
 * Explicitly set a Kaufland unit's status to ONHOLD or AVAILABLE.
 * Unlike updateUnit(), this bypasses price/SKU validation — safe to call even
 * when listing_price or id_offer are missing (e.g. zero-stock delist).
 *
 * @param {string|number} unitId - Kaufland unit ID
 * @param {'ONHOLD'|'AVAILABLE'} status
 * @param {{ storefront?: string }} options
 */
async function setUnitStatus(unitId, status, { storefront = 'de' } = {}) {
  const validStatuses = ['AVAILABLE', 'ONHOLD'];
  const normalizedStatus = String(status || '').toUpperCase();
  if (!validStatuses.includes(normalizedStatus)) {
    throw new Error(`Invalid Kaufland unit status: ${status}`);
  }
  const body = { status: normalizedStatus };
  if (normalizedStatus === 'ONHOLD') body.amount = 0;
  const res = await kauflandRequest('PATCH', `/units/${encodeURIComponent(String(unitId))}`, {
    query: { storefront },
    body,
  });
  return { updated: true, status: normalizedStatus, data: res.data };
}

/**
 * List all shipping groups for a storefront.
 * @param {{ storefront?: string }} options
 * @returns {Promise<Array<{ id: number, name: string, storefront: string, isDefault: boolean }>>}
 */
async function listShippingGroups({ storefront = 'de' } = {}) {
  const res = await kauflandRequest('GET', '/shipping-groups', {
    query: { storefront, limit: 30 },
  });
  const items = Array.isArray(res?.data?.data) ? res.data.data : [];
  return items.map((sg) => ({
    id: sg.id_shipping_group,
    name: safeString(sg.name),
    storefront: safeString(sg.storefront) || storefront,
    isDefault: Boolean(sg.is_default),
    type: safeString(sg.type) || 'PACKAGE',
  }));
}

/**
 * List all warehouses.
 * @returns {Promise<Array<{ id: number, name: string, isDefault: boolean }>>}
 */
async function listWarehouses() {
  const res = await kauflandRequest('GET', '/warehouses', {
    query: { limit: 30 },
  });
  const items = Array.isArray(res?.data?.data) ? res.data.data : [];
  return items.map((wh) => ({
    id: wh.id_warehouse,
    name: safeString(wh.name),
    isDefault: Boolean(wh.is_default),
    type: safeString(wh.type) || 'normal',
  }));
}

/**
 * Fetch bookings (payout transactions) from Kaufland Reports API.
 *
 * Reports API is async-CSV-based:
 *   1. POST /reports/bookings-new?storefront=de&version=v2  body {date_from,date_to}
 *      → returns {data:{id_report}} with HTTP 202
 *   2. Poll GET /reports/{id_report} until status === 'done'
 *   3. Download CSV from response.data.url
 *   4. Parse CSV and aggregate into structured bookings
 *
 * Operator note: the actual endpoint used is
 *   POST {baseUrl}/reports/bookings-new (verified via swagger.json)
 *
 * @param {Object} opts
 * @param {string} opts.from - ISO date YYYY-MM-DD (inclusive)
 * @param {string} opts.to - ISO date YYYY-MM-DD (inclusive)
 * @param {string} [opts.storefront='de'] - one of de|cz|sk|pl|at|fr|it
 * @param {number} [opts.limit=0] - 0 = no limit, otherwise cap returned bookings
 * @param {number} [opts.offset=0] - skip first N bookings (post-aggregation)
 * @param {number} [opts.pollIntervalMs=5000]
 * @param {number} [opts.pollTimeoutMs=180000]
 * @returns {Promise<{from,to,storefront,bookings,count,total_payout_cents,total_payout_eur,currency,reportUrl,reportId,endpointUsed}>}
 */
async function getBookings({
  from,
  to,
  storefront = 'de',
  limit = 0,
  offset = 0,
  pollIntervalMs = 5_000,
  pollTimeoutMs = 180_000,
} = {}) {
  const dateFrom = safeString(from);
  const dateTo = safeString(to);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    const err = new Error('getBookings requires from and to as YYYY-MM-DD');
    err.code = 'KAUFLAND_BOOKINGS_DATE_INVALID';
    throw err;
  }

  // Step 1: queue the report. Verified endpoint per swagger.json:
  //   POST /reports/bookings-new
  // Fallback path /reports/bookings is retained for resilience in case
  // Kaufland renames or deprecates the endpoint — we surface which path
  // actually succeeded via `endpointUsed` in the response for operator clarity.
  const candidatePaths = ['/reports/bookings-new', '/reports/bookings'];
  let queued = null;
  let endpointUsed = null;
  let lastErr = null;
  for (const candidate of candidatePaths) {
    try {
      const res = await kauflandRequest('POST', candidate, {
        query: { storefront, version: 'v2' },
        body: { date_from: dateFrom, date_to: dateTo },
      });
      queued = res?.data?.data || res?.data || null;
      endpointUsed = candidate;
      break;
    } catch (err) {
      lastErr = err;
      // 404 means this candidate path doesn't exist on the current API version
      // — try the next one. Anything else is a real failure, re-raise.
      if (err?.status !== 404) {
        throw err;
      }
    }
  }
  if (!queued) {
    const err = new Error(
      `Kaufland bookings report could not be queued at any known path: ${candidatePaths.join(', ')}`
    );
    err.code = 'KAUFLAND_BOOKINGS_ENDPOINT_UNKNOWN';
    err.cause = lastErr;
    throw err;
  }

  const reportId = Number(queued?.id_report || 0);
  if (!Number.isFinite(reportId) || reportId <= 0) {
    const err = new Error('Kaufland bookings report queued but id_report missing');
    err.code = 'KAUFLAND_BOOKINGS_QUEUE_INVALID';
    throw err;
  }
  console.log(`[kaufland-bookings] Queued report id=${reportId} via ${endpointUsed} from=${dateFrom} to=${dateTo} storefront=${storefront}`);

  // Step 2: poll until done
  const startedAt = Date.now();
  let reportMeta = null;
  while (Date.now() - startedAt < Math.max(5_000, pollTimeoutMs)) {
    await sleep(Math.max(500, pollIntervalMs));
    const pollRes = await kauflandRequest('GET', `/reports/${encodeURIComponent(String(reportId))}`);
    reportMeta = pollRes?.data?.data || null;
    const status = String(reportMeta?.status || '').toLowerCase();
    if (status === 'done') break;
    if (status === 'failed' || status === 'error') {
      const err = new Error(`Kaufland bookings report ${reportId} failed (status=${status})`);
      err.code = 'KAUFLAND_BOOKINGS_REPORT_FAILED';
      throw err;
    }
  }
  if (!reportMeta || String(reportMeta?.status || '').toLowerCase() !== 'done') {
    const err = new Error(`Kaufland bookings report ${reportId} did not finish within ${pollTimeoutMs}ms`);
    err.code = 'KAUFLAND_BOOKINGS_TIMEOUT';
    throw err;
  }

  // Step 3: download CSV
  const reportUrl = safeString(reportMeta?.url);
  if (!reportUrl) {
    const err = new Error(`Kaufland bookings report ${reportId} done but url missing`);
    err.code = 'KAUFLAND_BOOKINGS_URL_MISSING';
    throw err;
  }
  const csvResp = await fetch(reportUrl, { method: 'GET' });
  if (!csvResp.ok) {
    const err = new Error(`Kaufland bookings CSV download failed (${csvResp.status}) for report ${reportId}`);
    err.code = `KAUFLAND_BOOKINGS_DOWNLOAD_${csvResp.status}`;
    throw err;
  }
  const csvText = await csvResp.text();

  // Step 4: parse CSV. Kaufland CSV reports are semicolon-delimited UTF-8.
  // Schema is not fully documented and varies by version, so we extract
  // defensively: row → object, then pick common amount/currency columns.
  // Kaufland CSV reports are semicolon-delimited (EU convention; comma is the
  // decimal separator inside numeric columns). We sniff the header row and
  // pick ';' or ',' accordingly — never both, because mixing breaks values
  // like "12,50".
  let records = [];
  try {
    const headerLine = csvText.split(/\r?\n/, 1)[0] || '';
    const delimiter = headerLine.includes(';') ? ';' : ',';
    const { parse } = require('csv-parse/sync');
    records = parse(csvText, {
      columns: true,
      delimiter,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_quotes: true,
      relax_column_count: true,
    });
  } catch (parseErr) {
    const err = new Error(`Kaufland bookings CSV parse failed for report ${reportId}: ${parseErr?.message || parseErr}`);
    err.code = 'KAUFLAND_BOOKINGS_PARSE_FAILED';
    throw err;
  }

  const amountKeyCandidates = ['amount', 'amount_total', 'total_amount', 'value', 'booking_amount', 'sum', 'gross_amount', 'net_amount'];
  const currencyKeyCandidates = ['currency', 'currency_code', 'iso_currency'];
  const typeKeyCandidates = ['type', 'booking_type', 'transaction_type'];
  const dateKeyCandidates = ['date', 'ts_created', 'date_created', 'booking_date', 'transaction_date'];
  const orderKeyCandidates = ['id_order', 'order_id', 'order_number'];

  function pickFirst(row, keys) {
    for (const k of keys) {
      if (row[k] != null && String(row[k]).trim() !== '') return row[k];
      const lowerK = k.toLowerCase();
      for (const rk of Object.keys(row)) {
        if (rk.toLowerCase() === lowerK && row[rk] != null && String(row[rk]).trim() !== '') {
          return row[rk];
        }
      }
    }
    return null;
  }

  let totalPayoutCents = 0;
  let detectedCurrency = null;
  const bookings = records.map((row) => {
    const amountRaw = pickFirst(row, amountKeyCandidates);
    const cents = toPriceCents(
      typeof amountRaw === 'string'
        ? amountRaw.replace(/\s/g, '').replace(',', '.')
        : amountRaw
    );
    if (cents != null) totalPayoutCents += cents;
    const currency = safeString(pickFirst(row, currencyKeyCandidates)).toUpperCase() || null;
    if (currency && !detectedCurrency) detectedCurrency = currency;
    return {
      amount_cents: cents,
      currency,
      type: safeString(pickFirst(row, typeKeyCandidates)) || null,
      date: safeString(pickFirst(row, dateKeyCandidates)) || null,
      order_id: safeString(pickFirst(row, orderKeyCandidates)) || null,
      raw: row,
    };
  });

  const cappedOffset = Math.max(0, Number(offset) || 0);
  const cappedLimit = Math.max(0, Number(limit) || 0);
  const paged = cappedLimit > 0
    ? bookings.slice(cappedOffset, cappedOffset + cappedLimit)
    : bookings.slice(cappedOffset);

  return {
    from: dateFrom,
    to: dateTo,
    storefront,
    bookings: paged,
    count: bookings.length,
    total_payout_cents: totalPayoutCents,
    total_payout_eur: Math.round(totalPayoutCents) / 100,
    currency: detectedCurrency || 'EUR',
    reportId,
    reportUrl,
    endpointUsed,
  };
}

/**
 * Returns Kaufland refund bookings in the date range (money refunded to buyers).
 * Detection is by booking text (Erstattung/Storno/Gutschrift/Retoure) — NOT by
 * negative amount, because fee/commission bookings are also negative and must
 * NOT be treated as refunds (that would wrongly reduce VAT).
 *
 * @returns {Promise<Array<{refundId:string, orderId:string, amount:number, currency:string, date:string|null}>>}
 */
async function getKauflandRefunds({ from, to, storefront = 'de' } = {}) {
  const { bookings } = await getBookings({ from, to, storefront });
  const REFUND_RE = /(erstattung|r[uü]ckerstattung|storno|stornier|gutschrift|retoure|refund)/i;

  const refunds = [];
  for (const b of bookings) {
    const text = safeString(b?.raw?.booking_text || b?.raw?.bookingText || b?.type || '');
    if (!REFUND_RE.test(text)) continue;
    const orderId = b.order_id || safeString(b?.raw?.order_number) || null;
    const amount = Math.abs(Number(b.amount_cents) || 0) / 100;
    if (!orderId || !amount) continue;
    refunds.push({
      refundId: `kaufland:${orderId}:${amount.toFixed(2)}:${safeString(b.date)}`,
      orderId: String(orderId),
      amount,
      currency: b.currency || 'EUR',
      date: (safeString(b.date).split(' ')[0] || '').split('T')[0] || null,
    });
  }
  console.log(`[kaufland] ${from}–${to}: ${refunds.length} refund bookings erkannt`);
  return refunds;
}

module.exports = {
  kauflandRequest,
  getKauflandRefunds,
  findUnit,
  listUnits,
  getUnit,
  getProductByEan,
  getProductData,
  getProductDataStatus,
  putProductData,
  patchProductData,
  decideCategory,
  createUnit,
  updateUnit,
  setUnitStatus,
  pickUnitData,
  listShippingGroups,
  listWarehouses,
  getBookings,
  isValidGtin,
  isEanRejectionError,
};
