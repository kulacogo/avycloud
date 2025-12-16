/**
 * Bereinigt warehouseBins:
 * - fasst doppelte Einträge (gleiche productId oder gleiche sku) zusammen
 * - entfernt Einträge mit Menge <= 0
 * - setzt productCount neu
 *
 * Usage:
 *   node backend/scripts/fix-bin-duplicates.js
 */

const { firestore } = require('../lib/firestore');

function key(entry) {
  const pid = entry.productId ? String(entry.productId).trim() : '';
  const sku = entry.sku ? String(entry.sku).trim() : '';
  return pid || sku || null;
}

async function main() {
  const snap = await firestore.collection('warehouseBins').get();
  let updated = 0;
  snap.forEach((doc) => {
    const data = doc.data() || {};
    const products = Array.isArray(data.products) ? data.products : [];
    const map = new Map();
    products.forEach((entry) => {
      const k = key(entry);
      if (!k) return;
      const qty = Number(entry.quantity) || 0;
      const existing = map.get(k);
      if (existing) {
        existing.quantity += qty;
        existing.lastUpdatedAt = entry.lastUpdatedAt || existing.lastUpdatedAt;
      } else {
        map.set(k, { ...entry, quantity: qty });
      }
    });
    const cleaned = Array.from(map.values()).filter((e) => e.quantity > 0);
    const productCount = cleaned.reduce((s, e) => s + (e.quantity || 0), 0);
    const same =
      productCount === (data.productCount || 0) &&
      cleaned.length === products.length &&
      cleaned.every((c, i) => JSON.stringify(c) === JSON.stringify(products[i]));
    if (same) return;
    firestore.collection('warehouseBins').doc(doc.id).set(
      {
        ...data,
        products: cleaned,
        productCount,
      },
      { merge: true }
    );
    updated += 1;
  });
  console.log(`Bins updated: ${updated}/${snap.size}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
