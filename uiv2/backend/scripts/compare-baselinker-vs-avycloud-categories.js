/* eslint-disable no-console */
/**
 * Compare BaseLinker Inventory products vs AvyCloud products:
 * - Match by normalized SKU (same normalization as backend/lib/baselinker.js)
 * - Compare category breadcrumb paths (BaseLinker category_id -> breadcrumb, AvyCloud identification.category / ebay taxonomy)
 *
 * Outputs:
 * - summary.json
 * - mismatches.csv
 * - matches.csv
 * - missing_in_bl.csv
 * - missing_in_avy.csv
 *
 * Usage:
 *   NODE_PATH=backend/node_modules GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/compare-baselinker-vs-avycloud-categories.js --inventory-id 78659
 */

const fs = require('fs');
const path = require('path');

const { getAllProducts } = require('../lib/firestore');
const { callBaseLinker } = require('../lib/baselinker');
const { findEbayCategory } = require('../lib/ebay-taxonomy');

const OUT_ROOT = path.join(process.cwd(), 'exports', 'baselinker-category-compare');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const safeString = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());

const normalizeSkuValue = (val) =>
  (val || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^sku[-\s]*/i, '')
    .replace(/\s+/g, '');

function normalizeProductListPayload(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).map(([key, value]) => ({ id: key, ...(value || {}) }));
  }
  return [];
}

function normalizeCategoryPath(pathStr) {
  const segments = safeString(pathStr)
    .split('>')
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
  return segments.join(' > ');
}

function normalizePathKey(pathStr) {
  // Compare categories across systems: normalize aggressively (punctuation/umlauts),
  // because BaseLinker inventory categories often differ slightly in formatting
  // from eBay-style breadcrumbs stored in AvyCloud (e.g. ":" "," "&" variations).
  const value = safeString(pathStr);
  if (!value) return '';
  return value
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/[\u2010-\u2015-]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadBaseLinkerCategories(inventoryId) {
  const resp = await callBaseLinker('getInventoryCategories', { inventory_id: Number(inventoryId) });
  const cats = Array.isArray(resp?.categories) ? resp.categories : [];

  const byId = new Map();
  cats.forEach((c) => {
    const id = Number(c?.category_id);
    if (!Number.isFinite(id) || id <= 0) return;
    byId.set(id, {
      id,
      name: safeString(c?.name),
      parentId: Number((c?.parent_id ?? c?.parent_category_id) || 0) || 0,
    });
  });

  const memo = new Map(); // id -> segments[]
  const buildSegments = (id, stack = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    const node = byId.get(id);
    if (!node || !node.name) {
      memo.set(id, []);
      return [];
    }
    if (stack.has(id)) {
      const segs = [node.name];
      memo.set(id, segs);
      return segs;
    }
    stack.add(id);
    const parentSegs = node.parentId && byId.has(node.parentId) ? buildSegments(node.parentId, stack) : [];
    stack.delete(id);
    const segs = [...parentSegs, node.name];
    memo.set(id, segs);
    return segs;
  };

  const idToBreadcrumb = new Map();
  for (const id of byId.keys()) {
    const segs = buildSegments(id);
    const breadcrumb = normalizeCategoryPath(segs.join(' > '));
    if (breadcrumb) idToBreadcrumb.set(id, breadcrumb);
  }

  return { byId, idToBreadcrumb };
}

async function loadAllBaseLinkerInventoryProducts(inventoryId) {
  const PRODUCTS_PER_PAGE = 1000;
  const MAX_PAGES = 2000;
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await callBaseLinker('getInventoryProductsList', { inventory_id: Number(inventoryId), page });
    const products = normalizeProductListPayload(res?.products || res?.items || []);
    out.push(...products);
    if (products.length < PRODUCTS_PER_PAGE) break;
  }
  return out;
}

function chunkArray(arr, chunkSize) {
  const out = [];
  for (let i = 0; i < arr.length; i += chunkSize) out.push(arr.slice(i, i + chunkSize));
  return out;
}

async function loadBaseLinkerProductsData(inventoryId, productIds = []) {
  // Doc doesn't clearly state an upper bound for `products` length; stay conservative.
  const BATCH = 100;
  const chunks = chunkArray(productIds, BATCH);
  const out = new Map(); // id -> data
  for (const ids of chunks) {
    const resp = await callBaseLinker('getInventoryProductsData', {
      inventory_id: Number(inventoryId),
      products: ids.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0),
    });
    const raw = resp?.products || {};
    const entries = raw && typeof raw === 'object' ? Object.entries(raw) : [];
    for (const [idStr, data] of entries) {
      const id = Number(idStr);
      if (!Number.isFinite(id) || id <= 0) continue;
      out.set(id, data || {});
    }
  }
  return out;
}

function pickAvyCategory(product) {
  const cat = safeString(product?.identification?.category);
  if (cat && cat.includes('>')) return normalizeCategoryPath(cat);
  const catId = safeString(product?.details?.categoryId);
  if (catId) {
    const resolved = findEbayCategory(catId);
    const breadcrumb = resolved?.breadcrumb ? String(resolved.breadcrumb) : '';
    if (breadcrumb && breadcrumb.includes('>')) return normalizeCategoryPath(breadcrumb);
  }
  return '';
}

function csvEscape(value, delimiter = ';') {
  const str = value == null ? '' : String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (new RegExp(`[\"\\n${delimiter}]`).test(str) || /^\s|\s$/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(headers, rows, delimiter = ';') {
  const lines = [];
  lines.push(headers.join(delimiter));
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h], delimiter)).join(delimiter));
  }
  return lines.join('\n') + '\n';
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const inventoryId = safeString(args['inventory-id'] || process.env.BASELINKER_INVENTORY_ID || '78659');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(OUT_ROOT, ts);
  ensureDir(outDir);

  console.log(`[compare] loading BaseLinker categories (inventory ${inventoryId})…`);
  const { idToBreadcrumb } = await loadBaseLinkerCategories(inventoryId);

  console.log(`[compare] loading BaseLinker inventory products…`);
  const blProductsRaw = await loadAllBaseLinkerInventoryProducts(inventoryId);
  console.log(`[compare] BaseLinker products: ${blProductsRaw.length}`);

  const blIds = blProductsRaw
    .map((p) => Number(p?.id || p?.product_id || 0))
    .filter((n) => Number.isFinite(n) && n > 0);
  console.log('[compare] loading BaseLinker product details (category_id)…');
  const blDetailsById = await loadBaseLinkerProductsData(inventoryId, blIds);

  const blBySku = new Map(); // normSku -> entry
  for (const entry of blProductsRaw) {
    const sku = safeString(entry?.sku || entry?.product_sku || '');
    const normSku = normalizeSkuValue(sku);
    if (!normSku) continue;
    const pid = Number(entry?.id || entry?.product_id || 0) || 0;
    const details = pid ? blDetailsById.get(pid) || {} : {};
    const categoryId = Number(details?.category_id || 0) || 0;
    const breadcrumb = categoryId ? idToBreadcrumb.get(categoryId) || '' : '';
    const textFields = details?.text_fields && typeof details.text_fields === 'object' ? details.text_fields : {};
    const nameFromDetails = safeString(textFields?.name || textFields?.['name|de'] || '');
    blBySku.set(normSku, {
      sku: sku || '',
      normSku,
      product_id: pid || entry?.id || '',
      title: nameFromDetails || safeString(entry?.name || entry?.product_name || ''),
      category_id: categoryId || '',
      category_path: breadcrumb || '',
    });
  }

  console.log('[compare] loading AvyCloud products…');
  const avyProducts = await getAllProducts();
  console.log(`[compare] AvyCloud products: ${Array.isArray(avyProducts) ? avyProducts.length : 0}`);

  const avyBySku = new Map(); // normSku -> entry
  for (const p of Array.isArray(avyProducts) ? avyProducts : []) {
    const sku = safeString(p?.identification?.sku) || safeString(p?.details?.identifiers?.sku);
    const normSku = normalizeSkuValue(sku);
    if (!normSku) continue;
    avyBySku.set(normSku, {
      sku: sku || '',
      normSku,
      product_id: safeString(p?.id),
      title: safeString(p?.identification?.name),
      category_path: pickAvyCategory(p),
    });
  }

  const allSkus = new Set([...blBySku.keys(), ...avyBySku.keys()]);
  const mismatches = [];
  const matches = [];
  const missingInBl = [];
  const missingInAvy = [];
  let bothEmpty = 0;
  let blEmpty = 0;
  let avyEmpty = 0;

  for (const normSku of allSkus) {
    const bl = blBySku.get(normSku) || null;
    const avy = avyBySku.get(normSku) || null;
    if (!bl && avy) {
      missingInBl.push({ ...avy, missing: 'missing_in_baselinker' });
      continue;
    }
    if (bl && !avy) {
      missingInAvy.push({ ...bl, missing: 'missing_in_avycloud' });
      continue;
    }
    if (!bl || !avy) continue;

    const blKey = normalizePathKey(bl.category_path);
    const avyKey = normalizePathKey(avy.category_path);
    if (!blKey && !avyKey) bothEmpty += 1;
    else if (!blKey) blEmpty += 1;
    else if (!avyKey) avyEmpty += 1;
    const same = blKey === avyKey;
    const row = {
      sku: avy.sku || bl.sku,
      normSku,
      avy_product_id: avy.product_id,
      bl_product_id: bl.product_id,
      avy_title: avy.title,
      bl_title: bl.title,
      avy_category: avy.category_path,
      bl_category: bl.category_path,
      bl_category_id: bl.category_id,
    };
    if (same) matches.push(row);
    else mismatches.push(row);
  }

  const summary = {
    inventoryId,
    outDir,
    counts: {
      baselinker_products: blProductsRaw.length,
      baselinker_distinct_skus: blBySku.size,
      avycloud_products: Array.isArray(avyProducts) ? avyProducts.length : 0,
      avycloud_distinct_skus: avyBySku.size,
      compared_distinct_skus: allSkus.size,
      matches: matches.length,
      mismatches: mismatches.length,
      missing_in_baselinker: missingInBl.length,
      missing_in_avycloud: missingInAvy.length,
      category_empty_both: bothEmpty,
      category_empty_in_baselinker: blEmpty,
      category_empty_in_avycloud: avyEmpty,
    },
  };

  const headers = [
    'sku',
    'normSku',
    'avy_product_id',
    'bl_product_id',
    'avy_title',
    'bl_title',
    'avy_category',
    'bl_category',
    'bl_category_id',
  ];

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, 'mismatches.csv'), toCsv(headers, mismatches));
  fs.writeFileSync(path.join(outDir, 'matches.csv'), toCsv(headers, matches));
  fs.writeFileSync(path.join(outDir, 'missing_in_baselinker.csv'), toCsv(headers, missingInBl.map((x) => ({ ...x, bl_category: '', bl_category_id: '' }))));
  fs.writeFileSync(path.join(outDir, 'missing_in_avycloud.csv'), toCsv(headers, missingInAvy.map((x) => ({ ...x, avy_category: '' }))));

  // Also write a stable "latest" snapshot so users don't accidentally open an older run.
  const latestDir = path.join(OUT_ROOT, 'latest');
  ensureDir(latestDir);
  fs.writeFileSync(path.join(latestDir, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(latestDir, 'mismatches.csv'), toCsv(headers, mismatches));
  fs.writeFileSync(path.join(latestDir, 'matches.csv'), toCsv(headers, matches));
  fs.writeFileSync(
    path.join(latestDir, 'missing_in_baselinker.csv'),
    toCsv(headers, missingInBl.map((x) => ({ ...x, bl_category: '', bl_category_id: '' })))
  );
  fs.writeFileSync(
    path.join(latestDir, 'missing_in_avycloud.csv'),
    toCsv(headers, missingInAvy.map((x) => ({ ...x, avy_category: '' })))
  );

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

