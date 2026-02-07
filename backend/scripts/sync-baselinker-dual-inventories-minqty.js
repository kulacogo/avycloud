/* eslint-disable no-console */
/**
 * Sync all AvyCloud products with quantity >= minQty to BOTH BaseLinker inventories:
 * - 91387 (uses details.baselinkerCategories["91387"])
 * - 91388 (uses details.baselinkerCategories["91388"])
 *
 * IMPORTANT:
 * - Each inventory sync uses ONLY its inventory-specific category.
 * - Products missing either category are skipped (and reported).
 *
 * Usage:
 *   NODE_PATH=backend/node_modules GOOGLE_CLOUD_PROJECT=avycloud \
 *   node backend/scripts/sync-baselinker-dual-inventories-minqty.js --min-qty 1
 *
 * Options:
 *   --min-qty <n>     default 1
 *   --limit <n>       optional limit (testing)
 *   --offset <n>      optional offset (resume)
 */

const fs = require('fs');
const path = require('path');
const { getAllProducts } = require('../lib/firestore');
const { syncProductsToBaseLinker } = require('../lib/baselinker');

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

function pickSku(product) {
  return (
    safeString(product?.identification?.sku) ||
    safeString(product?.details?.identifiers?.sku) ||
    safeString(product?.id) ||
    ''
  );
}

function pickQuantity(product) {
  const candidates = [
    product?.inventory?.quantity,
    product?.storage?.quantity,
    product?.details?.attributes?.stock,
  ];
  for (const val of candidates) {
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    if (typeof val === 'string') {
      const numeric = Number(val);
      if (Number.isFinite(numeric)) return numeric;
    }
  }
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  const sum = bins.reduce((acc, b) => acc + (Number(b?.quantity) || 0), 0);
  return Number.isFinite(sum) ? sum : 0;
}

function parseArgs(argv) {
  const args = {
    minQty: 1,
    limit: 0,
    offset: 0,
    force: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--min-qty') args.minQty = Number(argv[i + 1]), i += 1;
    if (t === '--limit') args.limit = Number(argv[i + 1]), i += 1;
    if (t === '--offset' || t === '--skip') args.offset = Number(argv[i + 1]), i += 1;
    if (t === '--force') args.force = true;
  }
  args.minQty = Number.isFinite(args.minQty) ? Math.max(1, Math.floor(args.minQty)) : 1;
  args.limit = Number.isFinite(args.limit) ? Math.max(0, Math.floor(args.limit)) : 0;
  args.offset = Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
  return args;
}

function hasInventoryCategory(product, inventoryId) {
  const inv = String(inventoryId || '').trim();
  if (!inv) return false;
  const map =
    product?.details?.baselinkerCategories && typeof product.details.baselinkerCategories === 'object'
      ? product.details.baselinkerCategories
      : {};
  return Boolean(safeString(map?.[inv]));
}

function isAlreadySyncedToInventory(product, inventoryId) {
  const invKey = String(inventoryId || '').trim();
  if (!invKey) return false;
  const invOps =
    product?.ops?.baselinker?.inventories && typeof product.ops.baselinker.inventories === 'object'
      ? product.ops.baselinker.inventories
      : {};
  const status = String(invOps?.[invKey]?.sync_status || '').trim().toLowerCase();
  return status === 'synced';
}

async function main() {
  const args = parseArgs(process.argv);
  const stamp = nowStamp();
  const outDir = path.join(process.cwd(), 'exports', 'baselinker-dual-sync', stamp);
  ensureDir(outDir);

  console.log(`[dual-sync] minQty=${args.minQty} out=${outDir}`);
  const products = await getAllProducts();
  const total = Array.isArray(products) ? products.length : 0;
  console.log(`[dual-sync] loaded products=${total}`);

  const eligible = (Array.isArray(products) ? products : [])
    .filter((p) => p?.id)
    .map((p) => ({ p, qty: pickQuantity(p) }))
    .filter((x) => Number(x.qty) >= args.minQty);

  eligible.sort((a, b) => {
    const as = pickSku(a.p).toLowerCase();
    const bs = pickSku(b.p).toLowerCase();
    if (as && bs && as !== bs) return as.localeCompare(bs, 'de', { sensitivity: 'base' });
    return safeString(a.p?.id).localeCompare(safeString(b.p?.id), 'de', { sensitivity: 'base' });
  });

  const offset = args.offset ? eligible.slice(args.offset) : eligible;
  const selected = args.limit && args.limit > 0 ? offset.slice(0, args.limit) : offset;

  const withBothCats = selected
    .filter((x) => hasInventoryCategory(x.p, '91387') && hasInventoryCategory(x.p, '91388'))
    .map((x) => x.p);
  const missingCats = selected
    .filter((x) => !(hasInventoryCategory(x.p, '91387') && hasInventoryCategory(x.p, '91388')))
    .map((x) => ({
      id: x.p.id,
      sku: pickSku(x.p),
      qty: x.qty,
      missing91387: !hasInventoryCategory(x.p, '91387'),
      missing91388: !hasInventoryCategory(x.p, '91388'),
    }));

  const summary = {
    mode: 'APPLY',
    inventories: ['91387', '91388'],
    minQty: args.minQty,
    limit: args.limit || null,
    offset: args.offset || 0,
    force: Boolean(args.force),
    counts: {
      total,
      eligible: eligible.length,
      selected: selected.length,
      selected_with_both_categories: withBothCats.length,
      selected_missing_categories: missingCats.length,
    },
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'missing_categories.json'), JSON.stringify(missingCats, null, 2), 'utf8');

  console.log(
    `[dual-sync] selected=${selected.length} withBothCats=${withBothCats.length} missingCats=${missingCats.length}`
  );
  if (!withBothCats.length) {
    console.log('[dual-sync] nothing to sync (no products with both categories).');
    return;
  }

  const results = {};
  for (const inv of ['91387', '91388']) {
    const invKey = String(inv);
    const alreadySynced = withBothCats.filter((p) => isAlreadySyncedToInventory(p, invKey));
    const toSync = args.force ? withBothCats : withBothCats.filter((p) => !isAlreadySyncedToInventory(p, invKey));
    console.log(
      `[dual-sync] syncing inventory ${invKey}… toSync=${toSync.length} alreadySynced=${alreadySynced.length} (total=${withBothCats.length})`
    );
    if (!toSync.length) {
      results[invKey] = [];
      continue;
    }

    let processed = 0;
    let ok = 0;
    let failed = 0;
    const invResults = await syncProductsToBaseLinker(toSync, invKey, {
      mode: 'full',
      onProgress: async ({ total: t, result }) => {
        processed += 1;
        if (result?.status === 'synced') ok += 1;
        if (result?.status === 'failed') failed += 1;
        if (processed % 5 === 0 || processed === t) {
          console.log(
            `[dual-sync] inv=${invKey} ${processed}/${t} ok=${ok} failed=${failed} last=${result?.status || 'unknown'} ${result?.id || ''}`
          );
        }
      },
    });
    results[inv] = invResults;
    fs.writeFileSync(path.join(outDir, `results-${inv}.json`), JSON.stringify(invResults, null, 2), 'utf8');
  }

  fs.writeFileSync(path.join(outDir, 'results-all.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log('[dual-sync] done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

