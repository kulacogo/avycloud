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

// TTL caches for expensive, rarely-changing lookups
const SELLER_PROFILES_CACHE_TTL_MS = parseInt(process.env.EBAY_SELLER_PROFILES_CACHE_MS || String(4 * 60 * 60 * 1000), 10); // 4h
const CATEGORY_SPECIFICS_CACHE_TTL_MS = parseInt(process.env.EBAY_CATEGORY_SPECIFICS_CACHE_MS || String(24 * 60 * 60 * 1000), 10); // 24h
const CATEGORY_INFO_CACHE_TTL_MS = parseInt(process.env.EBAY_CATEGORY_INFO_CACHE_MS || String(24 * 60 * 60 * 1000), 10); // 24h

let sellerProfilesCache = { atMs: 0, value: null };
const categorySpecificsCache = new Map(); // categoryId → { atMs, value }
const categoryInfoCache = new Map(); // categoryId → { atMs, value }

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

// XML 1.0 verbietet fast alle Steuerzeichen — AUCH innerhalb von CDATA.
// Ein rohes Null-Byte (o. Ä.) in Produktdaten (z. B. ein zu 0x00 zerschossener
// Umlaut in Titel/Beschreibung) macht den GESAMTEN Trading-API-Request ungültig
// und eBay wirft SAXParseException "An invalid XML character (Unicode: 0x0)".
// Deshalb VOR jedem Escaping/CDATA alle XML-illegalen Zeichen entfernen.
// Erlaubt bleiben: #x9 (Tab), #xA (LF), #xD (CR), #x20–#xD7FF, #xE000–#xFFFD,
// #x10000–#x10FFFF. Entfernt werden Steuerzeichen, die Nichtzeichen #xFFFE/#xFFFF
// und einzelne (ungepaarte) Surrogate.
function stripInvalidXmlChars(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1');
}

function escapeXml(value) {
  return stripInvalidXmlChars(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function asCdata(value) {
  const raw = stripInvalidXmlChars(value);
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

/**
 * Ersetzt den <eBayAuthToken> in einem bereits fertig gebauten Trading-Request.
 * Viele Caller bauen ihr XML selbst via buildRequestRoot(cfg.userToken) —
 * ohne diesen Austausch würde der frische OAuth-Token aus dem
 * "Mit eBay verbinden"-Flow für sie nie greifen (Incident 2026-06-30:
 * statischer Token starb → kompletter Listing-Sync tot trotz OAuth-Pfad).
 * Replacer als Funktion, damit $-Muster im Token nicht als
 * Replacement-Pattern interpretiert werden.
 */
function replaceRequesterToken(fullXml, token) {
  const t = safeString(token);
  if (!t) return fullXml;
  return String(fullXml).replace(
    /(<eBayAuthToken>)[\s\S]*?(<\/eBayAuthToken>)/,
    (match, open, close) => `${open}${escapeXml(t)}${close}`
  );
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

// Detects the EPS/Catalog image-conflict error: eBay refuses to combine catalog
// stock photos ("self-hosted" image URLs) with listings that also supply custom
// pictureUrls, or vice versa. Manifests in German as "EPS ... kombiniert ..."
// and in English as "cannot combine stock picture with self-hosted" etc.
function isImageConflictError(errors) {
  if (!Array.isArray(errors) || !errors.length) return false;
  const msgs = errors
    .flatMap((e) => [String(e?.longMessage || ''), String(e?.shortMessage || '')])
    .filter(Boolean);
  return msgs.some((m) => {
    const l = m.toLowerCase();
    return (l.includes('eps') && l.includes('kombiniert')) ||
           (l.includes('stock') && l.includes('picture') && l.includes('self')) ||
           l.includes('cannot combine');
  });
}

// Detects the aspect-cap error: eBay limits item specifics to 45 per listing.
// German: "... auf 45 oder weniger reduzieren / Artikelmerkmale ..."
// English: "too many item specifics" / "aspect ... exceed(s)"
function isAspectsCapExceededError(errors) {
  if (!Array.isArray(errors) || !errors.length) return false;
  const msgs = errors
    .flatMap((e) => [String(e?.longMessage || ''), String(e?.shortMessage || '')])
    .filter(Boolean);
  return msgs.some((m) => {
    const l = m.toLowerCase();
    return (l.includes('artikelmerkmal') && (l.includes('45') || l.includes('reduzieren'))) ||
           (l.includes('too many') && l.includes('item specific')) ||
           (l.includes('aspect') && l.includes('exceed'));
  });
}

// Detects eBay error 240 — the policy / restricted-terms rejection.
// English: "The item cannot be listed or modified. The title and/or
// description may contain improper words, or the listing or seller may be in
// violation of eBay policy." German: "Der Artikel kann weder eingestellt noch
// bearbeitet werden. Die Artikelbezeichnung und/oder -beschreibung enthalten
// unter Umständen unzulässige Begriffe ... eBay-Grundsätze".
// This is policy-driven (keyword/category/account), NOT a payload data bug —
// it cannot be auto-fixed; we classify it so the operator gets actionable text.
function isRestrictedTermsError(errors) {
  if (!Array.isArray(errors) || !errors.length) return false;
  return errors.some((e) => {
    const code = String(e?.errorCode || e?.code || '');
    if (code === '240') return true;
    const l = `${e?.longMessage || ''} ${e?.shortMessage || ''}`.toLowerCase();
    return (
      (l.includes('weder eingestellt noch bearbeitet') &&
        (l.includes('unzulässige begriffe') || l.includes('grundsätze'))) ||
      (l.includes('cannot be listed or modified') &&
        (l.includes('improper words') || l.includes('violation of ebay policy')))
    );
  });
}

// Returns an actionable German operator message for a restricted-terms (240)
// rejection, or null if it doesn't apply. Surfaced in the Marktplätze tab in
// place of eBay's vague boilerplate so the operator knows what to do.
function describeRestrictedTermsError(errors) {
  if (!isRestrictedTermsError(errors)) return null;
  return (
    'eBay hat dieses Angebot wegen seiner Grundsätze abgelehnt (Fehler 240). ' +
    'Das ist KEIN Datenfehler, sondern eine Inhalts-/Richtlinienprüfung. ' +
    'Bitte prüfen: Titel und Beschreibung auf unzulässige Begriffe ' +
    '(z. B. Gesundheits-/Heilversprechen bei Futtermitteln, Kontaktdaten, ' +
    'Marken-/Trademark-Missbrauch), und ob die Kategorie auf eBay.de ' +
    'eingeschränkt ist oder das Verkäuferkonto eine Freischaltung benötigt. ' +
    'Manuelle Überarbeitung erforderlich.'
  );
}

// Identifiers that must NEVER be stripped from ItemSpecifics, even if eBay's PBSE
// error lists them as "product aspects sent as custom item specifics". Stripping
// them creates an EAN-fehlt loop: eBay says "remove EAN as custom specific" → we
// strip → eBay then says "EAN required" because the listing category needs the
// identifier. The safe response is to keep the identifier as an Item Specific
// AND let it stay in <ProductListingDetails>, then either (a) catalog matches
// and merges silently, or (b) catalog-mode is identify-only and the seller's
// EAN stands alone. Either way, "EAN fehlt" is never produced from this strip.
const PROTECTED_IDENTIFIER_TOKENS = new Set([
  'ean',
  'gtin',
  'upc',
  'isbn',
  'mpn',
  'herstellernummer',
  'brand',
  'marke',
  'hersteller',
]);

function stripItemSpecificsByAspectNames(itemSpecifics, aspectNames = []) {
  const specifics = itemSpecifics && typeof itemSpecifics === 'object' ? itemSpecifics : {};
  const tokens = new Set(asArray(aspectNames).map((n) => normalizeAspectToken(n)).filter(Boolean));
  if (!tokens.size) {
    return { itemSpecifics: specifics, removed: [], protected: [] };
  }
  const removed = [];
  const protectedKeys = [];
  const out = {};
  Object.entries(specifics).forEach(([k, v]) => {
    const key = safeString(k);
    if (!key) return;
    const token = normalizeAspectToken(key);
    if (token && tokens.has(token)) {
      // Never strip product identifiers — see PROTECTED_IDENTIFIER_TOKENS comment.
      if (PROTECTED_IDENTIFIER_TOKENS.has(token)) {
        protectedKeys.push(key);
        out[key] = v;
        return;
      }
      removed.push(key);
      return;
    }
    out[key] = v;
  });
  return { itemSpecifics: out, removed, protected: protectedKeys };
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
    // WP2 / F0.X — Best-Offer thresholds. `minimumBestOfferPrice` is the
    // auto-DECLINE threshold: a revise with BIN ≤ this jams the listing.
    bestOfferEnabled: String(item?.BestOfferDetails?.BestOfferEnabled ?? '').toLowerCase() === 'true',
    minimumBestOfferPrice: toNumber(
      item?.ListingDetails?.MinimumBestOfferPrice?.['#text']
      ?? item?.ListingDetails?.MinimumBestOfferPrice
      ?? item?.BestOfferDetails?.MinimumBestOfferPrice?.['#text']
      ?? item?.BestOfferDetails?.MinimumBestOfferPrice
    ),
    bestOfferAutoAcceptPrice: toNumber(
      item?.BestOfferDetails?.BestOfferAutoAcceptPrice?.['#text']
      ?? item?.BestOfferDetails?.BestOfferAutoAcceptPrice
      ?? item?.ListingDetails?.BestOfferAutoAcceptPrice?.['#text']
      ?? item?.ListingDetails?.BestOfferAutoAcceptPrice
    ),
  };
}

const RATE_LIMIT_MAX_RETRIES = parseInt(process.env.EBAY_RATE_LIMIT_MAX_RETRIES || '3', 10);

// ── Daily-quota circuit breaker (incident 2026-06-12) ────────────────────────
// When eBay returns "exceeded usage limit" (the daily Trading-API call cap),
// every further call (a) keeps the quota pinned at zero and (b) starves the
// calls that matter — GetOrders (order intake) and CompleteSale (tracking) —
// which is exactly how ~5 zero-stock products looping EndFixedPriceItem (~78
// calls/min) made "nothing sync". While the breaker is open we fail fast WITHOUT
// hitting eBay so the quota can recover; the cooldown auto-expires so the next
// call probes, and any success closes the breaker.
const EBAY_QUOTA_COOLDOWN_MS = parseInt(process.env.EBAY_QUOTA_COOLDOWN_MS || '300000', 10); // 5 min
let _quotaExhaustedUntil = 0;
function ebayQuotaCooldownActive() { return Date.now() < _quotaExhaustedUntil; }
function ebayQuotaCooldownRemainingMs() { return Math.max(0, _quotaExhaustedUntil - Date.now()); }

// WP1 Task 6: optional cross-instance delegation. The local breaker only protects
// ONE Cloud-Run instance; with the flag on we also broadcast the open/close to the
// Firestore-shared breaker (lib/ebay-quota-breaker.js) so all instances back off
// together. The fast synchronous in-call guard below stays as the hot path; the
// shared consult is an additional, 10s-cached read. Default OFF → unchanged.
function sharedQuotaBreakerEnabled() {
  return String(process.env.EBAY_QUOTA_BREAKER_SHARED || '').toLowerCase() === 'true';
}
function _sharedBreaker() { return require('./ebay-quota-breaker'); }

function openEbayQuotaBreaker() {
  _quotaExhaustedUntil = Date.now() + EBAY_QUOTA_COOLDOWN_MS;
  if (sharedQuotaBreakerEnabled()) {
    try { _sharedBreaker().openEbayQuotaBreaker({ cooldownMs: EBAY_QUOTA_COOLDOWN_MS, reason: 'exceeded usage limit' }).catch(() => {}); } catch (_) { /* fire-and-forget */ }
  }
}
function closeEbayQuotaBreaker() {
  _quotaExhaustedUntil = 0;
  if (sharedQuotaBreakerEnabled()) {
    try { _sharedBreaker().closeEbayQuotaBreaker({}).catch(() => {}); } catch (_) { /* fire-and-forget */ }
  }
}

// Cross-instance defer: if another instance opened the shared breaker, back off
// here too. Fail-safe: a breaker READ error never blocks a call. Mirrors the
// remaining cooldown into the local breaker so subsequent calls fail fast sync.
async function _consultSharedQuotaBreaker(callName) {
  if (!sharedQuotaBreakerEnabled()) return;
  try {
    const state = await _sharedBreaker().getEbayQuotaBreakerState({});
    if (state && state.open) {
      _quotaExhaustedUntil = Math.max(_quotaExhaustedUntil, Date.now() + (state.remainingMs || 0));
      const err = new Error(`eBay Trading skipped for ${callName}: exceeded usage limit (shared quota cooldown ${Math.ceil((state.remainingMs || 0) / 1000)}s)`);
      err.code = 'EBAY_QUOTA_COOLDOWN';
      err.quotaCooldown = true;
      throw err;
    }
  } catch (err) {
    if (err && err.quotaCooldown) throw err;
    // read failure → fail-safe, do not block calls on breaker unavailability
  }
}

function isRateLimitError(text, errors) {
  if (typeof text === 'string' && text.includes('exceeded usage limit')) return true;
  if (Array.isArray(errors)) {
    return errors.some((e) => String(e?.errorCode || e?.code || '') === '21917062');
  }
  return false;
}

async function callTradingApi(callName, bodyXml, { timeoutMs = DEFAULT_TIMEOUT_MS, siteId = null } = {}) {
  const { acquireSlot } = require('./ebay-rate-limiter');

  // Circuit breaker: while the daily quota is exhausted, fail fast WITHOUT
  // hitting eBay so it can recover instead of staying pinned by a retry storm.
  // Message keeps the "exceeded usage limit" marker so callers' rate-limit
  // detection (stock-sync / marketplace-tracking) still defers correctly.
  if (ebayQuotaCooldownActive()) {
    const err = new Error(`eBay Trading skipped for ${callName}: exceeded usage limit (quota cooldown ${Math.ceil(ebayQuotaCooldownRemainingMs() / 1000)}s)`);
    err.code = 'EBAY_QUOTA_COOLDOWN';
    err.quotaCooldown = true;
    throw err;
  }

  // Cross-instance breaker (flag-gated, cached). Throws EBAY_QUOTA_COOLDOWN when
  // another instance has the shared quota breaker open.
  await _consultSharedQuotaBreaker(callName);

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
  // pass <?xml ... so we detect and skip double-wrapping. In dem Fall wird der
  // eingebaute (statische) Token durch den effektiven Token ersetzt, damit der
  // OAuth-Token aus dem Verbinden-Flow auch für Prebuilt-Caller gilt.
  const fullXml = bodyXml.trimStart().startsWith('<?xml')
    ? replaceRequesterToken(bodyXml, effectiveToken)
    : buildRequestRoot(callName, bodyXml, effectiveToken, cfg.compatibilityLevel);

  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    // Wait for rate-limit slot before each attempt
    await acquireSlot();

    const res = await fetchWithTimeout(
      cfg.endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'X-EBAY-API-CALL-NAME': callName,
          // Site-Override (2026-07-22): Relist/Revise sind site-gebunden —
          // ein at/it/es/be/fr-Listing braucht SEINE Site-ID im Header, sonst
          // "kann nicht bearbeitet oder wiedereingestellt werden, da es
          // ursprünglich nicht auf dieser eBay-Website eingestellt wurde".
          'X-EBAY-API-SITEID': safeString(siteId) || cfg.siteId,
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

    // Retry on HTTP-level rate limit (429 or similar)
    if (!res.ok) {
      if (text.includes('exceeded usage limit')) {
        // Daily quota exhausted — open the breaker and stop hammering (retrying
        // in 8s is futile and just keeps the quota at zero).
        openEbayQuotaBreaker();
        const error = new Error(`eBay Trading exceeded usage limit for ${callName} (HTTP ${res.status}) — quota breaker opened`);
        error.code = 'EBAY_TRADING_RATE_LIMIT';
        error.quotaExhausted = true;
        throw error;
      }
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

    // API-level rate limit (daily quota) — open the breaker, stop hammering.
    if (!isAckSuccess(ack) && isRateLimitError(text, errors)) {
      openEbayQuotaBreaker();
      const error = new Error(`eBay Trading exceeded usage limit for ${callName} — quota breaker opened (cooldown ${Math.ceil(EBAY_QUOTA_COOLDOWN_MS / 1000)}s)`);
      error.code = 'EBAY_TRADING_RATE_LIMIT';
      error.quotaExhausted = true;
      throw error;
    }

    if (!isAckSuccess(ack)) {
      const message = errors[0]?.longMessage || errors[0]?.shortMessage || `${callName} failed with Ack=${ack}`;
      const error = new Error(message);
      error.code = 'EBAY_TRADING_CALL_FAILED';
      error.details = { ack, errors };
      throw error;
    }

    // Success — the quota is flowing again; make sure the breaker is closed.
    closeEbayQuotaBreaker();
    return {
      ack,
      errors,
      response: responseNode,
      rawXml: text,
    };
  }

  // Should not reach here, but safety net
  throw new Error(`[callTradingApi] ${callName} failed after ${RATE_LIMIT_MAX_RETRIES} rate-limit retries`);
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
    itemFields.push(`<Description>${asCdata(forceHttpsInHtml(patch.description))}</Description>`);
  }
  const specificsXml = buildNameValueListXml(patch?.itemSpecifics || {});
  if (specificsXml) {
    itemFields.push(specificsXml);
  }
  const pictureUrls = asArray(patch?.pictureUrls || patch?.pictureDetails)
    .map((u) => forceHttpsUrl(u))
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

  // Condition update
  const conditionId = safeString(patch?.conditionId);
  if (conditionId) {
    itemFields.push(`<ConditionID>${escapeXml(conditionId)}</ConditionID>`);
  }

  // Product identifiers (EAN/ISBN/MPN)
  const ean = safeString(patch?.ean);
  const isbn = safeString(patch?.isbn);
  const mpn = safeString(patch?.mpn);
  const brand = safeString(patch?.brand);
  if (ean || isbn || mpn) {
    const pld = [];
    pld.push(`<EAN>${escapeXml(ean || 'Does not apply')}</EAN>`);
    if (isbn) pld.push(`<ISBN>${escapeXml(isbn)}</ISBN>`);
    if (mpn) pld.push(`<BrandMPN><Brand>${escapeXml(brand || 'Unbranded')}</Brand><MPN>${escapeXml(mpn)}</MPN></BrandMPN>`);
    // SPIEGEL des Publish-Pfads (Incident 2026-07-21, SKU-4561422647): bei
    // K-Typ-Listings (itemCompatibilityList) bzw. explizitem identify-only-
    // Modus DARF der Revise die Katalog-Adoption nicht re-bekräftigen — auf
    // katalog-adoptierten Listings ignoriert eBay die Verkäufer-Kompatibilitäts-
    // liste und wirft sie mit Ack=Warning weg. Vorher stand hier hart
    // IncludeeBayProductDetails=true, wodurch jeder Revise die K-Typen
    // verlor, obwohl compat=60 im Request stand.
    const identifyOnly =
      patch?.catalogMode === 'identify-only' ||
      (Array.isArray(patch?.itemCompatibilityList) && patch.itemCompatibilityList.length > 0);
    if (identifyOnly) {
      pld.push('<IncludeeBayProductDetails>false</IncludeeBayProductDetails>');
      pld.push('<IncludeStockPhotoURL>false</IncludeStockPhotoURL>');
      pld.push('<UseStockPhotoURLAsGallery>false</UseStockPhotoURLAsGallery>');
    } else {
      pld.push('<IncludeeBayProductDetails>true</IncludeeBayProductDetails>');
    }
    itemFields.push(`<ProductListingDetails>${pld.join('')}</ProductListingDetails>`);
  }

  // Weight — ShippingPackageDetails (kg split into major/minor)
  const weightKg = parseFloat(patch?.weightKg);
  if (Number.isFinite(weightKg) && weightKg > 0) {
    const major = Math.floor(weightKg);
    const minor = Math.round((weightKg - major) * 1000);
    itemFields.push(
      `<ShippingPackageDetails>` +
      `<WeightMajor unit="kg">${major}</WeightMajor>` +
      `<WeightMinor unit="g">${minor}</WeightMinor>` +
      `</ShippingPackageDetails>`
    );
  }

  // K-Typ fitment compatibility list
  const compatibilityXml = buildCompatibilityListXml(patch?.itemCompatibilityList);
  if (compatibilityXml) {
    itemFields.push(compatibilityXml);
  }

  // VAT Details (MwSt)
  if (patch?.vatPercent != null) {
    itemFields.push(
      `<VATDetails>` +
      `<VATPercent>${escapeXml(String(patch.vatPercent))}</VATPercent>` +
      `</VATDetails>`
    );
  }

  // Regulatory: GPSR Manufacturer + Responsible Person
  const regulatory = buildRegulatoryXml(patch);
  if (regulatory) itemFields.push(regulatory);

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
// RelistFixedPriceItem — belebt ein beendetes Festpreis-Angebot wieder
// ---------------------------------------------------------------------------

/**
 * Relist a previously ENDED fixed-price listing. eBay erzeugt dabei eine NEUE
 * ItemID; alle Angebotsdaten (Titel, Bilder, Aspects, Policies) werden vom
 * beendeten Listing übernommen. Nur innerhalb von 90 Tagen nach Ende möglich
 * und pro beendetem Listing nur einmal — Fehler dafür kommen als Ack=Failure.
 *
 * Selbstheilungs-Pfad für den Zero-Stock-End (Incident 2026-07-19): kommt
 * Bestand zurück, wird das vom Stock-Sync beendete Angebot hierüber
 * wiederbelebt statt für immer still übersprungen.
 *
 * @param {string} itemId - ItemID des BEENDETEN Listings
 * @param {Object} [options]
 * @param {number} [options.quantity] - neue Menge (überschreibt die alte)
 * @returns {{ ack, warnings, itemId: string, startTime, endTime }} itemId = NEUE ItemID
 */
async function relistFixedPriceItem(itemId, { quantity = null, timeoutMs = DEFAULT_TIMEOUT_MS, siteId = null } = {}) {
  const id = safeString(itemId);
  if (!id) {
    const error = new Error('itemId is required for RelistFixedPriceItem call');
    error.code = 'EBAY_RELIST_ITEM_ID_REQUIRED';
    throw error;
  }
  const cfg = await getEbayTradingConfig();
  const qty = Number(quantity);
  const fields = [`<ItemID>${escapeXml(id)}</ItemID>`];
  if (Number.isFinite(qty) && qty > 0) {
    fields.push(`<Quantity>${Math.floor(qty)}</Quantity>`);
  }
  const requestXml = buildRequestRoot(
    'RelistFixedPriceItem',
    `<Item>${fields.join('')}</Item>`,
    cfg.userToken,
    cfg.compatibilityLevel
  );
  // siteId: Relist MUSS auf der Original-Site des Listings laufen (at=16,
  // it=101, es=186, benl.be=123, fr=71, ie=205, de=77) — sonst lehnt eBay ab.
  const result = await callTradingApi('RelistFixedPriceItem', requestXml, { timeoutMs, siteId });
  const response = result?.response || {};
  return {
    ack: result.ack,
    warnings: result.errors,
    itemId: safeString(response?.ItemID || ''),
    startTime: toIso(response?.StartTime) || null,
    endTime: toIso(response?.EndTime) || null,
  };
}

// ---------------------------------------------------------------------------
// Regulatory XML (GPSR — EU General Product Safety Regulation)
// ---------------------------------------------------------------------------

// Minimal country-name → ISO-3166-1 alpha-2 map for eBay Trading API.
// Kept inline (no registry import) so this file stays self-contained and
// safe to use from code paths that must not touch Firestore at module load.
const MANUFACTURER_COUNTRY_CODE_MAP = {
  deutschland: 'DE', germany: 'DE',
  österreich: 'AT', osterreich: 'AT', austria: 'AT',
  schweiz: 'CH', switzerland: 'CH',
  frankreich: 'FR', france: 'FR',
  italien: 'IT', italy: 'IT',
  spanien: 'ES', spain: 'ES',
  niederlande: 'NL', netherlands: 'NL',
  belgien: 'BE', belgium: 'BE',
  polen: 'PL', poland: 'PL',
  tschechien: 'CZ', czechia: 'CZ', 'czech republic': 'CZ',
  ungarn: 'HU', hungary: 'HU',
  dänemark: 'DK', danemark: 'DK', denmark: 'DK',
  schweden: 'SE', sweden: 'SE',
  norwegen: 'NO', norway: 'NO',
  finnland: 'FI', finland: 'FI',
  portugal: 'PT',
  irland: 'IE', ireland: 'IE',
  griechenland: 'GR', greece: 'GR',
  rumänien: 'RO', romania: 'RO',
  bulgarien: 'BG', bulgaria: 'BG',
  slowakei: 'SK', slovakia: 'SK',
  slowenien: 'SI', slovenia: 'SI',
  kroatien: 'HR', croatia: 'HR',
  luxemburg: 'LU', luxembourg: 'LU',
  estland: 'EE', estonia: 'EE',
  lettland: 'LV', latvia: 'LV',
  litauen: 'LT', lithuania: 'LT',
  malta: 'MT',
  zypern: 'CY', cyprus: 'CY',
  türkei: 'TR', turkei: 'TR', turkey: 'TR',
  'vereinigtes königreich': 'GB', 'united kingdom': 'GB',
  'great britain': 'GB', 'großbritannien': 'GB', grossbritannien: 'GB',
  england: 'GB',
  usa: 'US', 'united states': 'US', 'vereinigte staaten': 'US',
  china: 'CN', japan: 'JP', kanada: 'CA', canada: 'CA',
};

// Non-ISO 2-letter aliases that eBay's CountryCodeType (ISO 3166-1 alpha-2)
// rejects. The GPSR registry stores "UK" by marketplace convention
// (gpsr-manufacturer-registry.js), but eBay only accepts "GB"; "EL" is the
// EU statistical alias for Greece, whose ISO code is "GR". Without this remap
// eBay rejects the listing with "Eingabedaten für Tag
// <Item.Regulatory.Manufacturer.Country> sind ungültig oder fehlen".
const NON_ISO_COUNTRY_ALIASES = { UK: 'GB', EL: 'GR' };

function normalizeManufacturerCountryCode(raw) {
  const v = safeString(raw);
  if (!v) return '';
  if (/^[A-Z]{2}$/i.test(v)) {
    const up = v.toUpperCase();
    return NON_ISO_COUNTRY_ALIASES[up] || up;
  }
  return MANUFACTURER_COUNTRY_CODE_MAP[v.toLowerCase()] || '';
}

// eBay rejects listings containing non-HTTPS resources (error 21919490:
// "Security policy violation. Description contains HTTP resources").
// This applies to <PictureURL> values AND any http:// resource embedded in
// the description HTML. Upgrade the scheme to https:// (eBay's own
// recommended remediation) rather than dropping images.
function forceHttpsUrl(raw) {
  const v = safeString(raw);
  if (!v) return '';
  return v.replace(/^http:\/\//i, 'https://');
}

function forceHttpsInHtml(raw) {
  return safeString(raw).replace(/http:\/\//gi, 'https://');
}

/**
 * Build the <Manufacturer> sub-block.
 *
 * Returns '' when the data is insufficient. eBay rejects a <Manufacturer>
 * block that contains only CompanyName with:
 *   "Der Verkäufer muss mindestens eine Methode zur Kontaktaufnahme mit dem
 *    Hersteller angeben: entweder eine Adresse, eine E-Mail-Adresse, eine
 *    Kontakt-URL oder eine Telefonnummer."
 * GPSR itself is not required per-listing, so emitting no block at all is
 * preferable to emitting an incomplete one.
 */
function buildManufacturerXml(gpsr) {
  if (!gpsr) return '';
  const companyName = safeString(gpsr.manufacturer_name);
  if (!companyName) return '';

  const street = safeString(gpsr.manufacturer_address);
  const city = safeString(gpsr.manufacturer_city);
  const state = safeString(gpsr.manufacturer_state_province);
  const zip = safeString(gpsr.manufacturer_postalcode);
  const countryCode = normalizeManufacturerCountryCode(gpsr.country_code || gpsr.entity_country);
  const phone = safeString(gpsr.manufacturer_phone);
  const email = safeString(gpsr.email);

  const hasFullAddress = Boolean(street && city && zip && countryCode);
  const hasContactMethod = hasFullAddress || Boolean(phone) || Boolean(email);
  if (!hasContactMethod) return '';

  const fields = [`<CompanyName>${escapeXml(companyName)}</CompanyName>`];
  if (hasFullAddress) {
    fields.push(`<Street1>${escapeXml(street)}</Street1>`);
    fields.push(`<CityName>${escapeXml(city)}</CityName>`);
    if (state) fields.push(`<StateOrProvince>${escapeXml(state)}</StateOrProvince>`);
    fields.push(`<PostalCode>${escapeXml(zip)}</PostalCode>`);
    fields.push(`<Country>${escapeXml(countryCode)}</Country>`);
  }
  if (phone) fields.push(`<Phone>${escapeXml(phone)}</Phone>`);
  if (email) fields.push(`<Email>${escapeXml(email)}</Email>`);

  return `<Manufacturer>${fields.join('')}</Manufacturer>`;
}

/**
 * Build <Regulatory> XML block for eBay Trading API.
 * Includes Manufacturer info and Responsible Person (EU GPSR, mandatory since July 2024).
 *
 * eBay XML structure:
 * <Regulatory>
 *   <Manufacturer>
 *     <CompanyName>...</CompanyName>
 *     <Street1>...</Street1>
 *     <CityName>...</CityName>
 *     <StateOrProvince>...</StateOrProvince>
 *     <PostalCode>...</PostalCode>
 *     <Country>DE</Country>
 *     <Phone>...</Phone>
 *     <Email>...</Email>
 *   </Manufacturer>
 *   <ResponsiblePersons>
 *     <ResponsiblePerson>
 *       <CompanyName>...</CompanyName>
 *       <Street1>...</Street1>
 *       <CityName>...</CityName>
 *       <PostalCode>...</PostalCode>
 *       <Country>DE</Country>
 *       <Phone>...</Phone>
 *       <Email>...</Email>
 *       <Types>
 *         <Type>EUResponsiblePerson</Type>
 *       </Types>
 *     </ResponsiblePerson>
 *   </ResponsiblePersons>
 * </Regulatory>
 */
function buildRegulatoryXml(item) {
  const gpsr = item?.gpsr;
  const responsiblePerson = item?.responsiblePerson;
  if (!gpsr && !responsiblePerson) return '';

  const parts = [];

  const manufacturerXml = buildManufacturerXml(gpsr);
  if (manufacturerXml) parts.push(manufacturerXml);

  // Responsible Person block (EU GPSR — the EU-based contact person)
  if (responsiblePerson) {
    const rp = [];
    const rpName = safeString(responsiblePerson.companyName);
    if (rpName) rp.push(`<CompanyName>${escapeXml(rpName)}</CompanyName>`);
    const rpStreet = safeString(responsiblePerson.street);
    if (rpStreet) rp.push(`<Street1>${escapeXml(rpStreet)}</Street1>`);
    const rpCity = safeString(responsiblePerson.city);
    if (rpCity) rp.push(`<CityName>${escapeXml(rpCity)}</CityName>`);
    const rpZip = safeString(responsiblePerson.postalCode);
    if (rpZip) rp.push(`<PostalCode>${escapeXml(rpZip)}</PostalCode>`);
    const rpCountry = normalizeManufacturerCountryCode(responsiblePerson.countryCode) || 'DE';
    rp.push(`<Country>${escapeXml(rpCountry)}</Country>`);
    const rpPhone = safeString(responsiblePerson.phone);
    if (rpPhone) rp.push(`<Phone>${escapeXml(rpPhone)}</Phone>`);
    const rpEmail = safeString(responsiblePerson.email);
    if (rpEmail) rp.push(`<Email>${escapeXml(rpEmail)}</Email>`);
    rp.push(`<Types><Type>EUResponsiblePerson</Type></Types>`);

    if (rp.length > 1) { // at least countryCode + Types
      parts.push(`<ResponsiblePersons><ResponsiblePerson>${rp.join('')}</ResponsiblePerson></ResponsiblePersons>`);
    }
  }

  if (parts.length === 0) return '';
  return `<Regulatory>${parts.join('')}</Regulatory>`;
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
    fields.push(`<Description>${asCdata(forceHttpsInHtml(item.description))}</Description>`);
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

  const pictureUrls = asArray(item?.pictureUrls || item?.pictureDetails).map((u) => forceHttpsUrl(u)).filter(Boolean);
  if (pictureUrls.length) {
    fields.push(`<PictureDetails>${pictureUrls.map((u) => `<PictureURL>${escapeXml(u)}</PictureURL>`).join('')}</PictureDetails>`);
  }

  const ean = safeString(item?.ean);
  const isbn = safeString(item?.isbn);
  const mpn = safeString(item?.mpn);
  const brand = safeString(item?.brand);

  // ProductListingDetails — three modes:
  //
  //   1. 'merge'         (default): IncludeeBayProductDetails=true → eBay matches
  //                                  the GTIN against its catalog and merges title,
  //                                  description, item specifics and stock photo.
  //   2. 'identify-only':            IncludeeBayProductDetails=false → eBay records
  //                                  the EAN/UPC/ISBN as the product identifier but
  //                                  does NOT adopt the catalog product (no merge of
  //                                  catalog photos / item specifics / fitment data).
  //                                  This satisfies German categories that require
  //                                  an EAN ("Das Feld EAN fehlt …") while avoiding
  //                                  catalog conflicts (image conflict, K-Typ vs.
  //                                  catalog-fitment conflict for auto parts).
  //   3. 'omit'          (legacy):   skip <ProductListingDetails> entirely. ONLY
  //                                  use as a last resort — the EAN is then silently
  //                                  dropped and category EAN-required listings fail.
  //
  // Backward compat: `item.skipProductListingDetails === true` resolves to 'omit' so
  // older callers that explicitly opted out keep their behaviour. New callers should
  // prefer `item.catalogMode = 'identify-only'`.
  //
  // Reference: eBay Trading API ProductListingDetailsType / IncludeeBayProductDetails
  // (https://developer.ebay.com/devzone/xml/docs/reference/ebay/types/ProductListingDetailsType.html)
  const catalogMode =
    item?.catalogMode === 'identify-only' || item?.catalogMode === 'omit' || item?.catalogMode === 'merge'
      ? item.catalogMode
      : item?.skipProductListingDetails === true
        ? 'omit'
        : 'merge';

  if (catalogMode !== 'omit') {
    const pld = [];
    pld.push(`<EAN>${escapeXml(ean || 'Does not apply')}</EAN>`);
    if (isbn) pld.push(`<ISBN>${escapeXml(isbn)}</ISBN>`);
    if (mpn) pld.push(`<BrandMPN><Brand>${escapeXml(brand || 'Unbranded')}</Brand><MPN>${escapeXml(mpn)}</MPN></BrandMPN>`);
    if (catalogMode === 'identify-only') {
      // Send the identifier but do NOT adopt the catalog product. This is the eBay-
      // approved escape hatch for image conflicts (no catalog stock photos merged
      // into seller's PictureDetails) and for K-Typ vs. catalog-fitment conflicts
      // (no catalog product whose own ItemCompatibilityList could clash with the
      // seller's). The seller's title, description, specifics and pictures are used
      // as-is; the EAN is just informational metadata for buyers/search.
      pld.push('<IncludeeBayProductDetails>false</IncludeeBayProductDetails>');
      pld.push('<IncludeStockPhotoURL>false</IncludeStockPhotoURL>');
      pld.push('<UseStockPhotoURLAsGallery>false</UseStockPhotoURLAsGallery>');
    } else if (ean || isbn || mpn) {
      pld.push('<IncludeeBayProductDetails>true</IncludeeBayProductDetails>');
    }
    fields.push(`<ProductListingDetails>${pld.join('')}</ProductListingDetails>`);
  }

  // Weight — ShippingPackageDetails (kg split into major/minor)
  const publishWeightKg = parseFloat(item?.weightKg);
  if (Number.isFinite(publishWeightKg) && publishWeightKg > 0) {
    const major = Math.floor(publishWeightKg);
    const minor = Math.round((publishWeightKg - major) * 1000);
    fields.push(
      `<ShippingPackageDetails>` +
      `<WeightMajor unit="kg">${major}</WeightMajor>` +
      `<WeightMinor unit="g">${minor}</WeightMinor>` +
      `</ShippingPackageDetails>`
    );
  }

  const specificsXml = buildNameValueListXml(item?.itemSpecifics || {});
  if (specificsXml) fields.push(specificsXml);

  const compatibilityXml = buildCompatibilityListXml(item?.itemCompatibilityList);
  if (compatibilityXml) fields.push(compatibilityXml);

  // --- VAT Details (MwSt) ---
  const vatPercent = item?.vatPercent ?? 19.0;
  fields.push(
    `<VATDetails>` +
    `<VATPercent>${escapeXml(String(vatPercent))}</VATPercent>` +
    `</VATDetails>`
  );

  // --- Regulatory: GPSR Manufacturer + Responsible Person (EU Pflicht seit Juli 2024) ---
  const regulatory = buildRegulatoryXml(item);
  if (regulatory) fields.push(regulatory);

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

async function getSellerProfiles({ timeoutMs = DEFAULT_TIMEOUT_MS, forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && sellerProfilesCache.value && now - sellerProfilesCache.atMs < SELLER_PROFILES_CACHE_TTL_MS) {
    return sellerProfilesCache.value;
  }
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

  const profiles = {
    ack: result.ack,
    warnings: result.errors,
    shippingProfiles,
    returnProfiles,
    paymentProfiles,
  };
  sellerProfilesCache = { atMs: Date.now(), value: profiles };
  return profiles;
}

async function getCategoryInfo(categoryId, { timeoutMs = DEFAULT_TIMEOUT_MS, forceRefresh = false } = {}) {
  const id = safeString(categoryId);
  if (!id) throw Object.assign(new Error('categoryId is required'), { code: 'EBAY_CATEGORY_ID_REQUIRED' });
  const now = Date.now();
  const cached = categoryInfoCache.get(id);
  if (!forceRefresh && cached && now - cached.atMs < CATEGORY_INFO_CACHE_TTL_MS) {
    return cached.value;
  }
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
  const info = {
    categoryId: id,
    name: safeString(cat?.CategoryName) || null,
    level: toNumber(cat?.CategoryLevel),
    parentId: safeString(cat?.CategoryParentID) || null,
    isLeaf,
  };
  categoryInfoCache.set(id, { atMs: Date.now(), value: info });
  return info;
}

async function getCategorySpecifics(categoryId, { timeoutMs = DEFAULT_TIMEOUT_MS, forceRefresh = false } = {}) {
  const id = safeString(categoryId);
  if (!id) throw Object.assign(new Error('categoryId is required'), { code: 'EBAY_CATEGORY_ID_REQUIRED' });
  const now = Date.now();
  const cached = categorySpecificsCache.get(id);
  if (!forceRefresh && cached && now - cached.atMs < CATEGORY_SPECIFICS_CACHE_TTL_MS) {
    return cached.value;
  }
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
  const result2 = { categoryId: id, specifics };
  categorySpecificsCache.set(id, { atMs: Date.now(), value: result2 });
  return result2;
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
  stripInvalidXmlChars,
  escapeXml,
  asCdata,
  buildRequestRoot,
  replaceRequesterToken,
  fetchTradingStatus,
  callTradingApi,
  getMyeBaySellingActive,
  getItemDetails,
  getSellerProfiles,
  getCategoryInfo,
  getCategorySpecifics,
  reviseFixedPriceItem,
  reviseItem,
  buildReviseItemRequestXml,
  endItem,
  endFixedPriceItem,
  relistFixedPriceItem,
  addFixedPriceItem,
  verifyAddFixedPriceItem,
  buildAddFixedPriceItemXml,
  stripItemSpecificsByAspectNames,
  mapItemSpecifics,
  mapListingDetail,
  normalizeSpecificsMap,
  isAckSuccess,
  buildRegulatoryXml,
  buildManufacturerXml,
  normalizeManufacturerCountryCode,
  extractMisusedAspectNames,
  isCategoryMismatchError,
  isProductAspectMisuseError,
  isImageConflictError,
  isAspectsCapExceededError,
  isRestrictedTermsError,
  describeRestrictedTermsError,
  forceHttpsUrl,
  forceHttpsInHtml,
  ebayQuotaCooldownActive,
  ebayQuotaCooldownRemainingMs,
  openEbayQuotaBreaker,
  closeEbayQuotaBreaker,
  _consultSharedQuotaBreaker,
};
