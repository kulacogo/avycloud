'use strict';

const { getAllProducts, firestore } = require('../lib/firestore');
const { refreshProductInventory } = require('../lib/warehouse');
const { computeAvailableQuantity, syncStockToAllChannels, findProductsBySkuChunk } = require('./stock-sync-dispatcher');

/**
 * Check 1: Bin-Drift
 * Vergleiche inventory.quantity mit Summe der storageBins[].quantity.
 * Returns drift object or null.
 */
function checkBinDrift(product) {
  const inventoryQty = Number(product.inventory?.quantity || 0);
  const binTotal = (product.storageBins || [])
    .reduce((sum, b) => sum + (Number(b.quantity) || 0), 0);

  if (binTotal === inventoryQty) return null;

  return {
    productId: product.id,
    sku: product.identification?.sku || product.details?.identifiers?.sku || null,
    type: 'bin_drift',
    expected: binTotal,
    actual: inventoryQty,
    delta: binTotal - inventoryQty,
  };
}

/**
 * Check 2: Marketplace-Drift
 * Vergleiche aktuelle availableQty mit dem zuletzt gepushten Wert aus stock_sync_log.
 * Returns drift object or null.
 */
async function checkMarketplaceDrift(product, tenantId) {
  const { availableQty } = await computeAvailableQuantity(product, tenantId);

  // Letzten erfolgreichen Sync aus stock_sync_log holen
  const logSnap = await firestore.collection('stock_sync_log')
    .where('productId', '==', product.id)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();

  if (logSnap.empty) return null; // Nie gesynct → kein Drift feststellbar

  const lastSync = logSnap.docs[0].data();
  const lastPushed = Number(lastSync.availableQuantity ?? -1);

  if (lastPushed === availableQty) return null;

  return {
    productId: product.id,
    sku: product.identification?.sku || product.details?.identifiers?.sku || null,
    type: 'marketplace_drift',
    expected: availableQty,
    lastPushed,
    delta: availableQty - lastPushed,
  };
}

/**
 * Activity-based reconciliation — nur Produkte mit kürzlicher Aktivität.
 * Aufgerufen alle 30 Minuten.
 */
async function reconcileRecentActivity({ tenantId = 'default' } = {}) {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h lookback
  const productIds = new Set();

  // 1. Aus stock_sync_log
  const syncLogSnap = await firestore.collection('stock_sync_log')
    .where('createdAt', '>=', since)
    .limit(500)
    .get();
  syncLogSnap.docs.forEach((doc) => {
    const id = doc.data().productId;
    if (id) productIds.add(id);
  });

  // 2. Aus warehouse_movements (resolve SKU → productId)
  const movSnap = await firestore.collection('warehouse_movements')
    .where('createdAt', '>=', since)
    .limit(200)
    .get();
  const skus = new Set();
  movSnap.docs.forEach((doc) => {
    const sku = doc.data().productSku;
    if (sku) skus.add(sku);
  });
  if (skus.size > 0) {
    const skuArray = Array.from(skus);
    for (let i = 0; i < skuArray.length; i += 10) {
      const products = await findProductsBySkuChunk(skuArray.slice(i, i + 10));
      products.forEach((p) => productIds.add(p.id));
    }
  }

  if (productIds.size === 0) return { checked: 0, driftsFound: 0, autoFixed: 0, drifts: [] };

  return _runDriftChecks(Array.from(productIds), tenantId, 'activity');
}

/**
 * Full scan reconciliation — alle Produkte.
 * Aufgerufen 1x täglich nachts.
 */
async function reconcileFullScan({ tenantId = 'default' } = {}) {
  const products = await getAllProducts();
  const productIds = products.map((p) => p.id);
  return _runDriftChecks(productIds, tenantId, 'full_scan');
}

/**
 * Interne Funktion: Drift-Checks für eine Liste von Product-IDs.
 * Liest frisches Produkt, prüft Bin-Drift + Marketplace-Drift, fixt automatisch.
 */
async function _runDriftChecks(productIds, tenantId, reason) {
  const drifts = [];
  let fixed = 0;

  for (const productId of productIds) {
    try {
      // Frisches Produkt lesen
      const doc = await firestore.collection('products_v2').doc(productId).get();
      if (!doc.exists) continue;
      const product = { id: doc.id, ...doc.data() };

      // Check 1: Bin-Drift
      const binDrift = checkBinDrift(product);
      if (binDrift) {
        drifts.push(binDrift);
        try {
          await refreshProductInventory(productId);
          binDrift.autoFixed = true;
          fixed++;
          console.log(`[stock-reconciliation] bin-drift fixed: ${productId} delta=${binDrift.delta}`);
        } catch (err) {
          binDrift.autoFixed = false;
          binDrift.fixError = err.message;
          console.warn(`[stock-reconciliation] bin-drift fix failed: ${productId}: ${err.message}`);
        }
      }

      // Check 2: Marketplace-Drift
      const mktDrift = await checkMarketplaceDrift(product, tenantId);
      if (mktDrift) {
        drifts.push(mktDrift);
        try {
          // Re-read product after potential bin-drift fix
          const freshDoc = await firestore.collection('products_v2').doc(productId).get();
          const freshProduct = { id: freshDoc.id, ...freshDoc.data() };
          await syncStockToAllChannels({ tenantId, product: freshProduct, reason: `reconciliation-${reason}` });
          mktDrift.autoFixed = true;
          fixed++;
          console.log(`[stock-reconciliation] marketplace-drift fixed: ${productId} delta=${mktDrift.delta}`);
        } catch (err) {
          mktDrift.autoFixed = false;
          mktDrift.fixError = err.message;
          console.warn(`[stock-reconciliation] marketplace-drift fix failed: ${productId}: ${err.message}`);
        }
      }
    } catch (err) {
      console.warn(`[stock-reconciliation] check failed for ${productId}: ${err.message}`);
    }
  }

  // Ergebnisse loggen
  const result = {
    reason,
    checked: productIds.length,
    driftsFound: drifts.length,
    autoFixed: fixed,
    drifts,
    completedAt: new Date().toISOString(),
  };

  try {
    await firestore.collection('stock_reconciliation_log').add({
      ...result,
      // Drifts kürzen für Log-Speichereffizienz — max 50 Einträge
      drifts: drifts.slice(0, 50),
    });
  } catch (err) {
    console.warn('[stock-reconciliation] log write failed:', err.message);
  }

  if (drifts.length > 0) {
    console.log(`[stock-reconciliation] ${reason}: checked=${productIds.length} drifts=${drifts.length} fixed=${fixed}`);
  }

  return result;
}

module.exports = {
  reconcileRecentActivity,
  reconcileFullScan,
  checkBinDrift,
  checkMarketplaceDrift,
};
