/**
 * Migration: move multi-inventory BaseLinker categories -> single category fields.
 *
 * - Source: details.baselinkerCategories["91387"] (authoritative taxonomy)
 * - Target: details.baselinkerCategoryPath + details.baselinkerCategoryId (inventory 78659)
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/migrate-baselinker-single-category-78659.js --dry-run
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/migrate-baselinker-single-category-78659.js --apply
 *
 * Options:
 *   --min-qty 1
 *   --limit 0
 *   --offset 0
 */

const path = require('path');
const fs = require('fs');
const { Firestore } = require('@google-cloud/firestore');

const {
  getInventoryCategoryIndex,
  resolveInventoryCategoryIdByBreadcrumb,
} = require('../lib/baselinker-inventory-category-index');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function parseArgs(argv = []) {
  const args = { apply: false, dryRun: true, minQty: 1, limit: 0, offset: 0 };
  const list = Array.isArray(argv) ? argv.slice(2) : [];
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a === '--apply') {
      args.apply = true;
      args.dryRun = false;
    } else if (a === '--dry-run') {
      args.apply = false;
      args.dryRun = true;
    } else if (a === '--min-qty') {
      args.minQty = Math.max(0, Number(list[i + 1] || 0) || 0);
      i += 1;
    } else if (a === '--limit') {
      args.limit = Math.max(0, Math.floor(Number(list[i + 1] || 0) || 0));
      i += 1;
    } else if (a === '--offset') {
      args.offset = Math.max(0, Math.floor(Number(list[i + 1] || 0) || 0));
      i += 1;
    }
  }
  return args;
}

function pickTotalQuantity(product) {
  const p = product && typeof product === 'object' ? product : {};
  const invQty = Number(p?.inventory?.quantity);
  if (Number.isFinite(invQty)) return invQty;
  const storageQty = Number(p?.storage?.quantity);
  if (Number.isFinite(storageQty)) return storageQty;
  if (Array.isArray(p?.storageBins)) {
    const sum = p.storageBins
      .map((b) => Number(b?.quantity) || 0)
      .reduce((acc, n) => acc + (Number.isFinite(n) ? n : 0), 0);
    if (Number.isFinite(sum)) return sum;
  }
  const attrStock = p?.details?.attributes?.stock;
  const attrNum = typeof attrStock === 'string' ? Number(attrStock) : Number(attrStock);
  if (Number.isFinite(attrNum)) return attrNum;
  return 0;
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

(async () => {
  const args = parseArgs(process.argv);
  const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
  const firestore = new Firestore({ projectId: PROJECT_ID });

  const invId = '78659';
  const idx = await getInventoryCategoryIndex(invId);
  console.log(JSON.stringify({ action: 'migrate-baselinker-single-category-78659', project: PROJECT_ID, mode: args.apply ? 'APPLY' : 'DRY_RUN', inventoryId: invId, categoryCount: idx?.count || 0, args }, null, 2));

  const snap = await firestore.collection('products').get();
  const allDocs = snap.docs;
  const docs = allDocs.slice(args.offset, args.limit && args.limit > 0 ? args.offset + args.limit : undefined);
  console.log(`[migrate] products_total=${snap.size} processing=${docs.length} offset=${args.offset}`);

  const outDir = path.resolve('backend/exports/baselinker-migrations');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const reportFile = path.join(outDir, `migrate-baselinker-single-category-78659-${nowStamp()}.json`);

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let missingCategory = 0;
  let missingCategoryId = 0;
  let missingSku = 0;
  const examples = { missingCategory: [], missingCategoryId: [], missingSku: [] };

  for (const doc of docs) {
    processed += 1;
    const product = doc.data() || {};
    const qty = pickTotalQuantity(product);
    if (!Number.isFinite(qty) || qty < args.minQty) {
      skipped += 1;
      continue;
    }

    const details = product?.details && typeof product.details === 'object' ? product.details : {};
    const legacyMap =
      details?.baselinkerCategories && typeof details.baselinkerCategories === 'object'
        ? details.baselinkerCategories
        : {};

    const path91387 = safeString(legacyMap?.['91387'] || '');
    const nextPath = safeString(details?.baselinkerCategoryPath || '') || path91387;
    if (!nextPath) {
      missingCategory += 1;
      if (examples.missingCategory.length < 12) examples.missingCategory.push(doc.id);
      continue;
    }

    const resolvedId = await resolveInventoryCategoryIdByBreadcrumb(invId, nextPath);
    if (!resolvedId) {
      missingCategoryId += 1;
      if (examples.missingCategoryId.length < 12) examples.missingCategoryId.push({ id: doc.id, path: nextPath });
    }

    const strictSku = safeString(product?.identification?.sku || '') || safeString(details?.identifiers?.sku || '');
    if (!strictSku) {
      missingSku += 1;
      if (examples.missingSku.length < 12) examples.missingSku.push(doc.id);
    }

    const updates = {};
    updates['details.baselinkerCategoryPath'] = nextPath;
    if (resolvedId) updates['details.baselinkerCategoryId'] = String(resolvedId);
    if (!safeString(product?.identification?.sku) && safeString(details?.identifiers?.sku)) {
      updates['identification.sku'] = safeString(details.identifiers.sku);
    }
    updates['ops.sync_status'] = 'pending';
    updates['ops.updated_at_iso'] = new Date().toISOString();

    if (Object.keys(updates).length === 0) {
      skipped += 1;
      continue;
    }

    if (args.apply) {
      // eslint-disable-next-line no-await-in-loop
      await doc.ref.set(updates, { merge: true });
    }
    updated += 1;

    if (processed % 200 === 0) {
      console.log(JSON.stringify({ processed, updated, skipped, missingCategory, missingCategoryId, missingSku }, null, 2));
    }
  }

  const report = {
    action: 'migrate-baselinker-single-category-78659',
    project: PROJECT_ID,
    mode: args.apply ? 'APPLY' : 'DRY_RUN',
    inventoryId: invId,
    processed,
    updated,
    skipped,
    missingCategory,
    missingCategoryId,
    missingSku,
    examples,
    wrote_at_iso: new Date().toISOString(),
  };
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, reportFile, ...report }, null, 2));
})().catch((e) => {
  console.error('[migrate] failed:', e?.message || e);
  process.exitCode = 1;
});

