/* eslint-disable no-console */
/**
 * Audit BaseLinker inventory for corrupted titles/brands by comparing:
 * - BaseLinker product_id -> current BL sku/name/manufacturer_id
 * - AvyCloud products that claim ops.baselinker.product_id
 *
 * Outputs a report under exports/baselinker-audit/{timestamp}/
 *
 * Usage:
 *   NODE_PATH=backend/node_modules GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/audit-baselinker-titles-brands.js --inventory-id 78659
 *
 * Optional:
 *   --search "VILLA GINARIO"   (find substrings in BL names)
 */

const fs = require('fs');
const path = require('path');

const { callBaseLinker } = require('../lib/baselinker');
const { getAllProducts } = require('../lib/firestore');

const OUT_ROOT = path.join(process.cwd(), 'exports', 'baselinker-audit');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const safeString = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());

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

function normalizeSkuValue(val) {
  return (val || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^sku[-\s]*/i, '')
    .replace(/\s+/g, '');
}

function normalizeProductListPayload(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).map(([key, value]) => ({ id: key, ...(value || {}) }));
  }
  return [];
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function loadAllInventoryProducts(inventoryId) {
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

async function loadProductsData(inventoryId, productIds) {
  const out = new Map();
  for (const ids of chunk(productIds, 100)) {
    const resp = await callBaseLinker('getInventoryProductsData', {
      inventory_id: Number(inventoryId),
      products: ids.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0),
    });
    const raw = resp?.products || {};
    Object.entries(raw || {}).forEach(([idStr, data]) => {
      const id = Number(idStr);
      if (!Number.isFinite(id) || id <= 0) return;
      out.set(id, data || {});
    });
  }
  return out;
}

async function loadManufacturers(inventoryId) {
  const PAGE_LIMIT = 200;
  const out = [];
  for (let page = 1; page <= PAGE_LIMIT; page += 1) {
    const res = await callBaseLinker('getInventoryManufacturers', { inventory_id: Number(inventoryId), page });
    const list = Array.isArray(res?.manufacturers) ? res.manufacturers : [];
    out.push(...list);
    if (list.length < 1000 && !res?.next_page) break;
    if (!list.length) break;
  }
  const byId = new Map();
  out.forEach((m) => {
    const id = Number(m?.manufacturer_id);
    if (!Number.isFinite(id) || id <= 0) return;
    byId.set(id, safeString(m?.name));
  });
  return byId;
}

async function main() {
  const args = parseArgs(process.argv);
  const inventoryId = safeString(args['inventory-id'] || process.env.BASELINKER_INVENTORY_ID || '78659');
  const search = safeString(args.search || '');

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(OUT_ROOT, ts);
  ensureDir(outDir);

  console.log(`[audit] loading BaseLinker products list (inventory ${inventoryId})…`);
  const list = await loadAllInventoryProducts(inventoryId);
  const ids = list.map((p) => Number(p?.id || 0)).filter((n) => Number.isFinite(n) && n > 0);
  console.log(`[audit] BaseLinker products: ${list.length}`);

  console.log('[audit] loading BaseLinker product details (manufacturer_id + text_fields)…');
  const detailsById = await loadProductsData(inventoryId, ids);

  console.log('[audit] loading BaseLinker manufacturers…');
  const mfgById = await loadManufacturers(inventoryId);

  console.log('[audit] loading AvyCloud products…');
  const avy = await getAllProducts();
  const avyByBlId = new Map(); // bl product_id -> product
  const avyBySku = new Map(); // norm sku -> product

  (Array.isArray(avy) ? avy : []).forEach((p) => {
    const blId = Number(p?.ops?.baselinker?.product_id || p?.ops?.base_product_id || 0);
    if (Number.isFinite(blId) && blId > 0) {
      // If duplicates exist, keep the first and count later.
      if (!avyByBlId.has(blId)) avyByBlId.set(blId, p);
    }
    const sku = safeString(p?.identification?.sku || p?.details?.identifiers?.sku);
    const key = normalizeSkuValue(sku);
    if (key && !avyBySku.has(key)) avyBySku.set(key, p);
  });

  const rows = [];
  const searchHits = [];
  let mapped = 0;
  let titleMismatch = 0;
  let brandMismatch = 0;
  let unmapped = 0;

  for (const entry of list) {
    const blProductId = Number(entry?.id || 0);
    if (!Number.isFinite(blProductId) || blProductId <= 0) continue;

    const sku = safeString(entry?.sku);
    const name = safeString(entry?.name);
    const normSku = normalizeSkuValue(sku);

    const details = detailsById.get(blProductId) || {};
    const textFields = details?.text_fields && typeof details.text_fields === 'object' ? details.text_fields : {};
    const blName = safeString(textFields?.name || textFields?.['name|de'] || name);
    const manufacturerId = Number(details?.manufacturer_id || 0) || 0;
    const manufacturerName = manufacturerId ? safeString(mfgById.get(manufacturerId) || '') : '';

    const avyProduct = avyByBlId.get(blProductId) || (normSku ? avyBySku.get(normSku) : null) || null;

    if (search) {
      const hay = `${blName} ${manufacturerName} ${sku}`.toLowerCase();
      if (hay.includes(search.toLowerCase())) {
        searchHits.push({ bl_product_id: blProductId, sku, bl_name: blName, manufacturer: manufacturerName });
      }
    }

    if (!avyProduct) {
      unmapped += 1;
      rows.push({
        bl_product_id: blProductId,
        bl_sku: sku,
        bl_name: blName,
        bl_manufacturer: manufacturerName,
        avy_product_id: '',
        avy_sku: '',
        avy_name: '',
        avy_brand: '',
        match_source: '',
        title_match: '',
        brand_match: '',
      });
      continue;
    }

    mapped += 1;
    const avyId = safeString(avyProduct?.id);
    const avySku = safeString(avyProduct?.identification?.sku || avyProduct?.details?.identifiers?.sku);
    const avyName = safeString(avyProduct?.identification?.name);
    const avyBrand = safeString(avyProduct?.identification?.brand);
    const matchSource = avyByBlId.get(blProductId) ? 'ops.product_id' : 'sku';

    const titleMatch = avyName && blName ? avyName.trim() === blName.trim() : false;
    const brandMatch = avyBrand && manufacturerName ? avyBrand.trim().toLowerCase() === manufacturerName.trim().toLowerCase() : false;
    if (!titleMatch) titleMismatch += 1;
    if (!brandMatch) brandMismatch += 1;

    rows.push({
      bl_product_id: blProductId,
      bl_sku: sku,
      bl_name: blName,
      bl_manufacturer: manufacturerName,
      avy_product_id: avyId,
      avy_sku: avySku,
      avy_name: avyName,
      avy_brand: avyBrand,
      match_source: matchSource,
      title_match: titleMatch ? 'yes' : 'no',
      brand_match: brandMatch ? 'yes' : 'no',
    });
  }

  const summary = {
    inventoryId,
    counts: {
      baselinker_total: list.length,
      mapped_to_avycloud: mapped,
      unmapped: unmapped,
      title_mismatch: titleMismatch,
      brand_mismatch: brandMismatch,
    },
    outDir,
    search,
    searchHitsPreview: searchHits.slice(0, 20),
  };

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, 'rows.json'), JSON.stringify(rows, null, 2));

  const headers = Object.keys(rows[0] || { bl_product_id: '', bl_sku: '' });
  const csvEscape = (v) => {
    const s = v == null ? '' : String(v).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (/[\";\n]/.test(s) || /^\s|\s$/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const csv = [headers.join(';')]
    .concat(rows.map((r) => headers.map((h) => csvEscape(r[h])).join(';')))
    .join('\n')
    .concat('\n');
  fs.writeFileSync(path.join(outDir, 'rows.csv'), csv);

  // Stable latest
  const latest = path.join(OUT_ROOT, 'latest');
  ensureDir(latest);
  fs.writeFileSync(path.join(latest, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(latest, 'rows.csv'), csv);

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

