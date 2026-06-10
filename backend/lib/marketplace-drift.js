'use strict';

/**
 * Real marketplace stock-drift read-back.
 *
 * WHY THIS EXISTS: the reconciliation (services/stock-reconciliation.js) only
 * compares our available quantity against the value WE last pushed
 * (stock_sync_log). It never reads the quantity the marketplace ACTUALLY holds.
 * So a silently-clamped/rejected push, a never-drained failed sync, or a manual
 * marketplace edit stays invisible — the exact blind spot that lets oversell
 * happen unseen. This module reads the REAL eBay/Kaufland quantity and reports
 * the delta against products_v2.inventory.availableQuantity.
 *
 * RATE-LIMIT SAFETY: each check costs ONE marketplace API call. eBay already
 * throws "exceeded usage limit" under load, so this is intentionally NOT wired
 * to an automatic cron. It is invoked on demand (operator script) over a small
 * bounded batch, so the operator controls the API spend.
 *
 * The marketplace reads are injectable (opts.readers) so the core drift + alert
 * logic is unit-testable without hitting any live API.
 */

const { sendOpsAlert } = require('./ops-alert');

/** Our authoritative available quantity for a product. */
function getOurAvailable(product) {
  const inv = (product && product.inventory) || {};
  if (typeof inv.availableQuantity === 'number') return inv.availableQuantity;
  const qty = Number(inv.quantity) || 0;
  const reserved = Number(inv.reservedQuantity) || 0;
  return Math.max(0, qty - reserved);
}

/** Live eBay itemId (top-level is the active one; cleared→null when ended). */
function ebayItemId(product) {
  return (product && product.ebay && product.ebay.itemId) ||
    (product && product.marketplace && product.marketplace.ebay && product.marketplace.ebay.itemId) ||
    null;
}

function kauflandUnitId(product) {
  return (product && product.kaufland && product.kaufland.unitId) ||
    (product && product.marketplace && product.marketplace.kaufland && product.marketplace.kaufland.unitId) ||
    null;
}

async function defaultEbayRead(product) {
  const itemId = ebayItemId(product);
  if (!itemId) return null;
  const { getItemDetails } = require('./ebay-trading-api');
  const res = await getItemDetails(itemId);
  const marketplace = Number(res && res.item && res.item.quantityAvailable);
  if (!Number.isFinite(marketplace)) return null;
  return { channel: 'ebay', ref: itemId, marketplace };
}

async function defaultKauflandRead(product) {
  const idOffer = kauflandUnitId(product);
  const ean = (product && product.details && product.details.identifiers && product.details.identifiers.ean) ||
    (product && product.identification && product.identification.barcodes && product.identification.barcodes[0]) || null;
  if (!idOffer && !ean) return null;
  const { findUnit } = require('./kaufland-api');
  const unit = await findUnit({ idOffer, ean });
  if (!unit) return null;
  const marketplace = Number(unit.amount);
  if (!Number.isFinite(marketplace)) return null;
  return { channel: 'kaufland', ref: unit.id_unit || idOffer, marketplace };
}

/**
 * Check one product across channels. Records drift rows to `marketplace_drift`
 * and alerts ONLY when the marketplace holds MORE than we do (oversell
 * direction). Best-effort per channel: one channel's API error (incl. rate
 * limit) is recorded as {error} and never sinks the other channel.
 *
 * @param {object} product
 * @param {object} [opts]
 * @param {string} [opts.tenantId='default']
 * @param {boolean} [opts.record=true] - write drift rows + alerts (false = dry inspect)
 * @param {Array<Function>} [opts.readers] - injectable marketplace readers (for tests)
 * @returns {Promise<{ours:number, channels:Array}>}
 */
async function checkProductDrift(product, opts = {}) {
  const tenantId = opts.tenantId || 'default';
  const record = opts.record !== false;
  const readers = opts.readers || [defaultEbayRead, defaultKauflandRead];
  const ours = getOurAvailable(product);

  const channels = [];
  for (const reader of readers) {
    try {
      const r = await reader(product);
      if (!r) continue;
      channels.push({ ...r, ours, delta: r.marketplace - ours, drift: r.marketplace !== ours });
    } catch (e) {
      channels.push({ channel: reader.channelName || 'unknown', error: e && e.message ? e.message : String(e) });
    }
  }

  const drifts = channels.filter((c) => c.drift);
  if (record && drifts.length) {
    try {
      const { firestore } = require('./firestore');
      await firestore.collection('marketplace_drift').add({
        tenantId,
        productId: (product && product.id) || null,
        sku: (product && product.identification && product.identification.sku) ||
          (product && product.details && product.details.identifiers && product.details.identifiers.sku) || null,
        ours,
        channels: drifts,
        createdAt: new Date().toISOString(),
      });
    } catch (_) { /* audit write is best-effort */ }

    // Oversell direction = marketplace shows MORE than we actually have.
    const oversell = drifts.filter((d) => Number(d.marketplace) > ours);
    if (oversell.length) {
      sendOpsAlert({
        source: 'marketplace-drift',
        severity: 'critical',
        tenantId,
        message: `Marketplace stock HIGHER than ours (oversell risk) for ` +
          `${(product && product.identification && product.identification.sku) || (product && product.id)}: ` +
          oversell.map((d) => `${d.channel} market=${d.marketplace} ours=${ours}`).join(', '),
        context: { productId: (product && product.id) || null, oversell },
      }).catch(() => {});
    }
  }

  return { ours, channels };
}

module.exports = {
  getOurAvailable,
  ebayItemId,
  kauflandUnitId,
  defaultEbayRead,
  defaultKauflandRead,
  checkProductDrift,
};
