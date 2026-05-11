/* eslint-disable no-console */
/**
 * D.0b-Migration 2026-05-10: Migrated to getAllProductsForTenant().
 * See /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.0)
 * D.0b-Migration: Default to avycloud. Add --tenant flag for multi-tenant runs.
 */
/**
 * Cleanup: remove marketplace-specific attribute keys (ebay/kaufland) and keep attributes
 * consistently alphabetically sorted.
 *
 * Also does a best-effort neutral replacement:
 * - eBay/Kaufland prefixes like "eBay_Produktart" / "Kaufland_Produktart" become "Produktart"
 * - category-path-ish marketplace keys are mapped to neutral "Kategorie" when missing
 *
 * Safety:
 * - DRY-RUN by default
 * - COUNT GUARD: no create/delete; must remain stable
 *
 * Usage:
 *   node backend/scripts/cleanup-marketplace-attributes.js --dry-run --expected-count 420
 *   node backend/scripts/cleanup-marketplace-attributes.js --apply --expected-count 420
 */

const fs = require('fs');
const path = require('path');
const { getAllProducts, getAllProductsForTenant, firestore } = require('../lib/firestore');

// D.0b-Hardening 2026-05-11: mandatory TENANT_ID for write scripts (prevents silent cross-tenant writes)
const TENANT_ID = process.env.TENANT_ID;
if (!TENANT_ID) {
  console.error('TENANT_ID env var required. Example: TENANT_ID=avycloud node <script>.js');
  process.exit(1);
}
console.warn(`[D.0b-Hardening] Running for tenantId='${TENANT_ID}'.`);
const { sanitizeFirestoreValue } = require('../lib/firestore'); // exported? (if not, we fall back to raw update)

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeLower(v) {
  return safeString(v).toLowerCase();
}

function sortAttrsAlphabetically(attrs) {
  const entries = Object.entries(attrs || {}).sort((a, b) =>
    normalizeLower(a[0]).localeCompare(normalizeLower(b[0]), 'de', { sensitivity: 'base' })
  );
  return entries.reduce((acc, [k, v]) => {
    acc[k] = v;
    return acc;
  }, {});
}

function normalizeNeutralKey(rawKey) {
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

function isMarketplaceKey(key) {
  const k = normalizeLower(key);
  if (!k) return false;
  return k.includes('ebay') || k.includes('kaufland');
}

function isMetaKey(key) {
  const k = normalizeLower(key);
  if (!k) return false;
  if (k.startsWith('text_')) return true;
  if (k.includes('|de|')) return true;
  if (k.startsWith('features|')) return true;
  // meta IDs / paths
  const META = new Set(
    [
      'ebay_category_id',
      'ebaycategoryid',
      'ebay_category_path',
      'ebaycategorypath',
      'ebay_category_breadcrumb',
      'ebaycategorybreadcrumb',
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
      'category_id',
      'categoryid',
      'produkt-id',
      'produkt id',
      'produkt_id',
      'produktid',
      'product-id',
      'product id',
      'product_id',
      'productid',
      'artikel-id',
      'artikel id',
      'artikel_id',
    ].map((x) => x.toLowerCase())
  );
  if (META.has(k)) return true;
  return false;
}

function looksLikeBreadcrumb(value) {
  const v = safeString(value);
  if (!v) return false;
  return v.includes('>') && v.length >= 5;
}

function parseArgs(argv) {
  const out = { apply: false, expectedCount: null, outDir: null };
  argv.forEach((arg, idx) => {
    if (arg === '--apply') out.apply = true;
    if (arg === '--dry-run') out.apply = false;
    if (arg === '--expected-count') out.expectedCount = Number(argv[idx + 1]);
    if (arg === '--out') out.outDir = argv[idx + 1];
  });
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stamp = nowStamp();
  const outDir = args.outDir || path.join('exports', 'marketplace-attrs-cleanup', stamp);
  fs.mkdirSync(outDir, { recursive: true });

  const products = await getAllProductsForTenant(TENANT_ID);
  if (args.expectedCount != null && products.length !== args.expectedCount) {
    throw new Error(`Count guard failed: expected ${args.expectedCount} products, got ${products.length}`);
  }

  const report = { at_iso: new Date().toISOString(), apply: args.apply, total: products.length, changed: 0, unchanged: 0, entries: [] };

  const writer = firestore.bulkWriter();
  let writes = 0;

  for (const product of products) {
    const docId = product?.id;
    const attrs = product?.details?.attributes && typeof product.details.attributes === 'object' ? product.details.attributes : {};
    const extra = product?.details?.attributes_extra && typeof product.details.attributes_extra === 'object' ? product.details.attributes_extra : {};

    const nextAttrs = {};
    let dropped = [];
    let renamed = [];
    let mappedKategorie = false;

    const existingKategorie = Object.keys(attrs).some((k) => normalizeLower(k) === 'kategorie');
    const canonicalKategorie = safeString(product?.identification?.category);
    const categoryFallbacks = [];

    for (const [rawKey, val] of Object.entries(attrs)) {
      const originalKey = safeString(rawKey);
      if (!originalKey) continue;
      const neutralKey = normalizeNeutralKey(originalKey);
      const lowerNeutral = normalizeLower(neutralKey || originalKey);

      // If the raw key contains marketplace name, it MUST be removed or neutralized.
      // If we can neutralize (prefix-only), we keep the neutral key.
      const wasMarketplace = isMarketplaceKey(originalKey);
      const becomesMarketplace = isMarketplaceKey(neutralKey);

      // Collect possible category breadcrumbs from marketplace keys.
      if ((wasMarketplace || isMetaKey(originalKey) || isMetaKey(neutralKey)) && looksLikeBreadcrumb(val)) {
        categoryFallbacks.push(String(val));
      }

      // Remove pure marketplace/meta keys entirely.
      if (becomesMarketplace || isMetaKey(lowerNeutral) || isMetaKey(originalKey)) {
        dropped.push(originalKey);
        continue;
      }

      // If this was a marketplace-prefixed key and we successfully neutralized it, record rename.
      const finalKey = neutralKey || originalKey;
      if (finalKey !== originalKey) {
        renamed.push({ from: originalKey, to: finalKey });
      }

      // Avoid keeping "Kategorie" from imports; we will set it canonically below.
      if (normalizeLower(finalKey) === 'kategorie') {
        dropped.push(originalKey);
        continue;
      }

      nextAttrs[finalKey] = val;
    }

    // Ensure neutral Kategorie exists when possible.
    if (canonicalKategorie) {
      nextAttrs.Kategorie = canonicalKategorie;
      mappedKategorie = true;
    } else if (!existingKategorie) {
      const candidate = categoryFallbacks.find((v) => looksLikeBreadcrumb(v));
      if (candidate) {
        nextAttrs.Kategorie = candidate;
        mappedKategorie = true;
      }
    }

    // Remove marketplace keys from attributes_extra too (we don't want them to persist anywhere).
    const nextExtra = {};
    const extraDropped = [];
    for (const [k, v] of Object.entries(extra || {})) {
      const key = safeString(k);
      if (!key) continue;
      if (isMarketplaceKey(key) || isMarketplaceKey(normalizeNeutralKey(key))) {
        extraDropped.push(key);
        continue;
      }
      nextExtra[key] = v;
    }

    const sorted = sortAttrsAlphabetically(nextAttrs);
    const changed =
      JSON.stringify(sorted) !== JSON.stringify(sortAttrsAlphabetically(attrs)) ||
      JSON.stringify(nextExtra) !== JSON.stringify(extra);

    if (!changed) {
      report.unchanged++;
      continue;
    }

    report.changed++;
    report.entries.push({
      id: docId,
      dropped: Array.from(new Set(dropped)).slice(0, 50),
      renamed: renamed.slice(0, 50),
      mappedKategorie,
      extraDropped: extraDropped.slice(0, 50),
    });

    if (args.apply) {
      const ref = firestore.collection('products').doc(docId);
      const patch = {
        details: {
          ...(product.details || {}),
          attributes: sorted,
          attributes_extra: Object.keys(nextExtra).length ? nextExtra : undefined,
        },
        ops: {
          ...(product.ops || {}),
          data_quality: {
            ...((product.ops && product.ops.data_quality) || {}),
            marketplace_attrs_cleanup_v1: {
              at_iso: new Date().toISOString(),
              dropped_count: Array.from(new Set(dropped)).length,
              renamed_count: renamed.length,
              extra_dropped_count: extraDropped.length,
            },
          },
        },
      };
      // best-effort sanitization if helper is available; else write raw patch.
      const toWrite = typeof sanitizeFirestoreValue === 'function' ? sanitizeFirestoreValue(patch) : patch;
      writer.set(ref, toWrite, { merge: true });
      writes++;
    }
  }

  await writer.close();

  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf-8');
  console.log(`[cleanup-marketplace-attributes] ${args.apply ? 'APPLY' : 'DRY-RUN'} done. changed=${report.changed} unchanged=${report.unchanged} out=${outDir}`);
  if (args.expectedCount != null) {
    const after = await getAllProductsForTenant(TENANT_ID);
    console.log(`[cleanup-marketplace-attributes] count guard: ${products.length} -> ${after.length}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


