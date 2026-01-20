/* eslint-disable no-console */
const fetch = global.fetch || require('node-fetch');
const fs = require('fs');
const path = require('path');
const PQueue = require('p-queue').default || require('p-queue');

function backoffDelay(attempt) {
  const base = 500;
  const max = 8000;
  const delay = Math.min(base * 2 ** attempt, max);
  return delay + Math.random() * 250;
}

function getBigCommerceConfig() {
  const apiPathRaw = String(process.env.BIGCOMMERCE_API_PATH || '').trim();
  const storeHash = String(process.env.BIGCOMMERCE_STORE_HASH || '').trim();
  const token = String(process.env.BIGCOMMERCE_ACCESS_TOKEN || '').trim();
  const defaultCategoryId = String(process.env.BIGCOMMERCE_DEFAULT_CATEGORY_ID || '').trim();

  let apiBase = apiPathRaw || (storeHash ? `https://api.bigcommerce.com/stores/${storeHash}/v3/` : '');
  let accessToken = token;

  // Fallback: local credentials file (for manual runs / initial sync)
  // Does NOT print secrets; env vars still take precedence.
  if (!apiBase || !accessToken) {
    try {
      const credsDir = path.join(process.cwd(), 'bigcommerce');
      if (fs.existsSync(credsDir)) {
        const match = fs
          .readdirSync(credsDir)
          .filter((f) => /^BigCommerceAPI-credentials-.*\.txt$/i.test(f))
          .sort()
          .pop();
        if (match) {
          const txt = fs.readFileSync(path.join(credsDir, match), 'utf8');
          // File may be single-line; use regex to extract values robustly.
          const fileToken = (txt.match(/ACCESS TOKEN:\s*([A-Za-z0-9_]+)\b/i) || [])[1] || '';
          const fileApi = (txt.match(/API PATH:\s*(https?:\/\/\S+)\s*/i) || [])[1] || '';
          if (!accessToken && fileToken) accessToken = fileToken;
          if (!apiBase && fileApi) apiBase = fileApi;
        }
      }
    } catch {
      // ignore
    }
  }

  if (!apiBase) {
    throw new Error(
      'BigCommerce config missing: set BIGCOMMERCE_API_PATH or BIGCOMMERCE_STORE_HASH'
    );
  }
  if (!accessToken) {
    throw new Error('BigCommerce config missing: set BIGCOMMERCE_ACCESS_TOKEN');
  }

  return {
    apiBase: apiBase.endsWith('/') ? apiBase : `${apiBase}/`,
    token: accessToken,
    defaultCategoryId: defaultCategoryId ? parseInt(defaultCategoryId, 10) : null,
  };
}

async function callBigCommerce(path, { method = 'GET', body = null, retries = 4 } = {}) {
  const { apiBase, token } = getBigCommerceConfig();
  const url = path.startsWith('http') ? path : `${apiBase}${path.replace(/^\//, '')}`;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25_000);

      const resp = await fetch(url, {
        method,
        headers: {
          'X-Auth-Token': token,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const text = await resp.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = { raw: text };
      }

      if (resp.ok) return payload;

      if (resp.status === 429 || resp.status >= 500) {
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, backoffDelay(attempt)));
          continue;
        }
      }

      const msg =
        payload?.title ||
        payload?.error ||
        payload?.message ||
        payload?.raw ||
        `HTTP ${resp.status}`;
      throw new Error(`BigCommerce API error (${resp.status}): ${msg}`);
    } catch (err) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, backoffDelay(attempt)));
        continue;
      }
      throw err;
    }
  }

  throw new Error('BigCommerce request failed after retries');
}

async function findBigCommerceProductBySku(sku) {
  const s = String(sku || '').trim();
  if (!s) return null;
  // Docs: GET /catalog/products supports filter `sku`
  const payload = await callBigCommerce(`/catalog/products?sku=${encodeURIComponent(s)}`, {
    method: 'GET',
  });
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data.length ? data[0] : null;
}

async function findOrCreateBrandId(brandName) {
  const name = String(brandName || '').trim();
  if (!name) return null;

  // Docs: GET /catalog/brands can filter by name
  const list = await callBigCommerce(`/catalog/brands?name=${encodeURIComponent(name)}`, {
    method: 'GET',
  });
  const existing = Array.isArray(list?.data) ? list.data : [];
  const match = existing.find((b) => String(b?.name || '').trim().toLowerCase() === name.toLowerCase());
  if (match?.id) return match.id;

  // Docs: POST /catalog/brands requires `name`
  const created = await callBigCommerce(`/catalog/brands`, {
    method: 'POST',
    body: { name },
  });
  return created?.data?.id || null;
}

async function listProductImages(productId) {
  const id = String(productId || '').trim();
  if (!id) return [];
  const payload = await callBigCommerce(`/catalog/products/${encodeURIComponent(id)}/images`, {
    method: 'GET',
  });
  return Array.isArray(payload?.data) ? payload.data : [];
}

async function addProductImage(productId, image) {
  const id = String(productId || '').trim();
  if (!id) throw new Error('Missing productId for image upload');
  return callBigCommerce(`/catalog/products/${encodeURIComponent(id)}/images`, {
    method: 'POST',
    body: image,
  });
}

let cachedGuessedCategoryId = null;
async function guessDefaultCategoryId() {
  if (cachedGuessedCategoryId) return cachedGuessedCategoryId;
  try {
    // Prefer modern Category Trees endpoints
    const trees = await callBigCommerce('/catalog/trees', { method: 'GET' });
    const treeList = Array.isArray(trees?.data) ? trees.data : [];
    const treeId = treeList[0]?.id;
    if (treeId) {
      const cats = await callBigCommerce(`/catalog/trees/${encodeURIComponent(String(treeId))}/categories?limit=50`, {
        method: 'GET',
      });
      const catList = Array.isArray(cats?.data) ? cats.data : [];
      // Prefer a non-root category if available
      const nonRoot = catList.find((c) => (c?.parent_id || 0) !== 0) || catList[0];
      if (nonRoot?.id) {
        cachedGuessedCategoryId = nonRoot.id;
        return cachedGuessedCategoryId;
      }
    }
  } catch (e) {
    // ignore and try legacy
  }

  try {
    // Legacy fallback (may still work in many stores)
    const cats = await callBigCommerce('/catalog/categories?limit=50', { method: 'GET' });
    const catList = Array.isArray(cats?.data) ? cats.data : [];
    const nonRoot = catList.find((c) => (c?.parent_id || 0) !== 0) || catList[0];
    if (nonRoot?.id) {
      cachedGuessedCategoryId = nonRoot.id;
      return cachedGuessedCategoryId;
    }
  } catch (e) {
    // ignore
  }

  return null;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function computeAvailableQty(product) {
  const invAvail = Number(product?.inventory?.availableQuantity);
  if (Number.isFinite(invAvail)) return Math.max(0, invAvail);
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  const sumBins = bins.reduce((s, b) => s + (Number(b?.quantity) || 0), 0);
  if (sumBins > 0) return sumBins;
  const invQty = Number(product?.inventory?.quantity);
  if (Number.isFinite(invQty)) return Math.max(0, invQty);
  const invPhys = Number(product?.inventory?.physicalQuantity);
  if (Number.isFinite(invPhys)) return Math.max(0, invPhys);
  return 0;
}

function pickSku(product) {
  return safeString(product?.identification?.sku) || safeString(product?.details?.identifiers?.sku) || '';
}

function pickPrice(product) {
  const amount = product?.details?.pricing?.lowest_price?.amount;
  if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) return Number(amount);
  return null;
}

function pickWeight(product) {
  const w =
    product?.details?.weight ??
    product?.details?.attributes?.weight ??
    product?.ops?.weight ??
    null;
  const num = typeof w === 'number' ? w : w == null ? null : Number(String(w).trim());
  if (!Number.isFinite(num)) return null;
  if (num < 0) return null;
  return num;
}

function pickImages(product, max = 10) {
  const imgs = Array.isArray(product?.details?.images) ? product.details.images : [];
  const urls = imgs
    .map((img) => safeString(img?.url_or_base64))
    .filter((u) => u && (u.startsWith('http://') || u.startsWith('https://')));
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

function buildCreatePayloadFromProduct(product, { categoryId = null, brandId = null } = {}) {
  const sku = pickSku(product);
  const name = safeString(product?.identification?.name).slice(0, 250);
  const price = pickPrice(product);
  const weight = pickWeight(product);
  const description = safeString(product?.details?.description) || safeString(product?.details?.short_description) || '';
  const qty = computeAvailableQty(product);
  const images = pickImages(product, 10);

  const missing = [];
  if (!sku) missing.push('sku');
  if (!name) missing.push('name');
  if (price == null) missing.push('price');
  if (weight == null) missing.push('weight');

  // Docs mention categories required depending on product experience; we only send when configured.
  const categories = Number.isFinite(categoryId) ? [categoryId] : [];
  if (!categories.length) missing.push('categories');

  if (missing.length) {
    return { ok: false, missing, payload: null };
  }

  const payload = {
    name,
    type: 'physical',
    sku,
    weight,
    price,
    description,
    is_visible: true,
    categories,
    inventory_tracking: 'product',
    inventory_level: qty,
    ...(brandId ? { brand_id: brandId } : {}),
    // For create, attach images directly (docs allow `images` array on POST/PUT)
    images: images.map((url, i) => ({
      image_url: url,
      is_thumbnail: i === 0,
      sort_order: i + 1,
      description: '',
    })),
  };

  return { ok: true, missing: [], payload };
}

function buildUpdatePayloadFromProduct(product, { categoryId = null, brandId = null } = {}) {
  const sku = pickSku(product);
  const name = safeString(product?.identification?.name).slice(0, 250);
  const price = pickPrice(product);
  const weight = pickWeight(product);
  const description = safeString(product?.details?.description) || safeString(product?.details?.short_description) || '';
  const qty = computeAvailableQty(product);

  const missing = [];
  if (!sku) missing.push('sku');
  if (!name) missing.push('name');
  if (price == null) missing.push('price');
  if (weight == null) missing.push('weight');

  // categories are optional in update; we only send when configured to avoid overwriting.
  const payload = {
    name,
    type: 'physical',
    sku,
    weight,
    price,
    description,
    is_visible: true,
    inventory_tracking: 'product',
    inventory_level: qty,
    ...(brandId ? { brand_id: brandId } : {}),
    ...(Number.isFinite(categoryId) ? { categories: [categoryId] } : {}),
  };

  return { ok: missing.length === 0, missing, payload };
}

async function createBigCommerceProduct(payload) {
  const res = await callBigCommerce(`/catalog/products`, { method: 'POST', body: payload });
  return res?.data || null;
}

async function updateBigCommerceProduct(productId, payload) {
  const id = String(productId || '').trim();
  if (!id) throw new Error('Missing BigCommerce productId');
  const res = await callBigCommerce(`/catalog/products/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: payload,
  });
  return res?.data || null;
}

async function syncImagesNonDestructive(productId, imageUrls) {
  const urls = Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : [];
  if (!urls.length) return { added: 0, skipped: 0 };
  const existing = await listProductImages(productId);
  const existingUrls = new Set(
    existing.map((img) => safeString(img?.url_standard || img?.url_thumbnail || img?.image_url || img?.url_zoom || ''))
  );
  let added = 0;
  let skipped = 0;
  for (let i = 0; i < urls.length; i += 1) {
    const u = safeString(urls[i]);
    if (!u) continue;
    if (existingUrls.has(u)) {
      skipped += 1;
      continue;
    }
    await addProductImage(productId, {
      image_url: u,
      is_thumbnail: false,
      sort_order: existing.length + added + 1,
      description: '',
    });
    added += 1;
  }
  return { added, skipped };
}

/**
 * Create or update a single AvyCloud product in BigCommerce.
 * Returns a normalized result object for job aggregation.
 */
async function syncProductToBigCommerce(product) {
  const sku = pickSku(product);
  if (!sku) {
    return { id: product?.id, status: 'failed', message: 'Missing SKU (identification.sku)' };
  }

  const cfg = getBigCommerceConfig();
  const categoryId = cfg.defaultCategoryId ?? (await guessDefaultCategoryId());

  let brandId = null;
  try {
    brandId = await findOrCreateBrandId(product?.identification?.brand);
  } catch (e) {
    // Non-fatal; product can still be synced without brand_id.
    console.warn('[bigcommerce] brand sync failed (continuing):', e?.message || e);
  }

  // Prefer stored linkage if present
  const linkedId = product?.ops?.bigcommerce?.product_id ?? null;
  let existing = null;
  if (linkedId) {
    try {
      const loaded = await callBigCommerce(`/catalog/products/${encodeURIComponent(String(linkedId))}`, { method: 'GET' });
      existing = loaded?.data || null;
    } catch {
      existing = null;
    }
  }
  if (!existing) {
    existing = await findBigCommerceProductBySku(sku);
  }

  if (!existing) {
    const built = buildCreatePayloadFromProduct(product, { categoryId, brandId });
    if (!built.ok) {
      return {
        id: product?.id,
        status: 'failed',
        message: `Missing required fields for create: ${built.missing.join(', ')} (set BIGCOMMERCE_DEFAULT_CATEGORY_ID if categories are required)`,
      };
    }
    const created = await createBigCommerceProduct(built.payload);
    const bcId = created?.id || null;
    return {
      id: product?.id,
      status: 'synced',
      action: 'created',
      bigcommerce_product_id: bcId,
      sku,
    };
  }

  const built = buildUpdatePayloadFromProduct(product, { categoryId, brandId });
  if (!built.ok) {
    return {
      id: product?.id,
      status: 'failed',
      message: `Missing required fields for update: ${built.missing.join(', ')}`,
      bigcommerce_product_id: existing?.id || null,
      sku,
    };
  }

  const updated = await updateBigCommerceProduct(existing.id, built.payload);
  const imgs = pickImages(product, 10);
  try {
    await syncImagesNonDestructive(existing.id, imgs);
  } catch (e) {
    console.warn('[bigcommerce] image sync failed (continuing):', e?.message || e);
  }

  return {
    id: product?.id,
    status: 'synced',
    action: 'updated',
    bigcommerce_product_id: updated?.id || existing?.id || null,
    sku,
  };
}

async function syncProductsToBigCommerce(products = [], { onProgress } = {}) {
  const list = Array.isArray(products) ? products : [];
  const concurrency = Math.max(
    1,
    parseInt(process.env.BIGCOMMERCE_SYNC_CONCURRENCY || process.env.BIGCOMMERCE_JOB_CONCURRENCY || '2', 10)
  );
  const queue = new PQueue({ concurrency });
  const results = new Array(list.length);

  await Promise.all(
    list.map((p, idx) =>
      queue.add(async () => {
        let result;
        try {
          result = await syncProductToBigCommerce(p);
        } catch (e) {
          result = {
            id: p?.id,
            status: 'failed',
            message: e?.message || String(e),
          };
        }
        results[idx] = result;
        if (typeof onProgress === 'function') {
          await onProgress({ result });
        }
      })
    )
  );

  return results.filter(Boolean);
}

module.exports = {
  getBigCommerceConfig,
  callBigCommerce,
  findBigCommerceProductBySku,
  syncProductToBigCommerce,
  syncProductsToBigCommerce,
};

