const { XMLParser } = require('fast-xml-parser');
const { getSecretValue } = require('./secret-values');

const fetchImpl = global.fetch || require('node-fetch');

const XML_NS = 'urn:ebay:apis:eBLBaseComponents';
const DEFAULT_COMPATIBILITY_LEVEL = String(process.env.EBAY_TRADING_COMPATIBILITY_LEVEL || '1209').trim();
const DEFAULT_SITE_ID = String(process.env.EBAY_TRADING_SITE_ID || '77').trim();
const DEFAULT_TIMEOUT_MS = parseInt(process.env.EBAY_TRADING_TIMEOUT_MS || '25000', 10);

const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: true,
  trimValues: true,
});

const CONFIG_CACHE_TTL_MS = Math.max(
  10_000,
  parseInt(process.env.EBAY_TRADING_CONFIG_CACHE_TTL_MS || '60000', 10) || 60000
);

let configCache = { atMs: 0, value: null };

function normalizeEnv(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return v === 'sandbox' ? 'sandbox' : 'production';
}

function getTradingEndpoint(env) {
  return env === 'sandbox' ? 'https://api.sandbox.ebay.com/ws/api.dll' : 'https://api.ebay.com/ws/api.dll';
}

function safeString(value) {
  return value == null ? '' : String(value).trim();
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function toNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIso(value) {
  const raw = safeString(value);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function asCdata(value) {
  const raw = String(value == null ? '' : value);
  return `<![CDATA[${raw.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function normalizeSpecificsMap(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  Object.entries(input).forEach(([k, v]) => {
    const key = safeString(k);
    if (!key) return;
    const values = asArray(v)
      .map((x) => safeString(x))
      .filter(Boolean);
    if (!values.length) return;
    out[key] = values;
  });
  return out;
}

function buildNameValueListXml(itemSpecifics = {}) {
  const specifics = normalizeSpecificsMap(itemSpecifics);
  const entries = Object.entries(specifics);
  if (!entries.length) return '';
  return `<ItemSpecifics>${entries
    .map(([name, values]) => {
      const valueXml = values.map((v) => `<Value>${escapeXml(v)}</Value>`).join('');
      return `<NameValueList><Name>${escapeXml(name)}</Name>${valueXml}</NameValueList>`;
    })
    .join('')}</ItemSpecifics>`;
}

// K-Typ (TecDoc kType) fitment data must be submitted via ItemCompatibilityList,
// not as ItemSpecifics. Each kType number is a separate <Compatibility> entry.
// eBay counts each KType entry as 3 against the 3000-compatibility limit.
function buildCompatibilityListXml(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const xml = list
    .map(({ ktype }) => `<Compatibility><NameValueList><Name>KType</Name><Value>${escapeXml(safeString(ktype))}</Value></NameValueList></Compatibility>`)
    .join('');
  return `<ItemCompatibilityList>${xml}</ItemCompatibilityList>`;
}

async function resolveCredential(nameCandidates = []) {
  const names = asArray(nameCandidates).map((x) => safeString(x)).filter(Boolean);
  for (const name of names) {
    const direct = safeString(process.env[name]);
    if (direct) return direct;
  }
  for (const name of names) {
    try {
      const secret = safeString(await getSecretValue(name));
      if (secret) return secret;
    } catch {
      // best effort
    }
  }
  return '';
}

async function getEbayTradingConfig({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && configCache.value && now - (configCache.atMs || 0) < CONFIG_CACHE_TTL_MS) {
    return configCache.value;
  }

  const env = normalizeEnv(process.env.EBAY_TRADING_ENV || process.env.EBAY_ENV || 'production');
  const [appId, devId, certId, userToken] = await Promise.all([
    resolveCredential(['EBAY_TRADING_APP_ID', 'EBAY_APP_ID', 'EBAY_CLIENT_ID']),
    resolveCredential(['EBAY_TRADING_DEV_ID', 'EBAY_DEV_ID']),
    resolveCredential(['EBAY_TRADING_CERT_ID', 'EBAY_CERT_ID', 'EBAY_CLIENT_SECRET']),
    resolveCredential(['EBAY_TRADING_USER_TOKEN', 'EBAY_USER_TOKEN', 'EBAY_AUTH_TOKEN']),
  ]);

  const compatibilityLevel = safeString(process.env.EBAY_TRADING_COMPATIBILITY_LEVEL || DEFAULT_COMPATIBILITY_LEVEL);
  const siteId = safeString(process.env.EBAY_TRADING_SITE_ID || DEFAULT_SITE_ID) || '77';
  const endpoint = getTradingEndpoint(env);

  const missing = [];
  if (!appId) missing.push('EBAY_TRADING_APP_ID');
  if (!devId) missing.push('EBAY_TRADING_DEV_ID');
  if (!certId) missing.push('EBAY_TRADING_CERT_ID');
  if (!userToken) missing.push('EBAY_TRADING_USER_TOKEN');

  if (missing.length) {
    const error = new Error(`eBay Trading config missing: ${missing.join(', ')}`);
    error.code = 'EBAY_TRADING_CONFIG_MISSING';
    throw error;
  }

  const value = {
    env,
    endpoint,
    appId,
    devId,
    certId,
    userToken,
    compatibilityLevel: compatibilityLevel || DEFAULT_COMPATIBILITY_LEVEL,
    siteId,
  };
  configCache = { atMs: now, value };
  return value;
}

function buildRequestRoot(callName, innerXml, token, version) {
  return `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="${XML_NS}">
  <RequesterCredentials>
    <eBayAuthToken>${escapeXml(token)}</eBayAuthToken>
  </RequesterCredentials>
  <Version>${escapeXml(version)}</Version>
  ${innerXml}
</${callName}Request>`;
}

async function fetchWithTimeout(url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

function resolveResponseNode(parsed, callName) {
  const responseKey = `${callName}Response`;
  if (parsed && parsed[responseKey]) return parsed[responseKey];

  const envelope =
    parsed?.['soap:Envelope'] ||
    parsed?.['SOAP-ENV:Envelope'] ||
    parsed?.Envelope ||
    parsed?.['s:Envelope'] ||
    null;
  const body =
    envelope?.['soap:Body'] ||
    envelope?.['SOAP-ENV:Body'] ||
    envelope?.Body ||
    envelope?.['s:Body'] ||
    null;
  if (body && body[responseKey]) return body[responseKey];
  return null;
}

function parseErrors(errorsNode) {
  return asArray(errorsNode).map((error) => ({
    code: safeString(error?.ErrorCode) || null,
    shortMessage: safeString(error?.ShortMessage) || null,
    longMessage: safeString(error?.LongMessage) || null,
    severity: safeString(error?.SeverityCode) || null,
    classification: safeString(error?.ErrorClassification) || null,
  }));
}

function isAckSuccess(ack) {
  const value = safeString(ack).toLowerCase();
  return value === 'success' || value === 'warning';
}

// eBay error codes that indicate the specified category is wrong and eBay wants to
// auto-assign it (e.g. via GTIN/EAN catalog match). Retrying without <PrimaryCategory>
// lets eBay pick the correct category from its catalog.
const CATEGORY_MISMATCH_CODES = new Set([
  '21916248', // Item must be in the catalog category
  '21919077', // Category has been changed for this listing
  '21919197', // Category is not valid for catalog-based listing
  '21916284', // Item is listed in the wrong category
]);

function isCategoryMismatchError(errors) {
  if (!Array.isArray(errors) || !errors.length) return false;
  return errors.some((e) => {
    if (CATEGORY_MISMATCH_CODES.has(safeString(e?.code))) return true;
    const msg = (safeString(e?.longMessage) + ' ' + safeString(e?.shortMessage)).toLowerCase();
    return msg.includes('kategorie') || msg.includes('category');
  });
}

function isProductAspectMisuseError(errors) {
  if (!Array.isArray(errors) || !errors.length) return false;
  return errors.some((e) => {
    const msg = (safeString(e?.longMessage) + ' ' + safeString(e?.shortMessage)).toLowerCase();
    const german =
      msg.includes('produkt-artikelmerkmal') &&
      (msg.includes('benutzerdefin') || msg.includes('benutzerdefini') || msg.includes('custom'));
    const english =
      msg.includes('product aspect') &&
      (msg.includes('custom item specific') || msg.includes('custom item specifics') || msg.includes('custom'));
    return german || english;
  });
}

function normalizeAspectToken(value) {
  return safeString(value)
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '');
}

function extractMisusedAspectNames(errors) {
  if (!Array.isArray(errors) || !errors.length) return [];
  const messages = errors
    .flatMap((e) => [safeString(e?.longMessage), safeString(e?.shortMessage)])
    .filter(Boolean);
  for (const msg of messages) {
    const lower = msg.toLowerCase();
    const looksLikeMisuse =
      (lower.includes('produkt-artikelmerkmal') && (lower.includes('benutzerdefin') || lower.includes('custom'))) ||
      (lower.includes('product aspect') && (lower.includes('custom item specific') || lower.includes('custom')));
    if (!looksLikeMisuse) continue;
    const idx = msg.indexOf(':');
    if (idx < 0) continue;
    const tail = msg.slice(idx + 1);
    return tail
      .split(',')
      .map((x) => safeString(x).replace(/[.;]+$/g, '').trim())
      .filter(Boolean)
      .slice(0, 60);
  }
  return [];
}

function stripItemSpecificsByAspectNames(itemSpecifics, aspectNames = []) {
  const specifics = itemSpecifics && typeof itemSpecifics === 'object' ? itemSpecifics : {};
  const tokens = new Set(asArray(aspectNames).map((n) => normalizeAspectToken(n)).filter(Boolean));
  if (!tokens.size) {
    return { itemSpecifics: specifics, removed: [] };
  }
  const removed = [];
  const out = {};
  Object.entries(specifics).forEach(([k, v]) => {
    const key = safeString(k);
    if (!key) return;
    const token = normalizeAspectToken(key);
    if (token && tokens.has(token)) {
      removed.push(key);
      return;
    }
    out[key] = v;
  });
  return { itemSpecifics: out, removed };
}

function mapItemSpecifics(itemSpecificsNode) {
  const out = {};
  const list = asArray(itemSpecificsNode?.NameValueList);
  list.forEach((entry) => {
    const name = safeString(entry?.Name);
    if (!name) return;
    const values = asArray(entry?.Value)
      .map((v) => safeString(v))
      .filter(Boolean);
    if (!values.length) return;
    out[name] = values;
  });
  return out;
}

function extractVariationSkus(item = {}) {
  // Per eBay Trading API docs, multi-variation listings define SKUs at:
  // Item.Variations.Variation[].SKU (not Item.SKU).
  const variations = asArray(item?.Variations?.Variation);
  const skus = variations.map((v) => safeString(v?.SKU)).filter(Boolean);
  return Array.from(new Set(skus));
}

function mapActiveListingItem(item = {}) {
  const currentPrice = item?.SellingStatus?.CurrentPrice;
  return {
    itemId: safeString(item?.ItemID),
    sku: safeString(item?.SKU) || null,
    title: safeString(item?.Title) || null,
    subtitle: safeString(item?.SubTitle) || null,
    listingType: safeString(item?.ListingType) || null,
    listingStatus: safeString(item?.SellingStatus?.ListingStatus) || null,
    quantityAvailable: toNumber(item?.QuantityAvailable),
    quantityTotal: toNumber(item?.Quantity),
    currentPrice: {
      value: toNumber(currentPrice?.['#text'] ?? currentPrice),
      currency: safeString(currentPrice?.currencyID || item?.Currency) || null,
    },
    primaryCategoryId: safeString(item?.PrimaryCategory?.CategoryID) || null,
    primaryCategoryName: safeString(item?.PrimaryCategory?.CategoryName) || null,
    startTime: toIso(item?.ListingDetails?.StartTime),
    endTime: toIso(item?.ListingDetails?.EndTime),
    viewItemUrl: safeString(item?.ListingDetails?.ViewItemURL) || null,
    bidCount: toNumber(item?.SellingStatus?.BidCount),
  };
}

function mapListingDetail(item = {}) {
  const currentPrice = item?.SellingStatus?.CurrentPrice;
  const pictureUrls = asArray(item?.PictureDetails?.PictureURL)
    .map((url) => safeString(url))
    .filter(Boolean);
  return {
    itemId: safeString(item?.ItemID),
    sku: safeString(item?.SKU) || null,
    variationSkus: extractVariationSkus(item),
    title: safeString(item?.Title) || null,
    subtitle: safeString(item?.SubTitle) || null,
    description: safeString(item?.Description) || null,
    listingType: safeString(item?.ListingType) || null,
    listingStatus: safeString(item?.SellingStatus?.ListingStatus) || null,
    quantityAvailable: toNumber(item?.QuantityAvailable),
    quantityTotal: toNumber(item?.Quantity),
    bidCount: toNumber(item?.SellingStatus?.BidCount),
    inventoryTrackingMethod: safeString(item?.InventoryTrackingMethod) || null,
    primaryCategoryId: safeString(item?.PrimaryCategory?.CategoryID) || null,
    primaryCategoryName: safeString(item?.PrimaryCategory?.CategoryName) || null,
    startTime: toIso(item?.ListingDetails?.StartTime),
    endTime: toIso(item?.ListingDetails?.EndTime),
    timeLeft: safeString(item?.ListingDetails?.TimeLeft) || null,
    viewItemUrl: safeString(item?.ListingDetails?.ViewItemURL) || null,
    pictureUrls: pictureUrls.length ? Array.from(new Set(pictureUrls)).slice(0, 24) : [],
    location: safeString(item?.Location) || null,
    country: safeString(item?.Country) || null,
    conditionId: safeString(item?.ConditionID) || null,
    currency: safeString(currentPrice?.currencyID || item?.Currency) || null,
    currentPrice: toNumber(currentPrice?.['#text'] ?? currentPrice),
    itemSpecifics: mapItemSpecifics(item?.ItemSpecifics),
    variationSpecificsSet: mapItemSpecifics(item?.Variations?.VariationSpecificsSet),
    productListingDetails: item?.ProductListingDetails || null,
  };
}

async function callTradingApi(callName, bodyXml, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cfg = await getEbayTradingConfig();

  // Prefer the fresh OAuth access token from Firestore over the static GCP Secret token.
  // Both work in the Trading API <eBayAuthToken> field; the OAuth token is always up-to-date.
  let effectiveToken = cfg.userToken;
  try {
    const { getValidEbayAccessToken } = require('./ebay-oauth');
    const { accessToken } = await getValidEbayAccessToken();
    if (accessToken) effectiveToken = accessToken;
  } catch (_err) {
    // Fall back to static token from GCP Secret Manager
  }

  // Auto-wrap inner XML fragments — callers that already built the full root (via buildRequestRoot)
  // pass <?xml ... so we detect and skip double-wrapping.
  const fullXml = bodyXml.trimStart().startsWith('<?xml')
    ? bodyXml
    : buildRequestRoot(callName, bodyXml, effectiveToken, cfg.compatibilityLevel);

  const res = await fetchWithTimeout(
    cfg.endpoint,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'X-EBAY-API-CALL-NAME': callName,
        'X-EBAY-API-SITEID': cfg.siteId,
        'X-EBAY-API-COMPATIBILITY-LEVEL': cfg.compatibilityLevel,
        'X-EBAY-API-APP-NAME': cfg.appId,
        'X-EBAY-API-DEV-NAME': cfg.devId,
        'X-EBAY-API-CERT-NAME': cfg.certId,
      },
      body: fullXml,
    },
    timeoutMs
  );

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const error = new Error(`eBay Trading HTTP ${res.status} for ${callName}: ${text.slice(0, 500)}`);
    error.code = 'EBAY_TRADING_HTTP_ERROR';
    error.statusCode = res.status;
    throw error;
  }

  const parsed = XML_PARSER.parse(text);
  const responseNode = resolveResponseNode(parsed, callName);
  if (!responseNode) {
    const error = new Error(`Invalid ${callName} response payload.`);
    error.code = 'EBAY_TRADING_PARSE_ERROR';
    throw error;
  }

  const ack = safeString(responseNode?.Ack);
  const errors = parseErrors(responseNode?.Errors);
  if (!isAckSuccess(ack)) {
    const message = errors[0]?.longMessage || errors[0]?.shortMessage || `${callName} failed with Ack=${ack}`;
    const error = new Error(message);
    error.code = 'EBAY_TRADING_CALL_FAILED';
    error.details = { ack, errors };
    throw error;
  }

  return {
    ack,
    errors,
    response: responseNode,
    rawXml: text,
  };
}

async function getMyeBaySellingActive({
  pageNumber = 1,
  entriesPerPage = 100,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const cfg = await getEbayTradingConfig();
  const requestXml = buildRequestRoot(
    'GetMyeBaySelling',
    `<ActiveList>
  <Include>true</Include>
  <Pagination>
    <EntriesPerPage>${Math.max(1, Math.min(Number(entriesPerPage) || 100, 200))}</EntriesPerPage>
    <PageNumber>${Math.max(1, Number(pageNumber) || 1)}</PageNumber>
  </Pagination>
</ActiveList>`,
    cfg.userToken,
    cfg.compatibilityLevel
  );
  const result = await callTradingApi('GetMyeBaySelling', requestXml, { timeoutMs });
  const activeList = result?.response?.ActiveList || {};
  const items = asArray(activeList?.ItemArray?.Item).map(mapActiveListingItem).filter((row) => row.itemId);
  const pagination = activeList?.PaginationResult || {};
  return {
    ack: result.ack,
    warnings: result.errors,
    items,
    pagination: {
      totalEntries: toNumber(pagination?.TotalNumberOfEntries) || items.length,
      totalPages: toNumber(pagination?.TotalNumberOfPages) || 1,
      pageNumber: toNumber(pagination?.PageNumber) || Math.max(1, Number(pageNumber) || 1),
      entriesPerPage: toNumber(pagination?.EntriesPerPage) || Math.max(1, Math.min(Number(entriesPerPage) || 100, 200)),
    },
  };
}

async function getItemDetails(itemId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const id = safeString(itemId);
  if (!id) {
    const error = new Error('itemId is required');
    error.code = 'EBAY_ITEM_ID_REQUIRED';
    throw error;
  }
  const cfg = await getEbayTradingConfig();
  const requestXml = buildRequestRoot(
    'GetItem',
    `<ItemID>${escapeXml(id)}</ItemID>
<IncludeItemSpecifics>true</IncludeItemSpecifics>
<DetailLevel>ReturnAll</DetailLevel>`,
    cfg.userToken,
    cfg.compatibilityLevel
  );
  const result = await callTradingApi('GetItem', requestXml, { timeoutMs });
  const detail = mapListingDetail(result?.response?.Item || {});
  return {
    ack: result.ack,
    warnings: result.errors,
    item: detail,
  };
}

function buildReviseItemRequestXml(callName, patch, cfg) {
  const itemId = safeString(patch?.itemId);
  if (!itemId) {
    const error = new Error('itemId is required for revise call');
    error.code = 'EBAY_REVISE_ITEM_ID_REQUIRED';
    throw error;
  }

  const itemFields = [`<ItemID>${escapeXml(itemId)}</ItemID>`];
  const categoryId = safeString(patch?.primaryCategoryId);
  if (categoryId) {
    itemFields.push(`<PrimaryCategory><CategoryID>${escapeXml(categoryId)}</CategoryID></PrimaryCategory>`);
  }
  const title = safeString(patch?.title);
  if (title) {
    itemFields.push(`<Title>${escapeXml(title)}</Title>`);
  }
  const subtitle = safeString(patch?.subtitle);
  if (subtitle) {
    itemFields.push(`<SubTitle>${escapeXml(subtitle)}</SubTitle>`);
  }
  if (typeof patch?.description === 'string') {
    itemFields.push(`<Description>${asCdata(patch.description)}</Description>`);
  }
  const specificsXml = buildNameValueListXml(patch?.itemSpecifics || {});
  if (specificsXml) {
    itemFields.push(specificsXml);
  }
  const pictureUrls = asArray(patch?.pictureUrls || patch?.pictureDetails)
    .map((u) => safeString(u))
    .filter(Boolean);
  if (pictureUrls.length) {
    // Per Trading API docs: for revise calls, provide the complete set of PictureURL values you want the listing to include.
    itemFields.push(
      `<PictureDetails>${pictureUrls
        .map((u) => `<PictureURL>${escapeXml(u)}</PictureURL>`)
        .join('')}</PictureDetails>`
    );
  }

  // Price update — ReviseFixedPriceItem uses <StartPrice> for fixed-price listings
  const startPrice = parseFloat(patch?.startPrice ?? patch?.price);
  if (Number.isFinite(startPrice) && startPrice > 0) {
    const currency = safeString(patch?.currency) || 'EUR';
    itemFields.push(`<StartPrice currencyID="${escapeXml(currency)}">${startPrice.toFixed(2)}</StartPrice>`);
  }

  // Quantity update — sets total available quantity for the listing
  const quantity = parseInt(patch?.quantity, 10);
  if (Number.isFinite(quantity) && quantity >= 0) {
    itemFields.push(`<Quantity>${quantity}</Quantity>`);
  }

  if (itemFields.length <= 1) {
    const error = new Error(
      'No revisable fields provided. Expected category/title/subtitle/description/itemSpecifics/pictureUrls/startPrice/quantity.'
    );
    error.code = 'EBAY_REVISE_FIELDS_MISSING';
    throw error;
  }

  return buildRequestRoot(callName, `<Item>${itemFields.join('')}</Item>`, cfg.userToken, cfg.compatibilityLevel);
}

async function reviseListing(callName, patch, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cfg = await getEbayTradingConfig();
  const requestXml = buildReviseItemRequestXml(callName, patch, cfg);
  const result = await callTradingApi(callName, requestXml, { timeoutMs });
  const response = result?.response || {};
  return {
    ack: result.ack,
    warnings: result.errors,
    itemId: safeString(response?.ItemID || patch?.itemId),
    fees: response?.Fees || null,
  };
}

async function reviseFixedPriceItem(patch, options = {}) {
  return reviseListing('ReviseFixedPriceItem', patch, options);
}

async function reviseItem(patch, options = {}) {
  return reviseListing('ReviseItem', patch, options);
}

// ---------------------------------------------------------------------------
// EndItem / EndFixedPriceItem
// ---------------------------------------------------------------------------

async function endItem(itemId, { reason = 'NotAvailable', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const id = safeString(itemId);
  if (!id) {
    const error = new Error('itemId is required for EndItem call');
    error.code = 'EBAY_END_ITEM_ID_REQUIRED';
    throw error;
  }
  const validReasons = ['NotAvailable', 'Incorrect', 'LostOrBroken', 'OtherListingError', 'SellToHighBidder'];
  const endingReason = validReasons.includes(reason) ? reason : 'NotAvailable';
  const cfg = await getEbayTradingConfig();
  const requestXml = buildRequestRoot(
    'EndItem',
    `<ItemID>${escapeXml(id)}</ItemID>
<EndingReason>${escapeXml(endingReason)}</EndingReason>`,
    cfg.userToken,
    cfg.compatibilityLevel
  );
  const result = await callTradingApi('EndItem', requestXml, { timeoutMs });
  const response = result?.response || {};
  return {
    ack: result.ack,
    warnings: result.errors,
    itemId: safeString(response?.ItemID || id),
    endTime: toIso(response?.EndTime) || null,
  };
}

async function endFixedPriceItem(itemId, { reason = 'NotAvailable', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const id = safeString(itemId);
  if (!id) {
    const error = new Error('itemId is required for EndFixedPriceItem call');
    error.code = 'EBAY_END_ITEM_ID_REQUIRED';
    throw error;
  }
  const validReasons = ['NotAvailable', 'Incorrect', 'LostOrBroken', 'OtherListingError'];
  const endingReason = validReasons.includes(reason) ? reason : 'NotAvailable';
  const cfg = await getEbayTradingConfig();
  const requestXml = buildRequestRoot(
    'EndFixedPriceItem',
    `<ItemID>${escapeXml(id)}</ItemID>
<EndingReason>${escapeXml(endingReason)}</EndingReason>`,
    cfg.userToken,
    cfg.compatibilityLevel
  );
  const result = await callTradingApi('EndFixedPriceItem', requestXml, { timeoutMs });
  const response = result?.response || {};
  return {
    ack: result.ack,
    warnings: result.errors,
    itemId: safeString(response?.ItemID || id),
    endTime: toIso(response?.EndTime) || null,
  };
}

// ---------------------------------------------------------------------------
// AddFixedPriceItem / VerifyAddFixedPriceItem
// ---------------------------------------------------------------------------

function buildAddFixedPriceItemXml(item, cfg) {
  const fields = [];

  const title = safeString(item?.title);
  if (!title) throw Object.assign(new Error('title is required'), { code: 'EBAY_ADD_FIELD_MISSING' });
  fields.push(`<Title>${escapeXml(title)}</Title>`);

  const subtitle = safeString(item?.subtitle);
  if (subtitle) fields.push(`<SubTitle>${escapeXml(subtitle)}</SubTitle>`);

  const categoryId = safeString(item?.primaryCategoryId);
  if (categoryId) {
    fields.push(`<PrimaryCategory><CategoryID>${escapeXml(categoryId)}</CategoryID></PrimaryCategory>`);
  }

  if (typeof item?.description === 'string') {
    fields.push(`<Description>${asCdata(item.description)}</Description>`);
  }

  const price = item?.startPrice ?? item?.price;
  if (price == null) throw Object.assign(new Error('startPrice is required'), { code: 'EBAY_ADD_FIELD_MISSING' });
  const currency = safeString(item?.currency) || 'EUR';
  fields.push(`<StartPrice currencyID="${escapeXml(currency)}">${escapeXml(String(price))}</StartPrice>`);
  fields.push(`<Currency>${escapeXml(currency)}</Currency>`);

  const quantity = item?.quantity ?? 1;
  fields.push(`<Quantity>${escapeXml(String(quantity))}</Quantity>`);

  const conditionId = safeString(item?.conditionId);
  if (conditionId) fields.push(`<ConditionID>${escapeXml(conditionId)}</ConditionID>`);

  const conditionDescription = safeString(item?.conditionDescription);
  if (conditionDescription) fields.push(`<ConditionDescription>${escapeXml(conditionDescription)}</ConditionDescription>`);

  const duration = safeString(item?.listingDuration) || 'GTC';
  fields.push(`<ListingDuration>${escapeXml(duration)}</ListingDuration>`);
  fields.push(`<ListingType>FixedPriceItem</ListingType>`);

  const country = safeString(item?.country) || 'DE';
  fields.push(`<Country>${escapeXml(country)}</Country>`);

  const postalCode = safeString(item?.postalCode);
  if (postalCode) fields.push(`<PostalCode>${escapeXml(postalCode)}</PostalCode>`);

  const location = safeString(item?.location) || 'Deutschland';
  fields.push(`<Location>${escapeXml(location)}</Location>`);

  const sku = safeString(item?.sku);
  if (sku) fields.push(`<SKU>${escapeXml(sku)}</SKU>`);

  const pictureUrls = asArray(item?.pictureUrls || item?.pictureDetails).map((u) => safeString(u)).filter(Boolean);
  if (pictureUrls.length) {
    fields.push(`<PictureDetails>${pictureUrls.map((u) => `<PictureURL>${escapeXml(u)}</PictureURL>`).join('')}</PictureDetails>`);
  }

  const ean = safeString(item?.ean);
  const isbn = safeString(item?.isbn);
  const mpn = safeString(item?.mpn);
  const brand = safeString(item?.brand);
  // Always include ProductListingDetails — many eBay categories require product identifiers.
  // When no EAN/ISBN/MPN is available, send "Does not apply" so eBay accepts the listing.
  {
    const pld = [];
    pld.push(`<EAN>${escapeXml(ean || 'Does not apply')}</EAN>`);
    if (isbn) pld.push(`<ISBN>${escapeXml(isbn)}</ISBN>`);
    if (mpn) pld.push(`<BrandMPN><Brand>${escapeXml(brand || 'Unbranded')}</Brand><MPN>${escapeXml(mpn)}</MPN></BrandMPN>`);
    if (ean || isbn || mpn) {
      pld.push('<IncludeeBayProductDetails>true</IncludeeBayProductDetails>');
    }
    fields.push(`<ProductListingDetails>${pld.join('')}</ProductListingDetails>`);
  }

  const specificsXml = buildNameValueListXml(item?.itemSpecifics || {});
  if (specificsXml) fields.push(specificsXml);

  const compatibilityXml = buildCompatibilityListXml(item?.itemCompatibilityList);
  if (compatibilityXml) fields.push(compatibilityXml);

  const dispatchTimeMax = item?.dispatchTimeMax ?? 3;
  fields.push(`<DispatchTimeMax>${escapeXml(String(dispatchTimeMax))}</DispatchTimeMax>`);

  const shippingProfileId = safeString(item?.shippingProfileId);
  const returnProfileId = safeString(item?.returnProfileId);
  const paymentProfileId = safeString(item?.paymentProfileId);
  if (shippingProfileId || returnProfileId || paymentProfileId) {
    const profiles = [];
    if (shippingProfileId) {
      profiles.push(`<SellerShippingProfile><ShippingProfileID>${escapeXml(shippingProfileId)}</ShippingProfileID></SellerShippingProfile>`);
    }
    if (returnProfileId) {
      profiles.push(`<SellerReturnProfile><ReturnProfileID>${escapeXml(returnProfileId)}</ReturnProfileID></SellerReturnProfile>`);
    }
    if (paymentProfileId) {
      profiles.push(`<SellerPaymentProfile><PaymentProfileID>${escapeXml(paymentProfileId)}</PaymentProfileID></SellerPaymentProfile>`);
    }
    fields.push(`<SellerProfiles>${profiles.join('')}</SellerProfiles>`);
  }

  return buildRequestRoot('AddFixedPriceItem', `<Item>${fields.join('')}</Item>`, cfg.userToken, cfg.compatibilityLevel);
}

async function addFixedPriceItem(item, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cfg = await getEbayTradingConfig();
  let currentItem = item;
  let triedNoCategory = false;
  let triedStripProductAspects = false;
  let result;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      result = await callTradingApi('AddFixedPriceItem', buildAddFixedPriceItemXml(currentItem, cfg), { timeoutMs });
      break;
    } catch (err) {
      const errors = err?.details?.errors;
      // If eBay rejects the category, retry without <PrimaryCategory> so eBay
      // can auto-assign the correct category via GTIN/EAN catalog matching.
      if (!triedNoCategory && err.code === 'EBAY_TRADING_CALL_FAILED' && isCategoryMismatchError(errors)) {
        triedNoCategory = true;
        currentItem = { ...currentItem, primaryCategoryId: undefined };
        continue;
      }

      // PBSE/catalog: eBay can reject PRODUCT aspects sent via ItemSpecifics.
      // Retry once by removing only the offending aspect names listed in the API error message.
      if (
        !triedStripProductAspects &&
        err.code === 'EBAY_TRADING_CALL_FAILED' &&
        isProductAspectMisuseError(errors)
      ) {
        triedStripProductAspects = true;
        const misused = extractMisusedAspectNames(errors);
        const stripped = stripItemSpecificsByAspectNames(currentItem?.itemSpecifics, misused);
        currentItem = { ...currentItem, itemSpecifics: stripped.itemSpecifics };
        continue;
      }

      throw err;
    }
  }
  const response = result?.response || {};
  return {
    ack: result.ack,
    warnings: result.errors,
    itemId: safeString(response?.ItemID),
    fees: asArray(response?.Fees?.Fee).map((fee) => ({
      name: safeString(fee?.Name),
      amount: safeString(fee?.Fee?.['#text'] ?? fee?.Fee ?? fee?.Amount?.['#text'] ?? fee?.Amount),
      currency: safeString(fee?.Fee?.currencyID ?? fee?.Amount?.currencyID) || null,
    })),
    startTime: safeString(response?.StartTime) || null,
    endTime: safeString(response?.EndTime) || null,
  };
}

async function verifyAddFixedPriceItem(item, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cfg = await getEbayTradingConfig();
  const buildXml = (i) =>
    buildAddFixedPriceItemXml(i, cfg)
      .replace('<AddFixedPriceItemRequest', '<VerifyAddFixedPriceItemRequest')
      .replace('</AddFixedPriceItemRequest>', '</VerifyAddFixedPriceItemRequest>');
  let currentItem = item;
  let triedNoCategory = false;
  let triedStripProductAspects = false;
  let result;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      result = await callTradingApi('VerifyAddFixedPriceItem', buildXml(currentItem), { timeoutMs });
      break;
    } catch (err) {
      const errors = err?.details?.errors;
      // If eBay rejects the category, retry without <PrimaryCategory> so eBay
      // can auto-assign the correct category via GTIN/EAN catalog matching.
      if (!triedNoCategory && err.code === 'EBAY_TRADING_CALL_FAILED' && isCategoryMismatchError(errors)) {
        triedNoCategory = true;
        currentItem = { ...currentItem, primaryCategoryId: undefined };
        continue;
      }

      // PBSE/catalog: eBay can reject PRODUCT aspects sent via ItemSpecifics.
      // Retry once by removing only the offending aspect names listed in the API error message.
      if (
        !triedStripProductAspects &&
        err.code === 'EBAY_TRADING_CALL_FAILED' &&
        isProductAspectMisuseError(errors)
      ) {
        triedStripProductAspects = true;
        const misused = extractMisusedAspectNames(errors);
        const stripped = stripItemSpecificsByAspectNames(currentItem?.itemSpecifics, misused);
        currentItem = { ...currentItem, itemSpecifics: stripped.itemSpecifics };
        continue;
      }

      throw err;
    }
  }
  const response = result?.response || {};
  return {
    ack: result.ack,
    warnings: result.errors,
    fees: asArray(response?.Fees?.Fee).map((fee) => ({
      name: safeString(fee?.Name),
      amount: safeString(fee?.Fee?.['#text'] ?? fee?.Fee ?? fee?.Amount?.['#text'] ?? fee?.Amount),
      currency: safeString(fee?.Fee?.currencyID ?? fee?.Amount?.currencyID) || null,
    })),
  };
}

async function getSellerProfiles({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cfg = await getEbayTradingConfig();
  const requestXml = buildRequestRoot(
    'GetSellerProfiles',
    `<ProfileType>SHIPPING</ProfileType><ProfileType>RETURN_POLICY</ProfileType><ProfileType>PAYMENT</ProfileType>`,
    cfg.userToken,
    cfg.compatibilityLevel
  );
  const result = await callTradingApi('GetSellerProfiles', requestXml, { timeoutMs });
  const response = result?.response || {};

  const shippingProfiles = asArray(response?.ShippingProfileList?.ShippingProfile).map((p) => ({
    id: safeString(p?.ShippingProfileID),
    name: safeString(p?.ShippingProfileName),
  })).filter((p) => p.id);

  const returnProfiles = asArray(response?.ReturnPolicyProfileList?.ReturnPolicyProfile).map((p) => ({
    id: safeString(p?.ReturnPolicyProfileID),
    name: safeString(p?.ReturnPolicyProfileName),
  })).filter((p) => p.id);

  const paymentProfiles = asArray(response?.PaymentProfileList?.PaymentProfile).map((p) => ({
    id: safeString(p?.PaymentProfileID),
    name: safeString(p?.PaymentProfileName),
  })).filter((p) => p.id);

  return {
    ack: result.ack,
    warnings: result.errors,
    shippingProfiles,
    returnProfiles,
    paymentProfiles,
  };
}

async function getCategoryInfo(categoryId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const id = safeString(categoryId);
  if (!id) throw Object.assign(new Error('categoryId is required'), { code: 'EBAY_CATEGORY_ID_REQUIRED' });
  const cfg = await getEbayTradingConfig();
  // NOTE: LevelLimit is absolute in eBay's hierarchy (level 1 = root), NOT relative to CategoryID.
  // Omitting LevelLimit returns the subtree from the specified category (just the node itself if it's a leaf).
  const requestXml = buildRequestRoot(
    'GetCategories',
    `<CategoryID>${escapeXml(id)}</CategoryID><ViewAllNodes>true</ViewAllNodes>`,
    cfg.userToken,
    cfg.compatibilityLevel
  );
  const result = await callTradingApi('GetCategories', requestXml, { timeoutMs });
  const categories = asArray(result?.response?.CategoryArray?.Category);
  const cat = categories.find((c) => safeString(c?.CategoryID) === id);
  if (!cat) {
    // Category not found in response – assume valid leaf to avoid false blocks
    return { categoryId: id, name: null, level: null, parentId: null, isLeaf: true };
  }
  // LeafCategory is parsed as boolean by fast-xml-parser (parseTagValue: true)
  const leafRaw = cat?.LeafCategory;
  const isLeaf = leafRaw === true || safeString(leafRaw).toLowerCase() === 'true';
  return {
    categoryId: id,
    name: safeString(cat?.CategoryName) || null,
    level: toNumber(cat?.CategoryLevel),
    parentId: safeString(cat?.CategoryParentID) || null,
    isLeaf,
  };
}

async function getCategorySpecifics(categoryId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const id = safeString(categoryId);
  if (!id) throw Object.assign(new Error('categoryId is required'), { code: 'EBAY_CATEGORY_ID_REQUIRED' });
  const cfg = await getEbayTradingConfig();
  const requestXml = buildRequestRoot(
    'GetCategorySpecifics',
    `<CategoryID>${escapeXml(id)}</CategoryID>`,
    cfg.userToken,
    cfg.compatibilityLevel
  );
  const result = await callTradingApi('GetCategorySpecifics', requestXml, { timeoutMs });
  const recommendations = asArray(result?.response?.Recommendations);
  const specifics = recommendations
    .flatMap((rec) => asArray(rec?.NameRecommendation))
    .map((nr) => {
      const rules = nr?.ValidationRules || {};
      const minValues = toNumber(rules?.MinValues) || 0;
      return {
        name: safeString(nr?.Name),
        required: minValues > 0,
        minValues,
        maxValues: toNumber(rules?.MaxValues) || null,
        valueRecommendations: asArray(nr?.ValueRecommendation).map((vr) => safeString(vr?.Value)).filter(Boolean),
      };
    })
    .filter((s) => s.name);
  return { categoryId: id, specifics };
}

async function fetchTradingStatus() {
  const cfg = await getEbayTradingConfig();
  return {
    connected: true,
    mode: 'user_token',
    env: cfg.env,
    endpoint: cfg.endpoint,
    siteId: cfg.siteId,
    compatibilityLevel: cfg.compatibilityLevel,
    appIdMasked: cfg.appId ? `${cfg.appId.slice(0, 6)}***${cfg.appId.slice(-2)}` : null,
    devIdMasked: cfg.devId ? `${cfg.devId.slice(0, 4)}***${cfg.devId.slice(-2)}` : null,
    certIdMasked: cfg.certId ? `${cfg.certId.slice(0, 4)}***${cfg.certId.slice(-2)}` : null,
    tokenConfigured: Boolean(cfg.userToken),
  };
}

module.exports = {
  getEbayTradingConfig,
  buildRequestRoot,
  fetchTradingStatus,
  callTradingApi,
  getMyeBaySellingActive,
  getItemDetails,
  getSellerProfiles,
  getCategoryInfo,
  getCategorySpecifics,
  reviseFixedPriceItem,
  reviseItem,
  endItem,
  endFixedPriceItem,
  addFixedPriceItem,
  verifyAddFixedPriceItem,
  mapItemSpecifics,
  mapListingDetail,
  normalizeSpecificsMap,
  isAckSuccess,
};
