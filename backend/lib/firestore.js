const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { computeProductIdentityKey, buildIdentityAliasSet } = require('./product-identity');

// Initialize Firestore
const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud'
});

// Collection name
const PRODUCTS_COLLECTION = 'products';
const ORDERS_COLLECTION = 'orders';
const SKU_INDEX_COLLECTION = 'baselinker_sku_index';
const PRODUCT_LIST_LIMIT = parseInt(process.env.PRODUCT_LIST_LIMIT || '0', 10);
const MAX_ALIAS_LOOKUP = parseInt(process.env.MAX_ALIAS_LOOKUP || '50', 10);

/**
 * Save a product to Firestore
 */
async function saveProduct(product) {
  try {
    const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(product.id);
    
    // Add timestamps
    const ops = product.ops || {};
    const identityKey = computeProductIdentityKey(product);
    const pendingIntake =
      typeof ops.pending_intake_quantity === 'number' && Number.isFinite(ops.pending_intake_quantity)
        ? ops.pending_intake_quantity
        : 0;
    const aliasSet = buildIdentityAliasSet(product);
    const existingAliases = Array.isArray(ops.identity_aliases) ? ops.identity_aliases.filter(Boolean) : [];
    const mergedAliases = Array.from(new Set([...existingAliases, ...aliasSet])).slice(0, 100);
    const productData = {
      ...product,
      ops: {
        ...ops,
        identity_key: identityKey || ops.identity_key || null,
        identity_aliases: mergedAliases.length ? mergedAliases : undefined,
        pending_intake_quantity: pendingIntake,
        last_saved_iso: new Date().toISOString(),
        revision: ((ops.revision || 0)) + 1
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
    
    const data = doc.data();
    return {
      ...data,
      id: data?.id || doc.id,
    };
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
    let query = firestore.collection(PRODUCTS_COLLECTION).orderBy('ops.last_saved_iso', 'desc');
    if (Number.isFinite(PRODUCT_LIST_LIMIT) && PRODUCT_LIST_LIMIT > 0) {
      query = query.limit(PRODUCT_LIST_LIMIT);
    }
    const snapshot = await query.get();
    
    const products = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      products.push({
        ...data,
        id: data?.id || doc.id,
      });
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

async function findProductByIdentityKey(identityKey) {
  if (!identityKey) return null;
  const snapshot = await firestore
    .collection(PRODUCTS_COLLECTION)
    .where('ops.identity_key', '==', identityKey)
    .limit(1)
    .get();
  if (snapshot.empty) {
    return null;
  }
  const doc = snapshot.docs[0];
  const data = doc.data();
  return {
    ...data,
    id: data?.id || doc.id,
  };
}

async function findProductByStrictIdentifier({ barcodes = [], sku = null } = {}) {
  if (!barcodes.length && !sku) return null;

  // 1. Check barcodes (EAN/GTIN/UPC/etc)
  const uniqueBarcodes = Array.from(new Set(barcodes.filter(Boolean)));
  for (const code of uniqueBarcodes) {
    // Check identification.barcodes
    let snap = await firestore.collection(PRODUCTS_COLLECTION)
      .where('identification.barcodes', 'array-contains', code)
      .limit(1)
      .get();
    if (!snap.empty) {
      const doc = snap.docs[0];
      return { ...doc.data(), id: doc.id };
    }
    
    // Check details.identifiers.ean
    snap = await firestore.collection(PRODUCTS_COLLECTION)
      .where('details.identifiers.ean', '==', code)
      .limit(1)
      .get();
    if (!snap.empty) {
      const doc = snap.docs[0];
      return { ...doc.data(), id: doc.id };
    }

    // Check details.identifiers.gtin
    snap = await firestore.collection(PRODUCTS_COLLECTION)
      .where('details.identifiers.gtin', '==', code)
      .limit(1)
      .get();
    if (!snap.empty) {
      const doc = snap.docs[0];
      return { ...doc.data(), id: doc.id };
    }
  }

  // 2. Check SKU
  if (sku) {
    // Check identification.sku
    let snap = await firestore.collection(PRODUCTS_COLLECTION)
      .where('identification.sku', '==', sku)
      .limit(1)
      .get();
    if (!snap.empty) {
      const doc = snap.docs[0];
      return { ...doc.data(), id: doc.id };
    }

    // Check details.identifiers.sku
    snap = await firestore.collection(PRODUCTS_COLLECTION)
      .where('details.identifiers.sku', '==', sku)
      .limit(1)
      .get();
    if (!snap.empty) {
      const doc = snap.docs[0];
      return { ...doc.data(), id: doc.id };
    }
  }

  return null;
}

async function findProductByIdentityAliases(aliases = [], { excludeProductId = null, maxQueries = 12 } = {}) {
  if (!Array.isArray(aliases) || !aliases.length) {
    return null;
  }
  const uniqueAliases = Array.from(new Set(aliases.filter(Boolean))).slice(0, maxQueries);
  for (const alias of uniqueAliases) {
    const snapshot = await firestore
      .collection(PRODUCTS_COLLECTION)
      .where('ops.identity_aliases', 'array-contains', alias)
      .limit(5)
      .get();
    if (snapshot.empty) {
      continue;
    }
    for (const doc of snapshot.docs) {
      if (excludeProductId && doc.id === excludeProductId) {
        continue;
      }
      const data = doc.data();
      return {
        ...data,
        id: data?.id || doc.id,
      };
    }
  }
  return null;
}

async function findProductIdsByAliases(aliases = [], { excludeProductId = null } = {}) {
  if (!Array.isArray(aliases) || !aliases.length) {
    return [];
  }
  const filtered = Array.from(new Set(aliases.filter(Boolean))).slice(0, MAX_ALIAS_LOOKUP);
  if (!filtered.length) {
    return [];
  }
  const ids = new Set();
  for (const alias of filtered) {
    const snapshot = await firestore
      .collection(PRODUCTS_COLLECTION)
      .where('ops.identity_aliases', 'array-contains', alias)
      .get();
    snapshot.forEach((doc) => {
      if (excludeProductId && doc.id === excludeProductId) {
        return;
      }
      ids.add(doc.id);
    });
  }
  return Array.from(ids);
}

async function adjustPendingIntakeQuantity(productId, delta = 0) {
  if (!productId || !delta) {
    return null;
  }
  const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(productId);
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) {
      throw new Error(`Product ${productId} not found for pending intake update`);
    }
    const data = snap.data() || {};
    const current = Number(data?.ops?.pending_intake_quantity) || 0;
    const next = Math.max(0, current + delta);
    tx.update(docRef, {
      'ops.pending_intake_quantity': next,
    });
    return next;
  });
}

async function appendProductIdentityAliases(productId, aliases = []) {
  if (!productId || !Array.isArray(aliases) || !aliases.length) {
    return;
  }
  const filtered = aliases.filter(Boolean);
  if (!filtered.length) {
    return;
  }
  const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(productId);
  await docRef.set(
    {
      ops: {
        identity_aliases: FieldValue.arrayUnion(...filtered.slice(0, 100)),
      },
    },
    { merge: true }
  );
}

async function saveOrders(orders = []) {
  if (!Array.isArray(orders) || orders.length === 0) {
    return [];
  }

  const batch = firestore.batch();
  const now = new Date().toISOString();

  orders.forEach((order) => {
    if (!order?.id) return;
    const docRef = firestore.collection(ORDERS_COLLECTION).doc(order.id);
    batch.set(
      docRef,
      {
        ...order,
        createdAt: order.createdAt || now,
        updatedAt: order.updatedAt || now,
      },
      { merge: true }
    );
  });

  await batch.commit();
  return orders;
}

async function listOrders(limit = 50) {
  const snapshot = await firestore
    .collection(ORDERS_COLLECTION)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();

  return snapshot.docs.map((doc) => doc.data());
}

async function getOrderById(orderId) {
  if (!orderId) return null;
  const doc = await firestore.collection(ORDERS_COLLECTION).doc(orderId).get();
  return doc.exists ? doc.data() : null;
}

async function updateOrder(orderId, updates = {}) {
  if (!orderId) {
    throw new Error('Order ID is required');
  }
  const docRef = firestore.collection(ORDERS_COLLECTION).doc(orderId);
  await docRef.set(
    {
      ...updates,
      updatedAt: new Date().toISOString(),
      ...(!updates.updatedAt ? { updatedAt: new Date().toISOString() } : {}),
    },
    { merge: true }
  );
}

async function getSkuIndexEntry(key) {
  if (!key) return null;
  try {
    const doc = await firestore.collection(SKU_INDEX_COLLECTION).doc(key).get();
    if (!doc.exists) return null;
    return doc.data();
  } catch (error) {
    console.warn('Failed to read SKU index entry:', key, error.message);
    return null;
  }
}

async function setSkuIndexEntry(key, payload = {}) {
  if (!key) return;
  try {
    await firestore
      .collection(SKU_INDEX_COLLECTION)
      .doc(key)
      .set(
        {
          baseProductId: payload.baseProductId || null,
          productId: payload.productId || null,
          sku: payload.sku || null,
          ean: payload.ean || null,
          updated_at: payload.updatedAt || new Date().toISOString(),
        },
        { merge: true }
      );
  } catch (error) {
    console.warn('Failed to write SKU index entry:', key, error.message);
  }
}

module.exports = {
  saveProduct,
  getProduct,
  getAllProducts,
  deleteProduct,
  updateProductSyncStatus,
  findProductByIdentityKey,
  findProductByIdentityAliases,
  findProductIdsByAliases,
  findProductByStrictIdentifier, // Export the new function
  adjustPendingIntakeQuantity,
  appendProductIdentityAliases,
  saveOrders,
  listOrders,
  getOrderById,
  updateOrder,
  getSkuIndexEntry,
  setSkuIndexEntry,
  firestore,
};
