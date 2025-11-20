const { Firestore } = require('@google-cloud/firestore');

// Initialize Firestore
const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud'
});

// Collection name
const PRODUCTS_COLLECTION = 'products';

/**
 * Save a product to Firestore
 */
async function saveProduct(product) {
  try {
    const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(product.id);
    
    // Add timestamps
    const productData = {
      ...product,
      ops: {
        ...product.ops,
        last_saved_iso: new Date().toISOString(),
        revision: (product.ops.revision || 0) + 1
      }
    };
    
    await docRef.set(productData);
    
    console.log(`Product saved to Firestore: ${product.id}`);
    return {
      id: product.id,
      revision: productData.ops.revision
    };
  } catch (error) {
    console.error('Failed to save product to Firestore:', error);
    throw new Error(`Failed to save product: ${error.message}`);
  }
}

/**
 * Get a product from Firestore
 */
async function getProduct(productId) {
  try {
    const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(productId);
    const doc = await docRef.get();
    
    if (!doc.exists) {
      return null;
    }
    
    return doc.data();
  } catch (error) {
    console.error('Failed to get product from Firestore:', error);
    throw new Error(`Failed to get product: ${error.message}`);
  }
}

/**
 * Get all products from Firestore
 */
async function getAllProducts() {
  try {
    const snapshot = await firestore.collection(PRODUCTS_COLLECTION)
      .orderBy('ops.last_saved_iso', 'desc')
      .limit(100)
      .get();
    
    const products = [];
    snapshot.forEach(doc => {
      products.push(doc.data());
    });
    
    console.log(`Loaded ${products.length} products from Firestore`);
    return products;
  } catch (error) {
    console.error('Failed to get products from Firestore:', error);
    throw new Error(`Failed to get products: ${error.message}`);
  }
}

/**
 * Delete a product from Firestore
 */
async function deleteProduct(productId) {
  try {
    await firestore.collection(PRODUCTS_COLLECTION).doc(productId).delete();
    console.log(`Product deleted from Firestore: ${productId}`);
  } catch (error) {
    console.error('Failed to delete product from Firestore:', error);
    throw new Error(`Failed to delete product: ${error.message}`);
  }
}

/**
 * Update product sync status
 */
async function updateProductSyncStatus(productId, status, lastSyncedIso = null, baseProductId = undefined) {
  try {
    const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(productId);
    const updateData = {
      'ops.sync_status': status
    };
    
    if (lastSyncedIso) {
      updateData['ops.last_synced_iso'] = lastSyncedIso;
    }
    
    if (baseProductId !== undefined) {
      updateData['ops.base_product_id'] = baseProductId;
    }
    
    await docRef.update(updateData);
    console.log(`Product sync status updated: ${productId} -> ${status}`);
  } catch (error) {
    console.error('Failed to update product sync status:', error);
    throw new Error(`Failed to update sync status: ${error.message}`);
  }
}

module.exports = {
  saveProduct,
  getProduct,
  getAllProducts,
  deleteProduct,
  updateProductSyncStatus,
  firestore,
};

