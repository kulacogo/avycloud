/**
 * One-time GPSR backfill:
 * Re-saves products so the centralized save pipeline applies:
 * - GPSR splitting (street vs city/postal/state/country)
 * - English country name normalization
 * - placeholders for missing mandatory marketplace fields
 *
 * This does NOT “web search” manufacturer data. It normalizes and fills placeholders deterministically.
 *
 * Usage (local or Cloud Run Job):
 *   node scripts/gpsr-backfill-all-products.js
 *
 * Optional env:
 *   LIMIT=5000        (default 5000)
 *   PAGE_SIZE=200     (default 200)
 *   DRY_RUN=1         (default 0)
 */

const { firestore, saveProduct } = require('../lib/firestore');

async function main() {
  const limitTotal = Math.max(1, parseInt(process.env.LIMIT || '5000', 10));
  const pageSize = Math.min(500, Math.max(1, parseInt(process.env.PAGE_SIZE || '200', 10)));
  const dryRun = String(process.env.DRY_RUN || '').trim() === '1';

  console.log(JSON.stringify({ action: 'gpsr-backfill', limit_total: limitTotal, page_size: pageSize, dry_run: dryRun }, null, 2));

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  let lastDoc = null;
  while (processed < limitTotal) {
    let q = firestore.collection('products').orderBy('ops.last_saved_iso', 'desc').limit(pageSize);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      processed += 1;
      lastDoc = doc;
      const data = doc.data() || {};
      const product = { ...data, id: data.id || doc.id };
      if (!product.id) {
        skipped += 1;
        continue;
      }
      try {
        if (!dryRun) {
          await saveProduct(product, { source: 'script', skipTitlePolicy: true, skipKeyFeaturesNormalize: true });
          updated += 1;
        }
      } catch (err) {
        failed += 1;
        console.error(`[gpsr-backfill] Failed for ${product.id}:`, err?.message || err);
      }
      if (processed >= limitTotal) break;
    }
  }

  console.log(JSON.stringify({ done: true, processed, updated, skipped, failed }, null, 2));
  if (failed > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

