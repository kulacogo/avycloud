// Delete product(s) by SKU/alias (includes images + bin cleanup).
// Usage:
//   SKU=SKU-123 node delete_sku.cjs
//   # or set below and run: node delete_sku.cjs

const {
  firestore,
  getProduct,
  deleteProduct,
  deleteProductsByIdentityAlias,
} = require('./backend/lib/firestore');
const { deleteProductImages } = require('./backend/lib/storage');
const { removeProductFromBin } = require('./backend/lib/warehouse');

// Set your target SKU here or via environment variable SKU
const SKU = process.env.SKU || 'SKU-REPLACE-ME';

if (!SKU || SKU === 'SKU-REPLACE-ME') {
  console.error('Please set SKU=... before running this script.');
  process.exit(1);
}

const aliasVariants = Array.from(
  new Set([
    SKU,
    SKU.toLowerCase(),
    SKU.replace(/^sku[-_\s]*/i, '').trim(),
    `sku-${SKU.replace(/^sku[-_\s]*/i, '').trim()}`,
    `sku ${SKU.replace(/^sku[-_\s]*/i, '').trim()}`,
  ])
).filter(Boolean);

async function deleteByAliasFirst() {
  for (const alias of aliasVariants) {
    try {
      const res = await deleteProductsByIdentityAlias(alias, { limit: 50 });
      if (res.deletedCount > 0) {
        console.log('deleted via alias', alias, res.productIds);
        return res.productIds || [];
      }
    } catch (err) {
      console.warn('alias delete failed', alias, err?.message || err);
    }
  }
  return [];
}

async function deleteByDirectQuery() {
  const ids = [];
  const trimmed = SKU.trim();
  const coll = firestore.collection('products');

  const snaps = await Promise.all([
    coll.where('identification.sku', '==', trimmed).get(),
    coll.where('details.identifiers.sku', '==', trimmed).get(),
  ]);

  for (const snap of snaps) {
    snap.forEach((doc) => {
      if (!ids.includes(doc.id)) {
        ids.push(doc.id);
      }
    });
  }

  for (const id of ids) {
    const doc = await coll.doc(id).get();
    const data = doc.data() || {};
    try {
      if (data.storage?.binCode) {
        try {
          await removeProductFromBin(data.storage.binCode, id);
          console.log('bin cleared', id);
        } catch (err) {
          console.warn('bin clear failed', id, err?.message || err);
        }
      }
      await deleteProductImages(id).catch(() => {});
      await deleteProduct(id, { existingData: data });
      console.log('deleted direct', id);
    } catch (err) {
      console.error('delete failed direct', id, err?.message || err);
    }
  }
  return ids;
}

(async () => {
  try {
    const aliasDeleted = await deleteByAliasFirst();
    if (aliasDeleted.length) {
      return;
    }

    // Fallback: direct SKU fields
    const directDeleted = await deleteByDirectQuery();
    if (directDeleted.length === 0) {
      console.log('not found', SKU);
    }
  } catch (err) {
    console.error('error', SKU, err?.message || err);
    process.exit(1);
  }
})();
