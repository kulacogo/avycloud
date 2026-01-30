/* eslint-disable no-console */
/**
 * Repair wrong titles/brands by reconciling AvyCloud with BaseLinker inventory.
 *
 * Strategy (deterministic, no guessing):
 * - Use BaseLinker inventory as source-of-truth for brand (manufacturer) and base name (text_fields.name).
 * - For each AvyCloud product that is linked to a BaseLinker product_id:
 *   - If AvyCloud brand differs from BaseLinker manufacturer name => update AvyCloud brand (+ attrs Marke/Hersteller).
 *   - If AvyCloud title differs from BaseLinker name => compute a policy-coerced title from the BL name on the
 *     patched product and save it (skipTitlePolicy so Firestore won't re-coerce again).
 * - Optionally also push the corrected name/manufacturer back to BaseLinker (idempotent) via addInventoryProduct.
 *
 * Outputs: exports/baselinker-repair/{timestamp}/report.json + report.csv
 *
 * Usage:
 *   NODE_PATH=backend/node_modules GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/repair-avycloud-and-baselinker-titles-brands.js --inventory-id 78659
 *
 * Apply:
 *   ... --apply-avy
 *   ... --apply-avy --apply-bl
 */

const fs = require('fs');
const path = require('path');

const { callBaseLinker } = require('../lib/baselinker');
const { getAllProducts, saveProduct } = require('../lib/firestore');
const { coerceTitleToPolicy, inferTitleCategory, validateTitleToPolicy } = require('../lib/title-policy');
const { getRulebookConfigCached } = require('../lib/rulebook-config');

const OUT_ROOT = path.join(process.cwd(), 'exports', 'baselinker-repair');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const safeString = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());

function isUnknownLikeBrand(value) {
  const s = safeString(value).toLowerCase();
  return (
    !s ||
    s === 'unbekannt' ||
    s === 'unknown' ||
    s === 'n/a' ||
    s === 'na' ||
    s === '-' ||
    s === '—' ||
    s === '--' ||
    s === 'null' ||
    s === 'undefined' ||
    s === 'generisch' ||
    s === 'generic'
  );
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
    if (!list.length) break;
    if (list.length < 1000 && !res?.next_page) break;
  }
  const byId = new Map();
  out.forEach((m) => {
    const id = Number(m?.manufacturer_id);
    if (!Number.isFinite(id) || id <= 0) return;
    byId.set(id, safeString(m?.name));
  });
  return byId;
}

function csvEscape(v) {
  const s = v == null ? '' : String(v).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (/[\";\n]/.test(s) || /^\s|\s$/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main() {
  const args = parseArgs(process.argv);
  const inventoryId = safeString(args['inventory-id'] || process.env.BASELINKER_INVENTORY_ID || '78659');
  const applyAvy = Boolean(args['apply-avy']);
  const applyBl = Boolean(args['apply-bl']);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(OUT_ROOT, ts);
  ensureDir(outDir);

  console.log(`[repair] loading BaseLinker products list (inventory ${inventoryId})…`);
  const list = await loadAllInventoryProducts(inventoryId);
  const ids = list.map((p) => Number(p?.id || 0)).filter((n) => Number.isFinite(n) && n > 0);
  console.log(`[repair] BaseLinker products: ${list.length}`);

  console.log('[repair] loading BaseLinker product details (manufacturer_id + text_fields)…');
  const detailsById = await loadProductsData(inventoryId, ids);

  console.log('[repair] loading BaseLinker manufacturers…');
  const mfgById = await loadManufacturers(inventoryId);

  // Build BL index by product_id and by SKU
  const blById = new Map(); // id -> {sku, name, manufacturer_name}
  const blBySku = new Map(); // normSku -> id
  for (const entry of list) {
    const blId = Number(entry?.id || 0);
    if (!Number.isFinite(blId) || blId <= 0) continue;
    const sku = safeString(entry?.sku);
    const normSku = normalizeSkuValue(sku);
    const details = detailsById.get(blId) || {};
    const tf = details?.text_fields && typeof details.text_fields === 'object' ? details.text_fields : {};
    const name = safeString(tf?.['name|de'] || tf?.name || entry?.name || '');
    const manufacturerId = Number(details?.manufacturer_id || 0) || 0;
    const manufacturerName = manufacturerId ? safeString(mfgById.get(manufacturerId) || '') : '';
    blById.set(blId, { bl_product_id: blId, sku, normSku, name, manufacturer_name: manufacturerName, manufacturer_id: manufacturerId });
    if (normSku && !blBySku.has(normSku)) blBySku.set(normSku, blId);
  }

  console.log('[repair] loading AvyCloud products…');
  const avy = await getAllProducts();
  const cfg = getRulebookConfigCached();

  const report = [];
  let considered = 0;
  let wouldChange = 0;
  let changed = 0;

  for (const p of Array.isArray(avy) ? avy : []) {
    const blId = Number(p?.ops?.baselinker?.product_id || p?.ops?.base_product_id || 0);
    const sku = safeString(p?.identification?.sku || p?.details?.identifiers?.sku);
    const normSku = normalizeSkuValue(sku);

    const bl =
      (Number.isFinite(blId) && blId > 0 ? blById.get(blId) : null) ||
      (normSku && blBySku.has(normSku) ? blById.get(blBySku.get(normSku)) : null) ||
      null;

    if (!bl) continue;

    considered += 1;

    const avyName = safeString(p?.identification?.name);
    const avyBrand = safeString(p?.identification?.brand);
    const blName = safeString(bl.name);
    const blBrand = safeString(bl.manufacturer_name);

    const needBrand = blBrand && !isUnknownLikeBrand(blBrand) && (!avyBrand || avyBrand.toLowerCase() !== blBrand.toLowerCase());
    const needTitle = blName && (!avyName || avyName.trim() !== blName.trim());
    if (!needBrand && !needTitle) continue;

    wouldChange += 1;

    const next = {
      ...p,
      identification: {
        ...(p.identification || {}),
        brand: needBrand ? blBrand : (p?.identification?.brand || ''),
      },
      details: {
        ...(p.details || {}),
        attributes: {
          ...((p.details?.attributes && typeof p.details.attributes === 'object') ? p.details.attributes : {}),
          ...(needBrand ? { Marke: blBrand, Hersteller: blBrand } : {}),
        },
      },
      ops: {
        ...(p.ops || {}),
        repair_from_baselinker_v1: {
          at_iso: new Date().toISOString(),
          inventory_id: Number(inventoryId),
          bl_product_id: bl.bl_product_id,
          previous: { name: avyName || null, brand: avyBrand || null },
          baselinker: { name: blName || null, brand: blBrand || null },
        },
      },
    };

    // Restore the BaseLinker title verbatim to undo corruption.
    // (We do NOT coerce here; this is a rollback/repair pass.)
    const restoredTitle = blName;
    next.identification = { ...(next.identification || {}), name: restoredTitle };

    // Compute policy diagnostics for reporting only.
    const bucket = inferTitleCategory(next);
    const bySchema = cfg?.title?.rulesBySchema && typeof cfg.title.rulesBySchema === 'object' ? cfg.title.rulesBySchema : {};
    const rule = (bySchema && bySchema[bucket]) || cfg?.title || {};
    const minLen = Number(rule?.minLen || 65);
    const maxLen = Number(rule?.maxLen || 80);
    const mobileMaxLen = Number(rule?.mobileMaxLen || 60);
    const issues = validateTitleToPolicy(next, restoredTitle, { minLen, maxLen, mobileMaxLen });

    report.push({
      sku: sku || p.id,
      avy_id: safeString(p?.id),
      bl_product_id: bl.bl_product_id,
      before_brand: avyBrand,
      after_brand: next.identification.brand,
      bl_brand: blBrand,
      before_title: avyName,
      after_title: restoredTitle,
      bl_title: blName,
      bucket,
      title_issues: issues.join('|'),
      apply_avy: applyAvy ? 'yes' : 'no',
      apply_bl: applyBl ? 'yes' : 'no',
    });

    if (applyAvy) {
      await saveProduct(next, {
        source: 'script:repair-from-baselinker',
        skipTitlePolicy: true,
        overwriteTextFields: true,
        replaceAttributes: false,
      });
      changed += 1;
    }

    if (applyBl) {
      // Idempotent safety: only update name + manufacturer_id (do NOT touch category/stock/prices/images).
      const payload = {
        inventory_id: Number(inventoryId),
        product_id: bl.bl_product_id,
        sku: bl.sku,
        manufacturer_id: bl.manufacturer_id || undefined,
        text_fields: {
          name: restoredTitle,
          'name|de': restoredTitle,
        },
      };
      await callBaseLinker('addInventoryProduct', payload);
    }
  }

  const summary = {
    inventoryId,
    applyAvy,
    applyBl,
    counts: {
      baselinker_total: list.length,
      avy_total: Array.isArray(avy) ? avy.length : 0,
      considered,
      would_change: wouldChange,
      changed_avy: changed,
      report_rows: report.length,
    },
    outDir,
  };

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

  const headers = report.length ? Object.keys(report[0]) : ['sku'];
  const csv = [headers.join(';')]
    .concat(report.map((r) => headers.map((h) => csvEscape(r[h])).join(';')))
    .join('\n')
    .concat('\n');
  fs.writeFileSync(path.join(outDir, 'report.csv'), csv);

  const latest = path.join(OUT_ROOT, 'latest');
  ensureDir(latest);
  fs.writeFileSync(path.join(latest, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(latest, 'report.csv'), csv);

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

