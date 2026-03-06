/**
 * Stock Sync Dispatcher
 *
 * After a stock-out (or stock-in), pushes updated quantity to ALL connected
 * marketplace channels: BaseLinker (existing), eBay, Kaufland.
 *
 * Usage:
 *   const { syncStockToAllChannels } = require('./stock-sync-dispatcher');
 *   await syncStockToAllChannels({ tenantId, product });
 */

const { firestore } = require('../lib/firestore');

const SYNC_LOG_COLLECTION = 'stock_sync_log';

/**
 * Sync stock quantity to all connected marketplace channels for a product.
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
  const quantity = product?.inventory?.quantity ?? 0;
  const availableQuantity = product?.inventory?.availableQuantity ?? quantity;
  const results = [];

  // --- eBay ---
  const ebayItemId = product?.ops?.ebay?.itemId
    || product?.ops?.ebay?.item_id
    || product?.marketplace?.ebay?.itemId;

  if (ebayItemId) {
    try {
      const { reviseFixedPriceItem } = require('../lib/ebay-trading-api');
      const result = await reviseFixedPriceItem({
        itemId: String(ebayItemId),
        quantity: Math.max(0, availableQuantity),
      });
      const status = result?.ack === 'Success' || result?.ack === 'Warning' ? 'success' : 'failed';
      results.push({ channel: 'ebay', status, itemId: ebayItemId, quantityPushed: availableQuantity });
      console.log(
        `[stock-sync] ebay product=${productId} itemId=${ebayItemId} qty=${availableQuantity} status=${status}`
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
  const kauflandUnitId = product?.ops?.kaufland?.unitId
    || product?.ops?.kaufland?.id_unit
    || product?.marketplace?.kaufland?.unitId;

  if (kauflandUnitId) {
    try {
      const { updateUnit } = require('../lib/kaufland-api');
      // updateUnit reads quantity from product.inventory.availableQuantity or inventory.quantity
      // We ensure it's set correctly on the product object
      const productWithAvailable = {
        ...product,
        inventory: {
          ...(product.inventory || {}),
          availableQuantity,
        },
      };
      const result = await updateUnit(kauflandUnitId, productWithAvailable, { storefront: 'de' });
      results.push({
        channel: 'kaufland',
        status: result?.updated ? 'success' : 'failed',
        unitId: kauflandUnitId,
        quantityPushed: availableQuantity,
      });
      console.log(
        `[stock-sync] kaufland product=${productId} unitId=${kauflandUnitId} qty=${availableQuantity} status=success`
      );
    } catch (err) {
      results.push({ channel: 'kaufland', status: 'error', error: err?.message });
      console.warn(
        `[stock-sync] kaufland FAILED product=${productId} unitId=${kauflandUnitId}:`,
        err?.message || err
      );
    }
  }

  // --- BaseLinker (handled by existing backgroundSyncProductStockToBaseLinker in index.js) ---
  // We don't call it here — it's already triggered in the warehouse route.
  // Just log that BL was skipped (handled separately).
  const blLinked = Boolean(product?.ops?.base_product_id || product?.ops?.baselinker?.product_id);
  if (blLinked) {
    results.push({ channel: 'baselinker', status: 'handled_separately' });
  }

  // Log sync attempt to Firestore for audit trail
  try {
    await firestore.collection(SYNC_LOG_COLLECTION).add({
      tenantId,
      productId,
      reason,
      quantity,
      availableQuantity,
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
  const ebayPrice = prices.ebay ?? product?.pricing?.ebay?.price ?? product?.pricing?.sellPrice;

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
  const kauflandPrice = prices.kaufland ?? product?.pricing?.kaufland?.price ?? product?.pricing?.sellPrice;

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

module.exports = {
  syncStockToAllChannels,
  syncPriceToAllChannels,
};
