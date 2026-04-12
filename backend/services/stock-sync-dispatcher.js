/**
 * Stock Sync Dispatcher
 *
 * After a stock-out (or stock-in), pushes updated quantity to ALL connected
 * marketplace channels: eBay, Kaufland.
 *
 * Usage:
 *   const { syncStockToAllChannels } = require('./stock-sync-dispatcher');
 *   await syncStockToAllChannels({ tenantId, product });
 */

const { firestore } = require('../lib/firestore');

const SYNC_LOG_COLLECTION = 'stock_sync_log';

/**
 * Find products by SKU — searches both identification.sku and details.identifiers.sku
 * to avoid the silent-miss bug where products only have SKU in one field.
 */
async function findProductsBySkuChunk(skuChunk) {
  const found = new Map();
  // Primary: identification.sku
  const snap1 = await firestore.collection('products_v2')
    .where('identification.sku', 'in', skuChunk)
    .get();
  for (const doc of snap1.docs) {
    found.set(doc.id, { id: doc.id, ...doc.data() });
  }
  // Fallback: details.identifiers.sku (for products that only have SKU there)
  const snap2 = await firestore.collection('products_v2')
    .where('details.identifiers.sku', 'in', skuChunk)
    .get();
  for (const doc of snap2.docs) {
    if (!found.has(doc.id)) {
      found.set(doc.id, { id: doc.id, ...doc.data() });
    }
  }
  return [...found.values()];
}

/**
 * Compute true available quantity for a product by subtracting
 * active reservations from physical stock.
 *
 * @param {Object} product - Product with inventory.quantity and identification.sku
 * @param {string} tenantId
 * @returns {Promise<{ physicalQty: number, reservedQty: number, availableQty: number }>}
 */
async function computeAvailableQuantity(product, tenantId = 'default') {
  const physicalQty = Number(product?.inventory?.quantity ?? 0);
  const sku = String(product?.identification?.sku || product?.details?.identifiers?.sku || '').trim();
  const productId = String(product?.id || '');

  let reservedQty = 0;
  try {
    const { getReservedQuantity } = require('./stock-reservation');
    // Search by BOTH sku AND productId to catch all reservations.
    // Reservations from order intake use sku; manual reservations may use productId.
    // Using OR logic missed reservations when the key didn't match exactly.
    let bySkuQty = 0;
    let byProductIdQty = 0;
    if (sku) {
      bySkuQty = await getReservedQuantity({ tenantId, sku });
    }
    if (productId) {
      byProductIdQty = await getReservedQuantity({ tenantId, productId });
    }
    // Take the higher of the two to avoid double-counting if both point to same reservations,
    // but also to avoid missing reservations indexed under the other key.
    reservedQty = Math.max(bySkuQty, byProductIdQty);
  } catch (err) {
    console.warn(`[stock-sync] reservation lookup failed for ${sku || productId}: ${err.message}`);
  }

  const availableQty = Math.max(0, physicalQty - reservedQty);
  return { physicalQty, reservedQty, availableQty };
}

/**
 * Sync stock quantity to all connected marketplace channels for a product.
 * Computes real availableQuantity from physical stock minus active reservations.
 *
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (default: 'default')
 * @param {Object} params.product - Full product object from Firestore
 * @param {string} [params.reason] - Why the sync was triggered (e.g., 'stock-out', 'stock-in')
 * @returns {Object} { results: Array<{ channel, status, error? }> }
 */
async function syncStockToAllChannels({ tenantId = 'default', product, reason = 'manual' }) {
  if (!product?.id) {
    return { results: [{ channel: 'all', status: 'skipped', error: 'no product id' }] };
  }

  const productId = String(product.id);
  const { withStockLock } = require('../lib/stock-lock');

  return withStockLock(`sync:${productId}`, async () => {

  // Read fresh product data from Firestore to avoid stale quantities
  let freshProduct = product;
  try {
    const freshDoc = await firestore.collection('products_v2').doc(productId).get();
    if (freshDoc.exists) {
      freshProduct = { id: freshDoc.id, ...freshDoc.data() };
    }
  } catch (err) {
    console.warn(`[stock-sync] fresh read failed for ${productId}, using passed object: ${err.message}`);
  }

  const { physicalQty: quantity, reservedQty, availableQty: availableQuantity } =
    await computeAvailableQuantity(freshProduct, tenantId);
  const results = [];
  const isZeroStock = availableQuantity === 0;

  if (isZeroStock) {
    console.warn(`[stock-sync] ⚠️ ZERO STOCK product=${productId} physical=${quantity} reserved=${reservedQty} → pushing 0 to all channels`);
  }

  // --- eBay ---
  const ebayItemId = freshProduct?.ops?.ebay?.itemId
    || freshProduct?.ops?.ebay?.item_id
    || freshProduct?.marketplace?.ebay?.itemId;

  if (ebayItemId) {
    try {
      if (isZeroStock) {
        // eBay rejects reviseFixedPriceItem with qty=0 ("Die Stückzahl muss > 0 sein").
        // Use endFixedPriceItem to properly delist the item.
        const { endFixedPriceItem } = require('../lib/ebay-trading-api');
        const result = await endFixedPriceItem(String(ebayItemId), { reason: 'NotAvailable' });
        const status = result?.ack === 'Success' || result?.ack === 'Warning' ? 'success' : 'failed';
        // If listing was already ended, treat as success
        const alreadyEnded = result?.errors?.some((e) =>
          String(e?.errorCode || e?.code || '').includes('1047') ||
          String(e?.message || '').includes('ended') ||
          String(e?.message || '').includes('beendet')
        );
        const finalStatus = alreadyEnded ? 'success' : status;
        results.push({ channel: 'ebay', status: finalStatus, itemId: ebayItemId, quantityPushed: 0, zeroStock: true, action: 'end' });
        console.log(
          `[stock-sync] ebay END product=${productId} itemId=${ebayItemId} status=${finalStatus}`
        );
        // Clear stale itemId if listing was already ended (prevents repeated failures)
        if (alreadyEnded) {
          firestore.collection('products_v2').doc(productId)
            .update({ 'ops.ebay.itemId': null, 'ops.ebay.itemIdCleared': new Date().toISOString(), 'ops.ebay.itemIdClearReason': 'listing_ended' })
            .catch(() => {});
        }
      } else {
        const { reviseFixedPriceItem } = require('../lib/ebay-trading-api');
        const result = await reviseFixedPriceItem({
          itemId: String(ebayItemId),
          quantity: availableQuantity,
        });
        const status = result?.ack === 'Success' || result?.ack === 'Warning' ? 'success' : 'failed';
        // Check if the listing was ended — if so, clear the stale itemId
        const isEnded = result?.errors?.some((e) =>
          String(e?.message || '').includes('beendet') ||
          String(e?.message || '').includes('ended') ||
          String(e?.errorCode || e?.code || '').includes('1047')
        );
        if (isEnded) {
          console.warn(`[stock-sync] ebay listing ${ebayItemId} was ended — clearing stale itemId`);
          firestore.collection('products_v2').doc(productId)
            .update({ 'ops.ebay.itemId': null, 'ops.ebay.itemIdCleared': new Date().toISOString(), 'ops.ebay.itemIdClearReason': 'listing_ended' })
            .catch(() => {});
          results.push({ channel: 'ebay', status: 'skipped', itemId: ebayItemId, error: 'listing ended', zeroStock: false });
        } else {
          results.push({ channel: 'ebay', status, itemId: ebayItemId, quantityPushed: availableQuantity, zeroStock: false });
        }
        console.log(
          `[stock-sync] ebay product=${productId} itemId=${ebayItemId} qty=${availableQuantity} status=${status}`
        );
      }
    } catch (err) {
      const errMsg = err?.message || String(err);
      // If error says listing is ended, clear the stale itemId to stop endless retries
      if (errMsg.includes('beendet') || errMsg.includes('ended') || errMsg.includes('1047')) {
        firestore.collection('products_v2').doc(productId)
          .update({ 'ops.ebay.itemId': null, 'ops.ebay.itemIdCleared': new Date().toISOString(), 'ops.ebay.itemIdClearReason': 'listing_ended' })
          .catch(() => {});
        results.push({ channel: 'ebay', status: 'skipped', itemId: ebayItemId, error: 'listing ended (cleared)', zeroStock: isZeroStock });
        console.log(`[stock-sync] ebay listing ${ebayItemId} ended — cleared stale itemId for product=${productId}`);
      } else {
        results.push({ channel: 'ebay', status: 'error', error: errMsg });
        console.warn(
          `[stock-sync] ebay FAILED product=${productId} itemId=${ebayItemId}:`,
          errMsg
        );
      }
    }
  }

  // --- Kaufland ---
  // Primary: unitId stored in product ops. Fallback: look up from kauflandUnitsLive
  // by SKU or EAN. This handles products that were listed on Kaufland before
  // ops.kaufland.unitId was written (majority of historical products).
  let kauflandUnitId = freshProduct?.ops?.kaufland?.unitId
    || freshProduct?.ops?.kaufland?.id_unit
    || freshProduct?.marketplace?.kaufland?.unitId;

  if (!kauflandUnitId) {
    try {
      const sku = String(freshProduct?.identification?.sku || freshProduct?.details?.identifiers?.sku || '').trim();
      const ean = String(freshProduct?.identification?.ean || freshProduct?.details?.identifiers?.ean || '').trim();
      let unitSnap = null;
      if (sku) {
        unitSnap = await firestore.collection('kauflandUnitsLive')
          .where('id_offer', '==', sku)
          .where('active', '==', true)
          .limit(1)
          .get();
      }
      if ((!unitSnap || unitSnap.empty) && ean) {
        unitSnap = await firestore.collection('kauflandUnitsLive')
          .where('ean', '==', ean)
          .where('active', '==', true)
          .limit(1)
          .get();
      }
      if (unitSnap && !unitSnap.empty) {
        kauflandUnitId = unitSnap.docs[0].id;
        console.log(`[stock-sync] kaufland unitId resolved via lookup: ${kauflandUnitId} (sku=${sku})`);
        // Write back to product so future syncs don't need the lookup
        firestore.collection('products_v2').doc(productId)
          .update({ 'ops.kaufland.unitId': kauflandUnitId })
          .catch(() => {});
      }
    } catch (err) {
      console.warn(`[stock-sync] kaufland unitId lookup failed for product=${productId}: ${err.message}`);
    }
  }

  if (kauflandUnitId) {
    if (isZeroStock) {
      // Zero stock: explicitly set ONHOLD first — bypasses price validation in updateUnit()
      // This guarantees the listing is deactivated even if price/SKU data is missing.
      try {
        const { setUnitStatus } = require('../lib/kaufland-api');
        await setUnitStatus(kauflandUnitId, 'ONHOLD', { storefront: 'de' });
        results.push({
          channel: 'kaufland',
          status: 'success',
          unitId: kauflandUnitId,
          quantityPushed: 0,
          zeroStock: true,
          action: 'onhold',
        });
        console.log(
          `[stock-sync] kaufland ONHOLD product=${productId} unitId=${kauflandUnitId} → status=ONHOLD`
        );
      } catch (err) {
        const errMsg = err?.message || String(err);
        results.push({ channel: 'kaufland', status: 'error', error: errMsg, action: 'onhold' });
        console.warn(
          `[stock-sync] kaufland ONHOLD FAILED product=${productId} unitId=${kauflandUnitId}:`,
          errMsg
        );
        // If unit no longer exists on Kaufland, clear the stale unitId to stop endless retries
        if (errMsg.includes('Not Found') || errMsg.includes('404') || errMsg.includes('not_found')) {
          try {
            await firestore.collection('products_v2').doc(productId).set(
              { ops: { kaufland: { unitId: null, unitIdCleared: new Date().toISOString(), unitIdClearReason: 'unit_not_found' } } },
              { merge: true }
            );
            console.log(`[stock-sync] Cleared stale kaufland unitId for product=${productId} (Unit Not Found)`);
          } catch (clearErr) {
            console.warn(`[stock-sync] Failed to clear stale unitId: ${clearErr?.message}`);
          }
        }
      }
    } else {
      // Stock > 0: full update (price + qty + sets status=AVAILABLE automatically)
      try {
        const { updateUnit } = require('../lib/kaufland-api');
        const productWithAvailable = {
          ...freshProduct,
          inventory: {
            ...(freshProduct.inventory || {}),
            availableQuantity,
          },
        };
        const result = await updateUnit(kauflandUnitId, productWithAvailable, { storefront: 'de' });
        results.push({
          channel: 'kaufland',
          status: result?.updated ? 'success' : 'failed',
          unitId: kauflandUnitId,
          quantityPushed: availableQuantity,
          zeroStock: false,
        });
        console.log(
          `[stock-sync] kaufland product=${productId} unitId=${kauflandUnitId} qty=${availableQuantity} status=success`
        );
      } catch (err) {
        const errMsg = err?.message || String(err);
        results.push({ channel: 'kaufland', status: 'error', error: errMsg });
        console.warn(
          `[stock-sync] kaufland FAILED product=${productId} unitId=${kauflandUnitId}:`,
          errMsg
        );
        // If unit no longer exists on Kaufland, clear the stale unitId to stop endless retries
        if (errMsg.includes('Not Found') || errMsg.includes('404') || errMsg.includes('not_found')) {
          try {
            await firestore.collection('products_v2').doc(productId).set(
              { ops: { kaufland: { unitId: null, unitIdCleared: new Date().toISOString(), unitIdClearReason: 'unit_not_found' } } },
              { merge: true }
            );
            console.log(`[stock-sync] Cleared stale kaufland unitId for product=${productId} (Unit Not Found)`);
          } catch (clearErr) {
            console.warn(`[stock-sync] Failed to clear stale unitId: ${clearErr?.message}`);
          }
        }
      }
    }
  }

  // Log sync attempt to Firestore for audit trail
  try {
    await firestore.collection(SYNC_LOG_COLLECTION).add({
      tenantId,
      productId,
      reason,
      quantity,
      reservedQty,
      availableQuantity,
      zeroStock: isZeroStock,
      results,
      createdAt: new Date().toISOString(),
    });
  } catch (logErr) {
    console.warn('[stock-sync] log write failed:', logErr?.message);
  }

  return { results };
  }); // withStockLock
}

/**
 * Sync price to all connected marketplace channels for a product.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {Object} params.product
 * @param {Object} params.prices - { ebay?: number, kaufland?: number }
 * @returns {Object} { results }
 */
async function syncPriceToAllChannels({ tenantId = 'default', product, prices = {} }) {
  if (!product?.id) {
    return { results: [{ channel: 'all', status: 'skipped', error: 'no product id' }] };
  }

  const productId = String(product.id);
  const results = [];

  // --- eBay Price ---
  const ebayItemId = product?.ops?.ebay?.itemId
    || product?.ops?.ebay?.item_id
    || product?.marketplace?.ebay?.itemId;
  const ebayPrice = prices.ebay ?? product?.pricing?.ebay?.price ?? product?.details?.pricing?.sellPrice ?? product?.pricing?.sellPrice;

  if (ebayItemId && Number.isFinite(ebayPrice) && ebayPrice > 0) {
    try {
      const { reviseFixedPriceItem } = require('../lib/ebay-trading-api');
      const result = await reviseFixedPriceItem({
        itemId: String(ebayItemId),
        startPrice: ebayPrice,
        currency: 'EUR',
      });
      const status = result?.ack === 'Success' || result?.ack === 'Warning' ? 'success' : 'failed';
      results.push({ channel: 'ebay', status, pricePushed: ebayPrice });
      console.log(`[price-sync] ebay product=${productId} price=${ebayPrice} status=${status}`);
    } catch (err) {
      results.push({ channel: 'ebay', status: 'error', error: err?.message });
      console.warn(`[price-sync] ebay FAILED product=${productId}:`, err?.message || err);
    }
  }

  // --- Kaufland Price ---
  const kauflandUnitId = product?.ops?.kaufland?.unitId
    || product?.ops?.kaufland?.id_unit
    || product?.marketplace?.kaufland?.unitId;
  const kauflandPrice = prices.kaufland ?? product?.pricing?.kaufland?.price ?? product?.details?.pricing?.sellPrice ?? product?.pricing?.sellPrice;

  if (kauflandUnitId && Number.isFinite(kauflandPrice) && kauflandPrice > 0) {
    try {
      const { updateUnit } = require('../lib/kaufland-api');
      const productWithPrice = {
        ...product,
        pricing: {
          ...(product.pricing || {}),
          sellPrice: kauflandPrice,
        },
      };
      const result = await updateUnit(kauflandUnitId, productWithPrice, { storefront: 'de' });
      results.push({ channel: 'kaufland', status: result?.updated ? 'success' : 'failed', pricePushed: kauflandPrice });
      console.log(`[price-sync] kaufland product=${productId} price=${kauflandPrice} status=success`);
    } catch (err) {
      results.push({ channel: 'kaufland', status: 'error', error: err?.message });
      console.warn(`[price-sync] kaufland FAILED product=${productId}:`, err?.message || err);
    }
  }

  // Log
  try {
    await firestore.collection(SYNC_LOG_COLLECTION).add({
      tenantId,
      productId,
      reason: 'price-sync',
      prices,
      results,
      createdAt: new Date().toISOString(),
    });
  } catch (logErr) {
    console.warn('[price-sync] log write failed:', logErr?.message);
  }

  return { results };
}

/**
 * Sync stock with automatic retry on failure.
 * Retries once after 30s for channels that failed on first attempt.
 */
async function syncStockWithRetry({ tenantId = 'default', product, reason = 'manual' }) {
  const first = await syncStockToAllChannels({ tenantId, product, reason });
  const failedChannels = first.results.filter((r) => r.status === 'error');
  if (failedChannels.length === 0) return first;

  // Schedule retry after 30s for failed channels
  console.log(`[stock-sync] ${failedChannels.length} channel(s) failed, scheduling retry in 30s`);
  setTimeout(async () => {
    try {
      const retry = await syncStockToAllChannels({ tenantId, product, reason: `${reason}-retry` });
      const stillFailed = retry.results.filter((r) => r.status === 'error');
      if (stillFailed.length > 0) {
        // Log persistent failure to Firestore for monitoring
        await firestore.collection('stock_sync_failures').add({
          tenantId,
          productId: String(product?.id || ''),
          reason,
          failedChannels: stillFailed.map((r) => r.channel),
          errors: stillFailed.map((r) => r.error),
          createdAt: new Date().toISOString(),
        }).catch(() => {});
        console.warn(`[stock-sync] Retry still failed for product=${product?.id}: ${stillFailed.map((r) => `${r.channel}:${r.error}`).join(', ')}`);
      } else {
        console.log(`[stock-sync] Retry succeeded for product=${product?.id}`);
      }
    } catch (err) {
      console.error(`[stock-sync] Retry error for product=${product?.id}: ${err.message}`);
    }
  }, 30000);

  return first;
}

/**
 * Sync stock to all channels for all products in an order.
 * Reads product docs from order items' SKUs, then pushes stock to marketplaces.
 */
async function syncStockForOrderItems({ tenantId = 'default', orderId, reason = 'order' }) {
  try {
    // Read order to get items — supports both doc ID (e.g. 'kaufland__M4U7TQ5')
    // and sequential orderId (e.g. 'AVY-2026-0827').
    let orderDoc = await firestore.collection('orders').doc(orderId).get();
    if (!orderDoc.exists) {
      // Fallback: query by orderId field (OMS routes pass sequential IDs)
      const fallback = await firestore.collection('orders')
        .where('orderId', '==', orderId)
        .limit(1)
        .get();
      if (!fallback.empty) {
        orderDoc = fallback.docs[0];
        console.log(`[stock-sync] order found via orderId field fallback: ${orderId} → doc ${orderDoc.id}`);
      } else {
        console.warn(`[stock-sync] order not found by doc ID or orderId field: ${orderId}`);
        return;
      }
    }
    const order = { id: orderDoc.id, ...orderDoc.data() };
    const items = order.items || [];
    if (items.length === 0) return;

    // Collect unique SKUs from order items
    const skus = [...new Set(items.map((i) => String(i.sku || '').trim()).filter(Boolean))];
    if (skus.length === 0) return;

    // Query products by SKU (in chunks of 10) — search both SKU fields
    // Await each sync to ensure marketplace quantities are updated before returning.
    // Fire-and-forget caused race conditions where subsequent syncs read stale data.
    for (let i = 0; i < skus.length; i += 10) {
      const chunk = skus.slice(i, i + 10);
      const products = await findProductsBySkuChunk(chunk);
      for (const product of products) {
        try {
          await syncStockWithRetry({ tenantId, product, reason: `${reason}-${orderId}` });
        } catch (err) {
          console.warn(`[stock-sync] order item sync failed for ${product.id}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.warn(`[stock-sync] syncStockForOrderItems failed for ${orderId}: ${err.message}`);
  }
}

module.exports = {
  syncStockToAllChannels,
  syncStockWithRetry,
  syncStockForOrderItems,
  syncPriceToAllChannels,
  findProductsBySkuChunk,
  computeAvailableQuantity,
};
