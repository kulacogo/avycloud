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
  try {
    const created = await callBigCommerce(`/catalog/brands`, {
      method: 'POST',
      body: { name },
    });
    return created?.data?.id || null;
  } catch (e) {
    // Duplicate brand names can happen due to normalization rules; recover by re-querying.
    const msg = String(e?.message || '');
    if (msg.includes('(409)') || /duplicate brand/i.test(msg) || /duplicate/i.test(msg)) {
      const retry = await callBigCommerce(`/catalog/brands?name=${encodeURIComponent(name)}`, { method: 'GET' });
      const list2 = Array.isArray(retry?.data) ? retry.data : [];
      const m2 =
        list2.find((b) => String(b?.name || '').trim().toLowerCase() === name.toLowerCase()) || list2[0];
      return m2?.id || null;
    }
    throw e;
  }
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

async function getBigCommerceProduct(productId, { include = [] } = {}) {
  const id = String(productId || '').trim();
  if (!id) return null;
  const includeParts = Array.isArray(include) ? include.filter(Boolean) : [];
  const qs = includeParts.length ? `?include=${encodeURIComponent(includeParts.join(','))}` : '';
  const payload = await callBigCommerce(`/catalog/products/${encodeURIComponent(id)}${qs}`, { method: 'GET' });
  return payload?.data || null;
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
  const envMax = parseInt(process.env.BIGCOMMERCE_MAX_IMAGES || '', 10);
  const effectiveMax = Number.isFinite(envMax) && envMax > 0 ? envMax : max;
  const imgs = Array.isArray(product?.details?.images) ? product.details.images : [];
  const urls = imgs
    .map((img) => safeString(img?.url_or_base64))
    .filter((u) => u && (u.startsWith('http://') || u.startsWith('https://')))
    .filter((u) => {
      if (!u) return false;
      if (/\s/.test(u)) return false;
      if (u.length > 2000) return false;
      try {
        // Validate URL format
        // eslint-disable-next-line no-new
        new URL(u);
        return true;
      } catch {
        return false;
      }
    });
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= effectiveMax) break;
  }
  return out;
}

function pickHighlights(product) {
  const list = Array.isArray(product?.details?.key_features) ? product.details.key_features : [];
  return list.map((x) => safeString(x)).filter(Boolean);
}

function pickEanGtin(product) {
  const ids = product?.details?.identifiers || {};
  return {
    ean: safeString(ids.ean),
    gtin: safeString(ids.gtin),
    upc: safeString(ids.upc),
  };
}

function pickMpn(product) {
  const ids = product?.details?.identifiers || {};
  const attrs = product?.details?.attributes || {};
  return safeString(ids.mpn) || safeString(attrs.Herstellernummer) || safeString(attrs.MPN) || '';
}

function pickKTyp(product) {
  const attrs = product?.details?.attributes || {};
  const key = Object.keys(attrs || {}).find((k) => {
    const lower = String(k || '').trim().toLowerCase();
    return lower === 'k-typ' || lower === 'ktyp' || lower === 'k typ';
  });
  return key ? safeString(attrs[key]) : '';
}

function buildCustomFieldsFromProduct(product) {
  const fields = [];
  const ktyp = pickKTyp(product);
  const mpn = pickMpn(product);
  const { ean, gtin, upc } = pickEanGtin(product);
  const highlights = pickHighlights(product);

  const push = (name, value) => {
    let v = safeString(value);
    if (!v) return;
    // BigCommerce custom_fields values are validated; keep them compact and safe.
    v = v.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+/g, ' | ').replace(/\s+/g, ' ').trim();
    const MAX_LEN = 250;
    if (v.length > MAX_LEN) v = `${v.slice(0, MAX_LEN - 1)}…`;
    fields.push({ name, value: v });
  };

  push('K-Typ', ktyp);
  push('MPN', mpn);
  push('EAN', ean);
  push('GTIN', gtin);
  push('UPC', upc);
  if (highlights.length) {
    push('Highlights', highlights.join(' | '));
  }
  return fields;
}

function mergeCustomFields(existingFields = [], desiredFields = []) {
  const existing = Array.isArray(existingFields) ? existingFields : [];
  const desired = Array.isArray(desiredFields) ? desiredFields : [];
  const byName = new Map();
  for (const f of existing) {
    const n = safeString(f?.name);
    if (!n) continue;
    // Preserve BigCommerce custom field `id` so PUT can update instead of trying to create duplicates.
    const id = f?.id ?? null;
    byName.set(n.toLowerCase(), { ...(id ? { id } : {}), name: n, value: safeString(f?.value) });
  }
  for (const f of desired) {
    const n = safeString(f?.name);
    if (!n) continue;
    const key = n.toLowerCase();
    const prev = byName.get(key) || null;
    // If the field already exists, keep its id.
    byName.set(key, { ...(prev?.id ? { id: prev.id } : {}), name: n, value: safeString(f?.value) });
  }
  return Array.from(byName.values()).filter((f) => f.name && f.value);
}

function buildCreatePayloadFromProduct(product, { categoryId = null, brandId = null } = {}) {
  const sku = pickSku(product);
  const name = safeString(product?.identification?.name).slice(0, 250);
  const price = pickPrice(product);
  const weight = pickWeight(product);
  const description = safeString(product?.details?.description) || safeString(product?.details?.short_description) || '';
  const qty = computeAvailableQty(product);
  const images = pickImages(product, 50);
  const customFields = buildCustomFieldsFromProduct(product);

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
    ...(customFields.length ? { custom_fields: customFields } : {}),
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
  const customFields = buildCustomFieldsFromProduct(product);

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
    ...(customFields.length ? { custom_fields: customFields } : {}),
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

async function deleteBigCommerceProductById(productId) {
  const id = String(productId || '').trim();
  if (!id) throw new Error('Missing BigCommerce productId');
  await callBigCommerce(`/catalog/products/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return true;
}

async function deleteBigCommerceProductBySku(sku) {
  const existing = await findBigCommerceProductBySku(sku);
  if (!existing?.id) return { ok: false, reason: 'not_found' };
  await deleteBigCommerceProductById(existing.id);
  return { ok: true, id: existing.id };
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
  const isRateLimit = (err) => {
    const msg = String(err?.message || '');
    return msg.includes('(429)') || msg.includes('HTTP 429') || /rate/i.test(msg);
  };
  for (let i = 0; i < urls.length; i += 1) {
    const u = safeString(urls[i]);
    if (!u) continue;
    if (existingUrls.has(u)) {
      skipped += 1;
      continue;
    }
    // Avoid rate limits: small pacing + retry on 429.
    const payload = {
      image_url: u,
      is_thumbnail: false,
      sort_order: existing.length + added + 1,
      description: '',
    };
    let ok = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await addProductImage(productId, payload);
        ok = true;
        break;
      } catch (e) {
        if (isRateLimit(e) && attempt < 2) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
    if (ok) {
      added += 1;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 250));
    }
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

  if (product?.ops?.bigcommerce?.disabled) {
    return { id: product?.id, status: 'failed', message: 'BigCommerce sync disabled for this product.' };
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
      const loaded = await callBigCommerce(`/catalog/products/${encodeURIComponent(String(linkedId))}?include=custom_fields`, { method: 'GET' });
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
    let created;
    try {
      created = await createBigCommerceProduct(built.payload);
    } catch (e) {
      // Some external image URLs can be rejected (e.g. SVG, blocked hosts). Retry create without images.
      const msg = String(e?.message || '');
      if (msg.includes('image_url') || msg.includes('(400)') || msg.includes('(422)')) {
        const retryPayload = { ...built.payload };
        delete retryPayload.images;
        try {
          created = await createBigCommerceProduct(retryPayload);
        } catch (e2) {
          throw e;
        }
      } else {
        throw e;
      }
    }
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

  // Merge custom fields non-destructively: preserve existing custom fields and upsert ours.
  if (built?.payload?.custom_fields) {
    const existingFull =
      existing?.custom_fields
        ? existing
        : await getBigCommerceProduct(existing.id, { include: ['custom_fields'] }).catch(() => existing);
    const existingFields = Array.isArray(existingFull?.custom_fields) ? existingFull.custom_fields : [];
    built.payload.custom_fields = mergeCustomFields(existingFields, built.payload.custom_fields);
  }

  const updated = await updateBigCommerceProduct(existing.id, built.payload);
  const imgs = pickImages(product, 50);
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
  deleteBigCommerceProductBySku,
  deleteBigCommerceProductById,
  syncProductToBigCommerce,
  syncProductsToBigCommerce,
};

