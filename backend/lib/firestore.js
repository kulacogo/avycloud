const { Firestore, FieldValue } = require('@google-cloud/firestore');
const {
  computeProductIdentityKey,
  buildIdentityAliasSet,
  sanitizeIdentityValue,
} = require('./product-identity');

function isFirestoreSpecialValue(value) {
  if (!value) return false;
  if (value instanceof FieldValue) {
    return true;
  }
  const ctorName = value?.constructor?.name;
  return ctorName === 'FieldValue';
}

function sanitizeFirestoreValue(value) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return null;
    }
    return value;
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Date || Buffer.isBuffer?.(value)) {
    return value;
  }

  if (isFirestoreSpecialValue(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    const cleaned = value
      .map((item) => sanitizeFirestoreValue(item))
      .filter((item) => item !== undefined);
    return cleaned;
  }

  if (typeof value === 'object') {
    const cleaned = {};
    for (const [key, nested] of Object.entries(value)) {
      const sanitized = sanitizeFirestoreValue(nested);
      if (sanitized !== undefined) {
        cleaned[key] = sanitized;
      }
    }
    return cleaned;
  }

  return undefined;
}

// Initialize Firestore
const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud'
});

// Collection name
const PRODUCTS_COLLECTION = 'products';
const ORDERS_COLLECTION = 'orders';
const SKU_INDEX_COLLECTION = 'baselinker_sku_index';
const INVENTORIES_COLLECTION = 'inventories';
const INVENTORY_SYNC_LOGS_COLLECTION = 'inventorySyncLogs';
const PRODUCT_LIST_LIMIT = parseInt(process.env.PRODUCT_LIST_LIMIT || '0', 10);
const MAX_ALIAS_LOOKUP = parseInt(process.env.MAX_ALIAS_LOOKUP || '50', 10);

const normalizeSkuValue = (val) =>
  (val || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^sku[-\s]*/i, '')
    .replace(/\s+/g, '');

const normalizeEanValue = (val) =>
  (val || '')
    .toString()
    .replace(/\D+/g, '')
    .trim();

const buildSkuIndexKey = (type, value) => (value ? `${type}:${value}` : null);

const inventoryCollection = () => firestore.collection(INVENTORIES_COLLECTION);

const parseInventoryNameMeta = (name = '') => {
  const match = name.trim().match(/^([A-Z]{2,6})-(\d{2})-(\d{2,})/i);
  if (!match) {
    return { vendorCode: null, fiscalYear: null, sequence: null };
  }
  const [, vendor, year, seq] = match;
  const fiscalYear = Number(`20${year}`);
  const sequence = Number(seq);
  return {
    vendorCode: vendor.toUpperCase(),
    fiscalYear: Number.isFinite(fiscalYear) ? fiscalYear : null,
    sequence: Number.isFinite(sequence) ? sequence : null,
  };
};

const collectSkuIndexKeys = (product = {}) => {
  const keys = new Set();
  const addSku = (value) => {
    const normalized = normalizeSkuValue(value);
    if (normalized) {
      keys.add(buildSkuIndexKey('sku', normalized));
    }
  };
  const addEan = (value) => {
    const normalized = normalizeEanValue(value);
    if (normalized && normalized.length >= 6) {
      keys.add(buildSkuIndexKey('ean', normalized));
    }
  };

  addSku(product?.identification?.sku);
  addSku(product?.details?.identifiers?.sku);

  addEan(product?.details?.identifiers?.ean);
  addEan(product?.details?.identifiers?.gtin);
  addEan(product?.details?.identifiers?.upc);

  if (Array.isArray(product?.identification?.barcodes)) {
    product.identification.barcodes.forEach(addEan);
  }
  if (Array.isArray(product?.ops?.identity_aliases)) {
    product.ops.identity_aliases.forEach(addEan);
  }

  return Array.from(keys).filter(Boolean);
};

/**
 * Save a product to Firestore
 */
async function saveProduct(product) {
  try {
    const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(product.id);
    const existingSnap = await docRef.get();
    const existingData = existingSnap.exists ? existingSnap.data() || {} : null;

    const pickStableSku = (data) => {
      const idSku = typeof data?.identification?.sku === 'string' ? data.identification.sku.trim() : '';
      const detSku = typeof data?.details?.identifiers?.sku === 'string' ? data.details.identifiers.sku.trim() : '';
      return idSku || detSku || '';
    };

    const stableSku = pickStableSku(existingData);
    if (stableSku) {
      // Enforce SKU immutability: never overwrite existing SKU
      if (!product.identification) product.identification = {};
      if (!product.details) product.details = {};
      if (!product.details.identifiers) product.details.identifiers = {};

      const incomingSku =
        (typeof product.identification.sku === 'string' && product.identification.sku.trim()) ||
        (typeof product.details.identifiers.sku === 'string' && product.details.identifiers.sku.trim()) ||
        '';

      if (incomingSku && incomingSku !== stableSku) {
        console.warn(
          `[saveProduct] SKU change blocked for ${product.id}: incoming="${incomingSku}" kept="${stableSku}"`
        );
      }
      product.identification.sku = stableSku;
      product.details.identifiers.sku = stableSku;
    }
    
    // Merge existing product data to avoid overwriting enriched content (images/descriptions/attrs)
    const existingDetails = existingData?.details || {};
    const incomingDetails = product?.details || {};

    const mergeString = (incomingVal, existingVal) => {
      const normalizedIncoming = typeof incomingVal === 'string' ? incomingVal.trim() : '';
      const normalizedExisting = typeof existingVal === 'string' ? existingVal.trim() : '';
      return normalizedExisting || normalizedIncoming || '';
    };

    // Merge images: keep all existing images, append new ones that are not duplicates
    const existingImages = Array.isArray(existingDetails.images) ? existingDetails.images : [];
    const incomingImages = Array.isArray(incomingDetails.images) ? incomingDetails.images : [];
    const mergedImages = [...existingImages];
    const seenImages = new Set(
      existingImages
        .map((img) => img?.url_or_base64 || img?.url || img?.href)
        .filter(Boolean)
    );
    incomingImages.forEach((img) => {
      const key = img?.url_or_base64 || img?.url || img?.href;
      if (key && seenImages.has(key)) return;
      if (key) seenImages.add(key);
      mergedImages.push(img);
    });

    // Merge attributes (existing wins if incoming missing; incoming overrides same key if provided)
    const mergedAttributes = {
      ...(existingDetails.attributes || {}),
      ...(incomingDetails.attributes || {}),
    };

    // Merge pricing with guard (do not drop existing valid price)
    const existingPrice = existingDetails?.pricing?.lowest_price;
    const incomingPrice = incomingDetails?.pricing?.lowest_price;
    const incomingValid =
      incomingPrice &&
      typeof incomingPrice.amount === 'number' &&
      Number(incomingPrice.amount) > 0;
    const mergedPricing = {
      ...(existingDetails.pricing || {}),
      ...(incomingDetails.pricing || {}),
    };
    if (existingPrice && !incomingValid) {
      mergedPricing.lowest_price = existingPrice;
    } else if (incomingValid) {
      mergedPricing.lowest_price = {
        ...incomingPrice,
        currency: incomingPrice.currency || existingPrice?.currency || 'EUR',
      };
    }

    // Build merged details
    const mergedDetails = {
      ...existingDetails,
      ...incomingDetails,
      short_description: mergeString(incomingDetails.short_description, existingDetails.short_description),
      description: mergeString(incomingDetails.description, existingDetails.description),
      attributes: mergedAttributes,
      images: mergedImages,
      pricing: Object.keys(mergedPricing).length ? mergedPricing : undefined,
    };

    // Merge identification
    const mergedIdentification = {
      ...(existingData?.identification || {}),
      ...(product?.identification || {}),
    };

    const mergedOps = {
      ...(existingData?.ops || {}),
      ...(product?.ops || {}),
    };

    // Add timestamps and identity metadata
    const identityKey = computeProductIdentityKey({ ...product, details: mergedDetails, identification: mergedIdentification });
    const pendingIntake =
      typeof mergedOps.pending_intake_quantity === 'number' && Number.isFinite(mergedOps.pending_intake_quantity)
        ? mergedOps.pending_intake_quantity
        : 0;
    const aliasSet = buildIdentityAliasSet({ ...product, details: mergedDetails, identification: mergedIdentification });
    const existingAliases = Array.isArray(mergedOps.identity_aliases) ? mergedOps.identity_aliases.filter(Boolean) : [];
    const mergedAliases = Array.from(new Set([...existingAliases, ...aliasSet])).slice(0, 100);

    const productData = {
      ...(existingData || {}),
      ...product,
      identification: mergedIdentification,
      details: mergedDetails,
      ops: {
        ...mergedOps,
        identity_key: identityKey || mergedOps.identity_key || null,
        identity_aliases: mergedAliases.length ? mergedAliases : undefined,
        pending_intake_quantity: pendingIntake,
        last_saved_iso: new Date().toISOString(),
        revision: ((mergedOps.revision || 0)) + 1,
      },
    };

    const sanitizedProduct = sanitizeFirestoreValue(productData);
    await docRef.set(sanitizedProduct);
    
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
    const applyLimit = Number.isFinite(PRODUCT_LIST_LIMIT) && PRODUCT_LIST_LIMIT > 0;
    if (applyLimit) {
      console.warn(
        `[firestore] PRODUCT_LIST_LIMIT=${PRODUCT_LIST_LIMIT} konfiguriert – wird ignoriert, um fehlende Produkte im Inventar zu vermeiden.`
      );
    }

    // Wichtiger Fix: orderBy auf einem optionalen Feld filtert alle Dokumente ohne dieses Feld heraus.
    // Wir holen deshalb alle Dokumente ohne orderBy, damit keine Produkte fehlen.
    const snapshot = await firestore.collection(PRODUCTS_COLLECTION).get();
    
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
async function deleteProduct(productId, { existingData = null } = {}) {
  if (!productId) {
    throw new Error('Product ID is required for deletion.');
  }
  try {
    const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(productId);
    let productData = existingData;
    if (!productData) {
      const snapshot = await docRef.get();
      if (!snapshot.exists) {
        console.log(`Product not found for deletion: ${productId}`);
        return false;
      }
      productData = snapshot.data() || {};
    }

    const batch = firestore.batch();
    batch.delete(docRef);

    const indexKeys = collectSkuIndexKeys(productData);
    indexKeys.forEach((key) => {
      if (!key) return;
      batch.delete(firestore.collection(SKU_INDEX_COLLECTION).doc(key));
    });

    await batch.commit();

    const suffix = indexKeys.length === 1 ? 'entry' : 'entries';
    console.log(`Product deleted from Firestore: ${productId} (removed ${indexKeys.length} SKU index ${suffix})`);
    return true;
  } catch (error) {
    console.error('Failed to delete product from Firestore:', error);
    throw new Error(`Failed to delete product: ${error.message}`);
  }
}

/**
 * Update product sync status (and optional BaseLinker linkage)
 */
async function updateProductSyncStatus(
  productId,
  status,
  lastSyncedIso = null,
  baseProductId = undefined,
  inventoryId = undefined
) {
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
      updateData['ops.baselinker'] = {
        ...(updateData['ops.baselinker'] || {}),
        product_id: baseProductId,
        synced_inventory: inventoryId || null,
      };
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

async function findProductByNameBrand(name = null, brand = null) {
  const queries = [];
  const trimmedName = (name || '').trim();
  const trimmedBrand = (brand || '').trim();

  if (!trimmedName) return null;

  // Exact name match on identification.name
  queries.push(
    firestore
      .collection(PRODUCTS_COLLECTION)
      .where('identification.name', '==', trimmedName)
      .limit(3)
      .get()
  );

  // Exact name match on details.name
  queries.push(
    firestore
      .collection(PRODUCTS_COLLECTION)
      .where('details.name', '==', trimmedName)
      .limit(3)
      .get()
  );

  const snapshots = await Promise.all(queries);

  for (const snap of snapshots) {
    if (snap.empty) continue;
    for (const doc of snap.docs) {
      const data = doc.data();
      // If brand is provided, prefer matching brand
      if (trimmedBrand) {
        const candidateBrand =
          (data?.identification?.brand || data?.details?.brand || '').trim().toLowerCase();
        if (candidateBrand && candidateBrand !== trimmedBrand.toLowerCase()) {
          continue;
        }
      }
      return { ...data, id: data?.id || doc.id };
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

async function deleteProductsByIdentityAlias(alias, { limit = 50 } = {}) {
  const normalizedAlias = sanitizeIdentityValue(alias);
  if (!normalizedAlias) {
    return { alias: null, deletedCount: 0, productIds: [] };
  }
  const cap = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  const snapshot = await firestore
    .collection(PRODUCTS_COLLECTION)
    .where('ops.identity_aliases', 'array-contains', normalizedAlias)
    .limit(cap)
    .get();

  if (snapshot.empty) {
    return { alias: normalizedAlias, deletedCount: 0, productIds: [] };
  }

  const docs = snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() || {} }));
  const deletedIds = [];
  for (const doc of docs) {
    try {
      const removed = await deleteProduct(doc.id, { existingData: doc.data });
      if (removed) {
        deletedIds.push(doc.id);
      }
    } catch (error) {
      console.error(`Failed to delete product ${doc.id} for alias ${normalizedAlias}:`, error.message);
    }
  }

  return {
    alias: normalizedAlias,
    deletedCount: deletedIds.length,
    productIds: deletedIds,
  };
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

async function removeProductIdentityAliases(productId, aliases = []) {
  if (!productId || !Array.isArray(aliases) || !aliases.length) {
    return;
  }
  const normalized = aliases.map((alias) => sanitizeIdentityValue(alias)).filter(Boolean);
  if (!normalized.length) {
    return;
  }
  const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(productId);
  await docRef.set(
    {
      ops: {
        identity_aliases: FieldValue.arrayRemove(...normalized),
      },
    },
    { merge: true }
  );

  // Clean up SKU/EAN index entries that may have been created for the alias values
  const indexKeys = normalized
    .map((alias) => buildSkuIndexKey('ean', normalizeEanValue(alias)))
    .filter(Boolean);
  if (!indexKeys.length) {
    return;
  }
  const batch = firestore.batch();
  indexKeys.forEach((key) => {
    batch.delete(firestore.collection(SKU_INDEX_COLLECTION).doc(key));
  });
  await batch.commit();
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

/**
 * Aggregate order counts across the entire orders collection.
 * Picks are detected by:
 * - status === 'picked'
 * - statusLabel/status matching known closed labels (kommissioniert/versendet/zugestellt/…)
 * - pickedAt being present
 * - statusId matching configured picked status IDs (env) or the hard fallback.
 */
async function getOrderSummary() {
  const CLOSED_LABELS = new Set([
    'kommissioniert',
    'versendet',
    'zugestellt',
    'shipped',
    'delivered',
    'completed',
    'erledigt',
    'storniert',
    'cancelled',
    'canceled',
  ]);

  const pickedStatusIds = new Set(['363183']); // hard fallback BaseLinker picked status
  const envPickedId = process.env.BASE_ORDER_STATUS_PICKED;
  if (envPickedId) {
    pickedStatusIds.add(String(envPickedId).trim());
  }

  const snapshot = await firestore.collection(ORDERS_COLLECTION).get();

  let total = 0;
  let picked = 0;

  snapshot.forEach((doc) => {
    const order = doc.data() || {};
    total += 1;

    const statusId = order.statusId ? String(order.statusId) : null;
    const rawStatus = order.status || order.statusLabel || '';
    const normalizedStatus = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : '';

    const isPickedById = statusId ? pickedStatusIds.has(statusId) : false;
    const isPickedByLabel =
      CLOSED_LABELS.has(normalizedStatus) ||
      CLOSED_LABELS.has(normalizedStatus.replace(/\s+/g, ' ')) ||
      normalizedStatus.includes('versendet') ||
      normalizedStatus.includes('zugestellt');
    const isPickedStatus = normalizedStatus === 'picked';
    const isPickedByTimestamp = Boolean(order.pickedAt);

    if (isPickedById || isPickedByLabel || isPickedStatus || isPickedByTimestamp) {
      picked += 1;
    }
  });

  const open = Math.max(0, total - picked);
  return { total, picked, open };
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

async function upsertInventories(records = []) {
  if (!Array.isArray(records) || !records.length) {
    return { upserted: 0 };
  }
  const snapshot = await inventoryCollection().get();
  const existingMap = new Map();
  snapshot.forEach((doc) => existingMap.set(doc.id, doc.data()));
  const batch = firestore.batch();
  records.forEach((record) => {
    const inventoryId = String(record.inventoryId || record.id || '').trim();
    if (!inventoryId) return;
    const existing = existingMap.get(inventoryId);
    const docRef = inventoryCollection().doc(inventoryId);
    const parsedMeta = record.meta || parseInventoryNameMeta(record.name || '');
    const payload = sanitizeFirestoreValue({
      inventoryId,
      name: record.name || inventoryId,
      description: record.description || null,
      vendorCode: record.vendorCode || parsedMeta.vendorCode || null,
      fiscalYear: record.fiscalYear ?? parsedMeta.fiscalYear ?? null,
      sequence: record.sequence ?? parsedMeta.sequence ?? null,
      type: record.type || null,
      defaultWarehouse: record.defaultWarehouse || null,
      defaultPriceGroup: record.defaultPriceGroup || null,
      isActive: record.isActive !== false,
      isExternal: record.isExternal || false,
      baselinker: record.baselinker || null,
      meta: {
        vendorCode: record.vendorCode || parsedMeta.vendorCode || null,
        fiscalYear: record.fiscalYear ?? parsedMeta.fiscalYear ?? null,
        sequence: record.sequence ?? parsedMeta.sequence ?? null,
      },
      createdAt: existing?.createdAt || FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    batch.set(docRef, payload, { merge: true });
  });
  await batch.commit();
  return { upserted: records.length };
}

async function listInventories({ limit = 500, vendorCode = null, search = '' } = {}) {
  let query = inventoryCollection().orderBy('name');
  if (vendorCode) {
    query = query.where('meta.vendorCode', '==', vendorCode.toUpperCase());
  }
  if (Number.isFinite(limit) && limit > 0) {
    query = query.limit(limit);
  }
  const snapshot = await query.get();
  let inventories = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      ...data,
      inventoryId: data.inventoryId || doc.id,
    };
  });
  const normalizedSearch = search?.trim().toLowerCase();
  if (normalizedSearch) {
    inventories = inventories.filter((entry) => {
      const haystacks = [
        entry.name,
        entry.inventoryId,
        entry.description,
        entry.vendorCode,
        entry.meta?.vendorCode,
      ]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase());
      return haystacks.some((value) => value.includes(normalizedSearch));
    });
  }
  return inventories;
}

async function getInventoryRecord(inventoryId) {
  if (!inventoryId) return null;
  const snapshot = await inventoryCollection().doc(inventoryId).get();
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  return {
    ...data,
    inventoryId: data.inventoryId || snapshot.id,
  };
}

async function setProductInventory(productId, inventory) {
  if (!productId || !inventory?.inventoryId) {
    throw new Error('Inventory ID und Produkt ID sind erforderlich.');
  }
  const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(productId);
  await docRef.update({
    'inventory.inventoryId': inventory.inventoryId,
    'inventory.inventoryName': inventory.name || null,
  });
}

async function assignInventoryToProducts(productIds = [], inventory) {
  if (!Array.isArray(productIds) || !productIds.length) {
    return;
  }
  if (!inventory?.inventoryId) {
    throw new Error('Inventory-Datensatz ist erforderlich.');
  }
  const batch = firestore.batch();
  productIds.forEach((productId) => {
    const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(productId);
    batch.update(docRef, {
      'inventory.inventoryId': inventory.inventoryId,
      'inventory.inventoryName': inventory.name || null,
    });
  });
  await batch.commit();
}

async function logInventorySyncEvent({ productId, inventoryId, status, message }) {
  await firestore.collection(INVENTORY_SYNC_LOGS_COLLECTION).add({
    productId,
    inventoryId,
    status,
    message: message || null,
    createdAt: FieldValue.serverTimestamp(),
  });
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
  deleteProductsByIdentityAlias,
  findProductByStrictIdentifier, // Export the new function
  adjustPendingIntakeQuantity,
  appendProductIdentityAliases,
  removeProductIdentityAliases,
  saveOrders,
  listOrders,
  getOrderSummary,
  getOrderById,
  updateOrder,
  getSkuIndexEntry,
  setSkuIndexEntry,
  upsertInventories,
  listInventories,
  getInventoryRecord,
  setProductInventory,
  assignInventoryToProducts,
  logInventorySyncEvent,
  firestore,
};