// Delete a single product by SKU (including images and bin assignment).
// Set SKU below (or export SKU env) and run: node delete_sku.cjs

const { getProduct, deleteProduct } = require('./backend/lib/firestore');
const { deleteProductImages } = require('./backend/lib/storage');
const { removeProductFromBin } = require('./backend/lib/warehouse');

// Set your target SKU here or via environment variable SKU
const SKU = process.env.SKU || 'SKU-2116824185';

(async () => {
  try {
    const product = await getProduct(SKU);
    if (!product) {
      console.log('not found', SKU);
      return;
    }

    if (product.storage?.binCode) {
      try {
        await removeProductFromBin(product.storage.binCode, product.id);
        console.log('bin cleared', SKU);
      } catch (err) {
        console.warn('bin clear failed', SKU, err?.message || err);
      }
    }

    await deleteProductImages(SKU).catch(() => {});
    await deleteProduct(SKU, { existingData: product });
    console.log('deleted', SKU);
  } catch (err) {
    console.error('error', SKU, err?.message || err);
    process.exit(1);
  }
})();
