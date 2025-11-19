const { getSecrets } = require('./secrets');
const { updateProductSyncStatus } = require('./firestore');

// Rate limiting: max 5 concurrent requests to respect 100 RPM limit
let activeRequests = 0;
const MAX_CONCURRENT_REQUESTS = 5;
const requestQueue = [];
const manufacturerCache = new Map();

/**
 * Simple rate limiter
 */
async function acquireRequestSlot() {
  while (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    await new Promise(resolve => requestQueue.push(resolve));
  }
  activeRequests++;
}

function releaseRequestSlot() {
  activeRequests--;
  if (requestQueue.length > 0) {
    const resolve = requestQueue.shift();
    resolve();
  }
}

/**
 * Exponential backoff with jitter
 */
function calculateBackoffMs(attempt) {
  const baseDelayMs = 1000;
  const maxDelayMs = 30000;
  const jitter = Math.random() * 0.3; // 0-30% jitter
  const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
  return Math.floor(delay * (1 + jitter));
}

/**
 * Makes a request to BaseLinker API with retry logic
 * @param {string} method - BaseLinker API method name
 * @param {object} parameters - Method parameters
 * @param {number} maxRetries - Maximum retry attempts
 */
async function makeBaseLinkerRequest(method, parameters, maxRetries = 3) {
  const { baseApiToken } = await getSecrets();
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await acquireRequestSlot();
      
      const response = await fetch('https://api.baselinker.com/connector.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-BLToken': baseApiToken
        },
        body: new URLSearchParams({
          method: method,
          parameters: JSON.stringify(parameters)
        })
      });
      
      const data = await response.json();
      
      // BaseLinker returns status in the response body
      if (data.status === 'SUCCESS') {
        return { ok: true, data };
      }
      
      // Handle rate limiting
      if (response.status === 429 || data.error_code === 'RATE_LIMIT') {
        if (attempt < maxRetries) {
          const delayMs = calculateBackoffMs(attempt);
          console.log(`Rate limited, retrying in ${delayMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
      }
      
      // Handle other errors
      return {
        ok: false,
        error: {
          code: data.error_code || 'UNKNOWN_ERROR',
          message: data.error_message || 'Unknown error occurred'
        }
      };
      
    } catch (error) {
      // Network or parsing errors
      if (attempt < maxRetries) {
        const delayMs = calculateBackoffMs(attempt);
        console.log(`Request failed, retrying in ${delayMs}ms...`, error.message);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
      
      return {
        ok: false,
        error: {
          code: 'NETWORK_ERROR',
          message: error.message
        }
      };
    } finally {
      releaseRequestSlot();
    }
  }
}

/**
 * Maps a local product to BaseLinker addInventoryProduct format
 * @param {object} product - Local product object
 * @param {string} inventoryId - BaseLinker inventory ID
 */
function resolveProductName(product) {
  const candidates = [
    product?.identification?.name,
    product?.details?.short_description,
    product?.details?.identifiers?.sku,
    product?.details?.identifiers?.ean,
    product?.id,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function parseQuantity(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function resolveInventoryQuantity(product) {
  return (
    parseQuantity(product.inventory?.quantity) ||
    parseQuantity(product.storage?.quantity) ||
    parseQuantity(product.details?.attributes?.stock) ||
    0
  );
}

function sanitizeNumeric(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D+/g, '');
  if (digits.length >= 6) {
    return digits;
  }
  return null;
}

function hashStringToDigits(input = '') {
  const MODULO = 1_000_000_000_000; // 12 digits
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 131 + input.charCodeAt(i)) % MODULO;
  }
  return (hash || 1).toString().padStart(12, '0');
}

function resolveBaseLinkerId(product) {
  const identifiers = product?.details?.identifiers || {};
  const preferred = [
    identifiers.ean,
    identifiers.gtin,
    product.id,
  ];

  for (const candidate of preferred) {
    const numeric = sanitizeNumeric(candidate);
    if (numeric) {
      return numeric;
    }
  }
  return hashStringToDigits(product?.id || product?.identification?.name || 'product');
}

function resolveSku(product) {
  const candidates = [
    product?.details?.identifiers?.sku,
    product?.details?.identifiers?.mpn,
    product?.details?.identifiers?.ean,
    product?.details?.identifiers?.gtin,
    product?.id,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function resolvePriceAmount(product) {
  const value = product?.details?.pricing?.lowest_price?.amount;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return null;
}

function validateProductForBaseLinker(product) {
  const errors = [];
  const name = resolveProductName(product);
  if (!name) {
    errors.push('Produktname fehlt');
  }

  const sku = resolveSku(product);
  if (!sku) {
    errors.push('SKU fehlt');
  }

  const priceAmount = resolvePriceAmount(product);
  if (priceAmount === null) {
    errors.push('Preis fehlt');
  }

  const inventoryQuantity = resolveInventoryQuantity(product);

  return {
    isValid: errors.length === 0,
    errors,
    normalized: {
      name,
      sku,
      priceAmount: priceAmount ?? 0,
      inventoryQuantity: Math.max(0, inventoryQuantity ?? 0),
    },
  };
}

function mapToBaseLinkerProduct(product, inventoryId, payloadOptions = {}, normalized = {}) {
  const inventoryQuantity =
    normalized.inventoryQuantity ?? resolveInventoryQuantity(product);

  const resolvedName = normalized.name ?? resolveProductName(product);
  if (!resolvedName) {
    throw new Error(`Produkt ${product.id} hat keinen Namen und kann nicht mit BaseLinker synchronisiert werden.`);
  }
  const resolvedSku = normalized.sku ?? resolveSku(product) ?? product.id;
  const priceAmount =
    normalized.priceAmount ?? resolvePriceAmount(product) ?? 0;

  const identifiers = product.details?.identifiers || {};
  const ean =
    identifiers.ean ||
    identifiers.gtin ||
    (product.identification?.barcodes &&
      product.identification.barcodes.length > 0
      ? product.identification.barcodes[0]
      : '');

  const attributeEntries = Object.entries(product.details?.attributes || {}).reduce(
    (acc, [key, value]) => {
      acc[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
      return acc;
    },
    {}
  );

  const features = {};
  (product.details?.key_features || []).forEach((feature, index) => {
    features[`feature_${index + 1}`] = feature;
  });

  const textFields = {
    name: resolvedName,
    description: product.details?.short_description || resolvedName,
  };

  if (Object.keys(features).length) {
    textFields.features = features;
  }

  const imageUrls = (product.details?.images || [])
    .map((img) => img.url_or_base64)
    .filter((url) => typeof url === 'string' && url.startsWith('http'))
    .slice(0, 5);

  const images = {};
  imageUrls.forEach((url, idx) => {
    images[String(idx + 1)] = `url:${url}`;
  });

  const stockKey = payloadOptions.stockKey || `bl_${inventoryId}`;
  const priceKey = payloadOptions.priceGroupId || '1';

  const payload = {
    inventory_id: inventoryId,
    manufacturer_id: payloadOptions.manufacturerId || undefined,
    is_bundle: false,
    ean,
    asin: '',
    ean_additional: [],
    sku: resolvedSku,
    tags: [],
    tax_rate: 19,
    weight: parseFloat(product.details?.attributes?.weight) || 0,
    height: parseFloat(product.details?.attributes?.height) || 0,
    width: parseFloat(product.details?.attributes?.width) || 0,
    length: parseFloat(product.details?.attributes?.length) || 0,
    star: 0,
    category_id: 0,
    text_fields: textFields,
    stock: {
      [stockKey]: Math.max(0, inventoryQuantity),
    },
    prices: {
      [priceKey]: priceAmount,
    },
    locations: product.storage?.binCode
      ? { [stockKey]: product.storage.binCode }
      : undefined,
    images: Object.keys(images).length ? images : undefined,
    links: {},
    average_cost: 0,
    average_landed_cost: 0,
    suppliers: [],
  };

  if (Object.keys(attributeEntries).length) {
    payload.attributes = attributeEntries;
  }

  return payload;
}

/**
 * Simple EAN validation
 */
function isValidEAN(code) {
  return /^[0-9]{8,13}$/.test(code);
}

/**
 * Syncs a single product to BaseLinker
 */
async function ensureManufacturerId(name, inventoryId) {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const cacheKey = `${inventoryId}:${trimmed.toLowerCase()}`;
  if (manufacturerCache.has(cacheKey)) {
    return manufacturerCache.get(cacheKey);
  }

  const searchResult = await makeBaseLinkerRequest('getInventoryManufacturers', {
    inventory_id: inventoryId,
  });
  if (searchResult.ok && Array.isArray(searchResult.data?.manufacturers)) {
    const match = searchResult.data.manufacturers.find(
      (entry) => entry?.name?.trim()?.toLowerCase() === trimmed.toLowerCase()
    );
    if (match?.manufacturer_id) {
      manufacturerCache.set(cacheKey, match.manufacturer_id);
      return match.manufacturer_id;
    }
  }

  const createResult = await makeBaseLinkerRequest('addInventoryManufacturer', {
    inventory_id: inventoryId,
    name: trimmed,
  });

  const createdId =
    createResult.ok && (createResult.data?.manufacturer_id || createResult.data?.id)
      ? createResult.data.manufacturer_id || createResult.data.id
      : null;

  if (createdId) {
    manufacturerCache.set(cacheKey, createdId);
  }
  return createdId;
}

/**
 * Syncs a single product to BaseLinker
 */
async function syncProductToBaseLinker(product) {
  try {
    const { baseInventoryId } = await getSecrets();
    const validation = validateProductForBaseLinker(product);
    if (!validation.isValid) {
      const message = validation.errors.join(' | ');
      console.warn('Skipping BaseLinker sync due to validation errors', {
        productId: product.id,
        errors: validation.errors,
      });
      return {
        id: product.id,
        status: 'failed',
        message,
      };
    }

    const manufacturerId = await ensureManufacturerId(
      product.identification?.brand,
      baseInventoryId
    );

    const payload = mapToBaseLinkerProduct(
      product,
      baseInventoryId,
      { manufacturerId },
      validation.normalized
    );
    console.log('BaseLinker payload preview', {
      productId: product.id,
      name: payload.text_fields?.name,
      sku: payload.sku,
      price: payload.prices ? Object.values(payload.prices)[0] : undefined,
    });
    
    console.log('Syncing product to BaseLinker:', product.id);
    const result = await makeBaseLinkerRequest('addInventoryProduct', payload);
    
    if (result.ok) {
      return {
        id: product.id,
        status: 'synced',
        message: 'Successfully synced to BaseLinker'
      };
    } else {
      console.error('BaseLinker sync failed', {
        productId: product.id,
        code: result.error?.code,
        message: result.error?.message,
      });
      return {
        id: product.id,
        status: 'failed',
        message: result.error.message || 'Sync failed'
      };
    }
  } catch (error) {
    console.error('Failed to sync product:', error);
    return {
      id: product.id,
      status: 'failed',
      message: error.message
    };
  }
}

/**
 * Syncs multiple products to BaseLinker
 */
async function syncProductsToBaseLinker(products) {
  // Process products with controlled concurrency
  const results = [];
  
  for (const product of products) {
    const result = await syncProductToBaseLinker(product);
    results.push(result);
  }
  
  return results;
}

module.exports = {
  syncProductToBaseLinker,
  syncProductsToBaseLinker
};
