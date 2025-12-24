/* eslint-disable no-console */
/**
 * Batch-assign bucketed weights to all products.
 * Buckets: 1, 3, 6, 9, 12, 15 (kg)
 *
 * Usage:
 *   node backend/scripts/bucket-weights.js
 *
 * Requires Firestore credentials in env (same as backend).
 */

const { getAllProducts, saveProduct } = require('../lib/firestore');

const BUCKETS = [1, 3, 6, 9, 12, 15];
function bucketWeight(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  let best = BUCKETS[0];
  let bestDiff = Math.abs(num - best);
  for (const b of BUCKETS) {
    const d = Math.abs(num - b);
    if (d < bestDiff) {
      best = b;
      bestDiff = d;
    }
  }
  return Number(best.toFixed(2));
}

async function run() {
  console.log('Loading products…');
  const products = await getAllProducts();
  console.log(`Total products: ${products.length}`);
  let updated = 0;

  for (const product of products) {
    const attrs = product?.details?.attributes || {};
    const current =
      attrs.weight ??
      product?.details?.weight ??
      product?.ops?.weight ??
      null;
    const bucketed = bucketWeight(current) ?? BUCKETS[0];
    product.details = product.details || {};
    product.details.attributes = { ...(product.details.attributes || {}), weight: bucketed };
    product.details.weight = bucketed;
    await saveProduct(product);
    updated += 1;
    if (updated % 50 === 0) {
      console.log(`Updated ${updated}/${products.length}`);
    }
  }

  console.log(`Done. Updated weights on ${updated} products.`);
}

run().catch((err) => {
  console.error('Weight bucket script failed:', err);
  process.exit(1);
});

