/**
 * Produkt-Deduplizierung
 *
 * Erkennt Duplikate anhand von EAN/MPN/Brand+Model Kombination.
 * NIEMALS automatisch löschen — immer Vorschlag + manuelle Bestätigung.
 */
const { firestore, getProduct } = require('../lib/firestore');
const { saveProductV2 } = require('../lib/product-store');

/**
 * Findet potenzielle Duplikate über alle Produkte.
 * Gruppiert nach: EAN, MPN, Brand+Name Kombination.
 */
async function findDuplicates() {
  const snap = await firestore.collection('products').limit(2000).get();
  const products = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Index aufbauen
  const eanIndex = {};
  const mpnIndex = {};
  const brandNameIndex = {};

  for (const product of products) {
    const barcodes = product.identification?.barcodes || [];
    const ean = product.details?.identifiers?.ean;
    const mpn = product.details?.identifiers?.mpn;
    const brand = (product.identification?.brand || '').toLowerCase().trim();
    const name = (product.identification?.name || '').toLowerCase().trim();

    // EAN-basierte Duplikate
    const allEans = [...barcodes, ean].filter(Boolean).map(e => String(e).trim());
    for (const barcode of allEans) {
      if (barcode.length >= 8) {
        if (!eanIndex[barcode]) eanIndex[barcode] = [];
        eanIndex[barcode].push(product.id);
      }
    }

    // MPN-basierte Duplikate
    if (mpn && mpn.length >= 3) {
      const key = mpn.toLowerCase().trim();
      if (!mpnIndex[key]) mpnIndex[key] = [];
      mpnIndex[key].push(product.id);
    }

    // Brand+Name basierte Duplikate
    if (brand && name && brand !== 'unbekannt' && name.length >= 5) {
      const key = `${brand}|${name}`;
      if (!brandNameIndex[key]) brandNameIndex[key] = [];
      brandNameIndex[key].push(product.id);
    }
  }

  // Nur Gruppen mit > 1 Eintrag sind Duplikate
  const duplicates = [];

  for (const [ean, ids] of Object.entries(eanIndex)) {
    if (ids.length > 1) {
      duplicates.push({ type: 'ean', key: ean, productIds: [...new Set(ids)] });
    }
  }
  for (const [mpn, ids] of Object.entries(mpnIndex)) {
    if (ids.length > 1) {
      duplicates.push({ type: 'mpn', key: mpn, productIds: [...new Set(ids)] });
    }
  }
  for (const [brandName, ids] of Object.entries(brandNameIndex)) {
    if (ids.length > 1) {
      duplicates.push({ type: 'brand_name', key: brandName, productIds: [...new Set(ids)] });
    }
  }

  return { duplicates, totalProducts: products.length, totalDuplicateGroups: duplicates.length };
}

/**
 * Zeigt Unterschiede zwischen zwei Produkten für Merge-Vorschlag.
 */
async function suggestMerge(productIdA, productIdB) {
  const [a, b] = await Promise.all([getProduct(productIdA), getProduct(productIdB)]);
  if (!a || !b) {
    throw new Error('One or both products not found');
  }

  return {
    productA: {
      id: productIdA,
      name: a.identification?.name,
      brand: a.identification?.brand,
      sku: a.identification?.sku,
      barcodes: a.identification?.barcodes,
      stock: a.ops?.totalStock || 0,
      images: (a.details?.images || []).length,
      createdAt: a.ops?.createdAt,
    },
    productB: {
      id: productIdB,
      name: b.identification?.name,
      brand: b.identification?.brand,
      sku: b.identification?.sku,
      barcodes: b.identification?.barcodes,
      stock: b.ops?.totalStock || 0,
      images: (b.details?.images || []).length,
      createdAt: b.ops?.createdAt,
    },
  };
}

/**
 * Merge ausführen: Daten von removeId → keepId übertragen, removeId archivieren.
 * NICHT automatisch löschen.
 */
async function executeMerge(keepId, removeId) {
  const [keep, remove] = await Promise.all([getProduct(keepId), getProduct(removeId)]);
  if (!keep || !remove) {
    throw new Error('One or both products not found');
  }

  // Barcodes zusammenführen
  const mergedBarcodes = [...new Set([
    ...(keep.identification?.barcodes || []),
    ...(remove.identification?.barcodes || []),
  ])].filter(Boolean);

  // Bilder zusammenführen
  const mergedImages = [...new Set([
    ...(keep.details?.images || []),
    ...(remove.details?.images || []),
  ])].filter(Boolean);

  // Update keepId mit zusammengeführten Daten
  await saveProductV2({
    ...keep,
    identification: {
      ...keep.identification,
      barcodes: mergedBarcodes,
    },
    details: {
      ...keep.details,
      images: mergedImages,
    },
    ops: {
      ...keep.ops,
      mergedFrom: [...(keep.ops?.mergedFrom || []), removeId],
      lastMerge: new Date().toISOString(),
    },
  });

  // removeId als archiviert markieren (NICHT löschen)
  await firestore.collection('products').doc(removeId).set({
    ops: {
      archived: true,
      archivedAt: new Date().toISOString(),
      mergedInto: keepId,
      archivedReason: 'duplicate_merge',
    },
  }, { merge: true });

  return {
    keepId,
    removeId,
    merged: {
      barcodes: mergedBarcodes.length,
      images: mergedImages.length,
    },
  };
}

module.exports = {
  findDuplicates,
  suggestMerge,
  executeMerge,
};
