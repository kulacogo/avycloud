/**
 * Bulk sync products with quantity >= minQty to BaseLinker inventory 78659.
 *
 * Requirements:
 * - Each product must have ONE BaseLinker category:
 *   - details.baselinkerCategoryPath (preferred) OR legacy details.baselinkerCategories["91387"]
 * - Products are deduped by BaseLinker product_id (if linked) or strict SKU (identification.sku / details.identifiers.sku).
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud BASELINKER_SYNC_CONCURRENCY=1 node backend/scripts/sync-baselinker-inventory-78659-minqty.js --min-qty 1
 *   ... add --force to re-sync already synced products
 */

const path = require('path');
const fs = require('fs');
const { Firestore } = require('@google-cloud/firestore');
const { syncProductsToBaseLinker } = require('../lib/baselinker');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function parseArgs(argv = []) {
  const args = { minQty: 1, limit: 0, offset: 0, force: false };
  const list = Array.isArray(argv) ? argv.slice(2) : [];
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a === '--min-qty') {
      args.minQty = Math.max(0, Number(list[i + 1] || 0) || 0);
      i += 1;
    } else if (a === '--limit') {
      args.limit = Math.max(0, Math.floor(Number(list[i + 1] || 0) || 0));
      i += 1;
    } else if (a === '--offset') {
      args.offset = Math.max(0, Math.floor(Number(list[i + 1] || 0) || 0));
      i += 1;
    } else if (a === '--force') {
      args.force = true;
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
  return 0;
}

function hasCategory(product) {
  const p = product && typeof product === 'object' ? product : {};
  const path = safeString(p?.details?.baselinkerCategoryPath);
  if (path) return true;
  const legacy =
    p?.details?.baselinkerCategories && typeof p.details.baselinkerCategories === 'object'
      ? p.details.baselinkerCategories
      : {};
  return Boolean(safeString(legacy?.['91387']));
}

function strictSku(product) {
  const p = product && typeof product === 'object' ? product : {};
  return safeString(p?.identification?.sku) || safeString(p?.details?.identifiers?.sku) || '';
}

function isAlreadySyncedTo78659(product) {
  const p = product && typeof product === 'object' ? product : {};
  const invKey = 'inventory_78659';
  const inv = p?.ops?.baselinker?.inventories?.[invKey];
  if (inv?.sync_status === 'synced') return true;
  if (String(p?.ops?.baselinker?.synced_inventory || '').trim() === '78659' && p?.ops?.sync_status === 'synced') {
    return true;
  }
  return false;
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
  console.log(JSON.stringify({ action: 'sync-baselinker-inventory-78659-minqty', project: PROJECT_ID, inventoryId: invId, args }, null, 2));

  const snap = await firestore.collection('products').get();
  const all = snap.docs;
  const docs = all.slice(args.offset, args.limit && args.limit > 0 ? args.offset + args.limit : undefined);
  console.log(`[sync-78659] products_total=${snap.size} processing=${docs.length} offset=${args.offset}`);

  const withQty = docs
    .map((d) => ({ id: d.id, doc: d, data: d.data() || {} }))
    .filter((x) => pickTotalQuantity(x.data) >= args.minQty);
  const missingCats = withQty.filter((x) => !hasCategory(x.data)).map((x) => x.id);
  const missingSku = withQty.filter((x) => !strictSku(x.data)).map((x) => x.id);
  if (missingCats.length) {
    console.warn(`[sync-78659] missing_categories=${missingCats.length} (example: ${missingCats.slice(0, 8).join(', ')})`);
  }
  if (missingSku.length) {
    console.warn(`[sync-78659] missing_strict_sku=${missingSku.length} (example: ${missingSku.slice(0, 8).join(', ')})`);
  }

  const candidates = withQty.filter((x) => hasCategory(x.data) && strictSku(x.data));
  const toSync = args.force ? candidates : candidates.filter((x) => !isAlreadySyncedTo78659(x.data));
  console.log(`[sync-78659] qty>=${args.minQty}=${withQty.length} candidates=${candidates.length} toSync=${toSync.length} force=${args.force}`);

  const outDir = path.resolve('backend/exports/baselinker-sync-78659', nowStamp());
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'missing_categories.json'), JSON.stringify(missingCats, null, 2));
  fs.writeFileSync(path.join(outDir, 'missing_sku.json'), JSON.stringify(missingSku, null, 2));
  fs.writeFileSync(
    path.join(outDir, 'summary.json'),
    JSON.stringify(
      {
        action: 'sync-baselinker-inventory-78659-minqty',
        inventoryId: invId,
        minQty: args.minQty,
        products_total: snap.size,
        qtyEligible: withQty.length,
        candidates: candidates.length,
        toSync: toSync.length,
        missingCats: missingCats.length,
        missingSku: missingSku.length,
        force: args.force,
      },
      null,
      2
    )
  );

  const productsToSync = toSync.map((x) => x.data);
  let ok = 0;
  let failed = 0;
  const results = await syncProductsToBaseLinker(productsToSync, invId, {
    onProgress: ({ index, total, result }) => {
      const status = result?.status || 'unknown';
      if (status === 'synced') ok += 1;
      if (status === 'failed') failed += 1;
      if ((index + 1) % 5 === 0 || index + 1 === total) {
        console.log(JSON.stringify({ inventoryId: invId, processed: index + 1, total, ok, failed, last: result?.id || null }, null, 2));
      }
    },
  });

  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ ok: true, outDir, inventoryId: invId, synced: ok, failed }, null, 2));
})().catch((e) => {
  console.error('[sync-78659] failed:', e?.message || e);
  process.exitCode = 1;
});

