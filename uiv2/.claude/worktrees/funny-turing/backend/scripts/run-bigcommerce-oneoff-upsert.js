/* eslint-disable no-console */
/**
 * One-off BigCommerce upsert from Firestore (AvyCloud is source of truth).
 *
 * Behavior:
 * - If a product exists in BigCommerce for a given SKU (variant SKU), UPDATE it.
 * - If not exists, CREATE it.
 *
 * Safety:
 * - Default is DRY-RUN (no BigCommerce API calls).
 * - Use --apply to perform writes.
 * - Produces an output report under exports/bigcommerce-sync/<timestamp>/.
 *
 * Credentials:
 * - Prefer env vars:
 *   BIGCOMMERCE_API_PATH="https://api.bigcommerce.com/stores/<store_hash>/v3"
 *   BIGCOMMERCE_ACCESS_TOKEN="<token>"
 * - Or pass --credentials-file pointing to a text file containing lines like:
 *   ACCESS TOKEN: ...
 *   API PATH: https://api.bigcommerce.com/stores/<hash>/v3/
 *
 * Required create fields (per BigCommerce docs): name, type, price, weight (often required), categories (store dependent).
 * This script is conservative: it will SKIP products missing required fields unless you pass --allow-missing <csv>
 * to provide safe fallbacks (not recommended unless you accept placeholder data).
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/run-bigcommerce-oneoff-upsert.js --dry-run
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/run-bigcommerce-oneoff-upsert.js --apply --expected-count 609 --default-category-id 23
 *
 * Options:
 *   --apply                    Actually call BigCommerce API (default: dry-run)
 *   --dry-run                  Do not call BigCommerce API (default)
 *   --expected-count <n>       Required with --apply: total Firestore product count safety guard
 *   --limit <n>                Limit Firestore products (debug)
 *   --offset <n>               Offset Firestore products (debug)
 *   --default-category-id <n>  Required for CREATE (unless your store allows empty categories)
 *   --credentials-file <path>  Read API path and token from a local file
 *   --concurrency <n>          Default 2
 *   --sync-images              Also sync images non-destructively (default true)
 *   --no-sync-images           Disable image sync
 */
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { getAllProducts } = require('../lib/firestore');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeSku(v) {
  return safeString(v).replace(/\s+/g, '').toUpperCase();
}

function parseCredentialsFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  // Some exported credential files use CR-only separators (\r) instead of \n.
  // Also, some formats are freeform; prefer robust regex extraction first.
  const out = {};
  try {
    const tokenMatch = text.match(/ACCESS\s+TOKEN:\s*([^\r\n]+)/i);
    if (tokenMatch && tokenMatch[1]) out.token = tokenMatch[1].trim();
    const apiPathMatch = text.match(/API\s+PATH:\s*([^\r\n]+)/i);
    if (apiPathMatch && apiPathMatch[1]) out.apiPath = apiPathMatch[1].trim();
  } catch {
    // ignore
  }

  if (out.token && out.apiPath) return out;

  const lines = text
    .split(/\r\n|\n|\r/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!value) continue;
    if (key === 'access token') out.token = value;
    if (key === 'api path') out.apiPath = value;
  }
  return out;
}

function parseArgs(argv) {
  const args = {
    dryRun: true,
    apply: false,
    expectedCount: 0,
    limit: 0,
    offset: 0,
    defaultCategoryId: 0,
    credentialsFile: '',
    concurrency: 2,
    syncImages: true,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--apply') { args.apply = true; args.dryRun = false; }
    if (t === '--dry-run') { args.dryRun = true; args.apply = false; }
    if (t === '--expected-count') { args.expectedCount = Number(argv[i + 1]); i += 1; }
    if (t === '--limit') { args.limit = Number(argv[i + 1]); i += 1; }
    if (t === '--offset') { args.offset = Number(argv[i + 1]); i += 1; }
    if (t === '--default-category-id') { args.defaultCategoryId = Number(argv[i + 1]); i += 1; }
    if (t === '--credentials-file') { args.credentialsFile = String(argv[i + 1] || '').trim(); i += 1; }
    if (t === '--concurrency') { args.concurrency = Math.max(1, Number(argv[i + 1]) || 2); i += 1; }
    if (t === '--sync-images') args.syncImages = true;
    if (t === '--no-sync-images') args.syncImages = false;
  }
  return args;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callBigCommerce({ apiBase, token, method, pathName, query, body, retries = 5 }) {
  const url = new URL(apiBase.replace(/\/+$/, '') + '/' + String(pathName || '').replace(/^\/+/, ''));
  if (query && typeof query === 'object') {
    Object.entries(query).forEach(([k, v]) => {
      if (v === undefined || v === null || v === '') return;
      url.searchParams.set(k, String(v));
    });
  }

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: {
          'X-Auth-Token': token,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }

      if (res.status === 429 || res.status === 503) {
        if (attempt < retries) {
          const waitMs = Math.min(60_000, 1_000 * Math.pow(2, attempt));
          await sleep(waitMs);
          continue;
        }
      }

      if (!res.ok) {
        const msg =
          (json && (json.title || json.message)) ||
          (json && json?.errors && JSON.stringify(json.errors)) ||
          text ||
          `HTTP ${res.status}`;
        const err = new Error(`BigCommerce API error (${res.status}): ${msg}`);
        err.status = res.status;
        err.body = json || text;
        throw err;
      }
      return json;
    } catch (err) {
      clearTimeout(timeout);
      const isLast = attempt >= retries;
      if (isLast) throw err;
      // network/timeout: retry with backoff
      const waitMs = Math.min(60_000, 750 * Math.pow(2, attempt));
      await sleep(waitMs);
    }
  }
  throw new Error('Unreachable');
}

function pickSku(product) {
  return (
    safeString(product?.identification?.sku) ||
    safeString(product?.details?.identifiers?.sku) ||
    safeString(product?.id) ||
    ''
  );
}

function pickName(product) {
  return safeString(product?.identification?.name) || safeString(product?.id) || '';
}

function pickBrand(product) {
  return safeString(product?.identification?.brand);
}

function pickDescription(product) {
  return (
    safeString(product?.details?.description) ||
    safeString(product?.details?.short_description) ||
    ''
  );
}

function pickPrice(product) {
  const lowest = product?.details?.pricing?.lowest_price;
  const amount = typeof lowest?.amount === 'number' ? lowest.amount : null;
  if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) return amount;
  return null;
}

function pickWeightKg(product) {
  const attrs = product?.details?.attributes || {};
  const candidates = [
    attrs['Gewicht (kg)'],
    attrs['Gewicht'],
    attrs['weight'],
    attrs['Weight'],
    product?.details?.weight,
    product?.details?.shipping?.weight,
  ];
  for (const v of candidates) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    if (typeof v === 'string') {
      const n = Number(String(v).replace(',', '.').replace(/[^\d.]+/g, ''));
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return null;
}

function pickImages(product, max = 8) {
  const imgs = Array.isArray(product?.details?.images) ? product.details.images : [];
  const urls = imgs
    .map((img) => safeString(img?.url_or_base64 || img?.url || img?.href))
    .filter((u) => /^https?:\/\//i.test(u));
  const unique = Array.from(new Set(urls));
  return unique.slice(0, max);
}

function pickIdentifiers(product) {
  const ids = product?.details?.identifiers || {};
  const ean = safeString(ids.ean || ids.gtin || ids.upc);
  const mpn = safeString(ids.mpn);
  return { ean: ean || null, mpn: mpn || null };
}

function buildCustomFields(product) {
  const attrs = product?.details?.attributes || {};
  const ids = pickIdentifiers(product);
  const fields = [];
  if (ids.mpn) fields.push({ name: 'MPN', value: ids.mpn });
  if (ids.ean) fields.push({ name: 'EAN', value: ids.ean });
  const ktyp = safeString(attrs['K-Typ'] || attrs['KTyp'] || attrs['KTYPNR']);
  if (ktyp) fields.push({ name: 'K-Typ', value: ktyp });
  const highlights = Array.isArray(product?.details?.key_features) ? product.details.key_features : [];
  if (highlights.length) fields.push({ name: 'Highlights', value: highlights.slice(0, 12).join(' | ') });
  return fields;
}

async function findOrCreateBrandId({ apiBase, token, name }) {
  const n = safeString(name);
  if (!n) return 0;
  // Try find by name filter first
  const res = await callBigCommerce({
    apiBase,
    token,
    method: 'GET',
    pathName: '/catalog/brands',
    query: { name: n, limit: 50 },
  });
  const items = Array.isArray(res?.data) ? res.data : [];
  const match = items.find((b) => safeString(b?.name).toLowerCase() === n.toLowerCase());
  if (match?.id) return Number(match.id);

  // Create
  const created = await callBigCommerce({
    apiBase,
    token,
    method: 'POST',
    pathName: '/catalog/brands',
    body: { name: n },
  });
  return Number(created?.data?.id || 0) || 0;
}

async function listAllProductsBySku({ apiBase, token }) {
  const map = new Map(); // sku -> { productId, variantId }
  let page = 1;
  const limit = 250;
  while (page < 10_000) {
    const res = await callBigCommerce({
      apiBase,
      token,
      method: 'GET',
      pathName: '/catalog/products',
      query: { include: 'variants', limit, page },
    });
    const data = Array.isArray(res?.data) ? res.data : [];
    data.forEach((p) => {
      const productId = Number(p?.id || 0) || 0;
      const variants = Array.isArray(p?.variants) ? p.variants : [];
      variants.forEach((v) => {
        const sku = normalizeSku(v?.sku);
        if (!sku) return;
        map.set(sku, { productId, variantId: Number(v?.id || 0) || 0 });
      });
    });
    if (data.length < limit) break;
    page += 1;
  }
  return map;
}

async function listProductImages({ apiBase, token, productId }) {
  const res = await callBigCommerce({
    apiBase,
    token,
    method: 'GET',
    pathName: `/catalog/products/${productId}/images`,
    query: { limit: 250 },
  });
  return Array.isArray(res?.data) ? res.data : [];
}

async function addProductImage({ apiBase, token, productId, imageUrl, isThumbnail, sortOrder }) {
  return await callBigCommerce({
    apiBase,
    token,
    method: 'POST',
    pathName: `/catalog/products/${productId}/images`,
    body: {
      image_url: imageUrl,
      is_thumbnail: Boolean(isThumbnail),
      sort_order: Number(sortOrder) || 0,
    },
  });
}

async function syncImagesNonDestructive({ apiBase, token, productId, imageUrls }) {
  if (!imageUrls.length) return { added: 0 };
  const existing = await listProductImages({ apiBase, token, productId });
  const existingUrls = new Set(
    existing
      .map((img) => safeString(img?.url_standard || img?.url_thumbnail || img?.image_url || img?.url_zoom))
      .filter(Boolean)
  );
  let added = 0;
  for (let i = 0; i < imageUrls.length; i += 1) {
    const u = imageUrls[i];
    if (!u) continue;
    if ([...existingUrls].some((eu) => eu.includes(u) || u.includes(eu))) continue;
    await addProductImage({ apiBase, token, productId, imageUrl: u, isThumbnail: i === 0, sortOrder: i + 1 });
    added += 1;
  }
  return { added };
}

function validateForUpsert({ sku, name, price, weight, defaultCategoryId, exists }) {
  const errors = [];
  if (!sku) errors.push('missing_sku');
  if (!name) errors.push('missing_name');
  if (!exists) {
    if (price == null) errors.push('missing_price_for_create');
    if (weight == null) errors.push('missing_weight_for_create');
    if (!defaultCategoryId) errors.push('missing_default_category_id_for_create');
  }
  return errors;
}

async function main() {
  const args = parseArgs(process.argv);
  const stamp = nowStamp();
  const outDir = path.join(process.cwd(), 'exports', 'bigcommerce-sync', stamp);
  ensureDir(outDir);

  const mode = args.apply ? 'APPLY' : 'DRY_RUN';
  const report = {
    mode,
    timestamp: new Date().toISOString(),
    counts: { total: 0, selected: 0, skipped: 0, created: 0, updated: 0, failed: 0, would_create: 0, would_update: 0 },
    config: {
      defaultCategoryId: args.defaultCategoryId || null,
      syncImages: args.syncImages,
      concurrency: args.concurrency,
    },
    failures: [],
    skipped: [],
  };

  let apiPath = process.env.BIGCOMMERCE_API_PATH || '';
  let token = process.env.BIGCOMMERCE_ACCESS_TOKEN || '';
  if (args.credentialsFile) {
    const parsed = parseCredentialsFile(args.credentialsFile);
    apiPath = apiPath || parsed.apiPath || '';
    token = token || parsed.token || '';
  }
  const apiBase = safeString(apiPath).replace(/\/+$/, '');
  if (!apiBase || !token) {
    throw new Error('Missing BigCommerce credentials: set BIGCOMMERCE_API_PATH and BIGCOMMERCE_ACCESS_TOKEN (or pass --credentials-file).');
  }

  console.log(`[bigcommerce] mode=${mode} out=${outDir}`);
  console.log(`[bigcommerce] apiBase=${apiBase.replace(/\/v3$/i, '/v3')} (token hidden)`);

  const products = await getAllProducts();
  report.counts.total = products.length;
  if (args.apply) {
    if (!Number.isFinite(args.expectedCount) || args.expectedCount <= 0) {
      throw new Error('[bigcommerce] ABORT: --apply requires --expected-count <number>');
    }
    if (products.length !== args.expectedCount) {
      throw new Error(`[bigcommerce] ABORT: expected=${args.expectedCount} but got=${products.length}`);
    }
  }

  const offset = Number.isFinite(args.offset) && args.offset > 0 ? Math.floor(args.offset) : 0;
  let selected = offset ? products.slice(offset) : products;
  if (Number.isFinite(args.limit) && args.limit > 0) {
    selected = selected.slice(0, Math.max(0, Math.floor(args.limit)));
  }
  report.counts.selected = selected.length;

  // Build SKU index from BigCommerce (variant SKU -> product id).
  // This is read-only and safe for dry-runs; it lets us accurately estimate create vs update.
  const existingSkuMap = await listAllProductsBySku({ apiBase, token });
  console.log(`[bigcommerce] existingSkuIndex=${existingSkuMap.size}`);

  const progressPath = path.join(outDir, 'progress.json');
  const resultsJsonlPath = path.join(outDir, 'results.jsonl');
  fs.writeFileSync(resultsJsonlPath, '', { encoding: 'utf8', flag: 'w' });
  fs.writeFileSync(progressPath, JSON.stringify({ ...report, updated_at_iso: new Date().toISOString() }, null, 2), 'utf8');

  let cursor = 0;
  const concurrency = Math.max(1, Math.floor(args.concurrency || 2));
  const worker = async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= selected.length) return;
      const p = selected[idx];

      const sku = normalizeSku(pickSku(p));
      const name = pickName(p);
      const price = pickPrice(p);
      const weight = pickWeightKg(p);
      const images = pickImages(p, 8);
      const brand = pickBrand(p);

      const existing = existingSkuMap.get(sku) || null;
      const exists = Boolean(existing?.productId);
      const errors = validateForUpsert({
        sku,
        name,
        price,
        weight,
        defaultCategoryId: args.defaultCategoryId,
        exists,
      });

      if (errors.length) {
        report.counts.skipped += 1;
        report.skipped.push({ id: safeString(p?.id), sku, errors });
        fs.appendFileSync(resultsJsonlPath, JSON.stringify({ idx, sku, id: safeString(p?.id), status: 'skipped', errors }) + '\n', 'utf8');
        fs.writeFileSync(progressPath, JSON.stringify({ ...report, updated_at_iso: new Date().toISOString() }, null, 2), 'utf8');
        continue;
      }

      if (!args.apply) {
        if (exists) report.counts.would_update += 1;
        else report.counts.would_create += 1;
        fs.appendFileSync(
          resultsJsonlPath,
          JSON.stringify({ idx, sku, id: safeString(p?.id), status: exists ? 'would_update' : 'would_create' }) + '\n',
          'utf8'
        );
        fs.writeFileSync(progressPath, JSON.stringify({ ...report, updated_at_iso: new Date().toISOString() }, null, 2), 'utf8');
        continue;
      }

      try {
        const brandId = brand ? await findOrCreateBrandId({ apiBase, token, name: brand }) : 0;
        const customFields = buildCustomFields(p);

        if (!exists) {
          const createPayload = {
            name,
            type: 'physical',
            price: String(price.toFixed(2)),
            weight: Number(weight),
            categories: [Number(args.defaultCategoryId)],
            description: pickDescription(p),
            is_visible: false,
            custom_fields: customFields,
            variants: [
              {
                sku,
                price: String(price.toFixed(2)),
              },
            ],
            ...(brandId ? { brand_id: brandId } : {}),
            ...(images.length
              ? {
                  images: images.map((u, i) => ({
                    image_url: u,
                    is_thumbnail: i === 0,
                    sort_order: i + 1,
                  })),
                }
              : {}),
          };

          const created = await callBigCommerce({
            apiBase,
            token,
            method: 'POST',
            pathName: '/catalog/products',
            body: createPayload,
          });
          const newId = Number(created?.data?.id || 0) || 0;
          report.counts.created += 1;
          if (newId && args.syncImages && images.length) {
            // Some stores do not accept images in create payload; best-effort add missing via images endpoint.
            await syncImagesNonDestructive({ apiBase, token, productId: newId, imageUrls: images }).catch(() => {});
          }
          fs.appendFileSync(resultsJsonlPath, JSON.stringify({ idx, sku, id: safeString(p?.id), status: 'created', productId: newId }) + '\n', 'utf8');
        } else {
          const productId = Number(existing.productId);
          const updatePayload = {
            name,
            type: 'physical',
            // Only send price/weight if we have values. Some existing products may be missing these in AvyCloud,
            // and we should not crash or overwrite with guessed defaults.
            ...(price != null ? { price: String(price.toFixed(2)) } : {}),
            ...(weight != null ? { weight: Number(weight) } : {}),
            description: pickDescription(p),
            custom_fields: customFields,
            ...(brandId ? { brand_id: brandId } : {}),
          };
          await callBigCommerce({
            apiBase,
            token,
            method: 'PUT',
            pathName: `/catalog/products/${productId}`,
            body: updatePayload,
          });
          report.counts.updated += 1;
          if (args.syncImages) {
            await syncImagesNonDestructive({ apiBase, token, productId, imageUrls: images }).catch(() => {});
          }
          fs.appendFileSync(resultsJsonlPath, JSON.stringify({ idx, sku, id: safeString(p?.id), status: 'updated', productId }) + '\n', 'utf8');
        }
      } catch (err) {
        report.counts.failed += 1;
        report.failures.push({ id: safeString(p?.id), sku, message: err?.message || String(err) });
        fs.appendFileSync(resultsJsonlPath, JSON.stringify({ idx, sku, id: safeString(p?.id), status: 'failed', error: err?.message || String(err) }) + '\n', 'utf8');
      } finally {
        fs.writeFileSync(progressPath, JSON.stringify({ ...report, updated_at_iso: new Date().toISOString() }, null, 2), 'utf8');
      }
    }
  };

  const workers = Array(Math.min(concurrency, selected.length)).fill(null).map(() => worker());
  await Promise.all(workers);

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(
    `[bigcommerce] DONE created=${report.counts.created} updated=${report.counts.updated} skipped=${report.counts.skipped} failed=${report.counts.failed}`
  );
  console.log(`[bigcommerce] report=${outDir}`);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});

