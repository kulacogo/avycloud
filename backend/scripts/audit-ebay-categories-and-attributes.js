/* eslint-disable no-console */
/**
 * Audit current Firestore product category + attribute quality.
 *
 * Uses local snapshots:
 * - backend/ebay-data/categories.json
 * - backend/ebay-data/required-aspects-full.json / aspects-full.json via ebay-taxonomy helper
 *
 * Output:
 *  exports/reconciliation/ebay-attributes-audit.json
 *
 * Usage:
 *  node backend/scripts/audit-ebay-categories-and-attributes.js
 */

const fs = require('fs');
const path = require('path');
const { firestore } = require('../lib/firestore');
const { getRequiredAspects } = require('../lib/ebay-taxonomy');

const CATEGORIES = require('../ebay-data/categories.json');

const argv = process.argv.slice(2);
const LIMIT = (() => {
  const idx = argv.indexOf('--limit');
  if (idx === -1) return null;
  const n = Number(argv[idx + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
})();

const normalizeKey = (key) => (key == null ? '' : String(key)).trim();

const normalizeAspectKey = (key) => {
  const raw = normalizeKey(key);
  if (!raw) return '';
  // Strip common noisy prefixes coming from exports/LLM prompts
  return raw
    .replace(/^eBay[\s-_]*Item[\s-_]*Specifics[\s:_-]*\s*/i, '')
    .replace(/^Pflicht[\s-_]*Item[\s-_]*Specifics[\s:_-]*\s*/i, '')
    .replace(/^eBay[\s-_]+/i, '')
    .trim();
};

const normalizeLower = (v) => normalizeKey(v).toLowerCase();

const normalizeCatId = (val) => {
  const raw = normalizeKey(val);
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, '');
  return digits || raw;
};

const META_ATTRIBUTE_KEYS = new Set(
  [
    'ebay_category_id',
    'ebaycategoryid',
    'ebay_category_path',
    'ebaycategorypath',
    'ebay_category_breadcrumb',
    'ebaycategorybreadcrumb',
    // Some exports store a whole list of item specifics under this meta key (redundant, noisy)
    'ebay_item_specifics',
    'ebayitemspecifics',
    'ebay categorie',
    'eBay Kategorie'.toLowerCase(),
    'eBay Kategorie ID'.toLowerCase(),
    'eBay Kategorie Pfad'.toLowerCase(),
    'kaufland_category_id',
    'kauflandcategoryid',
    'kaufland_category_path',
    'kauflandcategorypath',
    'kaufland kategorie'.toLowerCase(),
  ].map((k) => k.toLowerCase())
);

const PLACEHOLDER_VALUES = [
  'not provided, eu',
  'info@example.com',
  'info@example.example.com',
  'info@example.de',
  'example.com',
  'n/a',
  'na',
  'unknown',
  'unbekannt',
];

const isPlaceholder = (value) => {
  const v = normalizeLower(value);
  if (!v) return false;
  return PLACEHOLDER_VALUES.some((p) => v === p || v.includes(p));
};

function extractEbayCategoryId(product) {
  const details = product?.details || {};
  const attrs = details?.attributes || {};
  const candidate =
    details.categoryId ||
    details.ebayCategoryId ||
    attrs.ebay_category_id ||
    attrs.ebayCategoryId ||
    attrs['ebay.category_id'] ||
    null;
  return normalizeCatId(candidate);
}

async function main() {
  const outDir = path.join(process.cwd(), 'exports', 'reconciliation');
  fs.mkdirSync(outDir, { recursive: true });

  const snapshot = await firestore.collection('products').get();

  const summary = {
    scanned: 0,
    limited: LIMIT,
    missingEbayCategoryId: 0,
    invalidEbayCategoryId: 0,
    productsWithAttributes: 0,
    productsWithPrefixedKeys: 0,
    productsWithMetaKeys: 0,
    productsWithUnknownKeys: 0,
    productsWithPlaceholderValues: 0,
    topAttributeKeys: {},
    topNormalizedKeys: {},
    topUnknownKeys: {},
    sampleIssues: [],
  };

  let processed = 0;
  for (const doc of snapshot.docs) {
    if (LIMIT && processed >= LIMIT) break;
    processed += 1;

    const product = doc.data() || {};
    summary.scanned += 1;

    const catId = extractEbayCategoryId(product);
    if (!catId) {
      summary.missingEbayCategoryId += 1;
    } else if (!CATEGORIES[String(catId)]) {
      summary.invalidEbayCategoryId += 1;
    }

    const details = product.details || {};
    const attrs = details.attributes && typeof details.attributes === 'object' ? details.attributes : {};
    const attrEntries = Object.entries(attrs || {});
    if (attrEntries.length) summary.productsWithAttributes += 1;

    const allowed = catId ? getRequiredAspects(String(catId)) : [];
    const allowedSet = new Set(allowed.map((x) => normalizeLower(x)).filter(Boolean));

    const prefixedKeys = [];
    const metaKeys = [];
    const unknownKeys = [];
    const placeholderKeys = [];

    for (const [rawKey, rawVal] of attrEntries) {
      const rawKeyStr = normalizeKey(rawKey);
      if (!rawKeyStr) continue;
      const normalizedKey = normalizeAspectKey(rawKeyStr);

      // counts
      summary.topAttributeKeys[rawKeyStr] = (summary.topAttributeKeys[rawKeyStr] || 0) + 1;
      if (normalizedKey) {
        summary.topNormalizedKeys[normalizedKey] = (summary.topNormalizedKeys[normalizedKey] || 0) + 1;
      }

      if (/^eBay[\s-_]*Item[\s-_]*Specifics/i.test(rawKeyStr)) {
        prefixedKeys.push(rawKeyStr);
      }

      const lowerKey = normalizeLower(normalizedKey || rawKeyStr);
      if (META_ATTRIBUTE_KEYS.has(lowerKey) || lowerKey.includes('kaufland')) {
        metaKeys.push(rawKeyStr);
      }

      if (catId && allowedSet.size && normalizedKey) {
        const normalizedLower = normalizeLower(normalizedKey);
        const isGpsr = normalizedLower.startsWith('gpsr ');
        if (
          normalizedLower &&
          !isGpsr &&
          !allowedSet.has(normalizedLower) &&
          !META_ATTRIBUTE_KEYS.has(normalizedLower)
        ) {
          unknownKeys.push(normalizedKey);
          summary.topUnknownKeys[normalizedKey] = (summary.topUnknownKeys[normalizedKey] || 0) + 1;
        }
      }

      if (isPlaceholder(rawVal)) {
        placeholderKeys.push(rawKeyStr);
      }
    }

    if (prefixedKeys.length) summary.productsWithPrefixedKeys += 1;
    if (metaKeys.length) summary.productsWithMetaKeys += 1;
    if (unknownKeys.length) summary.productsWithUnknownKeys += 1;
    if (placeholderKeys.length) summary.productsWithPlaceholderValues += 1;

    const hasIssues =
      !catId ||
      (catId && !CATEGORIES[String(catId)]) ||
      prefixedKeys.length ||
      metaKeys.length ||
      unknownKeys.length ||
      placeholderKeys.length;

    if (hasIssues && summary.sampleIssues.length < 40) {
      summary.sampleIssues.push({
        id: doc.id,
        ebayCategoryId: catId,
        ebayCategoryValid: catId ? Boolean(CATEGORIES[String(catId)]) : false,
        prefixedKeys: prefixedKeys.slice(0, 10),
        metaKeys: metaKeys.slice(0, 10),
        unknownKeys: unknownKeys.slice(0, 10),
        placeholderKeys: placeholderKeys.slice(0, 10),
      });
    }
  }

  // sort “top” maps
  const sortTop = (obj, limit = 50) =>
    Object.fromEntries(
      Object.entries(obj)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
    );

  summary.topAttributeKeys = sortTop(summary.topAttributeKeys, 80);
  summary.topNormalizedKeys = sortTop(summary.topNormalizedKeys, 80);
  summary.topUnknownKeys = sortTop(summary.topUnknownKeys, 80);

  const outPath = path.join(outDir, 'ebay-attributes-audit.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log('Audit written to:', outPath);
  console.log(JSON.stringify({ scanned: summary.scanned, missingEbayCategoryId: summary.missingEbayCategoryId, invalidEbayCategoryId: summary.invalidEbayCategoryId, productsWithUnknownKeys: summary.productsWithUnknownKeys, productsWithPlaceholderValues: summary.productsWithPlaceholderValues }, null, 2));
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});


