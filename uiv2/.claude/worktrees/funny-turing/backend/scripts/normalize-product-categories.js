/* eslint-disable no-console */
/**
 * Normalize product categories to a consistent breadcrumb format.
 *
 * Goal:
 * - `identification.category` should be a full breadcrumb (contains '>') whenever we can derive it
 *   unambiguously from the canonical eBay taxonomy.
 * - `details.categoryId` should be set to the resolved eBay category ID when available.
 *
 * Safety rules (no guessing):
 * - We only resolve category from:
 *   - a valid existing categoryId (details.categoryId / legacy ebayCategoryId / attributes.ebay_category_id)
 *   - an exact breadcrumb match (path -> id)
 *   - a UNIQUE leaf-name match (e.g. "Motoröl" -> id) using MarketplaceLookup's unique leaf index
 * - If ambiguous, we do not change the category; we only record a flag.
 *
 * Usage:
 *   node backend/scripts/normalize-product-categories.js --dry-run
 *   node backend/scripts/normalize-product-categories.js --apply --expected-count 420
 */

const fs = require('fs');
const path = require('path');
const { Firestore } = require('@google-cloud/firestore');
const { MarketplaceLookup } = require('../lib/marketplace-lookup');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const firestore = new Firestore({ projectId: PROJECT_ID });

const EBAY_CATEGORIES_JSON = path.join(__dirname, '..', 'ebay-data', 'categories.json');
const EBAY_CATEGORY_CSV = path.join(__dirname, '..', 'ebay', 'DE_New_Structure_(May2023).csv');
const KAUFLAND_CATEGORY_CSV = path.join(__dirname, '..', 'kaufland', 'category_tree_all_languages.csv');

const lookup = new MarketplaceLookup({
  ebayCsvPath: EBAY_CATEGORY_CSV,
  kauflandCsvPath: KAUFLAND_CATEGORY_CSV,
  ebayPathColumn: 'category_path',
  kauflandPathColumn: 'category_path',
});

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

function normalizePath(value) {
  return safeString(value).replace(/\s+/g, ' ').trim();
}

function looksBreadcrumb(pathStr) {
  const p = normalizePath(pathStr);
  return p.includes('>') && p.split('>').map((s) => s.trim()).filter(Boolean).length >= 2;
}

function readEbayCategories() {
  const raw = fs.readFileSync(EBAY_CATEGORIES_JSON, 'utf8');
  const json = JSON.parse(raw);
  return json && typeof json === 'object' ? json : {};
}

const EBAY_CATEGORIES = readEbayCategories();

function getBreadcrumbById(id) {
  if (!id) return '';
  const key = String(id).trim();
  const entry = EBAY_CATEGORIES[key];
  const breadcrumb = entry?.breadcrumb ? String(entry.breadcrumb) : '';
  return breadcrumb.trim();
}

function computeCategoryPatch(product) {
  const updates = {};
  const flags = [];

  const details = product?.details && typeof product.details === 'object' ? product.details : {};
  const attrs = details?.attributes && typeof details.attributes === 'object' ? details.attributes : {};
  const extra = details?.attributes_extra && typeof details.attributes_extra === 'object' ? details.attributes_extra : {};
  const identification = product?.identification && typeof product.identification === 'object'
    ? product.identification
    : {};

  const existingCategoryText = normalizePath(identification.category);

  const candidateId =
    safeString(details.categoryId) ||
    safeString(details.ebayCategoryId) ||
    safeString(extra.ebay_category_id) ||
    safeString(extra.ebayCategoryId) ||
    safeString(attrs.ebayCategoryId) ||
    '';

  // 1) If we already have a valid eBay category id -> enforce breadcrumb
  if (candidateId && lookup.isValidEbayId(candidateId)) {
    const breadcrumb = getBreadcrumbById(candidateId);
    if (breadcrumb) {
      if (safeString(details.categoryId) !== candidateId) {
        updates['details.categoryId'] = candidateId;
      }
      if (!looksBreadcrumb(existingCategoryText) || existingCategoryText !== breadcrumb) {
        updates['identification.category'] = breadcrumb;
      }
      flags.push('category_normalized_from_id');
      return { updates, flags };
    }
    flags.push('category_id_has_no_breadcrumb');
    return { updates, flags };
  }

  // 2) No id: try resolve from category text deterministically (exact breadcrumb or unique leaf)
  const textCandidates = [
    safeString(details.ebayCategoryPath),
    safeString(attrs.ebay_category_path),
    safeString(extra.ebay_category_path),
    safeString(extra.ebay_category),
    safeString(attrs.Kategorie),
    safeString(attrs.category),
    existingCategoryText,
  ]
    .map(normalizePath)
    .filter(Boolean);

  if (!textCandidates.length) {
    flags.push('category_missing');
    return { updates, flags };
  }

  // Prefer breadcrumb-like candidates; otherwise use the leaf candidate.
  const breadcrumbCandidate = textCandidates.find((c) => looksBreadcrumb(c));
  const leafCandidate = breadcrumbCandidate ? '' : textCandidates[0];
  const toLookup = breadcrumbCandidate || leafCandidate;

  // MarketplaceLookup:
  // - exact path matches OR unique leaf name matches (safe).
  const resolvedId = lookup.lookupEbay(toLookup);
  if (resolvedId && lookup.isValidEbayId(String(resolvedId))) {
    const breadcrumb = getBreadcrumbById(resolvedId) || (breadcrumbCandidate || '');
    if (breadcrumb && looksBreadcrumb(breadcrumb)) {
      updates['details.categoryId'] = String(resolvedId);
      updates['identification.category'] = breadcrumb;
      flags.push(breadcrumbCandidate ? 'category_resolved_from_breadcrumb' : 'category_resolved_from_unique_leaf');
      return { updates, flags };
    }
    // If we can't find a breadcrumb for that ID, we still set the id but keep text unchanged.
    updates['details.categoryId'] = String(resolvedId);
    flags.push('category_resolved_id_no_breadcrumb');
    return { updates, flags };
  }

  // 3) Still unresolved: record inconsistency flag if leaf-only
  if (!looksBreadcrumb(existingCategoryText)) {
    flags.push('category_leaf_only_unresolved');
  } else {
    flags.push('category_breadcrumb_unresolved');
  }
  return { updates, flags };
}

function parseArgs(argv) {
  const args = { dryRun: true, apply: false, expectedCount: 420 };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--apply') {
      args.apply = true;
      args.dryRun = false;
    }
    if (t === '--dry-run') {
      args.dryRun = true;
      args.apply = false;
    }
    if (t === '--expected-count') {
      args.expectedCount = Number(argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const stamp = nowStamp();
  const outDir = path.join(process.cwd(), 'exports', 'category-normalize', stamp);
  ensureDir(outDir);

  console.log(`[category-normalize] project=${PROJECT_ID} mode=${args.apply ? 'APPLY' : 'DRY_RUN'} out=${outDir}`);

  const snap = await firestore.collection('products').get();
  const preCount = snap.size;
  console.log(`[category-normalize] preCount=${preCount}`);
  if (args.apply && preCount !== args.expectedCount) {
    throw new Error(`[category-normalize] ABORT: expected preCount=${args.expectedCount} but got ${preCount}`);
  }

  const report = [];
  const summary = { preCount, total: preCount, touched: 0, flags: {}, changedFields: {} };

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const { updates, flags } = computeCategoryPatch(data);
    const fields = Object.keys(updates || {});
    if (!fields.length && !flags.length) continue;

    const touched = fields.length > 0;
    if (touched) summary.touched += 1;

    flags.forEach((f) => {
      summary.flags[f] = (summary.flags[f] || 0) + 1;
    });
    fields.forEach((k) => {
      summary.changedFields[k] = (summary.changedFields[k] || 0) + 1;
    });

    report.push({
      docId: doc.id,
      sku: safeString(data?.identification?.sku) || safeString(data?.details?.identifiers?.sku) || doc.id,
      flags,
      changed: fields,
      updates: args.apply ? undefined : updates,
    });
  }

  fs.writeFileSync(
    path.join(outDir, args.apply ? 'apply_summary.json' : 'dryrun_summary.json'),
    JSON.stringify(summary, null, 2),
    'utf8'
  );
  fs.writeFileSync(
    path.join(outDir, args.apply ? 'apply_report.json' : 'dryrun_report.json'),
    JSON.stringify(report, null, 2),
    'utf8'
  );

  console.log(`[category-normalize] touched=${summary.touched}`);

  if (!args.apply) {
    console.log('[category-normalize] Dry-run complete. No writes performed.');
    return;
  }

  console.log('[category-normalize] Applying updates via BulkWriter...');
  const bulkWriter = firestore.bulkWriter({
    throttling: { initialOpsPerSecond: 50, maxOpsPerSecond: 300 },
  });
  bulkWriter.onWriteError((error) => {
    console.error('[category-normalize] write error', error.documentRef.path, error.message);
    if (error.code === 'unavailable' && error.failedAttempts < 6) return true;
    return false;
  });

  for (const item of report) {
    if (!item.changed || item.changed.length === 0) continue;
    const docRef = firestore.collection('products').doc(item.docId);
    const data = snap.docs.find((d) => d.id === item.docId)?.data() || {};
    const { updates } = computeCategoryPatch(data);
    if (!updates || Object.keys(updates).length === 0) continue;
    bulkWriter.update(docRef, updates);
  }

  await bulkWriter.close();
  const postSnap = await firestore.collection('products').get();
  const postCount = postSnap.size;
  console.log(`[category-normalize] postCount=${postCount}`);
  if (postCount !== preCount) {
    throw new Error(`[category-normalize] COUNT MISMATCH pre=${preCount} post=${postCount}`);
  }
  console.log(`[category-normalize] SUCCESS. Reports in ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


