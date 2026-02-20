/* eslint-disable no-console */
/**
 * Canonicalize BaseLinker-style category breadcrumbs in Firestore products.
 *
 * Why:
 * - Some imports stored only leaf category names (no '>') or mixed roots ("Bekleidung", "Mode", ...).
 * - Sync to BaseLinker now canonicalizes paths on the fly, but we also want stored data consistent.
 *
 * What it updates:
 * - identification.category (string)
 * - details.attributes.Kategorie (string) if present
 *
 * Safety:
 * - Default is DRY-RUN (no writes).
 * - Use --apply with --expected-count guard.
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/canonicalize-baselinker-category-paths-in-products.js --dry-run
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/canonicalize-baselinker-category-paths-in-products.js --apply --expected-count 420
 */
const fs = require('fs');
const path = require('path');
const { Firestore } = require('@google-cloud/firestore');
const { canonicalizeBaselinkerCategoryPath } = require('../lib/baselinker-category-canonical');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const firestore = new Firestore({ projectId: PROJECT_ID });

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

function parseArgs(argv) {
  const args = { apply: false, dryRun: true, expectedCount: 0, limit: 0 };
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
    if (t === '--limit') {
      args.limit = Number(argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

function computePatch(product) {
  const updates = {};
  const beforeCategory = safeString(product?.identification?.category);
  const canonCategory = canonicalizeBaselinkerCategoryPath(beforeCategory);
  if (canonCategory && canonCategory !== beforeCategory) {
    updates['identification.category'] = canonCategory;
  }

  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};
  const beforeAttr = safeString(attrs?.Kategorie);
  const canonAttr = canonicalizeBaselinkerCategoryPath(beforeAttr);
  if (beforeAttr && canonAttr && canonAttr !== beforeAttr) {
    updates['details.attributes.Kategorie'] = canonAttr;
  }

  return { updates };
}

async function main() {
  const args = parseArgs(process.argv);
  const stamp = nowStamp();
  const outDir = path.join(process.cwd(), 'exports', 'category-canonicalize-baselinker', stamp);
  ensureDir(outDir);

  console.log(`[category-canonicalize-baselinker] project=${PROJECT_ID} mode=${args.apply ? 'APPLY' : 'DRY_RUN'} out=${outDir}`);

  const snap = await firestore.collection('products').get();
  const preCount = snap.size;
  console.log(`[category-canonicalize-baselinker] products=${preCount}`);

  if (args.apply) {
    if (!Number.isFinite(args.expectedCount) || args.expectedCount <= 0) {
      throw new Error('[category-canonicalize-baselinker] ABORT: --apply requires --expected-count <n>');
    }
    if (preCount !== args.expectedCount) {
      throw new Error(`[category-canonicalize-baselinker] ABORT: expected=${args.expectedCount} got=${preCount}`);
    }
  }

  const report = [];
  let touched = 0;
  let applied = 0;

  const docs = args.limit && args.limit > 0 ? snap.docs.slice(0, Math.floor(args.limit)) : snap.docs;

  for (const doc of docs) {
    const data = doc.data() || {};
    const { updates } = computePatch(data);
    const keys = Object.keys(updates || {});
    if (!keys.length) continue;
    touched += 1;
    report.push({
      id: doc.id,
      updates: args.apply ? undefined : updates,
      changed: keys,
    });
  }

  fs.writeFileSync(
    path.join(outDir, args.apply ? 'apply_report.json' : 'dryrun_report.json'),
    JSON.stringify({ touched, sample: report.slice(0, 50), reportCount: report.length }, null, 2),
    'utf8'
  );

  console.log(`[category-canonicalize-baselinker] touched=${touched}`);
  if (!args.apply) {
    console.log('[category-canonicalize-baselinker] Dry-run complete. No writes performed.');
    return;
  }

  console.log('[category-canonicalize-baselinker] Applying updates via BulkWriter...');
  const bulkWriter = firestore.bulkWriter({
    throttling: { initialOpsPerSecond: 50, maxOpsPerSecond: 300 },
  });
  bulkWriter.onWriteError((error) => {
    console.error('[category-canonicalize-baselinker] write error', error.documentRef.path, error.message);
    if (error.code === 'unavailable' && error.failedAttempts < 6) return true;
    return false;
  });

  for (const doc of docs) {
    const data = doc.data() || {};
    const { updates } = computePatch(data);
    const keys = Object.keys(updates || {});
    if (!keys.length) continue;
    bulkWriter.update(firestore.collection('products').doc(doc.id), updates);
    applied += 1;
  }
  await bulkWriter.close();
  console.log(`[category-canonicalize-baselinker] applied=${applied}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

