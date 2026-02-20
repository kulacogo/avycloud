/* eslint-disable no-console */
/**
 * Audit (and optionally fix) eBay category mismatches.
 *
 * Problem:
 * - Some products have an absurd eBay categoryId because a vague/ambiguous string was mapped to an unrelated branch.
 * - In many cases, the product still contains an explicit eBay category PATH hint somewhere (e.g. `ebay_category_path`,
 *   legacy `details.ebayCategoryPath`, or a canonical `Kategorie` breadcrumb).
 *
 * This script detects:
 * - current categoryId != categoryId resolved from a path hint
 *
 * Safe fix (optional):
 * - Update only:
 *   - details.categoryId (canonical)
 *   - identification.category (breadcrumb from categories.json)
 *   - ops.category_repaired (audit trail)
 *
 * Usage:
 *   node backend/scripts/audit-ebay-category-mismatches.js
 *   node backend/scripts/audit-ebay-category-mismatches.js --limit 200
 *   node backend/scripts/audit-ebay-category-mismatches.js --apply
 *
 * Output:
 *   exports/reconciliation/ebay-category-mismatches.csv
 *   exports/reconciliation/ebay-category-mismatches.json
 */

const fs = require('fs');
const path = require('path');
const { firestore } = require('../lib/firestore');
const CATEGORIES = require('../ebay-data/categories.json');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const LIMIT = (() => {
  const idx = argv.indexOf('--limit');
  if (idx === -1) return null;
  const n = Number(argv[idx + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
})();

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function normalizeSegment(text) {
  return (text || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/[\u2010-\u2015-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBreadcrumb(raw) {
  const text = (raw || '').toString().trim();
  if (!text) return '';
  return text
    .split('>')
    .map((seg) => normalizeSegment(seg))
    .filter(Boolean)
    .join(' > ');
}

function normalizeCatId(val) {
  const raw = val == null ? '' : String(val).trim();
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, '');
  return digits || raw;
}

function extractCurrentCategoryId(product) {
  const details = product?.details || {};
  const attrs = details?.attributes || {};
  const candidate = details.categoryId || details.ebayCategoryId || attrs.ebay_category_id || null;
  return normalizeCatId(candidate);
}

function collectPathHints(product) {
  const details = product?.details || {};
  const attrs = details?.attributes || {};
  const extra =
    details?.attributes_extra && typeof details.attributes_extra === 'object' ? details.attributes_extra : {};
  const id = product?.identification || {};

  const candidates = [
    { key: 'details.categoryId', value: details.categoryId },
    { key: 'details.ebayCategoryPath', value: details.ebayCategoryPath },
    { key: 'details.ebayCategoryBreadcrumb', value: details.ebayCategoryBreadcrumb },
    { key: 'details.attributes.ebay_category_path', value: attrs.ebay_category_path },
    { key: 'details.attributes["eBay Kategorie"]', value: attrs['eBay Kategorie'] || attrs['eBay-Kategorie'] },
    { key: 'details.attributes.Kategorie', value: attrs.Kategorie },
    { key: 'details.attributes_extra.ebay_category_path', value: extra.ebay_category_path },
    { key: 'details.attributes_extra["eBay Kategorie"]', value: extra['eBay Kategorie'] || extra['eBay-Kategorie'] },
    { key: 'details.attributes_extra.Kategorie', value: extra.Kategorie },
    // NOTE: identification.category is internal/free-text. We only treat it as a hint when it looks like a breadcrumb.
    { key: 'identification.category', value: id.category },
  ]
    .map((entry) => ({ ...entry, value: entry.value == null ? '' : String(entry.value).trim() }))
    .filter((entry) => entry.value);

  // Only treat breadcrumb-like hints as path hints (avoid ambiguous leaf names).
  return candidates
    .filter((c) => c.value.includes('>'))
    .map((c) => ({ key: c.key, path: c.value }));
}

function buildBreadcrumbIndex() {
  const idx = new Map();
  Object.values(CATEGORIES || {}).forEach((cat) => {
    const breadcrumb = cat?.breadcrumb || '';
    const id = cat?.id != null ? String(cat.id) : null;
    if (!breadcrumb || !id) return;
    const norm = normalizeBreadcrumb(breadcrumb);
    if (!norm) return;
    // Keep first match; normalized breadcrumbs should be unique.
    if (!idx.has(norm)) idx.set(norm, id);
  });
  return idx;
}

function resolveCategoryIdFromPath(pathText, breadcrumbIndex) {
  const norm = normalizeBreadcrumb(pathText);
  if (!norm) return null;
  return breadcrumbIndex.get(norm) || null;
}

async function main() {
  const outDir = path.join(process.cwd(), 'exports', 'reconciliation');
  ensureDir(outDir);

  const breadcrumbIndex = buildBreadcrumbIndex();

  const snap = await firestore.collection('products').get();
  const rows = [];

  const summary = {
    scanned: 0,
    limited: LIMIT,
    mismatches: 0,
    invalidCurrentCategoryId: 0,
    applied: 0,
    skippedNoHint: 0,
    skippedNoChange: 0,
  };

  let processed = 0;
  let batch = firestore.batch();
  let batchWrites = 0;

  rows.push(
    [
      'productId',
      'sku',
      'name',
      'currentCategoryId',
      'currentBreadcrumb',
      'suggestedCategoryId',
      'suggestedBreadcrumb',
      'hintKey',
      'hintPath',
      'action',
    ].join(',')
  );

  for (const doc of snap.docs) {
    if (LIMIT && processed >= LIMIT) break;
    processed += 1;
    summary.scanned += 1;

    const product = doc.data() || {};
    const currentId = extractCurrentCategoryId(product);
    const currentCat = currentId ? CATEGORIES[String(currentId)] : null;
    const currentBreadcrumb = currentCat?.breadcrumb || '';
    if (currentId && !currentCat) summary.invalidCurrentCategoryId += 1;

    const hints = collectPathHints(product);
    if (!hints.length) {
      summary.skippedNoHint += 1;
      continue;
    }

    // Choose the first hint that resolves to a valid eBay category id.
    let resolved = null;
    for (const hint of hints) {
      const suggestedId = resolveCategoryIdFromPath(hint.path, breadcrumbIndex);
      if (!suggestedId) continue;
      const suggestedCat = CATEGORIES[String(suggestedId)];
      if (!suggestedCat) continue;
      resolved = {
        suggestedId,
        suggestedBreadcrumb: suggestedCat.breadcrumb || '',
        hintKey: hint.key,
        hintPath: hint.path,
      };
      break;
    }

    if (!resolved) {
      summary.skippedNoHint += 1;
      continue;
    }

    const currentStr = currentId ? String(currentId) : '';
    const suggestedStr = String(resolved.suggestedId);
    if (currentStr && currentStr === suggestedStr) {
      summary.skippedNoChange += 1;
      continue;
    }

    summary.mismatches += 1;

    const sku =
      product?.identification?.sku ||
      product?.details?.identifiers?.sku ||
      doc.id;
    const name = product?.identification?.name || '';

    let action = 'report';
    if (APPLY) {
      action = 'applied';
      const docRef = firestore.collection('products').doc(doc.id);
      const nowIso = new Date().toISOString();
      batch.update(docRef, {
        'details.categoryId': suggestedStr,
        'identification.category': resolved.suggestedBreadcrumb || '',
        'ops.category_repaired': {
          at_iso: nowIso,
          from: currentStr || null,
          to: suggestedStr,
          hint_key: resolved.hintKey,
          hint_path: resolved.hintPath,
          reason: 'path-hint-mismatch',
        },
      });
      batchWrites += 1;
      summary.applied += 1;

      if (batchWrites >= 450) {
        await batch.commit();
        batch = firestore.batch();
        batchWrites = 0;
      }
    }

    rows.push(
      [
        csvEscape(doc.id),
        csvEscape(sku),
        csvEscape(name),
        csvEscape(currentStr),
        csvEscape(currentBreadcrumb),
        csvEscape(suggestedStr),
        csvEscape(resolved.suggestedBreadcrumb),
        csvEscape(resolved.hintKey),
        csvEscape(resolved.hintPath),
        csvEscape(action),
      ].join(',')
    );
  }

  if (APPLY && batchWrites > 0) {
    await batch.commit();
  }

  const csvPath = path.join(outDir, 'ebay-category-mismatches.csv');
  fs.writeFileSync(csvPath, rows.join('\n'));

  const jsonPath = path.join(outDir, 'ebay-category-mismatches.json');
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

  console.log('Report written:', csvPath);
  console.log('Summary written:', jsonPath);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});


