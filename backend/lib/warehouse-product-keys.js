'use strict';

// Shared, I/O-free identity matching for warehouse writes and stock guards.
function normalizeKey(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.toLowerCase() : null;
}

/**
 * Baut ein umfassendes Set von normalisierten Keys für Product-Matching.
 * Wird von ALLEN Warehouse-Funktionen genutzt die Produkte in BINs suchen.
 * @param {string|object} productIdOrData - Firestore docId (string) oder Produkt-Daten (object)
 * @returns {Set<string>} Normalisierte Keys (lowercase, SKU-Varianten)
 */
function buildProductKeySet(productIdOrData) {
  const keySet = new Set();
  const addKey = (value) => {
    const normalized = normalizeKey(value);
    if (normalized) keySet.add(normalized);
  };
  const addSkuVariants = (value) => {
    if (!value) return;
    const raw = String(value).trim();
    addKey(raw);
    const stripped = raw.replace(/^sku[-_\s]*/i, '');
    addKey(stripped);
    if (stripped) addKey(`sku-${stripped}`);
  };

  if (typeof productIdOrData === 'string') {
    addKey(productIdOrData);
    addSkuVariants(productIdOrData);
  }

  if (typeof productIdOrData === 'object' && productIdOrData) {
    addKey(productIdOrData.id);
    addSkuVariants(productIdOrData?.identification?.sku);
    addSkuVariants(productIdOrData?.details?.identifiers?.sku);
    addKey(productIdOrData?.details?.identifiers?.ean);
    addKey(productIdOrData?.details?.identifiers?.gtin);
    addKey(productIdOrData?.details?.identifiers?.upc);
    const barcodes = Array.isArray(productIdOrData?.identification?.barcodes)
      ? productIdOrData.identification.barcodes : [];
    barcodes.forEach((b) => addKey(b));
  }

  return keySet;
}

/**
 * Prüft ob ein Bin-Entry (p) zu einem keySet passt.
 * @param {object} p - Bin products[] Entry mit .productId und .sku
 * @param {Set<string>} keySet - Von buildProductKeySet() erzeugt
 * @returns {boolean}
 */
function binEntryMatchesKeySet(p, keySet) {
  if (!p) return false;
  const pid = normalizeKey(p.productId);
  const sku = normalizeKey(p.sku);
  const pidStripped = pid ? pid.replace(/^sku[-_\s]*/i, '') : null;
  const skuStripped = sku ? sku.replace(/^sku[-_\s]*/i, '') : null;
  return (
    (pid && keySet.has(pid)) ||
    (sku && keySet.has(sku)) ||
    (pidStripped && keySet.has(pidStripped)) ||
    (skuStripped && keySet.has(skuStripped))
  );
}

module.exports = { normalizeKey, buildProductKeySet, binEntryMatchesKeySet };
