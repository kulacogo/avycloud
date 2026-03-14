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
    if (sku) {
      reservedQty = await getReservedQuantity({ tenantId, sku });
    } else if (productId) {
      reservedQty = await getReservedQuantity({ tenantId, productId });
    }
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
      const { reviseFixedPriceItem } = require('../lib/ebay-trading-api');
      const result = await reviseFixedPriceItem({
        itemId: String(ebayItemId),
        quantity: Math.max(0, availableQuantity),
      });
      const status = result?.ack === 'Success' || result?.ack === 'Warning' ? 'success' : 'failed';
      results.push({ channel: 'ebay', status, itemId: ebayItemId, quantityPushed: availableQuantity, zeroStock: isZeroStock });
      console.log(
        `[stock-sync] ebay product=${productId} itemId=${ebayItemId} qty=${availableQuantity} status=${status}${isZeroStock ? ' (DELIST)' : ''}`
      );
    } catch (err) {
      results.push({ channel: 'ebay', status: 'error', error: err?.message });
      console.warn(
        `[stock-sync] ebay FAILED product=${productId} itemId=${ebayItemId}:`,
        err?.message || err
      );
    }
  }

  // --- Kaufland ---
  const kauflandUnitId = freshProduct?.ops?.kaufland?.unitId
    || freshProduct?.ops?.kaufland?.id_unit
    || freshProduct?.marketplace?.kaufland?.unitId;

  if (kauflandUnitId) {
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
        zeroStock: isZeroStock,
      });
      console.log(
        `[stock-sync] kaufland product=${productId} unitId=${kauflandUnitId} qty=${availableQuantity} status=success${isZeroStock ? ' (DELIST)' : ''}`
      );
    } catch (err) {
      results.push({ channel: 'kaufland', status: 'error', error: err?.message });
      console.warn(
        `[stock-sync] kaufland FAILED product=${productId} unitId=${kauflandUnitId}:`,
        err?.message || err
      );
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
    // Read order to get items
    const orderDoc = await firestore.collection('orders').doc(orderId).get();
    if (!orderDoc.exists) return;
    const order = { id: orderDoc.id, ...orderDoc.data() };
    const items = order.items || [];
    if (items.length === 0) return;

    // Collect unique SKUs from order items
    const skus = [...new Set(items.map((i) => String(i.sku || '').trim()).filter(Boolean))];
    if (skus.length === 0) return;

    // Query products by SKU (in chunks of 10)
    const { getProductV2 } = require('../lib/product-store');
    for (let i = 0; i < skus.length; i += 10) {
      const chunk = skus.slice(i, i + 10);
      const snap = await firestore.collection('products_v2')
        .where('details.identifiers.sku', 'in', chunk)
        .get();
      for (const doc of snap.docs) {
        const product = { id: doc.id, ...doc.data() };
        syncStockWithRetry({ tenantId, product, reason: `${reason}-${orderId}` })
          .catch((err) => console.warn(`[stock-sync] order item sync failed: ${err.message}`));
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
  computeAvailableQuantity,
};
