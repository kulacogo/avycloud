/**
 * Abstraktionsschicht für Produkt-Persistenz.
 *
 * saveProductV2() ist ein Drop-in-Replacement für saveProduct():
 *   - Gleiche Signatur: (product, options)
 *   - Ruft die originale saveProduct() auf (volle Business-Logik: SKU, Title-Policy etc.)
 *   - Schreibt ZUSÄTZLICH eine normalisierte Kopie in products_v2 (wenn USE_PRODUCTS_V2=true)
 *
 * Dual-Write-Pattern: Beide Collections werden parallel aktualisiert.
 * Lese-Pfade können über getCollection() gesteuert werden.
 */
const { firestore, saveProduct } = require('./firestore');
const { normalizeProduct, validateCanonical } = require('./product-canonical');
const { emitSyncEvent } = require('../services/sync-event-bus');

// Feature-Flag: Umschalten zwischen alter und neuer Collection
const COLLECTION = process.env.PRODUCT_COLLECTION || 'products';
const V2_COLLECTION = 'products_v2';
const USE_V2 = process.env.USE_PRODUCTS_V2 === 'true';

function getCollection() {
  return USE_V2 ? V2_COLLECTION : COLLECTION;
}

/**
 * Produkt speichern — Drop-in-Replacement für saveProduct().
 *
 * 1. Ruft die originale saveProduct(product, options) auf → volle Business-Logik
 * 2. Wenn USE_PRODUCTS_V2=true: schreibt normalisierte Kopie nach products_v2
 *
 * Signatur: saveProductV2(product, options) — identisch zu saveProduct().
 */
async function saveProductV2(product, options = {}) {
  const productId = product.id;

  // ── Stock change detection: read old inventory BEFORE save ──
  // Only when the incoming product includes inventory data (avoids extra reads on non-stock saves)
  let oldQty = null;
  const hasInventory = product?.inventory?.quantity !== undefined;
  if (hasInventory && productId) {
    try {
      const oldDoc = await firestore.collection(getCollection()).doc(productId).get();
      oldQty = oldDoc.exists ? Number(oldDoc.data()?.inventory?.quantity ?? -1) : null;
    } catch {
      // Non-critical: if read fails, skip change detection
    }
  }

  // 1) Originale saveProduct() ausführen — alle Business-Logik bleibt erhalten
  //    (SKU-Allokation, Title-Policy, Category-Mapping, Identifier-Sync etc.)
  const result = await saveProduct(product, options);

  // 2) Normalisierte Kopie in products_v2 schreiben (Dual-Write)
  //    NUR nötig wenn saveProduct() in eine ANDERE Collection schreibt als products_v2.
  //    Wenn PRODUCTS_COLLECTION === V2_COLLECTION, schreibt saveProduct() bereits direkt
  //    nach products_v2 → Dual-Write ist redundant und erzeugt durch _pickCanonicalId
  //    sogar Duplikate unter abweichenden Document-IDs (BUG-085).
  const { PRODUCTS_COLLECTION } = require('./firestore');
  const isDualWriteNeeded = PRODUCTS_COLLECTION !== V2_COLLECTION;

  if (USE_V2 && isDualWriteNeeded) {
    try {
      const productId = product.id;
      const freshSnap = await firestore.collection(PRODUCTS_COLLECTION).doc(productId).get();
      const freshData = freshSnap.exists ? { id: productId, ...freshSnap.data() } : product;

      const normalized = normalizeProduct(freshData);
      const validation = validateCanonical(normalized);
      if (!validation.valid) {
        console.error(`[saveProductV2] Validation failed for ${productId}:`, validation.errors);
        normalized.ops._validationErrors = validation.errors;
      }

      const targetId = normalized.id || productId;
      await firestore.collection(V2_COLLECTION).doc(targetId).set(normalized, { merge: true });
    } catch (err) {
      console.error(`[saveProductV2] v2 write failed for ${product.id}: ${err.message}`);
    }
  }

  // ── Emit stock:changed event if inventory actually changed ──
  // This triggers automatic stock sync to ALL marketplace channels (eBay, Kaufland)
  if (hasInventory && oldQty !== null && productId) {
    const newQty = Number(product.inventory.quantity);
    if (newQty !== oldQty) {
      emitSyncEvent('stock:changed', {
        entityId: productId,
        tenantId: options?.tenantId || 'default',
        reason: options?.source || 'product-save',
        oldQty,
        newQty,
      });
    }
  }

  return result;
}

/**
 * Produkt lesen — aus aktiver Collection.
 */
async function getProductV2(productId) {
  const doc = await firestore.collection(getCollection()).doc(productId).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

/**
 * Alle Produkte lesen — aus aktiver Collection.
 */
async function getAllProductsV2(queryFn) {
  let ref = firestore.collection(getCollection());
  if (queryFn) ref = queryFn(ref);
  const snap = await ref.get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Lookup product weight by SKU or EAN.
 * Returns weight in kg (number) or null if not found / no weight.
 *
 * @param {string|null} sku
 * @param {string|null} ean
 * @returns {Promise<number|null>}
 */
async function getProductWeightBySku(sku, ean) {
  if (!sku && !ean) return null;

  const col = firestore.collection(getCollection());
  let product = null;

  // 1. Try SKU
  if (sku) {
    const snap = await col.where('identification.sku', '==', sku).limit(1).get();
    if (!snap.empty) product = snap.docs[0].data();
  }

  // 2. Fallback: EAN via identification.barcodes
  if (!product && ean) {
    const snap = await col.where('identification.barcodes', 'array-contains', ean).limit(1).get();
    if (!snap.empty) product = snap.docs[0].data();
  }

  if (!product) return null;

  // Extract weight with fallback chain
  const w = product.details?.weight
    ?? product.details?.attributes?.weight
    ?? product.details?.attributes?.['Gewicht (kg)']
    ?? product.details?.attributes?.['Gewicht']
    ?? null;

  return (typeof w === 'number' && w > 0) ? w : null;
}

module.exports = {
  saveProductV2,
  getProductV2,
  getAllProductsV2,
  getProductWeightBySku,
  getCollection,
  COLLECTION,
  V2_COLLECTION,
  USE_V2,
};
