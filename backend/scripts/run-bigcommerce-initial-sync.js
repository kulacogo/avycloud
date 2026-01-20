/* eslint-disable no-console */
/**
 * Initial BigCommerce sync: create/update ALL products from Firestore.
 *
 * - Runs in-process (no HTTP server required)
 * - Uses the same BigCommerce sync engine as the UI jobs
 * - Does NOT print credentials
 *
 * Usage:
 *   node backend/scripts/run-bigcommerce-initial-sync.js
 *   node backend/scripts/run-bigcommerce-initial-sync.js --minStock 1
 *   node backend/scripts/run-bigcommerce-initial-sync.js --limit 200 --offset 0
 */

const { getAllProducts } = require('../lib/firestore');
const { syncProductsToBigCommerce } = require('../lib/bigcommerce');

function parseArgs(argv) {
  const args = { minStock: 0, limit: null, offset: 0 };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--minStock') {
      args.minStock = Number(argv[i + 1] || '0');
      i += 1;
    } else if (t === '--limit') {
      args.limit = Number(argv[i + 1] || '0');
      i += 1;
    } else if (t === '--offset') {
      args.offset = Number(argv[i + 1] || '0');
      i += 1;
    }
  }
  if (!Number.isFinite(args.minStock)) args.minStock = 0;
  if (!Number.isFinite(args.offset) || args.offset < 0) args.offset = 0;
  if (!Number.isFinite(args.limit) || args.limit <= 0) args.limit = null;
  return args;
}

function computeAvailableQty(product) {
  const invAvail = Number(product?.inventory?.availableQuantity);
  if (Number.isFinite(invAvail)) return Math.max(0, invAvail);
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  const sumBins = bins.reduce((s, b) => s + (Number(b?.quantity) || 0), 0);
  if (sumBins > 0) return sumBins;
  const invQty = Number(product?.inventory?.quantity);
  if (Number.isFinite(invQty)) return Math.max(0, invQty);
  const invPhys = Number(product?.inventory?.physicalQuantity);
  if (Number.isFinite(invPhys)) return Math.max(0, invPhys);
  return 0;
}

async function main() {
  const args = parseArgs(process.argv);

  const products = await getAllProducts();
  const filtered = products.filter((p) => computeAvailableQty(p) >= args.minStock);

  const sliced = filtered.slice(args.offset, args.limit ? args.offset + args.limit : undefined);

  console.log(
    `[bigcommerce-initial-sync] loaded=${products.length} eligible=${filtered.length} syncing=${sliced.length} minStock=${args.minStock} offset=${args.offset} limit=${args.limit ?? '∞'}`
  );

  let processed = 0;
  let synced = 0;
  let failed = 0;

  const startedAt = Date.now();

  const results = await syncProductsToBigCommerce(sliced, {
    onProgress: async ({ result }) => {
      processed += 1;
      if (result?.status === 'synced') synced += 1;
      if (result?.status === 'failed') failed += 1;
      if (processed % 10 === 0 || processed === sliced.length) {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        console.log(`[bigcommerce-initial-sync] ${processed}/${sliced.length} synced=${synced} failed=${failed} elapsed=${elapsed}s`);
      }
    },
  });

  const failedEntries = results.filter((r) => r?.status === 'failed');
  const created = results.filter((r) => r?.status === 'synced' && r?.action === 'created').length;
  const updated = results.filter((r) => r?.status === 'synced' && r?.action === 'updated').length;

  console.log('[bigcommerce-initial-sync] complete', {
    total: sliced.length,
    synced,
    failed,
    created,
    updated,
  });

  if (failedEntries.length) {
    console.log('[bigcommerce-initial-sync] failed_samples', failedEntries.slice(0, 20));
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error('[bigcommerce-initial-sync] fatal:', err?.message || err);
  process.exit(1);
});

