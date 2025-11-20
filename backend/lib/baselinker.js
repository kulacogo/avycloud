const fetch = require('node-fetch');
const { getSecrets } = require('./secrets');
const { updateProductSyncStatus } = require('./firestore');

/**
 * BaseLinker API – request limiter (100 RPM ⇒ max 5 parallel calls)
 */
const MAX_PARALLEL_REQUESTS = 5;
const requestQueue = [];
let activeRequestCount = 0;

async function acquireSlot() {
  while (activeRequestCount >= MAX_PARALLEL_REQUESTS) {
    await new Promise((resolve) => requestQueue.push(resolve));
  }
  activeRequestCount += 1;
}

function releaseSlot() {
  activeRequestCount -= 1;
  const next = requestQueue.shift();
  if (next) next();
}

function backoffDelay(attempt) {
  const base = 500; // 0.5s
  const max = 8000; // 8s
  const delay = Math.min(base * (2 ** attempt), max);
  return delay + Math.random() * 250;
}

async function callBaseLinker(method, parameters = {}, retries = 4) {
  const { baseApiToken } = await getSecrets();

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await acquireSlot();
    try {
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
      });

      const payload = await response.json();
      if (payload.status === 'SUCCESS') {
        return payload;
      }

      if (response.status === 429 || payload.error_code === 'RATE_LIMIT') {
        await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt)));
        continue;
      }

      throw new Error(`${payload.error_code || 'BL_ERROR'}: ${payload.error_message || 'Unknown BaseLinker error'}`);
    } catch (error) {
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt)));
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
  const inventories = Array.isArray(response.inventories) ? response.inventories : [];
  const match = inventories.find((entry) => String(entry.inventory_id || entry.id) === String(inventoryId))
    || inventories[0];

  if (!match) {
    throw new Error('getInventories returned no entries – cannot determine warehouse/price group');
  }

  const meta = {
    inventoryId: String(inventoryId),
    warehouseKey: match.default_warehouse ? String(match.default_warehouse) : null,
    priceGroupKey: match.default_price_group != null ? String(match.default_price_group) : '1',
  };

  inventoryMetaCache = meta;
  return meta;
}

/**
 * Manufacturer cache/lookup
 */
const manufacturerCache = new Map();
const categoryCache = new Map();

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
  const match = existing.find((entry) => entry.name?.toLowerCase() === name.toLowerCase());
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
      (cat) => String(cat.name || '').toLowerCase() === level.toLowerCase(),
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
 * Helpers for mapping product data
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
    product?.details?.identifiers?.ean,
    product?.details?.identifiers?.gtin,
    product?.id,
  ];
  for (const entry of candidates) {
    if (entry && typeof entry === 'string' && entry.trim().length > 0) {
      return entry.trim();
    }
  }
  return null;
}

function pickEan(product) {
  const candidates = [
    product?.details?.identifiers?.ean,
    product?.details?.identifiers?.gtin,
    Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes[0] : null,
  ];
  for (const entry of candidates) {
    if (entry && typeof entry === 'string' && entry.trim().length > 0) {
      const sanitized = entry.replace(/\D+/g, '');
      if (sanitized.length >= 8 && sanitized.length <= 14) {
        return sanitized;
      }
    }
  }
  return '';
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

function buildEbay9800Fields(product) {
  const fields = {};
  const add = (key, value) => {
    if (!value) return;
    fields[key] = String(value);
  };

  add('Produktart', product?.identification?.category);
  add('Marke', product?.identification?.brand);
  add('Modell',
    product?.details?.attributes?.model ||
    product?.details?.identifiers?.mpn ||
    product?.identification?.model);
  add('Farbe', product?.details?.attributes?.color || product?.details?.attributes?.colour);
  add('Laufzeit', product?.details?.attributes?.battery_life || product?.details?.attributes?.runtime);

  return Object.keys(fields).length ? fields : null;
}

function buildTextFields(product, name) {
  const features = {};

  if (Array.isArray(product?.details?.key_features)) {
    product.details.key_features.forEach((feature, index) => {
      if (!feature) return;
      features[`Feature_${index + 1}`] = String(feature);
    });
  }

  const attributes = product?.details?.attributes || {};
  Object.entries(attributes).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    const normalizedValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
    features[key] = normalizedValue;
  });

  const textFields = {
    name,
    description: product?.details?.short_description || name,
  };

  if (Object.keys(features).length) {
    textFields.features = features;
    textFields['features|de|ebay_9800'] = {
      Produktart: product?.identification?.category || '',
      Marke: product?.identification?.brand || '',
      Modell: product?.details?.attributes?.model
        || product?.identification?.model
        || product?.details?.identifiers?.mpn
        || '',
      Farbe: product?.details?.attributes?.color
        || product?.details?.attributes?.colour
        || '',
      Laufzeit: product?.details?.attributes?.battery_life
        || product?.details?.attributes?.runtime
        || '',
    };

    // remove empty entries from ebay fields
    Object.keys(textFields['features|de|ebay_9800']).forEach((key) => {
      if (!textFields['features|de|ebay_9800'][key]) {
        delete textFields['features|de|ebay_9800'][key];
      }
    });

    if (!Object.keys(textFields['features|de|ebay_9800']).length) {
      delete textFields['features|de|ebay_9800'];
    }
  }

  return textFields;
}

function buildImages(product) {
  const images = {};
  const urls = (product?.details?.images || [])
    .map((img) => img?.url_or_base64)
    .filter((url) => typeof url === 'string' && url.startsWith('http'))
    .slice(0, 10);

  urls.forEach((url, index) => {
    images[String(index)] = `url:${url}`;
  });

  return images;
}

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

function buildPayload(product, inventoryId, meta, manufacturerId, categoryId, price, quantity) {
  const name = pickProductName(product);
  const sku = pickSku(product);
  const ean = pickEan(product);
  const textFields = buildTextFields(product, name);
  const images = buildImages(product);
  const ebayFields = buildEbay9800Fields(product);
  const stockKey = meta.warehouseKey || `inventory_${inventoryId}`;
  const priceKey = meta.priceGroupKey || '1';
  const binCode = product?.storage?.binCode;

  const payload = {
    inventory_id: inventoryId,
    is_bundle: false,
    sku,
    ean,
    asin: '',
    ean_additional: [],
    tags: [],
    tax_rate: 19,
    manufacturer_id: manufacturerId || undefined,
    category_id: categoryId || 0,
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
  };

  if (binCode) {
    payload.locations = { [stockKey]: binCode };
  }
  if (ebayFields) {
    payload['text_fields|de|ebay_9800'] = ebayFields;
  }
  if (Object.keys(images).length) {
    payload.images = images;
  }

  return payload;
}

async function findProductBySkuOrEan(inventoryId, sku, ean) {
  let page = 1;
  const MAX_PAGES = 200;

  while (page <= MAX_PAGES) {
    const res = await callBaseLinker('getInventoryProductsList', {
      inventory_id: inventoryId,
      page,
    });

    const products = Array.isArray(res.products) ? res.products : [];
    const match = products.find((entry) => {
      const entrySku = entry?.sku || entry?.product_sku;
      const entryEan = entry?.ean || entry?.product_ean;
      if (sku && entrySku && entrySku.trim().toLowerCase() === sku.trim().toLowerCase()) return true;
      if (ean && entryEan && entryEan.trim() === ean.trim()) return true;
      return false;
    });

    if (match) return match;
    if (products.length < 100) break;
    page += 1;
  }

  return null;
}

async function syncProductToBaseLinker(product) {
  try {
    const { baseInventoryId } = await getSecrets();
    const validation = validateProduct(product);
    if (!validation.isValid) {
      return {
        id: product.id,
        status: 'failed',
        message: validation.errors.join(' | '),
      };
    }

    const meta = await getInventoryMeta(baseInventoryId);
    if (!meta.warehouseKey) {
      throw new Error('BaseLinker inventory has no default warehouse (stock key)');
    }

    const manufacturerId = await ensureManufacturerId(
      product?.identification?.brand,
      baseInventoryId,
    );

    const categoryId = await ensureCategoryId(product?.identification?.category, baseInventoryId);

    const quantity = pickQuantity(product);
    const payload = buildPayload(
      product,
      baseInventoryId,
      meta,
      manufacturerId,
      categoryId,
      validation.normalizedPrice,
      quantity,
    );

    const existing = await findProductBySkuOrEan(baseInventoryId, payload.sku, payload.ean);
    const requestPayload = {
      ...payload,
      product_id: existing?.product_id || 0,
    };

    const result = await callBaseLinker('addInventoryProduct', requestPayload);
    if (result.status !== 'SUCCESS') {
      throw new Error(result.error_message || 'BaseLinker returned error');
    }

    const baseProductId = result.product_id || existing?.product_id || null;

    try {
      await updateProductSyncStatus(
        product.id,
        'synced',
        new Date().toISOString(),
        baseProductId
      );
    } catch (updateError) {
      console.warn('updateProductSyncStatus failed:', updateError.message);
    }

    return {
      id: product.id,
      status: 'synced',
      message: 'Successfully synced to BaseLinker',
    };
  } catch (error) {
    console.error('Failed to sync product to BaseLinker:', error);
    return {
      id: product.id,
      status: 'failed',
      message: error.message,
    };
  }
}

async function syncProductsToBaseLinker(products) {
  const results = [];
  for (const product of products) {
    const result = await syncProductToBaseLinker(product);
    results.push(result);
  }
  return results;
}

module.exports = {
  syncProductToBaseLinker,
  syncProductsToBaseLinker,
};

