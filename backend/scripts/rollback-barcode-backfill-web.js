/* eslint-disable no-console */
/**
 * D.0b-Migration 2026-05-10: Migrated to getAllProductsForTenant().
 * See /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.0)
 * D.0b-Migration: Default to avycloud. Override via TENANT_ID env var.
 */
/**
 * Rollback barcodes applied by barcode-backfill-web apply_report.json.
 *
 * Why:
 * - Some web-derived GTINs can be valid (checkdigit) but belong to a different product.
 * - Once persisted, downstream pipelines might treat the barcode as a strong identifier and overwrite product data.
 *
 * This script:
 * - Reads an apply_report.json (exports/barcode-backfill-web/.../apply_report.json)
 * - For each entry with status=applied:
 *   - Loads the product from Firestore
 *   - If the product still contains that code AND the product shows the backfill marker,
 *     remove that code from identification.barcodes and delete matching identifiers (ean/gtin/upc).
 *   - Writes an audit marker ops.data_quality.barcode_backfill_rollback_v1
 *
 * Safety:
 * - DRY-RUN by default
 * - COUNT GUARD: product count must remain stable
 *
 * Usage:
 *   node backend/scripts/rollback-barcode-backfill-web.js --report exports/barcode-backfill-web/20260107-020803/apply_report.json --dry-run --expected-count 420
 *   node backend/scripts/rollback-barcode-backfill-web.js --report exports/barcode-backfill-web/20260107-020803/apply_report.json --apply --expected-count 420
 */

const fs = require('fs');
const path = require('path');
const { getAllProductsForTenant, getProduct, saveProduct } = require('../lib/firestore');

// D.0b-Hardening 2026-05-11: mandatory TENANT_ID for write scripts (prevents silent cross-tenant writes)
const TENANT_ID = process.env.TENANT_ID;
if (!TENANT_ID) {
  console.error('TENANT_ID env var required. Example: TENANT_ID=avycloud node <script>.js');
  process.exit(1);
}
console.warn(`[D.0b-Hardening] Running for tenantId='${TENANT_ID}'.`);
const { normalizeDigits, isValidGtin, getGtinType } = require('../lib/gtin');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function parseArgs(argv) {
  const out = { apply: false, expectedCount: null, reportPath: null, outDir: null };
  argv.forEach((arg, idx) => {
    if (arg === '--apply') out.apply = true;
    if (arg === '--dry-run') out.apply = false;
    if (arg === '--expected-count') out.expectedCount = Number(argv[idx + 1]);
    if (arg === '--report') out.reportPath = argv[idx + 1];
    if (arg === '--out') out.outDir = argv[idx + 1];
  });
  return out;
}

function removeCodeFromProduct(product, code) {
  const normalized = normalizeDigits(code);
  if (!normalized || !isValidGtin(normalized)) return { changed: false, reason: 'invalid_code' };

  const next = JSON.parse(JSON.stringify(product || {}));
  if (!next.identification) next.identification = {};
  if (!next.details) next.details = {};
  if (!next.details.identifiers) next.details.identifiers = {};
  if (!next.ops) next.ops = {};

  const before = Array.isArray(next.identification.barcodes) ? next.identification.barcodes : [];
  const beforeNorm = before.map((c) => normalizeDigits(String(c))).filter(Boolean);
  const removed = beforeNorm.includes(normalized);
  // IMPORTANT: saveProduct merges identification with existing data.
  // To ensure deletion is applied, we must explicitly overwrite with an empty array,
  // not just omit/delete the field in the incoming payload.
  if (removed) {
    next.identification.barcodes = [];
  }

  const t = getGtinType(normalized);
  if (t === 'ean13' && safeString(next.details.identifiers.ean) === normalized) delete next.details.identifiers.ean;
  if (t === 'gtin14' && safeString(next.details.identifiers.gtin) === normalized) delete next.details.identifiers.gtin;
  if (t === 'upc12' && safeString(next.details.identifiers.upc) === normalized) delete next.details.identifiers.upc;

  if (!removed) return { changed: false, reason: 'code_not_present' };

  next.ops.data_quality = {
    ...(next.ops.data_quality || {}),
    barcode_backfill_rollback_v1: {
      at_iso: new Date().toISOString(),
      removed: normalized,
      note: 'rolled_back_web_backfill',
    },
  };
  return { changed: true, product: next };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.reportPath) {
    throw new Error('Missing --report <path-to-apply_report.json>');
  }
  const reportAbs = path.isAbsolute(args.reportPath)
    ? args.reportPath
    : path.join(process.cwd(), args.reportPath);
  const raw = fs.readFileSync(reportAbs, 'utf-8');
  const entries = JSON.parse(raw);

  const applied = (entries || []).filter((e) => e && e.status === 'applied' && e.productId && e.chosen);
  const stamp = nowStamp();
  const outDir = args.outDir || path.join(process.cwd(), 'exports', 'barcode-backfill-web-rollback', stamp);
  fs.mkdirSync(outDir, { recursive: true });

  const pre = await getAllProductsForTenant(TENANT_ID);
  if (args.expectedCount != null && pre.length !== args.expectedCount) {
    throw new Error(`Count guard failed: expected ${args.expectedCount}, got ${pre.length}`);
  }

  const summary = { preCount: pre.length, targets: applied.length, apply: args.apply, rolledBack: 0, skipped: 0, failed: 0 };
  const out = [];

  for (const e of applied) {
    const productId = safeString(e.productId);
    const chosen = safeString(e.chosen);
    const normalized = normalizeDigits(chosen);

    try {
      const product = await getProduct(productId);
      if (!product) {
        summary.failed += 1;
        out.push({ productId, status: 'failed', reason: 'not_found' });
        continue;
      }

      // Only rollback if the product still carries the backfill marker OR was last saved by barcode-web.
      const marker = product?.ops?.data_quality?.barcode_backfilled_web_v1?.value;
      const lastSource = safeString(product?.ops?.last_saved_source);
      const markerMatch = safeString(marker) && normalizeDigits(marker) === normalized;
      const canRollback = markerMatch || lastSource === 'barcode-web';

      if (!canRollback) {
        summary.skipped += 1;
        out.push({ productId, status: 'skip', reason: 'no_marker', chosen: normalized, lastSource });
        continue;
      }

      const res = removeCodeFromProduct(product, normalized);
      if (!res.changed) {
        summary.skipped += 1;
        out.push({ productId, status: 'skip', reason: res.reason, chosen: normalized });
        continue;
      }

      if (args.apply) {
        await saveProduct(res.product, { source: 'barcode-rollback', syncIdentifiersFromBarcodes: false, overwriteTextFields: false, replaceAttributes: false, allowCategoryChange: false });
      }
      summary.rolledBack += 1;
      out.push({ productId, status: args.apply ? 'rolled_back' : 'would_rollback', chosen: normalized });
    } catch (err) {
      summary.failed += 1;
      out.push({ productId, status: 'failed', chosen: normalized, error: err?.message || String(err) });
    }
  }

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(out, null, 2), 'utf-8');
  console.log(`[barcode-rollback] ${args.apply ? 'APPLY' : 'DRY-RUN'} rollback=${summary.rolledBack} skipped=${summary.skipped} failed=${summary.failed} out=${outDir}`);

  const post = await getAllProductsForTenant(TENANT_ID);
  console.log(`[barcode-rollback] count guard: ${pre.length} -> ${post.length}`);
  if (args.expectedCount != null && post.length !== args.expectedCount) {
    throw new Error(`Count guard failed post: expected ${args.expectedCount}, got ${post.length}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


