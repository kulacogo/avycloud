/* eslint-disable no-console */
/**
 * D.0b-Migration 2026-05-10: Migrated to getAllProductsForTenant().
 * See /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.0)
 * D.0b-Migration: Default to avycloud. Add --tenant flag for multi-tenant runs.
 */
/**
 * Batch-assign bucketed weights to all products.
 * Buckets: 1, 3, 6, 9, 12, 15 (kg)
 *
 * Usage:
 *   node backend/scripts/bucket-weights.js
 *
 * Requires Firestore credentials in env (same as backend).
 */

const { getAllProducts, getAllProductsForTenant, saveProduct } = require('../lib/firestore');


// D.0b-Hardening 2026-05-11: mandatory TENANT_ID for write scripts (prevents silent cross-tenant writes)
const TENANT_ID = process.env.TENANT_ID;
if (!TENANT_ID) {
  console.error('TENANT_ID env var required. Example: TENANT_ID=avycloud node <script>.js');
  process.exit(1);
}
console.warn(`[D.0b-Hardening] Running for tenantId='${TENANT_ID}'.`);
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
  const products = await getAllProductsForTenant(TENANT_ID);
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

