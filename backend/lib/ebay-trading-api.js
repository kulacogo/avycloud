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
  return {
    itemId: safeString(item?.ItemID),
    sku: safeString(item?.SKU) || null,
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
      body: bodyXml,
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

  if (itemFields.length <= 1) {
    const error = new Error('No revisable fields provided. Expected category/title/subtitle/description/itemSpecifics.');
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
  fetchTradingStatus,
  callTradingApi,
  getMyeBaySellingActive,
  getItemDetails,
  reviseFixedPriceItem,
  reviseItem,
  mapItemSpecifics,
  mapListingDetail,
  normalizeSpecificsMap,
  isAckSuccess,
};
