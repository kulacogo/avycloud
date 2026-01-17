const fetch = require('node-fetch');
const path = require('path');
const { getSecrets } = require('./secrets');
const {
  updateProductSyncStatus,
  getSkuIndexEntry,
  setSkuIndexEntry,
  findProductByStrictIdentifier,
  logInventorySyncEvent,
  firestore,
} = require('./firestore');
const { MarketplaceLookup } = require('./marketplace-lookup');
const { getGeminiClient } = require('../lib/gemini-client');

const MIN_IMAGE_EDGE_BASELINKER = parseInt(
  process.env.BASELINKER_IMAGE_MIN_EDGE || '600',
  10
);
// Optional: Bild-URLs übertragen (kein Base64). Default an, da nur URLs gesendet werden.
const BASELINKER_SEND_IMAGES =
  (process.env.BASELINKER_SEND_IMAGES ?? 'true').toString().toLowerCase() === 'true';
const TARGET_INVENTORY_ID = process.env.BASELINKER_INVENTORY_ID || '78659'; // statisch, wie gefordert
// Feste Zuordnung der CSVs (keine env-Overrides, um Vertauschungen zu vermeiden)
const EBAY_CATEGORY_CSV = path.join(
  __dirname,
  '../ebay/DE_New_Structure_(May2023).csv'
);
const KAUFLAND_CATEGORY_CSV = path.join(
  __dirname,
  '../kaufland/category_tree_all_languages.csv'
);

let marketplaceLookup = null;
function ensureMarketplaceLookup() {
  if (marketplaceLookup) return marketplaceLookup;
  marketplaceLookup = new MarketplaceLookup({
    ebayCsvPath: EBAY_CATEGORY_CSV,
    kauflandCsvPath: KAUFLAND_CATEGORY_CSV,
    ebayPathColumn: 'category_path',
    kauflandPathColumn: 'category_path',
  });
  return marketplaceLookup;
}

function safeString(value) {
  return typeof value === 'string'
    ? value.trim()
    : value == null
      ? ''
      : String(value).trim();
}

async function resolveCategoryWithGemini(product, invId) {
  try {
    const client = await getGeminiClient();
    const model = client.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const lookup = ensureMarketplaceLookup();
    const isEbay = String(invId) === '85403';
    const isKaufland = String(invId) === '85404';
    if (!isEbay && !isKaufland) return null;

    const attrs = product?.details?.attributes || {};
    const prompt = `
Du bist ein Kategorisierungs-Assistent. Finde einen passenden Kategorie-PFAD (deutsch)
für ${isEbay ? 'eBay (inventory 85403)' : 'Kaufland (inventory 85404)'}.
Liefere NUR ein JSON-Objekt: { "path": "..." }
- Nutze realistische, präzise Pfade (deutsch) entsprechend dem Marktplatz.
- Keine IDs ausdenken – nur Pfadtext.

Daten:
SKU: ${product?.details?.identifiers?.sku || product?.identification?.sku || product?.id}
Name: ${product?.identification?.name || ''}
Marke: ${product?.identification?.brand || ''}
Kategorie (frei): ${product?.identification?.category || ''}
Beschreibung: ${product?.details?.description || product?.details?.short_description || ''}
Attribute: ${Object.entries(attrs)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join(' | ')}
    `.trim();

    const resp = await model.generateContent(prompt);
    const text = resp?.response?.text() || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const json = JSON.parse(match[0]);
    const pathText = json.path || json.category || json.category_path;
    if (!pathText) return null;
    const id = isEbay ? lookup.lookupEbay(pathText) : lookup.lookupKaufland(pathText);
    if (id) return { id: String(id), path: pathText };
  } catch (e) {
    console.warn('Gemini category resolution failed:', e.message);
  }
  return null;
}

/**
 * BaseLinker API – request limiter
 *
 * Official docs (https://api.baselinker.com/index.php): 100 requests per minute.
 * Use conservative defaults because the limit is global per API token (Cloud Run may scale horizontally).
 */
const MAX_PARALLEL_REQUESTS = Math.max(
  1,
  parseInt(process.env.BASELINKER_MAX_PARALLEL_REQUESTS || '1', 10)
);
// Minimum spacing between requests in ms.
// Default 800ms ≈ 75 RPM per instance (safety margin vs 100 RPM global token limit).
const MIN_REQUEST_INTERVAL_MS = Math.max(
  0,
  parseInt(process.env.BASELINKER_MIN_REQUEST_INTERVAL_MS || '800', 10)
);

// --- Reserved stock (open orders) ---
// BaseLinker reduces "available" stock on sale (open orders).
// In avycloud, warehouse BIN stock represents physical stock and should only change on pick/stock-out.
// Therefore, when syncing stock TO BaseLinker we must send AVAILABLE = physical - reserved(open orders).
let RESERVED_OPEN_ORDERS_CACHE = { atMs: 0, map: new Map() };
const RESERVED_CACHE_TTL_MS = parseInt(process.env.RESERVED_STOCK_CACHE_TTL_MS || '30000', 10);

async function getReservedOpenOrderMap() {
  const now = Date.now();
  if (
    RESERVED_OPEN_ORDERS_CACHE?.map &&
    now - (RESERVED_OPEN_ORDERS_CACHE.atMs || 0) < RESERVED_CACHE_TTL_MS
  ) {
    return RESERVED_OPEN_ORDERS_CACHE.map;
  }

  const map = new Map(); // key: normalizeSkuValue -> reserved qty
  try {
    // Prefer indexed query, but fall back to scanning all orders if needed.
    const snap = await firestore.collection('orders').where('status', '==', 'new').get();
    snap.forEach((doc) => {
      const order = doc.data() || {};
      const items = Array.isArray(order.items) ? order.items : [];
      for (const item of items) {
        const key = normalizeSkuValue(item?.sku || item?.productId || '');
        const qty = Number(item?.quantity || 0);
        if (!key || qty <= 0) continue;
        map.set(key, (map.get(key) || 0) + qty);
      }
    });
  } catch (error) {
    console.warn('Reserved-open-orders query failed; falling back to full scan:', error.message);
    try {
      const snap = await firestore.collection('orders').get();
      snap.forEach((doc) => {
        const order = doc.data() || {};
        if (order.status !== 'new') return;
        const items = Array.isArray(order.items) ? order.items : [];
        for (const item of items) {
          const key = normalizeSkuValue(item?.sku || item?.productId || '');
          const qty = Number(item?.quantity || 0);
          if (!key || qty <= 0) continue;
          map.set(key, (map.get(key) || 0) + qty);
        }
      });
    } catch (scanError) {
      console.warn('Reserved-open-orders full scan failed:', scanError.message);
    }
  }

  RESERVED_OPEN_ORDERS_CACHE = { atMs: now, map };
  return map;
}

// Inventory category cache (path -> id)
const inventoryCategoryCache = new Map(); // key: inventoryId -> Map<path, id>

function normalizePathSegments(pathStr) {
  return (pathStr || '')
    .split('>')
    .map((p) => p.trim())
    .filter(Boolean);
}

async function ensureInventoryCategoriesLoaded(inventoryId) {
  const key = String(inventoryId);
  if (inventoryCategoryCache.has(key)) return;
  const cache = new Map();
  try {
    const resp = await callBaseLinker('getInventoryCategories', { inventory_id: Number(inventoryId) });
    const cats = resp?.categories || [];
    cats.forEach((c) => {
      if (c?.name && c?.category_id) {
        cache.set(c.name, c.category_id);
      }
    });
    inventoryCategoryCache.set(key, cache);
  } catch (e) {
    console.warn('Could not load inventory categories for', inventoryId, e.message);
    inventoryCategoryCache.set(key, cache);
  }
}

async function ensureInventoryCategory(inventoryId, pathStr) {
  if (!inventoryId || !pathStr) return 0;
  await ensureInventoryCategoriesLoaded(inventoryId);
  const key = String(inventoryId);
  const cache = inventoryCategoryCache.get(key) || new Map();
  const segments = normalizePathSegments(pathStr);
  let parentId = 0;
  let currentPath = '';

  for (const seg of segments) {
    currentPath = currentPath ? `${currentPath} > ${seg}` : seg;
    if (cache.has(currentPath)) {
      parentId = cache.get(currentPath);
      continue;
    }
    const resp = await callBaseLinker('addInventoryCategory', {
      inventory_id: Number(inventoryId),
      name: seg,
      parent_id: parentId,
    });
    if (resp?.status !== 'SUCCESS' || !resp?.category_id) {
      console.warn(`Failed to create inventory category "${currentPath}" for ${inventoryId}:`, resp);
      return parentId || 0;
    }
    parentId = resp.category_id;
    cache.set(currentPath, parentId);
  }
  inventoryCategoryCache.set(key, cache);
  return parentId || 0;
}

/**
 * Inventory text field keys cache (BaseLinker integration-scoped text fields)
 *
 * BaseLinker product text fields can be overridden per language and per integration account:
 *   field|lang|integration_account (e.g. "description|de|amazon_123")
 *
 * The official API exposes discoverability via:
 * - getInventoryIntegrations (lists integrations + accounts + languages)
 * - getInventoryAvailableTextFieldKeys (returns "text_field_keys" map of key -> label)
 */
const inventoryTextFieldKeysCache = new Map(); // key: inventoryId -> { atMs, keys: string[] }
const TEXT_FIELD_KEYS_CACHE_TTL_MS = parseInt(
  process.env.BASELINKER_TEXT_FIELD_KEYS_CACHE_TTL_MS || `${6 * 60 * 60 * 1000}`,
  10
);

function parseTextFieldKeyId(key) {
  const parts = String(key || '')
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean);
  const field = parts[0] || null;
  const maybeLang = parts[1] || null;
  const lang = maybeLang && /^[a-z]{2}$/i.test(maybeLang) ? maybeLang.toLowerCase() : null;
  return { field, lang };
}

async function getInventoryAvailableTextFieldKeyIds(inventoryId) {
  const invKey = String(inventoryId || '');
  if (!invKey) return [];

  const now = Date.now();
  const cached = inventoryTextFieldKeysCache.get(invKey);
  if (cached?.keys && now - (cached.atMs || 0) < TEXT_FIELD_KEYS_CACHE_TTL_MS) {
    return cached.keys;
  }

  const keys = new Set();

  // 1) Default keys (without specifying integration_name)
  try {
    const res = await callBaseLinker('getInventoryAvailableTextFieldKeys', {
      inventory_id: Number(invKey),
    });
    const map = res?.text_field_keys;
    if (map && typeof map === 'object') {
      Object.keys(map).forEach((k) => keys.add(k));
    }
  } catch (e) {
    console.warn('getInventoryAvailableTextFieldKeys (default) failed:', e.message);
  }

  // 2) Integration-scoped keys
  try {
    const res = await callBaseLinker('getInventoryIntegrations', {
      inventory_id: Number(invKey),
    });
    // BaseLinker returns integrations typically as:
    // { integrations: [ { ebay: { langs: [...], accounts: { "301": "..." } } }, ... ] }
    const raw = res?.integrations;
    const list = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object'
        ? Object.entries(raw).map(([name, value]) => ({ [name]: value }))
        : [];

    const MAX_ACCOUNTS_PER_INTEGRATION = Math.max(
      1,
      parseInt(process.env.BASELINKER_TEXT_FIELDS_MAX_ACCOUNTS || '30', 10)
    );

    // IMPORTANT:
    // Do NOT auto-expand `extra_field_*` into integration/lang variants.
    // Some additional fields are single-language only; sending multiple language variants can trigger:
    // "ERROR_INVALID_DATA: Additional field extra_field_XXXX does not support setting values in different languages."
    const fields = ['name', 'description', 'description_extra1'];

    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const [integrationName] = Object.keys(entry);
      const meta = integrationName ? entry[integrationName] : null;
      if (!integrationName || !meta || typeof meta !== 'object') continue;

      const langs = Array.isArray(meta.langs)
        ? meta.langs.map((l) => String(l).toLowerCase()).filter(Boolean)
        : [];
      const accountsObj = meta.accounts && typeof meta.accounts === 'object' ? meta.accounts : {};
      const accountIds = Object.keys(accountsObj)
        .map((id) => String(id).trim())
        .filter(Boolean)
        .slice(0, MAX_ACCOUNTS_PER_INTEGRATION);

      // Add integration-wide "0" identifier (per BaseLinker docs, e.g. amazon_0)
      const integrationAccounts = Array.from(
        new Set([`${integrationName}_0`, ...accountIds.map((id) => `${integrationName}_${id}`)])
      );

      for (const field of fields) {
        for (const acc of integrationAccounts) {
          // Without explicit lang (falls back to default language in BaseLinker)
          keys.add(`${field}|${acc}`);
          // With explicit language variants
          for (const l of langs) {
            keys.add(`${field}|${l}|${acc}`);
          }
        }
      }

      // Optional: also fetch the integration-provided keys list (can be slow if many integrations)
      const fetchIntegrationKeys =
        (process.env.BASELINKER_FETCH_INTEGRATION_TEXT_KEYS ?? 'false')
          .toString()
          .toLowerCase() === 'true';
      if (fetchIntegrationKeys) {
        try {
          const keysRes = await callBaseLinker('getInventoryAvailableTextFieldKeys', {
            inventory_id: Number(invKey),
            integration_name: integrationName,
          });
          const map = keysRes?.text_field_keys;
          if (map && typeof map === 'object') {
            Object.keys(map).forEach((k) => keys.add(k));
          }
        } catch (inner) {
          console.warn(
            `getInventoryAvailableTextFieldKeys failed for integration ${integrationName}:`,
            inner.message
          );
        }
      }
    }
  } catch (e) {
    console.warn('getInventoryIntegrations failed:', e.message);
  }

  const list = Array.from(keys);
  inventoryTextFieldKeysCache.set(invKey, { atMs: now, keys: list });
  return list;
}

async function expandTextFieldsForInventory(inventoryId, textFields, values, lang) {
  const enabled =
    (process.env.BASELINKER_TEXT_FIELDS_AUTO_EXPAND ?? 'true')
      .toString()
      .toLowerCase() === 'true';
  if (!enabled) return textFields;
  if (!textFields || typeof textFields !== 'object') return textFields;

  const keyIds = await getInventoryAvailableTextFieldKeyIds(inventoryId);
  if (!Array.isArray(keyIds) || keyIds.length === 0) return textFields;

  const out = { ...textFields };
  const targetLang = (lang || 'de').toLowerCase();

  for (const keyId of keyIds) {
    const { field, lang: keyLang } = parseTextFieldKeyId(keyId);
    if (!field) continue;
    if (keyLang && keyLang !== targetLang) continue;

    if (field === 'name' && values?.name && out[keyId] == null) out[keyId] = values.name;
    if (field === 'description' && values?.description && out[keyId] == null)
      out[keyId] = values.description;
    if (field === 'description_extra1' && values?.description_extra1 && out[keyId] == null)
      out[keyId] = values.description_extra1;
  }

  return out;
}

const requestQueue = [];
let activeRequestCount = 0;
let lastRequestAt = 0;

const normalizeSkuValue = (val) =>
  (val || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^sku[-\s]*/i, '')
    .replace(/\s+/g, '');

const normalizeEanValue = (val) =>
  (val || '')
    .toString()
    .replace(/\D+/g, '')
    .trim();

const buildSkuIndexKey = (type, value) => (value ? `${type}:${value}` : null);

const normalizeProductListPayload = (raw) => {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).map(([key, value]) => {
      if (value && typeof value === 'object') {
        if (!value.product_id && key) {
          return {
            ...value,
            product_id: value.product_id || Number(key) || key,
          };
        }
        return value;
      }
      return { product_id: Number(key) || key, value };
    });
  }
  return [];
};

async function acquireSlot() {
  while (activeRequestCount >= MAX_PARALLEL_REQUESTS) {
    await new Promise((resolve) => requestQueue.push(resolve));
  }
  activeRequestCount += 1;
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise((resolve) =>
      setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed)
    );
  }
}

function releaseSlot() {
  activeRequestCount -= 1;
  const next = requestQueue.shift();
  if (next) next();
}

function backoffDelay(attempt) {
  const base = 500; // 0.5s
  const max = 8000; // 8s
  const delay = Math.min(base * 2 ** attempt, max);
  return delay + Math.random() * 250;
}

/**
 * Low-level BaseLinker API caller with retry + rate limit
 */
async function callBaseLinker(method, parameters = {}, retries = 4) {
  const { baseApiToken } = await getSecrets();

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await acquireSlot();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25_000);
      const response = await fetch('https://api.baselinker.com/connector.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-BLToken': baseApiToken,
        },
        body: new URLSearchParams({
          method,
          parameters: JSON.stringify(parameters),
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const payload = await response.json();
      lastRequestAt = Date.now();

      if (payload.status === 'SUCCESS') {
        return payload;
      }

      // Rate-Limit / Token block → Backoff und Retry
      const errCode = payload.error_code || '';
      const errMsg = payload.error_message || '';
      if (
        response.status === 429 ||
        errCode === 'RATE_LIMIT' ||
        errCode === 'ERROR_BLOCKED_TOKEN' ||
        /token blocked/i.test(errMsg) ||
        /maximale anzahl von anrufen pro minute/i.test(errMsg)
      ) {
        // Wenn explizit "blocked until" im Text steht, 60s warten, sonst exponentiell
        const waitMs = /blocked until/i.test(errMsg)
          ? 60_000
          : backoffDelay(attempt);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      throw new Error(
        `${payload.error_code || 'BL_ERROR'}: ${payload.error_message || 'Unknown BaseLinker error'
        }`
      );
    } catch (error) {
      if (attempt < retries) {
        await new Promise((resolve) =>
          setTimeout(resolve, backoffDelay(attempt))
        );
        continue;
      }
      throw error;
    } finally {
      releaseSlot();
    }
  }

  throw new Error('BaseLinker request failed after retries');
}

/**
 * Inventory meta cache (default warehouse / price group)
 */
let inventoryMetaCache = null;

async function getInventoryMeta(inventoryId) {
  if (inventoryMetaCache && inventoryMetaCache.inventoryId === inventoryId) {
    return inventoryMetaCache;
  }

  const response = await callBaseLinker('getInventories');
  const inventories = Array.isArray(response.inventories)
    ? response.inventories
    : [];
  const match =
    inventories.find(
      (entry) =>
        String(entry.inventory_id || entry.id) === String(inventoryId)
    ) || inventories[0];

  if (!match) {
    throw new Error(
      'getInventories returned no entries – cannot determine warehouse/price group'
    );
  }

  const normalizeWarehouseKey = (value) => {
    if (value === null || value === undefined) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    // BaseLinker API expects warehouse keys like "bl_206"
    if (/^\d+$/.test(raw)) return `bl_${raw}`;
    return raw;
  };

  const meta = {
    inventoryId: String(inventoryId),
    warehouseKey: normalizeWarehouseKey(match.default_warehouse),
    priceGroupKey:
      match.default_price_group != null
        ? String(match.default_price_group)
        : '1',
  };

  inventoryMetaCache = meta;
  return meta;
}

/**
 * Manufacturer + category caches
 */
const manufacturerCache = new Map();
const categoryCache = new Map();

/**
 * Manufacturers
 */
async function listManufacturers(inventoryId) {
  const manufacturers = [];
  let page = 1;
  const PAGE_LIMIT = 200;

  while (page <= PAGE_LIMIT) {
    const res = await callBaseLinker('getInventoryManufacturers', {
      inventory_id: inventoryId,
      page,
    });

    if (!Array.isArray(res.manufacturers) || res.manufacturers.length === 0) {
      break;
    }
    manufacturers.push(...res.manufacturers);

    if (res.manufacturers.length < 100) break;
    page += 1;
  }

  return manufacturers;
}

async function ensureManufacturerId(name, inventoryId) {
  if (!name) return null;
  const key = `${inventoryId}:${name.toLowerCase()}`;
  if (manufacturerCache.has(key)) {
    return manufacturerCache.get(key);
  }

  const existing = await listManufacturers(inventoryId);
  const match = existing.find(
    (entry) => entry.name?.toLowerCase() === name.toLowerCase()
  );
  if (match?.manufacturer_id) {
    manufacturerCache.set(key, match.manufacturer_id);
    return match.manufacturer_id;
  }

  const created = await callBaseLinker('addInventoryManufacturer', {
    inventory_id: inventoryId,
    name,
  });

  if (!created.manufacturer_id) {
    throw new Error('addInventoryManufacturer returned no manufacturer_id');
  }

  manufacturerCache.set(key, created.manufacturer_id);
  return created.manufacturer_id;
}

/**
 * Kategorien
 */
async function listCategories(inventoryId, parentId = 0) {
  const cacheKey = `list:${inventoryId}:${parentId}`;
  if (categoryCache.has(cacheKey)) {
    return categoryCache.get(cacheKey);
  }

  const categories = [];
  let page = 1;
  const PAGE_LIMIT = 200;

  while (page <= PAGE_LIMIT) {
    const res = await callBaseLinker('getInventoryCategories', {
      inventory_id: inventoryId,
      parent_id: parentId || 0,
      page,
    });

    if (!Array.isArray(res.categories) || res.categories.length === 0) {
      break;
    }

    categories.push(...res.categories);

    if (res.categories.length < 100) break;
    page += 1;
  }

  categoryCache.set(cacheKey, categories);
  return categories;
}

async function ensureCategoryId(categoryPath, inventoryId) {
  if (!categoryPath) {
    return 0;
  }

  const levels = categoryPath
    .split('>')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (!levels.length) {
    return 0;
  }

  let parentId = 0;
  for (const level of levels) {
    const cacheKey = `${inventoryId}:${parentId}:${level.toLowerCase()}`;
    if (categoryCache.has(cacheKey)) {
      parentId = categoryCache.get(cacheKey);
      continue;
    }

    const siblings = await listCategories(inventoryId, parentId);
    const existing = siblings.find(
      (cat) => String(cat.name || '').toLowerCase() === level.toLowerCase()
    );

    if (existing) {
      parentId = Number(existing.category_id);
      categoryCache.set(cacheKey, parentId);
      continue;
    }

    const created = await callBaseLinker('addInventoryCategory', {
      inventory_id: inventoryId,
      name: level,
      parent_id: parentId ?? 0,
    });

    parentId = Number(created.category_id);
    categoryCache.set(cacheKey, parentId);
  }

  return parentId;
}

/**
 * Helpers für Produktdaten
 */
function pickProductName(product) {
  const candidates = [
    product?.identification?.name,
    product?.details?.short_description,
    product?.details?.identification_name,
    product?.id,
  ];
  for (const entry of candidates) {
    if (entry && typeof entry === 'string' && entry.trim().length > 0) {
      return entry.trim();
    }
  }
  return null;
}

function pickSku(product) {
  const candidates = [
    product?.identification?.sku,
    product?.details?.identifiers?.sku,
    product?.details?.identifiers?.mpn,
    product?.id,
  ];
  for (const entry of candidates) {
    if (entry && typeof entry === 'string' && entry.trim().length > 0) {
      return entry.trim();
    }
  }
  return null;
}

function pickPrice(product) {
  const priceCandidates = [
    product?.details?.pricing?.lowest_price?.amount,
    product?.details?.pricing?.price,
    product?.details?.pricing?.msrp,
  ];
  for (const value of priceCandidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
    }
  }
  return null;
}

function pickQuantity(product) {
  const candidates = [
    product?.inventory?.quantity,
    product?.storage?.quantity,
    product?.details?.attributes?.stock,
  ];
  for (const val of candidates) {
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    if (typeof val === 'string') {
      const numeric = Number(val);
      if (Number.isFinite(numeric)) return numeric;
    }
  }
  return 0;
}

/**
 * eBay-spezifische Felder, basierend auf Features/Attributen
 */
function buildEbay9800Fields(product, featuresFromTextFields = {}) {
  const fields = {};
  const add = (key, value) => {
    if (value === undefined || value === null) return;
    const stringified =
      typeof value === 'number' ? value.toString() : String(value).trim();
    if (!stringified) return;
    fields[key] = stringified;
  };

  const attrs = product?.details?.attributes || {};
  const f = featuresFromTextFields;

  // Marke
  add(
    'Marke',
    f.Marke ||
    f.marke ||
    attrs.Marke ||
    attrs.marke ||
    product?.identification?.brand
  );

  // Modell
  add(
    'Modell',
    f.Modell ||
    f.modell ||
    attrs.Modell ||
    attrs.modell ||
    attrs.model ||
    product?.details?.identifiers?.mpn
  );

  // Farbe
  add(
    'Farbe',
    f.Farbe ||
    f.farbe ||
    attrs.Farbe ||
    attrs.farbe ||
    attrs.color ||
    attrs.colour
  );

  // Produkttyp
  add(
    'Produkttyp',
    f.Produktart ||
    f.produktart ||
    f.Produkttyp ||
    f.produkttyp ||
    attrs.Produktart ||
    attrs.produktart ||
    attrs.Produkttyp ||
    attrs.produkttyp ||
    attrs.product_type
  );

  // Herstellernummer
  add(
    'Herstellernummer',
    attrs.mpn ||
    attrs.Manufacturernummer ||
    product?.details?.identifiers?.mpn ||
    product?.details?.attributes?.manufacturer_number ||
    product?.details?.identifiers?.sku ||
    product?.identification?.sku
  );

  return fields;
}

/**
 * text_fields für BaseLinker: Name, Beschreibung, Features
 * KEINE Feature_1… mehr, nur sinnvolle Parameternamen.
 */
function buildTextFields(product, name) {
  const features = {};
  const clampShortText = (value) => {
    if (value === null || value === undefined) return '';
    const raw = String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const trimmed = raw.trim();
    if (!trimmed) return '';
    // BaseLinker docs: name + short additional fields have a 200-char limit
    if (trimmed.length <= 200) return trimmed;
    return trimmed.slice(0, 200).trim();
  };

  const addFeature = (key, value) => {
    if (!key || value === undefined || value === null) return;
    const trimmed =
      typeof value === 'number' ? value.toString() : String(value).trim();
    if (!trimmed) return;
    features[key] = trimmed;
  };

  // Attribute → direkt als sprechende Parameternamen übernehmen
  const attributes = product?.details?.attributes || {};
  Object.entries(attributes).forEach(([rawKey, rawVal]) => {
    if (rawVal === undefined || rawVal === null) return;
    const key = String(rawKey).trim();
    // Avoid syncing technical/ambiguous keys as Parameters.
    // "SKU" must come from the actual SKU field, not from arbitrary source attributes.
    const keyLower = key.toLowerCase();
    if (
      keyLower === 'sku' ||
      keyLower === 'product_id' ||
      keyLower === 'id' ||
      keyLower === 'k-typ' ||
      keyLower === 'ktyp' ||
      keyLower === 'k typ'
    ) {
      return;
    }
    const value =
      typeof rawVal === 'object' ? JSON.stringify(rawVal) : rawVal;
    addFeature(key, value);
  });

  // Always expose the real SKU as parameter "SKU" for consistency in BaseLinker UI,
  // overriding any source attribute that might use the same key.
  const realSku = pickSku(product);
  if (realSku) {
    features.SKU = realSku;
  }

  // BaseLinker text_fields keys support optional "|{lang}" and "|{lang}|{integration_account}" suffixes.
  // See BaseLinker API docs (addInventoryProduct): examples include "name|de".
  // To ensure the DE language tab is updated, we send both default keys and language-specific keys.
  const defaultLang = (process.env.BASELINKER_TEXT_LANG || 'de').toString().trim().toLowerCase();
  const desc =
    (product?.details?.short_description || '').toString().trim() ||
    (product?.details?.description || '').toString().trim() ||
    name;

  const textFields = {
    // Default (catalog default language)
    name: clampShortText(name),
    description: desc,
    // Explicit language (e.g. DE tab in BaseLinker UI)
    [`name|${defaultLang}`]: clampShortText(name),
    [`description|${defaultLang}`]: desc,
  };

  // --- BaseLinker extra fields ---
  // K-Typ is stored in AvyCloud as details.attributes["K-Typ"] (vehicle compatibility).
  // BaseLinker extra field target: extra_field_18699.
  const ktypKey = Object.keys(attributes || {}).find((k) => {
    const lower = String(k || '').trim().toLowerCase();
    return lower === 'k-typ' || lower === 'ktyp' || lower === 'k typ';
  });
  const ktypRaw = ktypKey ? attributes[ktypKey] : null;
  const ktypValue = ktypRaw === undefined || ktypRaw === null ? '' : String(ktypRaw).trim();
  if (ktypValue) {
    const blKey = 'extra_field_18699';
    // IMPORTANT: User requirement: K-Typ must be synced with ALL values.
    // We therefore do NOT clamp this value. If BaseLinker rejects long values for this extra field,
    // the sync will fail and we must change the field type in BaseLinker (short -> long) or adjust storage.
    textFields[blKey] = ktypValue;
    // IMPORTANT:
    // Additional fields may NOT support multilingual values. Sending `extra_field_x|de` (or any lang variant)
    // can cause: "ERROR_INVALID_DATA: Additional field extra_field_x does not support setting values in different languages."
    // Therefore we only set the plain key here.
  }

  // Extra Beschreibung 1 = Highlights/Bullets für BL
  const highlights = Array.isArray(product?.details?.key_features)
    ? product.details.key_features.filter(Boolean)
    : [];
  if (highlights.length) {
    // BaseLinker erwartet description_extra1 (nicht extra_description_1)
    const extra1 = clampShortText(highlights.map((h) => `• ${h}`).join('\n'));
    if (extra1) {
      textFields.description_extra1 = extra1;
      textFields[`description_extra1|${defaultLang}`] = extra1;
    }
  }

  if (Object.keys(features).length) {
    textFields.features = features;
  }

  // eBay Item-Specifics aus denselben Daten ableiten
  const ebayFields = buildEbay9800Fields(product, features);
  if (ebayFields && Object.keys(ebayFields).length) {
    textFields['features|de|ebay_9800'] = ebayFields;
  }

  // GPSR Parameters (Essential for compliance)
  const gpsr = product?.details?.gpsr;
  if (gpsr) {
    // Add these to default features so they appear in "Parameters" (BaseLinker general)
    // Kaufland often picks these up if mapped or present.
    if (gpsr.manufacturer_name) features['GPSR Manufacturer name'] = gpsr.manufacturer_name;
    if (gpsr.manufacturer_address) features['GPSR Manufacturer address'] = gpsr.manufacturer_address;
    if (gpsr.email) features['GPSR Manufacturer email'] = gpsr.email;
    if (gpsr.url) features['GPSR Manufacturer URL'] = gpsr.url;
  }

  return textFields;
}

/**
 * Bilder → nur self-hosted URLs, Mindestkante filterbar
 */
function buildImages(product) {
  if (!BASELINKER_SEND_IMAGES) return {};
  const images = {};
  const candidates = (product?.details?.images || [])
    .filter(
      (img) =>
        typeof img?.url_or_base64 === 'string' &&
        img.url_or_base64.startsWith('http')
    )
    .filter((img) => {
      const width = Number(img?.width) || 0;
      const height = Number(img?.height) || 0;
      if (!width && !height) return true; // unknown size → zulassen
      const longest = Math.max(width, height);
      return longest >= MIN_IMAGE_EDGE_BASELINKER;
    })
    .slice(0, 10);

  candidates.forEach((img, index) => {
    images[String(index)] = `url:${img.url_or_base64}`;
  });

  return images;
}

/**
 * Minimal-Validierung vor Sync
 */
function validateProduct(product) {
  const errors = [];
  if (!pickProductName(product)) errors.push('Produktname fehlt');
  if (!pickSku(product)) errors.push('SKU fehlt');

  const price = pickPrice(product);
  if (price === null) errors.push('Preis fehlt');

  return {
    isValid: errors.length === 0,
    errors,
    normalizedPrice: price ?? 0,
  };
}

/**
 * Payload für addInventoryProduct
 */
function pickEan(product) {
  const candidates = [
    product?.details?.identifiers?.ean,
    product?.details?.identifiers?.gtin,
    Array.isArray(product?.identification?.barcodes)
      ? product.identification.barcodes[0]
      : null,
  ];
  for (const entry of candidates) {
    if (entry && typeof entry === 'string' && entry.trim().length > 0) {
      const sanitized = entry.replace(/\D+/g, '');
      if (sanitized.length >= 8 && sanitized.length <= 14) {
        return sanitized;
      }
    }
  }
  return null;
}

function pickPhysicalProperties(product) {
  const attrs = product?.details?.attributes || {};

  const parseNum = (val) => {
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
      const match = val.match(/([\d.,]+)/); // match number part
      if (match) {
        return parseFloat(match[1].replace(',', '.'));
      }
    }
    return 0;
  };

  const findVal = (keys) => {
    for (const key of keys) {
      // Case insensitive lookup
      const actualKey = Object.keys(attrs).find(k => k.toLowerCase() === key.toLowerCase());
      if (actualKey && attrs[actualKey]) return parseNum(attrs[actualKey]);
    }
    return 0;
  };

  return {
    weight: findVal(['weight', 'gewicht', 'artikelgewicht', 'masse']), // sometimes weight is under generic keys, but 'gewicht' is standard
    width: findVal(['width', 'breite', 'artikelbreite']),
    height: findVal(['height', 'höhe', 'artikelhöhe']),
    length: findVal(['length', 'länge', 'tiefe', 'artikellänge', 'artikeltiefe']),
  };
}

function buildPayload(
  product,
  inventoryId,
  meta,
  manufacturerId,
  categoryId, // marketplace category (for features)
  price,
  quantity,
  inventoryCategoryId // BaseLinker inventory category id
) {
  const name = pickProductName(product);
  const sku = pickSku(product);
  const ean = pickEan(product);
  const textFields = buildTextFields(product, name);
  const images = buildImages(product);
  const stockKey = meta.warehouseKey || `inventory_${inventoryId}`;
  const priceKey = meta.priceGroupKey || '1';
  const binCode = product?.storage?.binCode;

  const { weight, width, height, length } = pickPhysicalProperties(product);

  // Marketplace-spezifische Kategorien (falls als IDs im Produkt hinterlegt)
  const attrs = product?.details?.attributes || {};
  const ebayCategoryId =
    // Canonical field in AvyCloud:
    product?.details?.categoryId ||
    product?.details?.ebayCategoryId ||
    attrs.ebay_category_id ||
    attrs.ebayCategoryId ||
    attrs['ebay.category_id'] ||
    null;
  const ebayCategoryPath =
    product?.details?.ebayCategoryPath ||
    attrs.ebay_category_path ||
    attrs.ebay_category ||
    product?.identification?.category ||
    null;
  const kauflandCategoryId =
    product?.details?.kauflandCategoryId ||
    attrs.kaufland_category_id ||
    attrs.kauflandCategoryId ||
    attrs['kaufland.category_id'] ||
    null;
  const kauflandCategoryPath =
    product?.details?.kauflandCategoryPath ||
    attrs.kaufland_category_path ||
    attrs.kaufland_category ||
    product?.identification?.category ||
    null;
  if (ebayCategoryId || ebayCategoryPath) {
    textFields.features = textFields.features || {};
    textFields.features.ebay_category_id = ebayCategoryId || ebayCategoryPath || '';
    textFields.features.ebay_category_path = ebayCategoryPath || '';
  }
  if (kauflandCategoryId || kauflandCategoryPath) {
    textFields.features = textFields.features || {};
    textFields.features.kaufland_category_id = kauflandCategoryId || kauflandCategoryPath || '';
    textFields.features.kaufland_category_path = kauflandCategoryPath || '';
  }

  const payload = {
    inventory_id: inventoryId,
    is_bundle: false,
    sku,
    asin: '',
    ean,
    ean_additional: [],
    tags: [],
    tax_rate: 19,
    manufacturer_id: manufacturerId || undefined,
    // BaseLinker-inventory category (not marketplace); if missing, fall back to 0
    category_id: inventoryCategoryId || 0,
    text_fields: textFields,
    stock: {
      [stockKey]: Math.max(0, quantity),
    },
    prices: {
      [priceKey]: price,
    },
    links: {},
    average_cost: 0,
    average_landed_cost: 0,
    suppliers: [],
    weight: weight || 0,
    height: height || 0,
    width: width || 0,
    length: length || 0,
  };

  if (binCode) {
    payload.locations = { [stockKey]: binCode };
  }
  if (Object.keys(images).length) {
    payload.images = images;
  }

  return payload;
}

// Lightweight internal export for local verification/debugging (not part of public API usage).
// Allows scripts/tests to assert the payload includes language-specific text_fields keys.
function __buildPayloadForDebug(product, inventoryId) {
  const meta = { warehouseKey: 'inventory_debug', priceGroupKey: '1' };
  const name = pickProductName(product) || 'Debug product';
  const textFields = buildTextFields(product, name);
  const sku = pickSku(product) || 'DEBUG-SKU';
  const payload = buildPayload(
    { ...product, identification: { ...(product.identification || {}), name } },
    String(inventoryId || TARGET_INVENTORY_ID || '0'),
    meta,
    null,
    0,
    1,
    0,
    0
  );
  // Ensure deterministic fields for assertions.
  payload.sku = sku;
  payload.text_fields = textFields;
  return payload;
}

/**
 * Existierendes Produkt anhand SKU finden
 */
async function findProductBySku(inventoryId, skuOrEan) {
  // IMPORTANT:
  // BaseLinker supports filtered lookups (filter_sku / filter_ean / filter_id / filter_name).
  // A full inventory scan can be extremely slow (and risks hitting rate limits), so we only do it
  // when explicitly enabled for one-off migrations/debugging.
  const ALLOW_FULL_SCAN =
    (process.env.BASELINKER_ALLOW_FULL_SCAN ?? 'false').toString().toLowerCase() === 'true';

  let page = 1;
  const MAX_PAGES = 2000;
  // BaseLinker docs: getInventoryProductsList returns up to 1000 products per page.
  const PRODUCTS_PER_PAGE = 1000;
  const rawIdentifier = safeString(skuOrEan);
  const looksLikePureDigits = /^\d+$/.test(rawIdentifier);
  const targetSku = normalizeSkuValue(rawIdentifier);
  const targetEan = normalizeEanValue(rawIdentifier);

  const pickMatchFromList = (products = []) =>
    products.find((entry) => {
      const entrySku = normalizeSkuValue(entry?.sku || entry?.product_sku || '');
      if (targetSku && entrySku && entrySku === targetSku) {
        return true;
      }
      if (targetEan) {
        const entryEan = normalizeEanValue(entry?.ean || entry?.product_ean || '');
        if (entryEan && entryEan === targetEan) {
          return true;
        }
      }
      return false;
    });

  const tryFilteredLookup = async (filterKey, filterValue) => {
    if (!filterKey || !filterValue) return null;
    try {
      const response = await callBaseLinker('getInventoryProductsList', {
        inventory_id: inventoryId,
        page: 1,
        [filterKey]: filterValue,
      });
      const directProducts = normalizeProductListPayload(
        response.products || response.items || []
      );
      return pickMatchFromList(directProducts || []);
    } catch (error) {
      console.warn(
        `BaseLinker filtered lookup failed (${filterKey}=${filterValue}):`,
        error.message
      );
      return null;
    }
  };

  // Filtered lookups (fast path)
  // - Only use filter_sku when identifier is not a pure barcode string.
  // - Always try filter_ean when we have digits (this prevents accidental "EAN treated as SKU" full scans).
  if (targetSku && !looksLikePureDigits) {
    const directMatch = await tryFilteredLookup('filter_sku', rawIdentifier);
    if (directMatch) return directMatch;
  }
  if (targetEan) {
    const eanMatch = await tryFilteredLookup('filter_ean', targetEan);
    if (eanMatch) return eanMatch;
  }

  if (!ALLOW_FULL_SCAN) {
    return null;
  }

  while (page <= MAX_PAGES) {
    const res = await callBaseLinker('getInventoryProductsList', {
      inventory_id: inventoryId,
      page,
    });
    const products = normalizeProductListPayload(res.products || res.items || []);
    const match = pickMatchFromList(products);

    if (match) return match;
    if (products.length < PRODUCTS_PER_PAGE) break;
    page += 1;
  }

  return null;
}

/**
 * Mehrere SKUs/EANs in einem Rutsch prüfen
 * Rückgabe: Map von normalisiertem SKU/EAN → { product_id, sku, ean }
 */
async function findProductsBySkus(inventoryId, skuList = []) {
  if (!Array.isArray(skuList) || !skuList.length) return {};
  const invId = String(inventoryId || TARGET_INVENTORY_ID);
  const normalized = Array.from(
    new Set(
      skuList
        .map((v) => normalizeSkuValue(v) || normalizeEanValue(v))
        .filter(Boolean)
    )
  );

  const results = {};
  for (const key of normalized) {
    const match = await findProductBySku(invId, key);
    if (match) {
      const pid = match.product_id || match.id;
      if (pid) {
        const matchedSku = normalizeSkuValue(match.sku || match.product_sku || key) || null;
        const matchedEan = normalizeEanValue(match.ean || match.product_ean || null) || null;
        results[key] = {
          product_id: pid,
          sku: matchedSku,
          ean: matchedEan,
          inventoryId: invId,
        };
      }
    }
  }
  return results;
}

/**
 * Einzelnes Produkt synchronisieren
 */
async function syncProductToBaseLinker(product, inventoryId) {
  // Always use the effective inventory (we only operate on one BaseLinker inventory in production).
  const invId = String(inventoryId || TARGET_INVENTORY_ID);
  if (!invId) {
    const message = 'Inventory ID fehlt';
    await logInventorySyncEvent({
      productId: product.id,
      inventoryId: invId,
      status: 'failed',
      message,
    });
    return {
      id: product.id,
      status: 'failed',
      message,
    };
  }

  try {
    const validation = validateProduct(product);
    if (!validation.isValid) {
      const message = validation.errors.join(' | ');
      await logInventorySyncEvent({
        productId: product.id,
        inventoryId,
        status: 'failed',
        message,
      });
      return {
        id: product.id,
        status: 'failed',
        message,
      };
    }

    const meta = await getInventoryMeta(invId);
    if (!meta.warehouseKey) {
      throw new Error('BaseLinker inventory has no default warehouse (stock key)');
    }

    // Better Brand Detection
    let brandName = product?.identification?.brand;
    if (!brandName) {
      // Look in attributes
      const attrs = product?.details?.attributes || {};
      const brandKey = Object.keys(attrs).find(k => ['marke', 'hersteller', 'brand', 'manufacturer'].includes(k.toLowerCase()));
      if (brandKey) brandName = attrs[brandKey];
    }

    // Fallback if still empty, dont call ensureManufacturerId with empty string or default
    if (brandName && brandName.toLowerCase() === 'unbekannt') brandName = null;

    const manufacturerId = await ensureManufacturerId(
      brandName,
      invId
    );

    const attrs = { ...(product?.details?.attributes || {}) };
    const categoryPath =
      product?.details?.ebayCategoryPath ||
      product?.details?.kauflandCategoryPath ||
      product?.identification?.category ||
      attrs.ebay_category_path ||
      attrs.kaufland_category_path ||
      null;
    if (categoryPath) {
      attrs.category_path = categoryPath;
    }
    if (product.details) {
      product.details.attributes = attrs;
    }

    // Quantity to send to BaseLinker must reflect AVAILABLE stock:
    // available = physical (warehouse BIN stock) - reserved (open orders).
    const physicalQuantity = pickQuantity(product);
    let quantity = Math.max(0, physicalQuantity);
    const preferredAvailable = product?.inventory?.availableQuantity;
    if (typeof preferredAvailable === 'number' && Number.isFinite(preferredAvailable)) {
      quantity = Math.max(0, preferredAvailable);
    } else {
      const reservedMap = await getReservedOpenOrderMap();
      const skuKey = normalizeSkuValue(pickSku(product) || product?.id || '');
      const reservedQty = skuKey ? Number(reservedMap.get(skuKey) || 0) : 0;
      quantity = Math.max(0, physicalQuantity - reservedQty);
    }
    const inventoryCategoryId = categoryPath ? await ensureInventoryCategory(invId, categoryPath) : 0;
    const numericCategoryId = inventoryCategoryId || 0;

    const payload = buildPayload(
      product,
      invId,
      meta,
      manufacturerId,
      numericCategoryId,
      validation.normalizedPrice,
      quantity,
      inventoryCategoryId
    );

    // Ensure BaseLinker receives description for the *actual* text field key used by the UI.
    // BaseLinker supports field|lang|integration_account keys; we discover and mirror values.
    const defaultLang = (process.env.BASELINKER_TEXT_LANG || 'de')
      .toString()
      .trim()
      .toLowerCase();
    payload.text_fields = await expandTextFieldsForInventory(
      invId,
      payload.text_fields,
      {
        name: payload?.text_fields?.name,
        description: payload?.text_fields?.description,
        description_extra1: payload?.text_fields?.description_extra1,
        extra_field_18699: payload?.text_fields?.extra_field_18699,
      },
      defaultLang
    );

    const debugTextFields =
      (process.env.BASELINKER_DEBUG_TEXT_FIELDS ?? 'false').toString().toLowerCase() ===
      'true';
    if (debugTextFields) {
      const tf = payload.text_fields || {};
      const descKeys = Object.keys(tf).filter((k) => /^description(\||$)/i.test(k));
      console.log(
        '[BaseLinker sync debug] text_fields description keys:',
        JSON.stringify(
          {
            inventoryId: invId,
            sku: payload.sku,
            productId: product.id,
            keys: descKeys,
            preview: Object.fromEntries(
              descKeys.slice(0, 12).map((k) => [k, String(tf[k] || '').slice(0, 120)])
            ),
          },
          null,
          2
        )
      );
    }
    const normalizedSku = normalizeSkuValue(payload.sku);
    const normalizedEan = normalizeEanValue(payload.ean);

    const hasOpsLink = Boolean(product?.ops?.base_product_id || product?.ops?.baselinker?.product_id);

    // If the BaseLinker product_id is already known, prefer it (do NOT rely on SKU scan).
    // This is critical to update the intended product (e.g. 467527271) and avoid accidental duplicates.
    let baseProductId = null; // resolved per inventory
    let baseProductIdSource = null;

    // Optional override for one-off fixes/debugging.
    const forcedPid = Number(process.env.BASELINKER_FORCE_PRODUCT_ID || 0);
    if (Number.isFinite(forcedPid) && forcedPid > 0) {
      baseProductId = forcedPid;
      baseProductIdSource = 'env:BASELINKER_FORCE_PRODUCT_ID';
    }

    if (!baseProductId) {
      const linkedRaw =
        product?.ops?.baselinker?.product_id ??
        product?.ops?.base_product_id ??
        null;
      const linkedPid = Number(linkedRaw);
      const linkedInv = product?.ops?.baselinker?.synced_inventory ?? null;
      if (
        Number.isFinite(linkedPid) &&
        linkedPid > 0 &&
        (!linkedInv || String(linkedInv) === String(invId))
      ) {
        baseProductId = linkedPid;
        baseProductIdSource = 'product.ops';
      }
    }

    // Next best: resolve via Firestore SKU index (fast, avoids BaseLinker list scans).
    if (!baseProductId) {
      const indexKeys = [
        buildSkuIndexKey('sku', normalizedSku),
        buildSkuIndexKey('ean', normalizedEan),
      ].filter(Boolean);
      for (const key of indexKeys) {
        const entry = await getSkuIndexEntry(key);
        const pid = Number(entry?.baseProductId);
        if (Number.isFinite(pid) && pid > 0) {
          baseProductId = pid;
          baseProductIdSource = `sku_index:${key}`;
          break;
        }
      }
    }

    let existing = null;
    let resolvedExisting = false;
    const resolveExistingProduct = async (identifier) => {
      if (resolvedExisting || !identifier) return null;
      resolvedExisting = true;
      // Try lookup by SKU first
      existing = await findProductBySku(invId, identifier);
      if (!existing?.product_id && payload?.ean) {
        // second attempt: by EAN
        existing = await findProductBySku(invId, payload.ean);
      }
      return existing;
    };
    if (!baseProductId && (payload?.sku || payload?.ean)) {
      await resolveExistingProduct(payload.sku || payload.ean);
      if (existing?.product_id) {
        baseProductId = existing.product_id;
        baseProductIdSource = 'baselinker_lookup';
      }
    }

    // If the product is already linked to BaseLinker, never create a new product.
    if (!baseProductId && hasOpsLink) {
      throw new Error(
        `BaseLinker linkage exists but product_id could not be resolved (sku=${payload?.sku || ''}, ean=${payload?.ean || ''}). Refusing to create a new BaseLinker product.`
      );
    }

    const buildRequest = (productId) => ({
      ...payload,
      product_id: Number(productId) || 0,
      category_id: numericCategoryId || 0,
    });

    let requestPayload = buildRequest(baseProductId || 0);
    let result;
    let retriedAfterResolvingId = false;
    try {
      result = await callBaseLinker('addInventoryProduct', requestPayload);
    } catch (error) {
      const msg = String(error.message || '').toUpperCase();
      const staleIdError =
        msg.includes('ERROR_PRODUCT_ID') || msg.includes('NO PRODUCT WITH ID');

      if (staleIdError) {
        if (!retriedAfterResolvingId) {
          retriedAfterResolvingId = true;
          if (!existing) {
            await resolveExistingProduct(payload.sku || payload.ean);
          }
          if (existing?.product_id) {
            baseProductId = existing.product_id;
            baseProductIdSource = 'baselinker_lookup_after_stale';
            requestPayload = buildRequest(baseProductId);
          } else {
            baseProductId = null;
            // If linked, do NOT create a new product as a fallback.
            if (hasOpsLink) {
              throw new Error(
                `BaseLinker product_id is stale and no replacement could be resolved (sku=${payload?.sku || ''}). Refusing to create a new product.`
              );
            }
            requestPayload = buildRequest(0);
          }
          result = await callBaseLinker('addInventoryProduct', requestPayload);
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }

    if (result.status !== 'SUCCESS') {
      throw new Error(result.error_message || 'BaseLinker returned error');
    }

    baseProductId = result.product_id || baseProductId || null;
    const debugPid =
      (process.env.BASELINKER_DEBUG_TEXT_FIELDS ?? 'false').toString().toLowerCase() ===
      'true';
    if (debugPid) {
      console.log('[BaseLinker sync debug] product_id resolved:', {
        inventoryId: invId,
        sku: payload?.sku,
        productId: product?.id,
        baseProductId,
        baseProductIdSource,
      });
    }

    const syncTimestamp = new Date().toISOString();
    try {
      await updateProductSyncStatus(
        product.id,
        'synced',
        syncTimestamp,
        baseProductId,
        invId
      );
    } catch (updateError) {
      console.warn(
        'updateProductSyncStatus failed (non-blocking):',
        updateError.message
      );
    }

    if (baseProductId) {
      const indexPayload = {
        baseProductId,
        productId: product.id,
        sku: payload.sku || null,
        ean: payload.ean || null,
        updatedAt: syncTimestamp,
      };
      const indexKeys = [
        buildSkuIndexKey('sku', normalizedSku),
        buildSkuIndexKey('ean', normalizedEan),
      ].filter(Boolean);
      await Promise.all(indexKeys.map((key) => setSkuIndexEntry(key, indexPayload)));
    }

    await logInventorySyncEvent({
      productId: product.id,
      inventoryId: invId,
      status: 'success',
      message: 'Successfully synced to BaseLinker',
    });

    return {
      id: product.id,
      status: 'synced',
      message: 'Successfully synced to BaseLinker',
    };
  } catch (error) {
    console.error('Failed to sync product to BaseLinker:', error);
    await logInventorySyncEvent({
      productId: product.id,
      inventoryId,
      status: 'failed',
      message: error.message,
    });
    return {
      id: product.id,
      status: 'failed',
      message: error.message,
    };
  }
}

/**
 * Mehrere Produkte synchronisieren
 */
async function syncProductsToBaseLinker(products, inventoryId) {
  const results = new Array(products.length);
  const concurrency = Math.max(1, parseInt(process.env.BASELINKER_SYNC_CONCURRENCY || '3', 10));
  let index = 0;
  const logProgress =
    (process.env.BASELINKER_SYNC_LOG_PROGRESS ?? 'false').toString().toLowerCase() === 'true';

  const worker = async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= products.length) break;
      const product = products[current];
      if (logProgress) {
        const sku = pickSku(product) || '';
        console.log(`[baselinker] (${current + 1}/${products.length}) syncing id=${product?.id || ''} sku=${sku}`);
      }
      results[current] = await syncProductToBaseLinker(product, inventoryId);
    }
  };

  const workers = Array(Math.min(concurrency, products.length))
    .fill(null)
    .map(() => worker());

  await Promise.all(workers);
  return results;
}

module.exports = {
  syncProductToBaseLinker,
  syncProductsToBaseLinker,
  callBaseLinker,
  findProductsBySkus,
  __buildPayloadForDebug,
};
