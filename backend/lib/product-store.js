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
  // 1) Originale saveProduct() ausführen — alle Business-Logik bleibt erhalten
  //    (SKU-Allokation, Title-Policy, Category-Mapping, Identifier-Sync etc.)
  const result = await saveProduct(product, options);

  // 2) Normalisierte Kopie in products_v2 schreiben (Dual-Write)
  if (USE_V2) {
    try {
      // saveProduct() kann das Produkt modifiziert haben (SKU generiert etc.)
      // Wir nehmen das Ergebnis-Produkt + die aktualisierten Daten aus Firestore.
      // WICHTIG: Muss aus der GLEICHEN Collection lesen, in die saveProduct() geschrieben hat.
      // Vorher stand hier COLLECTION ('products'), aber saveProduct() schreibt nach PRODUCTS_COLLECTION
      // ('products_v2' wenn USE_PRODUCTS_V2=true). Das führte dazu, dass der Dual-Write
      // veraltete Daten aus der alten Collection las und damit manuelle Änderungen (z.B. Titel)
      // sofort wieder überschrieb.
      const productId = product.id;
      const { PRODUCTS_COLLECTION } = require('./firestore');
      const freshSnap = await firestore.collection(PRODUCTS_COLLECTION).doc(productId).get();
      const freshData = freshSnap.exists ? { id: productId, ...freshSnap.data() } : product;

      const normalized = normalizeProduct(freshData);
      const validation = validateCanonical(normalized);
      if (!validation.valid) {
        console.error(`[saveProductV2] Validation failed for ${productId}:`, validation.errors);
        normalized.ops._validationErrors = validation.errors;
      }

      // targetId = kanonische ID (kann sich von productId unterscheiden durch _pickCanonicalId)
      const targetId = normalized.id || productId;
      await firestore.collection(V2_COLLECTION).doc(targetId).set(normalized, { merge: true });
    } catch (err) {
      // Dual-Write-Fehler darf den Hauptprozess NICHT blockieren
      console.error(`[saveProductV2] v2 write failed for ${product.id}: ${err.message}`);
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

module.exports = {
  saveProductV2,
  getProductV2,
  getAllProductsV2,
  getCollection,
  COLLECTION,
  V2_COLLECTION,
  USE_V2,
};
