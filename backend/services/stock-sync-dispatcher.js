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
const STOCK_SYNC_FAILURES_COLLECTION = 'stock_sync_failures';
const STOCK_OPERATION_FAILURES_COLLECTION = 'stock_operation_failures';

function extractProductSku(product) {
  return String(
    product?.identification?.sku
    || product?.details?.identifiers?.sku
    || ''
  ).trim();
}

/**
 * Pick the eBay live-listing row that is still ACTIVE. NEVER falls back to an
 * ended/inactive row — doing so made stock-sync resolve a dead itemId and
 * re-push to it on every cycle (production logs: 600+ wasted "already ended"
 * eBay Trading-API calls/day, from just 14 dead listings, one hit 234×/day).
 * Returns null when there is no active listing (→ no eBay call is made).
 */
function pickActiveListing(docs) {
  return (Array.isArray(docs) ? docs : []).find((row) => row && row.active !== false) || null;
}

/**
 * Whether an eBay error message is a transient daily-call-limit error. Such
 * errors must NOT trigger the fail-safe-end (it would kill a healthy listing and
 * the end call is itself rate-limited) — defer and let the drain retry instead.
 */
function isRateLimited(msg) {
  const lower = String(msg || '').toLowerCase();
  return lower.includes('exceeded usage limit') || lower.includes('check your call usage');
}

async function persistSyncFailureForDrain({
  tenantId,
  product,
  reason,
  failedChannels = [],
}) {
  const productId = String(product?.id || '');
  const sku = extractProductSku(product);
  const createdAt = new Date().toISOString();
  const channels = failedChannels.map((r) => String(r?.channel || 'unknown'));
  const errors = failedChannels.map((r) => String(r?.error || `status:${r?.status || 'unknown'}`));

  await firestore.collection(STOCK_SYNC_FAILURES_COLLECTION).add({
    tenantId,
    productId,
    reason,
    failedChannels: channels,
    errors,
    createdAt,
  }).catch(() => {});

  await firestore.collection(STOCK_OPERATION_FAILURES_COLLECTION).add({
    tenantId,
    operation: 'stock-sync',
    status: 'pending',
    reason,
    productId,
    source: 'stock-sync-dispatcher',
    failures: failedChannels.map((r) => ({
      step: 'marketplaceSync',
      sku: sku || null,
      productId,
      channel: r?.channel || null,
      error: r?.error || `status:${r?.status || 'unknown'}`,
    })),
    createdAt,
  }).catch(() => {});
}

async function resolveEbayItemIdFromLiveListing({ productId, freshProduct }) {
  const sku = extractProductSku(freshProduct);
  if (!sku) return null;
  try {
    const listingsSnap = await firestore.collection('ebayListingsLive')
      .where('sku', '==', sku)
      .limit(5)
      .get();
    if (listingsSnap.empty) return null;
    const docs = listingsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const activeListing = pickActiveListing(docs);
    if (!activeListing) return null; // no ACTIVE listing → don't revive a dead itemId
    const itemId = String(activeListing?.itemId || activeListing?.id || '').trim();
    if (!itemId) return null;
    await firestore.collection('products_v2').doc(productId)
      .set({ ops: { ebay: { itemId, itemIdSource: 'ebayListingsLive', itemIdResolvedAt: new Date().toISOString() } } }, { merge: true })
      .catch(() => {});
    console.log(`[stock-sync] ebay itemId resolved via listing lookup: ${itemId} (sku=${sku})`);
    return itemId;
  } catch (err) {
    console.warn(`[stock-sync] ebay itemId lookup failed for product=${productId}: ${err.message}`);
    return null;
  }
}

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
    const reservations = [];
    if (sku) {
      reservations.push(await getReservedQuantity({ tenantId, sku }));
    }
    if (productId) {
      reservations.push(await getReservedQuantity({ tenantId, productId }));
    }
    reservedQty = reservations.length > 0 ? Math.max(...reservations) : 0;
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
  let resolvedEbayItemId = ebayItemId;
  if (!resolvedEbayItemId) {
    resolvedEbayItemId = await resolveEbayItemIdFromLiveListing({ productId, freshProduct });
  }

  if (resolvedEbayItemId) {
    const isEndedListing = (msg) => {
      const lower = String(msg || '').toLowerCase();
      return lower.includes('beendet') || lower.includes('ended') || lower.includes('1047');
    };

    const clearStaleItemId = async () => {
      try {
        await firestore.collection('products_v2').doc(productId).set(
          {
            ops: { ebay: { itemId: null, itemIdCleared: new Date().toISOString(), itemIdClearReason: 'listing_ended' } },
            listingStatus: { ebay: 'inactive' },
          },
          { merge: true }
        );
        // Mark the cached live listing inactive too, so resolveEbayItemIdFromLiveListing
        // stops handing the stale itemId straight back next cycle (the loop behind
        // 600+ wasted "already ended" eBay calls/day). A re-list re-activates it via
        // the listing ingest.
        try {
          const sku = extractProductSku(freshProduct);
          if (sku) {
            const snap = await firestore.collection('ebayListingsLive').where('sku', '==', sku).limit(5).get();
            await Promise.all(snap.docs.map((d) =>
              d.ref.set({ active: false, endedDetectedAt: new Date().toISOString() }, { merge: true }).catch(() => {})
            ));
          }
        } catch (_) { /* best-effort cache cleanup */ }
        console.log(`[stock-sync] Cleared stale ebay itemId + marked listing inactive for product=${productId} (listing ended)`);
      } catch (clearErr) {
        console.warn(`[stock-sync] Failed to clear stale ebay itemId: ${clearErr?.message}`);
      }
    };

    if (isZeroStock) {
      // Zero stock: end listing instead of revise(qty=0) which eBay rejects
      try {
        const { endFixedPriceItem } = require('../lib/ebay-trading-api');
        await endFixedPriceItem(String(resolvedEbayItemId), { reason: 'NotAvailable' });
        results.push({ channel: 'ebay', status: 'success', itemId: resolvedEbayItemId, quantityPushed: 0, zeroStock: true, action: 'ended' });
        console.log(`[stock-sync] ebay END product=${productId} itemId=${resolvedEbayItemId} → ended (zero stock)`);
      } catch (err) {
        const errMsg = err?.message || String(err);
        if (isEndedListing(errMsg)) {
          // Listing was already ended — treat as success, clear stale itemId
          results.push({ channel: 'ebay', status: 'success', itemId: resolvedEbayItemId, quantityPushed: 0, zeroStock: true, action: 'already_ended' });
          console.log(`[stock-sync] ebay product=${productId} itemId=${resolvedEbayItemId} already ended, clearing stale itemId`);
          await clearStaleItemId();
        } else {
          results.push({ channel: 'ebay', status: 'error', error: errMsg });
          console.warn(`[stock-sync] ebay END FAILED product=${productId} itemId=${resolvedEbayItemId}:`, errMsg);
          if (isEndedListing(errMsg)) await clearStaleItemId();
        }
      }
    } else {
      // Stock > 0: revise quantity. If this fails, fail-safe end the listing
      // to prevent oversell on stale higher marketplace quantity.
      try {
        const { reviseFixedPriceItem } = require('../lib/ebay-trading-api');
        const result = await reviseFixedPriceItem({
          itemId: String(resolvedEbayItemId),
          quantity: availableQuantity,
        });
        const status = result?.ack === 'Success' || result?.ack === 'Warning' ? 'success' : 'failed';
        results.push({ channel: 'ebay', status, itemId: resolvedEbayItemId, quantityPushed: availableQuantity, zeroStock: false });
        console.log(`[stock-sync] ebay product=${productId} itemId=${resolvedEbayItemId} qty=${availableQuantity} status=${status}`);
      } catch (err) {
        const errMsg = err?.message || String(err);
        if (isEndedListing(errMsg)) {
          // Listing was ended — can't revise, clear stale itemId and skip
          results.push({ channel: 'ebay', status: 'skipped', itemId: resolvedEbayItemId, error: 'listing_ended', quantityPushed: 0 });
          console.warn(`[stock-sync] ebay product=${productId} itemId=${resolvedEbayItemId} listing ended, clearing stale itemId`);
          await clearStaleItemId();
        } else if (isRateLimited(errMsg)) {
          // Transient eBay rate limit — the listing is NOT dead. Ending it would
          // be WRONG (lose a live sale) and the end call would itself be rate-
          // limited ("fail_safe_end_failed"). Defer: record a retryable failure;
          // the drain retries once quota resets. Avoids a doomed 2nd call AND
          // avoids killing healthy listings on a transient error.
          results.push({ channel: 'ebay', status: 'failed', itemId: resolvedEbayItemId, error: errMsg, retryable: true });
          console.warn(`[stock-sync] ebay RATE-LIMITED product=${productId} itemId=${resolvedEbayItemId} — deferring (no fail-safe end): ${errMsg}`);
        } else {
          // A revise failure at stock > 0 means the eBay listing is UNCHANGED —
          // it does NOT prove the stock is gone. Ending it here was a silent,
          // destructive over-reaction: Incident 2026-06-16 killed 66 healthy
          // listings in 30d this way (Best-Offer pricing-config errors,
          // transient "operation aborted", image errors) — 0 were genuine
          // stock-outs. The fake-`success` end also bypassed the drain, so no
          // repair was ever queued. Per the oversell architecture
          // (decisions.md), a failed sync belongs in the durable drain, NOT a
          // marketplace mutation: record a retryable failure so
          // syncStockWithRetry → stock_operation_failures → stock-failure-drain
          // retries, and stock-reconciliation independently reconciles. The true
          // zero-stock end is handled above in the isZeroStock branch.
          results.push({
            channel: 'ebay',
            status: 'failed',
            itemId: resolvedEbayItemId,
            error: errMsg,
            retryable: true,
            action: 'revise_failed_deferred',
          });
          console.warn(
            `[stock-sync] ebay REVISE FAILED product=${productId} itemId=${resolvedEbayItemId} — deferring to drain (NOT ending healthy listing): ${errMsg}`
          );
        }
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
      // If update fails, fail-safe set ONHOLD to avoid oversell.
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
        try {
          const { setUnitStatus } = require('../lib/kaufland-api');
          await setUnitStatus(kauflandUnitId, 'ONHOLD', { storefront: 'de' });
          results.push({
            channel: 'kaufland',
            status: 'success',
            unitId: kauflandUnitId,
            quantityPushed: 0,
            action: 'fail_safe_onhold',
            note: 'quantity_update_failed_unit_onhold',
          });
          console.warn(
            `[stock-sync] kaufland FAIL-SAFE ONHOLD product=${productId} unitId=${kauflandUnitId} after update failure: ${errMsg}`
          );
        } catch (fallbackErr) {
          const fallbackMsg = fallbackErr?.message || String(fallbackErr);
          results.push({ channel: 'kaufland', status: 'error', error: `${errMsg}; fail_safe_onhold_failed: ${fallbackMsg}` });
          console.warn(
            `[stock-sync] kaufland FAILED product=${productId} unitId=${kauflandUnitId}; fail-safe ONHOLD failed:`,
            fallbackMsg
          );
          // If unit no longer exists on Kaufland, clear the stale unitId to stop endless retries
          if (errMsg.includes('Not Found') || errMsg.includes('404') || errMsg.includes('not_found')
            || fallbackMsg.includes('Not Found') || fallbackMsg.includes('404') || fallbackMsg.includes('not_found')) {
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
async function syncStockWithRetry({
  tenantId = 'default',
  product,
  reason = 'manual',
  skipPersistentFailureQueue = false,
}) {
  const first = await syncStockToAllChannels({ tenantId, product, reason });
  const isFailedStatus = (s) => s === 'error' || s === 'failed';
  const failedChannels = first.results.filter((r) => isFailedStatus(r?.status));
  if (failedChannels.length === 0) return first;

  // If EVERY failure is a marketplace rate-limit (quota), an immediate 30s retry
  // is futile — it burns another quota-blocked call and piles Firestore
  // stock-lock contention (the 2026-06-12 sync-storm root cause). Hand straight
  // to the durable drain instead of hammering in-process.
  const isDrainRetry = String(reason || '').startsWith('drain:');
  const allRateLimited = failedChannels.length > 0 && failedChannels.every((r) => isRateLimited(r?.error));
  if (allRateLimited) {
    console.warn(`[stock-sync] ${failedChannels.length} channel(s) rate-limited for product=${product?.id}; deferring to drain (no immediate retry)`);
    if (!skipPersistentFailureQueue && !isDrainRetry) {
      await persistSyncFailureForDrain({ tenantId, product, reason, failedChannels }).catch(() => {});
    }
    return first;
  }

  // Schedule retry after 30s for failed channels
  console.log(`[stock-sync] ${failedChannels.length} channel(s) failed, scheduling retry in 30s`);
  setTimeout(async () => {
    try {
      const retry = await syncStockToAllChannels({ tenantId, product, reason: `${reason}-retry` });
      const stillFailed = retry.results.filter((r) => isFailedStatus(r?.status));
      if (stillFailed.length > 0) {
        if (!skipPersistentFailureQueue && !isDrainRetry) {
          // Persist persistent failures for both monitoring and durable drain retries.
          await persistSyncFailureForDrain({ tenantId, product, reason, failedChannels: stillFailed });
        }
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

    // Query products by SKU (in chunks of 10) — search both SKU fields
    for (let i = 0; i < skus.length; i += 10) {
      const chunk = skus.slice(i, i + 10);
      const products = await findProductsBySkuChunk(chunk);
      for (const product of products) {
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
  findProductsBySkuChunk,
  computeAvailableQuantity,
  pickActiveListing,
  isRateLimited,
};
