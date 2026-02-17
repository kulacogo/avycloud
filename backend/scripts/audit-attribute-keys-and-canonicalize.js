/* eslint-disable no-console */
/**
 * Extract all attribute/parameter keys from Firestore products and generate a consolidated,
 * evidence-based canonical list + alias suggestions.
 *
 * Data sources:
 * - Firestore: products/{id}.details.attributes + details.identifiers + details.gpsr (optional)
 * - Local taxonomy snapshots:
 *   - backend/ebay-data/required-aspects-full.json / aspects-full.json via ebay-taxonomy helper
 *
 * Output:
 * - exports/reconciliation/attribute-keys-audit_<stamp>.json
 * - exports/reconciliation/attribute-keys-audit_<stamp>.csv
 *
 * Usage:
 *   node backend/scripts/audit-attribute-keys-and-canonicalize.js
 *   node backend/scripts/audit-attribute-keys-and-canonicalize.js --limit 500
 *   node backend/scripts/audit-attribute-keys-and-canonicalize.js --out exports/reconciliation/custom.json
 */

const fs = require('fs');
const path = require('path');
const { firestore } = require('../lib/firestore');
const { getRequiredAspects } = require('../lib/ebay-taxonomy');

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeAspectKey(rawKey = '') {
  const key = safeString(rawKey);
  if (!key) return '';
  return key
    .replace(/^eBay[\s-_]*Item[\s-_]*Specifics[\s:_-]*\s*/i, '')
    .replace(/^Pflicht[\s-_]*Item[\s-_]*Specifics[\s:_-]*\s*/i, '')
    .replace(/^eBay[\s-_]+/i, '')
    .replace(/^Kaufland[\s-_]*Item[\s-_]*Specifics[\s:_-]*\s*/i, '')
    .replace(/^Kaufland[\s-_]+/i, '')
    .trim();
}

function normalizeKeyForCluster(key = '') {
  // Purpose: group similar keys for review (not used for writes).
  return safeString(key)
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

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (/[",\n]/.test(str) || /^\s|\s$/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function parseArgs(argv) {
  const args = { limit: null, out: null };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--limit') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) args.limit = Math.floor(n);
      i += 1;
    } else if (token === '--out') {
      args.out = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function extractCategoryId(product) {
  const details = product?.details || {};
  const attrs = details?.attributes || {};
  const candidate =
    (details.categoryId && String(details.categoryId).trim()) ||
    (details.ebayCategoryId && String(details.ebayCategoryId).trim()) ||
    (attrs.ebay_category_id && String(attrs.ebay_category_id).trim()) ||
    null;
  return candidate ? String(candidate).replace(/\D+/g, '') || String(candidate).trim() : null;
}

function addKeySample(stat, { productId, categoryId, value }) {
  if (!stat) return;
  stat.products += 1;
  if (categoryId) {
    stat.categories[categoryId] = (stat.categories[categoryId] || 0) + 1;
  }
  const type =
    value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  stat.types[type] = (stat.types[type] || 0) + 1;
  const vStr = safeString(value);
  if (vStr && stat.sampleValues.length < 8 && !stat.sampleValues.includes(vStr)) {
    stat.sampleValues.push(vStr.slice(0, 180));
  }
  if (stat.sampleProductIds.length < 8 && productId && !stat.sampleProductIds.includes(productId)) {
    stat.sampleProductIds.push(productId);
  }
}

function pickCanonicalKey(clusterKeys, { requiredAspectSet }) {
  // Prefer exact match from required aspects (most stable for marketplace exports).
  const required = requiredAspectSet instanceof Set ? requiredAspectSet : new Set();
  for (const k of clusterKeys) {
    if (required.has(k)) return k;
  }
  // Otherwise: pick the most common visual key (the first in sorted list will be replaced by freq ranking outside).
  return clusterKeys[0] || '';
}

async function main() {
  const args = parseArgs(process.argv);
  const stamp = nowStamp();
  const outDir = path.join(process.cwd(), 'exports', 'reconciliation');
  fs.mkdirSync(outDir, { recursive: true });

  const outJsonPath = args.out
    ? (path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out))
    : path.join(outDir, `attribute-keys-audit_${stamp}.json`);
  const outCsvPath = outJsonPath.replace(/\.json$/i, '.csv');

  // Build a global required-aspect set for only categories that actually appear in data.
  const usedCategoryIds = new Set();

  const keyStats = {}; // rawKey -> stat
  const clusters = {}; // clusterKey -> { keys: Set<string>, total: number }

  const snapshot = await firestore.collection('products').get();
  const docs = args.limit ? snapshot.docs.slice(0, args.limit) : snapshot.docs;

  for (const doc of docs) {
    const product = doc.data() || {};
    const productId = String(product?.id || doc.id || '').trim() || doc.id;
    const categoryId = extractCategoryId(product);
    if (categoryId) usedCategoryIds.add(String(categoryId));

    const details = product?.details || {};
    const attrs = details?.attributes && typeof details.attributes === 'object' && !Array.isArray(details.attributes)
      ? details.attributes
      : {};
    const identifiers = details?.identifiers && typeof details.identifiers === 'object' ? details.identifiers : {};
    const gpsr = details?.gpsr && typeof details.gpsr === 'object' ? details.gpsr : {};

    const visit = (key, value, source) => {
      const rawKey = safeString(key);
      if (!rawKey) return;
      const cleanedKey = normalizeAspectKey(rawKey);
      const displayKey = cleanedKey || rawKey;

      if (!keyStats[displayKey]) {
        keyStats[displayKey] = {
          key: displayKey,
          products: 0,
          sources: {},
          categories: {},
          types: {},
          sampleValues: [],
          sampleProductIds: [],
          cluster: normalizeKeyForCluster(displayKey),
        };
      }
      keyStats[displayKey].sources[source] = (keyStats[displayKey].sources[source] || 0) + 1;
      addKeySample(keyStats[displayKey], { productId, categoryId, value });

      const clusterKey = keyStats[displayKey].cluster || normalizeKeyForCluster(displayKey);
      if (!clusters[clusterKey]) {
        clusters[clusterKey] = { key: clusterKey, keys: new Set(), total: 0 };
      }
      clusters[clusterKey].keys.add(displayKey);
      clusters[clusterKey].total += 1;
    };

    Object.entries(attrs).forEach(([k, v]) => visit(k, v, 'attributes'));
    Object.entries(identifiers).forEach(([k, v]) => visit(`identifiers.${k}`, v, 'identifiers'));
    Object.entries(gpsr).forEach(([k, v]) => visit(`gpsr.${k}`, v, 'gpsr'));
  }

  const requiredAspectSet = new Set();
  usedCategoryIds.forEach((catId) => {
    const aspects = getRequiredAspects(String(catId));
    aspects.forEach((a) => {
      const s = safeString(a);
      if (s) requiredAspectSet.add(s);
    });
  });

  const keyList = Object.values(keyStats);
  keyList.sort((a, b) => b.products - a.products || a.key.localeCompare(b.key));

  // Proposed canonical mapping per cluster (best-effort, evidence-based).
  const clusterList = Object.values(clusters).map((c) => ({
    cluster: c.key,
    total: c.total,
    keys: Array.from(c.keys),
  }));
  clusterList.sort((a, b) => b.total - a.total);

  const proposed = clusterList.map((c) => {
    // Rank keys within cluster by frequency
    const ranked = [...c.keys].sort((a, b) => {
      const fa = keyStats[a]?.products || 0;
      const fb = keyStats[b]?.products || 0;
      return fb - fa || a.localeCompare(b);
    });
    const canonical = pickCanonicalKey(ranked, { requiredAspectSet });
    const aliases = ranked.filter((k) => k !== canonical);
    return {
      cluster: c.cluster,
      total: c.total,
      canonical,
      aliases,
      // small explanation for review
      canonical_is_required_aspect: requiredAspectSet.has(canonical),
    };
  });

  const out = {
    at_iso: new Date().toISOString(),
    scanned: docs.length,
    limit: args.limit,
    used_category_ids: Array.from(usedCategoryIds).slice(0, 2000),
    required_aspects_used_categories_count: requiredAspectSet.size,
    top_keys: keyList.slice(0, 200).map((k) => ({ key: k.key, products: k.products })),
    keys: keyList,
    proposed_canonical_by_cluster: proposed,
  };

  fs.writeFileSync(outJsonPath, JSON.stringify(out, null, 2), 'utf8');

  // CSV: key stats
  const headers = [
    'Key',
    'Products',
    'Cluster',
    'Types',
    'Sources',
    'TopCategories',
    'SampleValues',
  ];
  const lines = [headers.join(',')];
  for (const row of keyList) {
    const topCats = Object.entries(row.categories || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, n]) => `${id}:${n}`)
      .join(' ');
    const types = Object.entries(row.types || {})
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t}:${n}`)
      .join(' ');
    const sources = Object.entries(row.sources || {})
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `${s}:${n}`)
      .join(' ');
    lines.push(
      [
        row.key,
        row.products,
        row.cluster,
        types,
        sources,
        topCats,
        (row.sampleValues || []).join(' | '),
      ].map(csvEscape).join(',')
    );
  }
  fs.writeFileSync(outCsvPath, `${lines.join('\n')}\n`, 'utf8');

  console.log('[audit-attribute-keys] wrote:', outJsonPath);
  console.log('[audit-attribute-keys] wrote:', outCsvPath);
  console.log(JSON.stringify({ scanned: docs.length, unique_keys: keyList.length, clusters: clusterList.length }, null, 2));
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});

