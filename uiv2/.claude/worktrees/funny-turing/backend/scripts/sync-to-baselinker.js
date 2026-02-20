/**
 * Quick manual sync script for selected products to eBay (85403) and Kaufland (85404).
 *
 * Usage (example for specific SKUs):
 *   SKUS=SKU-8857013241,SKU-XXXXXXXXXX GOOGLE_CLOUD_PROJECT=avycloud NODE_PATH=backend/node_modules node backend/scripts/sync-to-baselinker.js
 *
 * If SKUS is not set, nothing is synced (set at least one SKU).
 *
 * Notes:
 * - Expects BaseLinker credentials available (as in the running service).
 * - Uses the existing syncProductToBaseLinker() helper, so the same payload/path is used as im Backend.
 * - Prints per-product/per-inventory results.
 */

const { Firestore } = require('@google-cloud/firestore');
const { syncProductToBaseLinker } = require('../lib/baselinker');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const TARGET_INVENTORIES = ['85403', '85404']; // eBay, Kaufland

// Accept multiple env names: SKUS, SKU_LIST, SKU
const skuEnv = process.env.SKUS || process.env.SKU_LIST || process.env.SKU || '';
const TARGET_SKUS = skuEnv
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (TARGET_SKUS.length === 0) {
  console.error('Bitte SKUs angeben, z.B. SKUS=SKU-8857013241 oder SKU_LIST=SKU-1,SKU-2');
  process.exit(1);
}

const db = new Firestore({ projectId: PROJECT_ID });

async function loadProductsBySkus(skus) {
  const products = [];
  for (const sku of skus) {
    const snap = await db
      .collection('products')
      .where('details.identifiers.sku', '==', sku)
      .limit(1)
      .get();
    if (snap.empty) {
      console.warn(`SKU ${sku}: kein Produkt gefunden`);
      continue;
    }
    const doc = snap.docs[0];
    products.push({ id: doc.id, ...doc.data() });
  }
  return products;
}

async function main() {
  const products = await loadProductsBySkus(TARGET_SKUS);
  console.log(`Gefundene Produkte: ${products.length}`);

  for (const product of products) {
    for (const inv of TARGET_INVENTORIES) {
      try {
        console.log(`Sync ${product.id} (${product.details?.identifiers?.sku}) -> inventory ${inv}`);
        const res = await syncProductToBaseLinker(product, inv);
        console.log('Result:', res);
      } catch (e) {
        console.error(`Fehler bei ${product.id} inv ${inv}:`, e.message);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
