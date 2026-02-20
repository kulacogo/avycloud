/**
 * One-time GPSR normalization migration:
 * Re-saves all products with price > 50 EUR so the centralized save pipeline
 * applies GPSR splitting, country normalization, and placeholders.
 *
 * Usage:
 *   node backend/scripts/gpsr-normalize-price-gt-50.js
 *
 * Optional env:
 *   PRICE_GT=50            (default 50)
 *   LIMIT=2000             (default 5000) total documents to process max
 *   PAGE_SIZE=200          (default 200) per query page
 *   DRY_RUN=1              (default 0)
 */

const { firestore, saveProduct } = require('../lib/firestore');

const PRICE_FIELD = 'details.pricing.lowest_price.amount';

async function main() {
  const priceGt = Number(process.env.PRICE_GT || 50);
  const limitTotal = Math.max(1, parseInt(process.env.LIMIT || '5000', 10));
  const pageSize = Math.min(500, Math.max(1, parseInt(process.env.PAGE_SIZE || '200', 10)));
  const dryRun = String(process.env.DRY_RUN || '').trim() === '1';

  console.log(
    JSON.stringify(
      { action: 'gpsr-normalize', price_gt: priceGt, limit_total: limitTotal, page_size: pageSize, dry_run: dryRun },
      null,
      2
    )
  );

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  let lastDoc = null;
  while (processed < limitTotal) {
    let q = firestore.collection('products').where(PRICE_FIELD, '>', priceGt).orderBy(PRICE_FIELD).limit(pageSize);
    if (lastDoc) {
      q = q.startAfter(lastDoc);
    }

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      processed += 1;
      lastDoc = doc;

      const data = doc.data() || {};
      const amount = Number(
        data?.details?.pricing?.lowest_price && typeof data.details.pricing.lowest_price === 'object'
          ? data.details.pricing.lowest_price.amount
          : 0
      );

      if (!(amount > priceGt)) {
        skipped += 1;
        continue;
      }

      const product = { ...data, id: data.id || doc.id };
      if (!product.id) {
        skipped += 1;
        continue;
      }

      try {
        if (!dryRun) {
          await saveProduct(product, {
            source: 'script',
            // Safety: do NOT touch titles/key features in a migration whose goal is GPSR normalization.
            skipTitlePolicy: true,
            skipKeyFeaturesNormalize: true,
          });
          updated += 1;
        }
      } catch (err) {
        failed += 1;
        console.error(`[gpsr-normalize] Failed for ${product.id}:`, err?.message || err);
      }

      if (processed >= limitTotal) break;
      if (processed % 100 === 0) {
        console.log(
          JSON.stringify(
            { processed, updated, skipped, failed, last_price: amount, last_id: product.id },
            null,
            2
          )
        );
      }
    }
  }

  console.log(JSON.stringify({ done: true, processed, updated, skipped, failed }, null, 2));
  if (failed > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

