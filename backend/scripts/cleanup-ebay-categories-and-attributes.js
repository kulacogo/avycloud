/* eslint-disable no-console */
/**
 * Cleanup eBay category + attributes on Firestore products.
 *
 * What it does (SAFE):
 * - Normalizes the single canonical category fields into:
 *   - details.categoryId (string digits)
 *   - identification.category (canonical breadcrumb from categories.json when possible)
 * - Cleans details.attributes:
 *   - Strip "eBay Item Specifics:" prefixes
 *   - Remove category metadata keys (ebay_category_id/path, kaufland_* etc.)
 *   - Remove obvious duplicates for identifiers (EAN/SKU/UPC/GTIN fields) from attributes
 *   - Drop placeholder values (info@example.com, Not Provided, EU, etc.)
 *   - Keep eBay-allowed aspects (from taxonomy helper / required-aspects-full) + compliance keys (GPSR*) in attributes
 *   - Move everything else to details.attributes_extra to avoid data loss
 *
 * What it NEVER touches:
 * - storage, storageBins, inventory (warehouse data)
 *
 * Usage:
 *   node backend/scripts/cleanup-ebay-categories-and-attributes.js          # dry-run
 *   node backend/scripts/cleanup-ebay-categories-and-attributes.js --apply  # write
 *
 * Output:
 *   exports/reconciliation/ebay-attributes-cleanup-report.json
 */

const fs = require('fs');
const path = require('path');
const { FieldValue } = require('@google-cloud/firestore');
const { firestore } = require('../lib/firestore');
const { getRequiredAspects } = require('../lib/ebay-taxonomy');

const CATEGORIES = require('../ebay-data/categories.json');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const LIMIT = (() => {
  const idx = argv.indexOf('--limit');
  if (idx === -1) return null;
  const n = Number(argv[idx + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
})();

const normalizeKey = (key) => (key == null ? '' : String(key)).trim();
const normalizeLower = (v) => normalizeKey(v).toLowerCase();

const normalizeBooleanishValue = (val) => {
  if (val === true) return 'Ja';
  if (val === false) return 'Nein';
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'true') return 'Ja';
  if (lower === 'false') return 'Nein';
  return val;
};

const normalizeAspectKey = (key) => {
  const raw = normalizeKey(key);
  if (!raw) return '';
  return raw
    .replace(/^eBay[\s-_]*Item[\s-_]*Specifics[\s:_-]*\s*/i, '')
    .replace(/^Pflicht[\s-_]*Item[\s-_]*Specifics[\s:_-]*\s*/i, '')
    .replace(/^eBay[\s-_]+/i, '')
    .trim();
};

// Canonical key aliases (cross-category + multilingual).
// Goal: stable internal vocabulary aligned with common eBay DE aspect names.
const KEY_ALIASES = new Map(
  Object.entries({
    // Product type
    'produkttyp': 'Produktart',
    'produkt typ': 'Produktart',
    'produktart': 'Produktart',
    'product type': 'Produktart',
    'item type': 'Produktart',

    // Brand / manufacturer
    'brand': 'Marke',
    'marke': 'Marke',
    'manufacturer': 'Hersteller',
    'hersteller': 'Hersteller',

    // Condition
    'condition': 'Zustand',
    'zustand': 'Zustand',

    // Common spec keys
    'color': 'Farbe',
    'colour': 'Farbe',
    'farbe': 'Farbe',
    'material': 'Material',
    'modell': 'Modell',
    'model': 'Modell',

    // Identifiers
    'mpn': 'Herstellernummer',
    'manufacturer part number': 'Herstellernummer',
    'herstellernummer': 'Herstellernummer',
    'oem reference number': 'Referenznummer(n) OEM',
    'oem reference number(s)': 'Referenznummer(n) OEM',
    'referenznummer(n) oem': 'Referenznummer(n) OEM',

    // Category path variants
    'kategorie-pfad': 'Kategorie',
    'kategorie pfad': 'Kategorie',
    'kategoriepfad': 'Kategorie',
    'category path': 'Kategorie',
    'category_path': 'Kategorie',
  }).map(([k, v]) => [k.toLowerCase(), v])
);

const normalizeCatId = (val) => {
  const raw = normalizeKey(val);
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, '');
  return digits || raw;
};

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
    'ebay kategorie',
    'ebay-kategorie',
    'ebay_kategorie',
    'ebay kategorie id',
    'ebay kategorie pfad',
    'kaufland_category_id',
    'kauflandcategoryid',
    'kaufland_category_path',
    'kauflandcategorypath',
    'kaufland kategorie',
    'kaufland-kategorie',
    'kaufland_kategorie',
    'kaufland kategorie pfad',
    'category_path',
    // Text-field payloads / LLM exports sometimes embed BaseLinker text fields in attributes
    'text_name',
    'text_description',
    'text_features',
    'text_features|de|ebay_9800',
    'features|de|ebay_9800',
    'features|de|ebay',
    // Category path variants (canonical key is "Kategorie")
    'kategorie-pfad',
    'kategorie pfad',
    'kategoriepfad',
  ]
);

const isMetaKey = (lowerKey) => {
  if (!lowerKey) return false;
  if (META_ATTRIBUTE_KEYS.has(lowerKey)) return true;
  if (lowerKey.includes('kaufland')) return true;
  if (lowerKey.startsWith('text_')) return true;
  if (lowerKey.includes('|de|')) return true;
  if (lowerKey.startsWith('features|')) return true;
  return false;
};

const IDENTIFIER_ATTRIBUTE_KEYS = new Set(
  ['ean', 'gtin', 'upc', 'sku', 'produkt-id', 'produkt id', 'product id', 'id', 'mpn'].map((x) => x.toLowerCase())
);

const isGpsrKey = (key) => normalizeLower(key).startsWith('gpsr ');

function extractCategoryId(product) {
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

function normalizeAttributesOrder(attrs = {}, catId, allowedList = []) {
  const entries = Object.entries(attrs || {});
  if (!entries.length) return {};
  const order = Array.isArray(allowedList) ? allowedList : [];
  const orderIndex = new Map(order.map((name, idx) => [normalizeLower(name), idx]));
  entries.sort((a, b) => {
    const aKey = normalizeLower(a[0]);
    const bKey = normalizeLower(b[0]);
    const aIsKategorie = aKey === 'kategorie';
    const bIsKategorie = bKey === 'kategorie';
    if (aIsKategorie !== bIsKategorie) return aIsKategorie ? -1 : 1;

    const aIsGpsr = aKey.startsWith('gpsr ');
    const bIsGpsr = bKey.startsWith('gpsr ');
    if (aIsGpsr !== bIsGpsr) return aIsGpsr ? 1 : -1;

    const aIdx = orderIndex.has(aKey) ? orderIndex.get(aKey) : Number.POSITIVE_INFINITY;
    const bIdx = orderIndex.has(bKey) ? orderIndex.get(bKey) : Number.POSITIVE_INFINITY;
    if (aIdx !== bIdx) return aIdx - bIdx;
    return aKey.localeCompare(bKey);
  });
  return entries.reduce((acc, [k, v]) => {
    acc[k] = v;
    return acc;
  }, {});
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function main() {
  const outDir = path.join(process.cwd(), 'exports', 'reconciliation');
  fs.mkdirSync(outDir, { recursive: true });

  const snapshot = await firestore.collection('products').get();
  const report = {
    apply: APPLY,
    limit: LIMIT,
    scanned: 0,
    changed: 0,
    skipped: 0,
    missingCategory: 0,
    invalidCategory: 0,
    samples: {
      changed: [],
      missingCategory: [],
      invalidCategory: [],
    },
  };

  let batch = firestore.batch();
  let batchCount = 0;

  const commitBatch = async () => {
    if (!APPLY || batchCount === 0) return;
    await batch.commit();
    batch = firestore.batch();
    batchCount = 0;
  };

  let processed = 0;
  for (const doc of snapshot.docs) {
    if (LIMIT && processed >= LIMIT) break;
    processed += 1;
    report.scanned += 1;

    const product = doc.data() || {};
    const details = product.details || {};
    const attrsRaw = details.attributes && typeof details.attributes === 'object' ? details.attributes : {};
    const attrsExtraRaw =
      details.attributes_extra && typeof details.attributes_extra === 'object' ? details.attributes_extra : {};

    const stableSku =
      normalizeKey(product?.identification?.sku) ||
      normalizeKey(product?.details?.identifiers?.sku) ||
      '';

    let catId = extractCategoryId(product);
    // Targeted fixes for the 3 SKUs referenced by the user (deterministic overrides).
    if (stableSku.toUpperCase() === 'SKU-1353005263') catId = '177699';
    if (stableSku.toUpperCase() === 'SKU-3818412905') catId = '29585';

    const categoryInfo = catId ? CATEGORIES[String(catId)] : null;
    if (!catId) {
      report.missingCategory += 1;
      if (report.samples.missingCategory.length < 20) report.samples.missingCategory.push(doc.id);
    } else if (!categoryInfo) {
      report.invalidCategory += 1;
      if (report.samples.invalidCategory.length < 20) report.samples.invalidCategory.push({ id: doc.id, catId });
    }

    const nextBreadcrumb = categoryInfo?.breadcrumb ? String(categoryInfo.breadcrumb) : null;

    const allowedList = catId ? getRequiredAspects(String(catId)) : [];
    const canonicalByLower = new Map(
      allowedList
        .map((n) => normalizeKey(n))
        .filter(Boolean)
        .map((n) => [normalizeLower(n), n])
    );

    const cleaned = {};
    const sourceByKey = {};
    const compliance = {};
    const extra = {};

    const seenOriginalKeys = new Set();

    const processEntry = (rawKey, rawVal) => {
      const originalKey = normalizeKey(rawKey);
      if (!originalKey) return;
      if (seenOriginalKeys.has(originalKey)) return;
      seenOriginalKeys.add(originalKey);

      const normalizedKey = normalizeAspectKey(originalKey);
      const preKey = normalizedKey || originalKey;
      const aliasedKey = KEY_ALIASES.get(normalizeLower(preKey)) || preKey;
      const keyToUse = aliasedKey;
      const lowerKey = normalizeLower(keyToUse);

      // Clean value
      let value = rawVal;
      if (typeof value === 'string') value = value.trim();
      value = normalizeBooleanishValue(value);

      // Drop empty or placeholder values
      if (value === null || value === undefined || value === '' || isPlaceholder(value)) {
        extra[originalKey] = rawVal;
        return;
      }

      // Remove meta keys (but keep in extra for audit)
      if (isMetaKey(lowerKey)) {
        extra[originalKey] = rawVal;
        return;
      }

      // Move non-primitive values out of attributes to keep UI stable
      if (value && typeof value === 'object') {
        extra[originalKey] = rawVal;
        return;
      }

      // Normalize category path keys: when we have a canonical eBay breadcrumb,
      // we only keep the canonical "Kategorie" derived from categoryId.
      // If we don't have a categoryId/breadcrumb yet, keep the user's value for now.
      if (lowerKey === 'kategorie' && nextBreadcrumb) {
        extra[originalKey] = rawVal;
        return;
      }

      // Remove identifier duplicates from attributes (we keep identifiers in details.identifiers)
      if (IDENTIFIER_ATTRIBUTE_KEYS.has(lowerKey)) {
        extra[originalKey] = rawVal;
        return;
      }

      // Compliance keys: keep, but separate sorting bucket
      if (isGpsrKey(keyToUse)) {
        compliance[keyToUse] = value;
        return;
      }

      const canonicalName = canonicalByLower.get(lowerKey) || keyToUse;

      // Avoid overwriting on collisions (e.g. "eBay_Marke" + "Marke" -> "Marke").
      // Prefer non-eBay-prefixed keys when both exist; otherwise preserve duplicates in attributes_extra.
      const existing = Object.prototype.hasOwnProperty.call(cleaned, canonicalName);
      if (!existing) {
        cleaned[canonicalName] = value;
        sourceByKey[canonicalName] = originalKey;
      } else {
        const prevSource = sourceByKey[canonicalName] || canonicalName;
        const prevVal = cleaned[canonicalName];
        const prevValStr = typeof prevVal === 'string' ? prevVal.trim() : prevVal;
        const nextValStr = typeof value === 'string' ? value.trim() : value;
        const prevEmpty = prevVal === null || prevVal === undefined || prevValStr === '';
        const nextEmpty = value === null || value === undefined || nextValStr === '';

        const isEbayPrefixed = (k) => {
          const lower = normalizeLower(k);
          return (
            lower.startsWith('ebay_') ||
            lower.startsWith('ebay-') ||
            lower.startsWith('ebay ') ||
            lower.startsWith('ebayitem')
          );
        };

        const preferNew =
          (prevEmpty && !nextEmpty) || (isEbayPrefixed(prevSource) && !isEbayPrefixed(originalKey));

        if (preferNew) {
          extra[prevSource] = prevVal;
          cleaned[canonicalName] = value;
          sourceByKey[canonicalName] = originalKey;
        } else {
          extra[originalKey] = rawVal;
        }
      }
    };

    for (const [rawKey, rawVal] of Object.entries(attrsRaw || {})) {
      processEntry(rawKey, rawVal);
    }
    // Rehydrate optional attributes previously moved to attributes_extra (without bringing back meta/noise).
    for (const [rawKey, rawVal] of Object.entries(attrsExtraRaw || {})) {
      processEntry(rawKey, rawVal);
    }

    // Canonical Kategorie attribute for consistent UI + exports
    if (nextBreadcrumb) {
      cleaned.Kategorie = nextBreadcrumb;
    }

    // Ordering: aspects by allowlist order, then compliance keys alphabetical
    // Ensure all required aspects exist (missing ones get null; no guessing)
    if (allowedList.length) {
      const existingLower = new Set(Object.keys(cleaned).map((k) => normalizeLower(k)));
      allowedList.forEach((req) => {
        const canonical = normalizeKey(req);
        if (!canonical) return;
        const lower = normalizeLower(canonical);
        if (existingLower.has(lower)) return;
        cleaned[canonical] = null;
        existingLower.add(lower);
      });
    }

    const orderedAspects = normalizeAttributesOrder(cleaned, catId, allowedList);
    const orderedCompliance = Object.fromEntries(
      Object.entries(compliance).sort((a, b) => normalizeLower(a[0]).localeCompare(normalizeLower(b[0])))
    );
    const nextAttributes = {
      ...orderedAspects,
      ...orderedCompliance,
    };

    // Build update payload (only category + attribute fields)
    const updates = {};

    if (catId) {
      updates['details.categoryId'] = String(catId);
      if (nextBreadcrumb) {
        updates['identification.category'] = nextBreadcrumb;
      }
    }

    // Always set cleaned attributes (even if empty -> {})
    updates['details.attributes'] = nextAttributes;

    // Preserve removed keys in attributes_extra
    if (Object.keys(extra).length) {
      updates['details.attributes_extra'] = extra;
    } else {
      updates['details.attributes_extra'] = FieldValue.delete();
    }

    // Remove legacy category fields if present
    updates['details.kauflandCategoryId'] = FieldValue.delete();
    updates['details.kauflandCategoryPath'] = FieldValue.delete();
    updates['details.ebayCategoryId'] = FieldValue.delete();
    updates['details.ebayCategoryBreadcrumb'] = FieldValue.delete();
    updates['details.ebayCategoryPath'] = FieldValue.delete();

    // Only write if something changes
    const prevAttrs = attrsRaw || {};
    const prevExtra = attrsExtraRaw || null;
    const prevCat = details.categoryId || details.ebayCategoryId || null;
    const prevBreadcrumb = product?.identification?.category || null;

    const catChanged =
      (catId && String(prevCat || '') !== String(catId)) ||
      (nextBreadcrumb && String(prevBreadcrumb || '') !== String(nextBreadcrumb));
    const attrsChanged = !deepEqual(prevAttrs, nextAttributes) || !deepEqual(prevExtra || {}, extra || {});

    if (!catChanged && !attrsChanged) {
      report.skipped += 1;
      continue;
    }

    report.changed += 1;
    if (report.samples.changed.length < 25) {
      report.samples.changed.push({
        id: doc.id,
        categoryId: catId,
        willSetBreadcrumb: Boolean(nextBreadcrumb),
        attrsBefore: Object.keys(prevAttrs).length,
        attrsAfter: Object.keys(nextAttributes).length,
        extraCount: Object.keys(extra).length,
      });
    }

    if (APPLY) {
      const ref = firestore.collection('products').doc(doc.id);
      batch.update(ref, updates);
      batchCount += 1;
      if (batchCount >= 400) {
        await commitBatch();
      }
    }
  }

  await commitBatch();

  const outPath = path.join(outDir, 'ebay-attributes-cleanup-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('Cleanup report written to:', outPath);
  console.log(JSON.stringify({ scanned: report.scanned, changed: report.changed, skipped: report.skipped, missingCategory: report.missingCategory, invalidCategory: report.invalidCategory, apply: APPLY }, null, 2));
}

main().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});


