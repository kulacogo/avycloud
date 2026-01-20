/* eslint-disable no-console */
/**
 * Delete products from BigCommerce by SKU, and disable BigCommerce sync for them in Firestore
 * so they won't be recreated by the next sync.
 *
 * Usage:
 *   node backend/scripts/delete-bigcommerce-products-by-sku.js SKU-123 SKU-456
 */

const { deleteBigCommerceProductBySku } = require('../lib/bigcommerce');
const { getAllProducts, setProductBigCommerceDisabled } = require('../lib/firestore');

function pickSku(product) {
  return (product?.identification?.sku || product?.details?.identifiers?.sku || '').toString().trim();
}

async function main() {
  const skus = process.argv.slice(2).map((s) => String(s || '').trim()).filter(Boolean);
  if (!skus.length) {
    console.error('Provide at least one SKU argument.');
    process.exit(2);
  }

  const products = await getAllProducts();
  const skuToProductIds = new Map();
  for (const p of products) {
    const sku = pickSku(p);
    if (sku) {
      const arr = skuToProductIds.get(sku) || [];
      arr.push(p.id);
      skuToProductIds.set(sku, arr);
    }
  }

  const report = { requested: skus.length, deleted: 0, notFoundInBigCommerce: 0, disabled: 0, errors: [] };

  for (const sku of skus) {
    try {
      const res = await deleteBigCommerceProductBySku(sku);
      if (res.ok) {
        report.deleted += 1;
      } else {
        report.notFoundInBigCommerce += 1;
      }
    } catch (e) {
      report.errors.push({ sku, where: 'bigcommerce_delete', message: e?.message || String(e) });
    }

    const ids = skuToProductIds.get(sku) || [];
    for (const id of ids) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await setProductBigCommerceDisabled(String(id), true, { reason: 'user_requested_delete' });
        report.disabled += 1;
      } catch (e) {
        report.errors.push({ sku, productId: id, where: 'firestore_disable', message: e?.message || String(e) });
      }
    }
  }

  console.log('[bigcommerce-delete] report=', JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error('Delete script failed:', err?.message || err);
  process.exit(1);
});

