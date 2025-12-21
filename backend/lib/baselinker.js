const fetch = require('node-fetch');
const path = require('path');
const { getSecrets } = require('./secrets');
const {
  updateProductSyncStatus,
  getSkuIndexEntry,
  setSkuIndexEntry,
  findProductByStrictIdentifier,
  logInventorySyncEvent,
} = require('./firestore');
const { MarketplaceLookup } = require('./marketplace-lookup');
const { getGeminiClient } = require('../lib/gemini-client');

const MIN_IMAGE_EDGE_BASELINKER = parseInt(
  process.env.BASELINKER_IMAGE_MIN_EDGE || '600',
  10
);
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
 * BaseLinker API – request limiter (100 RPM ⇒ max 5 parallel calls)
 */
// Konservativer: weniger Parallelität, stabiler gegen 429/Timeouts
const MAX_PARALLEL_REQUESTS = 3;
// Mindestabstand zwischen Requests in ms (zusätzlich zur Parallelitätsbremse)
const MIN_REQUEST_INTERVAL_MS = 250;

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
        /token blocked/i.test(errMsg)
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

  const meta = {
    inventoryId: String(inventoryId),
    warehouseKey: match.default_warehouse
      ? String(match.default_warehouse)
      : null,
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
    f.Produkttyp ||
    f.produkttyp ||
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
    const value =
      typeof rawVal === 'object' ? JSON.stringify(rawVal) : rawVal;
    addFeature(key, value);
  });

  const textFields = {
    name,
    description: product?.details?.short_description || name,
  };

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

/**
 * Existierendes Produkt anhand SKU finden
 */
async function findProductBySku(inventoryId, skuOrEan) {
  let page = 1;
  const MAX_PAGES = 2000;
  const targetSku = normalizeSkuValue(skuOrEan);
  const targetEan = normalizeEanValue(skuOrEan);

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

  if (targetSku) {
    const directMatch = await tryFilteredLookup('filter_sku', skuOrEan);
    if (directMatch) {
      return directMatch;
    }
  }
  if (!targetSku && targetEan) {
    const eanMatch = await tryFilteredLookup('filter_ean', skuOrEan);
    if (eanMatch) {
      return eanMatch;
    }
  }

  while (page <= MAX_PAGES) {
    const res = await callBaseLinker('getInventoryProductsList', {
      inventory_id: inventoryId,
      page,
    });
    const products = normalizeProductListPayload(res.products || res.items || []);
    const match = pickMatchFromList(products);

    if (match) return match;
    if (products.length < 100) break;
    page += 1;
  }

  return null;
}

/**
 * Einzelnes Produkt synchronisieren
 */
async function syncProductToBaseLinker(product, inventoryId) {
  const invId = String(TARGET_INVENTORY_ID);
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

    const meta = await getInventoryMeta(inventoryId);
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
      inventoryId
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

    const quantity = pickQuantity(product);
    const inventoryCategoryId = categoryPath
      ? await ensureInventoryCategory(invId, categoryPath)
      : 0;
    const numericCategoryId = inventoryCategoryId || 0;

    const payload = buildPayload(
      product,
      inventoryId,
      meta,
      manufacturerId,
      numericCategoryId,
      validation.normalizedPrice,
      quantity,
      inventoryCategoryId
    );
    const normalizedSku = normalizeSkuValue(payload.sku);
    const normalizedEan = normalizeEanValue(payload.ean);

    let baseProductId = null; // do not reuse across inventories; resolve per inventory
    let existing = null;
    let resolvedExisting = false;
    const resolveExistingProduct = async (identifier) => {
      if (resolvedExisting || !identifier) return null;
      resolvedExisting = true;
      // Try lookup by SKU first
      existing = await findProductBySku(inventoryId, identifier);
      if (!existing?.product_id && payload?.ean) {
        // second attempt: by EAN
        existing = await findProductBySku(inventoryId, payload.ean);
      }
      return existing;
    };
    if (!baseProductId && (payload?.sku || payload?.ean)) {
      await resolveExistingProduct(payload.sku || payload.ean);
      if (existing?.product_id) {
        baseProductId = existing.product_id;
      }
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
            requestPayload = buildRequest(baseProductId);
          } else {
            baseProductId = null;
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

    const syncTimestamp = new Date().toISOString();
    try {
      await updateProductSyncStatus(
        product.id,
        'synced',
        syncTimestamp,
        baseProductId,
        inventoryId
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
      inventoryId,
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
  const results = [];
  for (const product of products) {
    const result = await syncProductToBaseLinker(product, inventoryId);
    results.push(result);
  }
  return results;
}

module.exports = {
  syncProductToBaseLinker,
  syncProductsToBaseLinker,
  callBaseLinker,
};
