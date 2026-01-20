/* eslint-disable no-console */
/**
 * Sync a specific set of Firestore product IDs to BigCommerce (create/update).
 *
 * Usage:
 *   node backend/scripts/run-bigcommerce-sync-by-product-ids.js <id1> <id2> ...
 */

const { getAllProducts } = require('../lib/firestore');
const { syncProductsToBigCommerce } = require('../lib/bigcommerce');

async function main() {
  const ids = process.argv.slice(2).map((s) => String(s || '').trim()).filter(Boolean);
  if (!ids.length) {
    console.error('Provide at least one Firestore product ID.');
    process.exit(2);
  }

  const all = await getAllProducts();
  const wanted = new Set(ids);
  const products = all.filter((p) => wanted.has(String(p?.id)));
  const missing = ids.filter((id) => !products.some((p) => String(p?.id) === id));

  console.log(`[bigcommerce-sync-by-ids] requested=${ids.length} found=${products.length} missing=${missing.length}`);
  if (missing.length) console.log('[bigcommerce-sync-by-ids] missing_ids=', missing.slice(0, 50));

  const results = await syncProductsToBigCommerce(products, {
    onProgress: async ({ result }) => {
      console.log('[bigcommerce-sync-by-ids] progress', result);
    },
  });

  const failed = results.filter((r) => r?.status === 'failed');
  console.log('[bigcommerce-sync-by-ids] complete', {
    total: results.length,
    synced: results.filter((r) => r?.status === 'synced').length,
    failed: failed.length,
  });
  if (failed.length) {
    console.log('[bigcommerce-sync-by-ids] failed=', failed);
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error('Script failed:', err?.message || err);
  process.exit(1);
});

