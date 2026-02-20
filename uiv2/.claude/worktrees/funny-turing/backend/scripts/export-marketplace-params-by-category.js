/* eslint-disable no-console */
/**
 * Export "used marketplace integration parameters" per category as CSV.
 *
 * What "used" means here:
 * - We look at our own product catalog (Firestore) and compute which attribute keys are present
 *   (non-empty) for products within each marketplace category.
 * - For eBay we additionally include the category's required aspects (even if not present yet),
 *   using our local taxonomy cache (`backend/ebay-data/required-aspects*.json`).
 *
 * Output:
 * - backend/exports/marketplace-params/marketplace-params-by-category.csv
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/export-marketplace-params-by-category.js
 *
 * Options (env):
 *   OUT_DIR=backend/exports/marketplace-params
 *   MAX_SAMPLE_VALUES=5
 */

const fs = require('fs');
const path = require('path');
const { getAllProducts } = require('../lib/firestore');
const { findEbayCategory, getRequiredAspects } = require('../lib/ebay-taxonomy');
const { findKauflandCategory } = require('../lib/kaufland-taxonomy');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(
    d.getSeconds()
  )}`;
}

function normalizeKey(key) {
  return safeString(key).toLowerCase();
}

function isNonEmptyValue(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'boolean') return true;
  return false;
}

function valueToSample(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return '';
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function modeFromCounts(countMap) {
  let best = null;
  let bestCount = 0;
  for (const [k, c] of countMap.entries()) {
    if (c > bestCount) {
      bestCount = c;
      best = k;
    }
  }
  return best;
}

function getCategoryLeafFromBreadcrumb(breadcrumb) {
  const b = safeString(breadcrumb);
  if (!b) return '';
  const parts = b.split('>').map((x) => safeString(x)).filter(Boolean);
  return parts[parts.length - 1] || b;
}

function addCount(map, key) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + 1);
}

function coerceCategoryPathFromExtra(extra) {
  const e = extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {};
  // Common variants we saw in data_quality runs / imports
  const candidates = [
    e['Kaufland-Kategorie'],
    e.Kaufland_Kategorie,
    e['Kaufland Kategorie'],
    e.kaufland_category_path,
    e.kaufland_category,
    e.kauflandcategorypath,
    e.kauflandcategory,
  ];
  for (const c of candidates) {
    const v = safeString(c);
    if (v) return v;
  }
  return '';
}

function isKauflandSpecificKey(key) {
  const k = safeString(key);
  if (!k) return false;
  return /^kaufland[\s-_]/i.test(k) || /^kaufland[-_]/i.test(k) || k.toLowerCase().includes('kaufland_');
}

function normalizeKauflandParamKey(key) {
  // Reduce "Kaufland_Produktart (Produktart)" -> "Produktart"
  // Reduce "Kaufland_Farbe" -> "Farbe"
  const k = safeString(key);
  if (!k) return '';
  let out = k
    .replace(/^Kaufland[\s-_]*Item[\s-_]*Specifics[\s:_-]*\s*/i, '')
    .replace(/^Kaufland[\s-_]+/i, '')
    .replace(/^Kaufland[_-]*/i, '')
    .trim();
  const m = out.match(/\(([^)]+)\)\s*$/);
  if (m && m[1]) out = m[1].trim();
  return out;
}

async function main() {
  const outDir = path.resolve(String(process.env.OUT_DIR || 'backend/exports/marketplace-params'));
  const maxSamples = Math.max(1, Math.min(10, parseInt(process.env.MAX_SAMPLE_VALUES || '5', 10) || 5));
  ensureDir(outDir);

  console.log(JSON.stringify({ action: 'export-marketplace-params-by-category', outDir, maxSamples }, null, 2));

  const all = await getAllProducts();
  const products = Array.isArray(all) ? all.filter((p) => p?.id) : [];

  const marketplaces = {
    ebay: {
      byCategory: new Map(), // catId -> { total, keyStats, pathCounts }
      getCategoryId: (p) => safeString(p?.details?.categoryId || p?.details?.ebayCategoryId),
      getCategoryPath: (catId) => {
        const cat = findEbayCategory(catId);
        return safeString(cat?.breadcrumb || cat?.name || '');
      },
    },
    kaufland: {
      byCategory: new Map(),
      // Prefer explicit stored ID, else try resolving from stored path in attributes_extra
      getCategoryId: (p) => {
        const direct = safeString(p?.details?.kauflandCategoryId);
        if (direct) return direct;
        const pathText = safeString(p?.details?.kauflandCategoryPath) || coerceCategoryPathFromExtra(p?.details?.attributes_extra);
        if (!pathText) return '';
        const resolved = findKauflandCategory(pathText);
        return resolved?.id ? safeString(resolved.id) : '';
      },
      getCategoryPathFromProduct: (p) => {
        const direct = safeString(p?.details?.kauflandCategoryPath);
        if (direct) return direct;
        const extraPath = coerceCategoryPathFromExtra(p?.details?.attributes_extra);
        if (extraPath) return extraPath;
        const attrs = p?.details?.attributes;
        if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) {
          const v =
            safeString(attrs.kaufland_category_path) ||
            safeString(attrs.kaufland_category) ||
            safeString(attrs.Kategorie) ||
            safeString(attrs.category);
          if (v) return v;
        }
        return '';
      },
    },
  };

  const ingest = (marketplace, categoryId, categoryPathHint, attributes) => {
    if (!categoryId) return;
    const store = marketplaces[marketplace];
    if (!store) return;

    if (!store.byCategory.has(categoryId)) {
      store.byCategory.set(categoryId, {
        total: 0,
        keyStats: new Map(), // normKey -> { key, used, samples:Set }
        pathCounts: new Map(),
      });
    }
    const entry = store.byCategory.get(categoryId);
    entry.total += 1;
    if (categoryPathHint) addCount(entry.pathCounts, categoryPathHint);

    const attrs =
      attributes && typeof attributes === 'object' && !Array.isArray(attributes) ? attributes : {};
    for (const [rawKey, rawVal] of Object.entries(attrs)) {
      const key = safeString(rawKey);
      if (!key) continue;

      // Skip internal/meta keys
      const lower = key.toLowerCase();
      if (lower.includes('ebay') || lower.includes('kaufland')) continue;
      if (lower.startsWith('text_')) continue;
      if (lower.includes('|de|')) continue;
      if (lower.startsWith('features|')) continue;

      if (!isNonEmptyValue(rawVal)) continue;

      const nk = normalizeKey(key);
      if (!entry.keyStats.has(nk)) {
        entry.keyStats.set(nk, { key, used: 0, samples: new Set() });
      }
      const stat = entry.keyStats.get(nk);
      // Prefer the "nicer" display key (longer often includes proper case/spacing)
      if (key.length > stat.key.length) stat.key = key;
      stat.used += 1;
      const sample = valueToSample(rawVal);
      if (sample && stat.samples.size < maxSamples) stat.samples.add(sample);
    }
  };

  // Ingest from catalog
  for (const p of products) {
    const attributes =
      p?.details?.attributes && typeof p.details.attributes === 'object' && !Array.isArray(p.details.attributes)
        ? p.details.attributes
        : {};
    const extra =
      p?.details?.attributes_extra && typeof p.details.attributes_extra === 'object' && !Array.isArray(p.details.attributes_extra)
        ? p.details.attributes_extra
        : {};

    const ebayCatId = marketplaces.ebay.getCategoryId(p);
    const ebayPath = ebayCatId ? marketplaces.ebay.getCategoryPath(ebayCatId) : '';
    ingest('ebay', ebayCatId, ebayPath, attributes);

    const kCatId = marketplaces.kaufland.getCategoryId(p);
    const kPath = marketplaces.kaufland.getCategoryPathFromProduct(p);
    ingest('kaufland', kCatId, kPath, attributes);

    // Also ingest Kaufland-specific keys from attributes_extra (these are often marketplace-only params)
    if (kCatId) {
      const kauflandParams = {};
      for (const [k, v] of Object.entries(extra)) {
        if (!isKauflandSpecificKey(k)) continue;
        const nk = normalizeKauflandParamKey(k);
        if (!nk) continue;
        // We store normalized key for mapping; keep value for sample.
        kauflandParams[nk] = v;
      }
      ingest('kaufland', kCatId, kPath, kauflandParams);
    }
  }

  const rows = [];

  // Emit eBay rows (include required aspects)
  for (const [catId, entry] of marketplaces.ebay.byCategory.entries()) {
    const pathText = modeFromCounts(entry.pathCounts) || marketplaces.ebay.getCategoryPath(catId) || '';
    const leaf = getCategoryLeafFromBreadcrumb(pathText);
    const required = new Set(getRequiredAspects(catId));

    // union(used keys, required)
    const usedKeys = Array.from(entry.keyStats.values());
    const requiredMissing = Array.from(required)
      .filter((k) => !entry.keyStats.has(normalizeKey(k)))
      .map((k) => ({ key: k, used: 0, samples: new Set() }));

    const combined = [...usedKeys, ...requiredMissing].sort((a, b) => a.key.localeCompare(b.key));

    for (const stat of combined) {
      const requiredFlag = required.has(stat.key) ? 'true' : required.has(stat.key.trim()) ? 'true' : 'false';
      const usageRate = entry.total > 0 ? (stat.used / entry.total) : 0;
      rows.push({
        marketplace: 'ebay',
        categoryId: catId,
        categoryPath: pathText,
        categoryName: leaf,
        parameterKey: stat.key,
        required: requiredFlag,
        usedCount: stat.used,
        totalProducts: entry.total,
        usageRate: usageRate.toFixed(4),
        sampleValues: Array.from(stat.samples || []).slice(0, maxSamples).join(' | '),
      });
    }
  }

  // Emit Kaufland rows (used-only; we don't have per-category required attribute list in our codebase)
  for (const [catId, entry] of marketplaces.kaufland.byCategory.entries()) {
    const pathText = modeFromCounts(entry.pathCounts) || '';
    const leaf = getCategoryLeafFromBreadcrumb(pathText);
    const combined = Array.from(entry.keyStats.values()).sort((a, b) => a.key.localeCompare(b.key));
    for (const stat of combined) {
      const usageRate = entry.total > 0 ? (stat.used / entry.total) : 0;
      rows.push({
        marketplace: 'kaufland',
        categoryId: catId,
        categoryPath: pathText,
        categoryName: leaf,
        parameterKey: stat.key,
        required: '',
        usedCount: stat.used,
        totalProducts: entry.total,
        usageRate: usageRate.toFixed(4),
        sampleValues: Array.from(stat.samples || []).slice(0, maxSamples).join(' | '),
      });
    }
  }

  // Stable sort: marketplace, categoryId numeric-ish, then parameterKey
  const num = (s) => (String(s || '').match(/^\d+$/) ? Number(s) : Number.MAX_SAFE_INTEGER);
  rows.sort((a, b) => {
    if (a.marketplace !== b.marketplace) return a.marketplace.localeCompare(b.marketplace);
    const na = num(a.categoryId);
    const nb = num(b.categoryId);
    if (na !== nb) return na - nb;
    if (a.categoryId !== b.categoryId) return String(a.categoryId).localeCompare(String(b.categoryId));
    return a.parameterKey.localeCompare(b.parameterKey);
  });

  const header = [
    'marketplace',
    'categoryId',
    'categoryPath',
    'categoryName',
    'parameterKey',
    'required',
    'usedCount',
    'totalProducts',
    'usageRate',
    'sampleValues',
  ];
  const csv = [header.join(',')]
    .concat(
      rows.map((r) =>
        [
          csvEscape(r.marketplace),
          csvEscape(r.categoryId),
          csvEscape(r.categoryPath),
          csvEscape(r.categoryName),
          csvEscape(r.parameterKey),
          csvEscape(r.required),
          csvEscape(r.usedCount),
          csvEscape(r.totalProducts),
          csvEscape(r.usageRate),
          csvEscape(r.sampleValues),
        ].join(',')
      )
    )
    .join('\n');

  const outCsv = path.join(outDir, `marketplace-params-by-category-${nowStamp()}.csv`);
  fs.writeFileSync(outCsv, csv + '\n', 'utf8');

  console.log(
    JSON.stringify(
      {
        done: true,
        products: products.length,
        ebayCategories: marketplaces.ebay.byCategory.size,
        kauflandCategories: marketplaces.kaufland.byCategory.size,
        rows: rows.length,
        outCsv,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

