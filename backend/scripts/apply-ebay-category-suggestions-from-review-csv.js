/* eslint-disable no-console */
/**
 * D.0b-Migration 2026-05-10: Migrated to getAllProductsForTenant().
 * See /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.0)
 * D.0b-Migration: Default to avycloud. Add --tenant flag for multi-tenant runs.
 */
/**
 * Apply eBay category suggestions from a review CSV to Firestore products.
 *
 * Input: a CSV like `exports/category_review_suspicious_roots__suggested_*.csv` containing:
 * - SKU, DocId
 * - TargetCategoryId (required for apply)
 * - TargetCategoryBreadcrumb (optional, will be validated against categories.json)
 *
 * Safety:
 * - Dry-run by default.
 * - Validates TargetCategoryId exists in backend/ebay-data/categories.json.
 * - Uses saveProduct(..., { allowCategoryChange: true }) so category invariants + required aspects are re-applied.
 * - Count guard: pre/post products must remain 420 (or provided expected count).
 *
 * Usage:
 *   node backend/scripts/apply-ebay-category-suggestions-from-review-csv.js \
 *     --in exports/category_review_suspicious_roots__suggested_20260105-134822.csv \
 *     --dry-run
 *
 *   node backend/scripts/apply-ebay-category-suggestions-from-review-csv.js \
 *     --in exports/category_review_suspicious_roots__suggested_20260105-134822.csv \
 *     --apply --expected-count 420 --concurrency 2
 */

const fs = require('fs');
const path = require('path');
const PQueue = require('p-queue').default || require('p-queue');
const { parse } = require('csv-parse/sync');
const { getAllProducts, getAllProductsForTenant, getProduct, saveProduct } = require('../lib/firestore');

// D.0b-Hardening 2026-05-11: mandatory TENANT_ID for write scripts (prevents silent cross-tenant writes)
const TENANT_ID = process.env.TENANT_ID;
if (!TENANT_ID) {
  console.error('TENANT_ID env var required. Example: TENANT_ID=avycloud node <script>.js');
  process.exit(1);
}
console.warn(`[D.0b-Hardening] Running for tenantId='${TENANT_ID}'.`);

const EBAY_CATEGORIES_JSON = path.join(__dirname, '..', 'ebay-data', 'categories.json');
// eslint-disable-next-line import/no-dynamic-require, global-require
const EBAY_CATEGORIES = require(EBAY_CATEGORIES_JSON);

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

function loadCsv(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    bom: true,
  });
}

function canonicalBreadcrumb(id) {
  const entry = EBAY_CATEGORIES[String(id || '').trim()];
  return entry?.breadcrumb ? String(entry.breadcrumb).trim() : '';
}

function parseArgs(argv) {
  const args = {
    in: null,
    apply: false,
    dryRun: true,
    expectedCount: 420,
    concurrency: 2,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--in') {
      args.in = argv[i + 1];
      i += 1;
    } else if (t === '--apply') {
      args.apply = true;
      args.dryRun = false;
    } else if (t === '--dry-run') {
      args.apply = false;
      args.dryRun = true;
    } else if (t === '--expected-count') {
      args.expectedCount = Number(argv[i + 1]);
      i += 1;
    } else if (t === '--concurrency') {
      args.concurrency = Number(argv[i + 1]);
      i += 1;
    }
  }
  if (!args.in) throw new Error('Missing --in <csv>');
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const stamp = nowStamp();
  const inPath = path.isAbsolute(args.in) ? args.in : path.join(process.cwd(), args.in);
  const outDir = path.join(process.cwd(), 'exports', 'category-apply', stamp);
  ensureDir(outDir);

  console.log(`[category-apply] mode=${args.apply ? 'APPLY' : 'DRY_RUN'} in=${inPath} out=${outDir}`);

  const products = await getAllProductsForTenant(TENANT_ID);
  const preCount = products.length;
  console.log(`[category-apply] preCount=${preCount}`);
  if (args.apply && preCount !== args.expectedCount) {
    throw new Error(`[category-apply] ABORT: expected preCount=${args.expectedCount} but got ${preCount}`);
  }

  const bySku = new Map();
  const byId = new Map();
  products.forEach((p) => {
    const sku = safeString(p?.identification?.sku) || safeString(p?.details?.identifiers?.sku);
    if (sku) bySku.set(sku, String(p.id));
    if (p?.id) byId.set(String(p.id), String(p.id));
  });

  const rows = loadCsv(inPath);
  const queue = new PQueue({ concurrency: Math.max(1, args.concurrency || 2) });

  const report = [];
  let applied = 0;
  let wouldApply = 0;
  let noop = 0;
  let skipped = 0;
  let invalid = 0;

  for (const row of rows) {
    queue.add(async () => {
      const sku = safeString(row.SKU);
      const docId = safeString(row.DocId);
      const targetId = safeString(row.TargetCategoryId);
      const targetBreadcrumb = safeString(row.TargetCategoryBreadcrumb);

      if (!targetId) {
        skipped += 1;
        report.push({ sku, docId, status: 'skip', reason: 'missing_target_category_id' });
        return;
      }
      const canonical = canonicalBreadcrumb(targetId);
      if (!canonical || !canonical.includes('>')) {
        invalid += 1;
        report.push({ sku, docId, status: 'invalid', reason: 'target_id_not_in_taxonomy', targetId });
        return;
      }
      if (targetBreadcrumb && canonical && targetBreadcrumb !== canonical) {
        // mismatch -> prefer canonical, but log it
        report.push({
          sku,
          docId,
          status: args.apply ? 'apply' : 'would_apply',
          note: 'breadcrumb_mismatch_prefer_canonical',
          targetId,
          targetBreadcrumb,
          canonical,
        });
      }

      const productId = (sku && bySku.get(sku)) || (docId && byId.get(docId)) || null;
      if (!productId) {
        invalid += 1;
        report.push({ sku, docId, status: 'invalid', reason: 'product_not_found' });
        return;
      }

      const product = await getProduct(productId);
      if (!product?.id) {
        invalid += 1;
        report.push({ sku, docId, status: 'invalid', reason: 'product_not_found_by_id', productId });
        return;
      }

      const currentId = safeString(product?.details?.categoryId);
      if (currentId === targetId) {
        noop += 1;
        report.push({ sku, docId, status: 'noop', productId, targetId });
        return;
      }

      const next = JSON.parse(JSON.stringify(product));
      next.details = next.details || {};
      next.identification = next.identification || {};
      next.ops = next.ops || {};

      next.details.categoryId = targetId;
      next.identification.category = canonical;
      next.ops.data_quality = {
        ...(next.ops.data_quality || {}),
        category_applied_from_review_csv: {
          iso: new Date().toISOString(),
          from: currentId || null,
          to: targetId,
          csv: path.basename(inPath),
        },
      };

      if (!args.apply) {
        wouldApply += 1;
        report.push({ sku, docId, status: 'would_apply', productId, from: currentId || null, to: targetId, canonical });
        return;
      }

      await saveProduct(next, { source: 'category-review-csv', allowCategoryChange: true });
      applied += 1;
      report.push({ sku, docId, status: 'applied', productId, from: currentId || null, to: targetId, canonical });
    });
  }

  await queue.onIdle();

  const summary = { preCount, applied, wouldApply, noop, skipped, invalid, totalRows: rows.length };
  fs.writeFileSync(path.join(outDir, args.apply ? 'apply_summary.json' : 'dryrun_summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, args.apply ? 'apply_report.json' : 'dryrun_report.json'), JSON.stringify(report, null, 2), 'utf8');

  console.log(`[category-apply] rows=${rows.length} applied=${applied} skipped=${skipped} invalid=${invalid}`);

  if (!args.apply) {
    console.log('[category-apply] Dry-run complete. No writes performed.');
    return;
  }

  const post = await getAllProductsForTenant(TENANT_ID);
  const postCount = post.length;
  console.log(`[category-apply] postCount=${postCount}`);
  if (postCount !== preCount) {
    throw new Error(`[category-apply] COUNT MISMATCH pre=${preCount} post=${postCount}`);
  }
  console.log(`[category-apply] SUCCESS. Reports in ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


