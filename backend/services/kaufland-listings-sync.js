'use strict';

/**
 * Kaufland-Listings-Sync — pulls latest Kaufland units and caches them in
 * Firestore (`kauflandUnitsLive`) for fast Inventory-UI listed/not-listed
 * indicators. Also backfills `ops.kaufland.unitId` into `products_v2` so the
 * stock-sync-dispatcher can push to Kaufland without an extra lookup, and
 * detects drift (marketplace > warehouse) to queue outbound stock syncs
 * against the local source of truth.
 *
 * Extracted (Plan-D.0d) from the inline `POST /api/marketplace/kaufland/listings/sync`
 * route-handler so the same logic can be triggered by the safety-net cron in
 * `backend/index.js`. Route handler now delegates here verbatim, response shape
 * stays exactly identical.
 *
 * Multi-Tenant: tenantId is required and used for tenant-scoped product reads
 * (getAllProductsV2ForTenant) when supplied. The legacy global read path
 * (getAllProductsV2) is preserved when no tenantId is given — that matches the
 * pre-extraction behaviour for un-decorated requests.
 *
 * IMPORTANT: never pull `inventory.quantity` from marketplace into warehouse.
 * If Kaufland reports stock > 0 while warehouse is 0, we queue an outbound
 * stock sync to push local truth (and stop oversell).
 *
 * Returns `{ storefront, fetched, active, driftsDetected, reconciled,
 * reverseDriftsDetected, reverseDriftSamples }` — same shape as the
 * pre-extraction route response payload.
 */

/**
 * @param {object} opts
 * @param {string} [opts.tenantId]   tenant for product reads (optional; legacy global read when absent)
 * @param {string} [opts.storefront='de']
 * @returns {Promise<{storefront:string, fetched:number, active:number, driftsDetected:number, reconciled:number, reverseDriftsDetected:number, reverseDriftSamples:Array<object>}>}
 */
async function syncKauflandListingsCache({ tenantId, storefront = 'de' } = {}) {
  const sf = String(storefront || 'de').trim().toLowerCase();
  const { listUnits } = require('../lib/kaufland-api');
  const { Timestamp } = require('@google-cloud/firestore');
  const { firestore } = require('../lib/firestore');
  const { getAllProductsV2, getAllProductsV2ForTenant } = require('../lib/product-store');
  const { syncStockWithRetry } = require('./stock-sync-dispatcher');

  const units = await listUnits({ storefront: sf, limit: 100, maxPages: 300 });
  const now = Timestamp.now();
  const collection = firestore.collection('kauflandUnitsLive');
  const seenIds = new Set();

  let batch = firestore.batch();
  let batchCount = 0;
  const commitBatch = async () => {
    if (!batchCount) return;
    await batch.commit();
    batch = firestore.batch();
    batchCount = 0;
  };

  for (const unit of units) {
    const idUnit = Number(unit?.id_unit || 0);
    if (!Number.isFinite(idUnit) || idUnit <= 0) continue;
    const docId = String(idUnit);
    seenIds.add(docId);

    const product = unit?.product && typeof unit.product === 'object' ? unit.product : {};
    const productEans = Array.isArray(product?.eans) ? product.eans : [];
    const normalizedEans = Array.from(
      new Set(
        productEans
          .map((v) => normalizeMarketplaceEan(v))
          .filter(Boolean)
      )
    );

    const idProduct = Number(unit?.id_product || product?.id_product || 0);
    const normalizedIdProduct = Number.isFinite(idProduct) && idProduct > 0 ? idProduct : null;
    const productUrl = String(product?.url || '').trim();
    const viewItemUrl = productUrl || (normalizedIdProduct ? `https://www.kaufland.de/product/${normalizedIdProduct}/` : null);

    // Extract title and price from Kaufland API response
    const klTitle = typeof product?.title === 'string' && product.title.trim() ? product.title.trim() : null;
    const rawPrice = unit?.listing_price ?? unit?.price ?? null;
    const klListingPrice = Number.isFinite(Number(rawPrice)) ? Number(rawPrice) : null;

    const payload = {
      id_unit: idUnit,
      id_offer: String(unit?.id_offer || '').trim() || null,
      id_offer_normalized: normalizeMarketplaceSku(unit?.id_offer),
      ean: normalizeMarketplaceEan(unit?.ean),
      eans: normalizedEans,
      id_product: normalizedIdProduct,
      view_item_url: viewItemUrl,
      amount: Number.isFinite(Number(unit?.amount)) ? Number(unit.amount) : null,
      status: String(unit?.status || '').trim() || null,
      storefront: String(unit?.storefront || sf || 'de').trim().toLowerCase(),
      active: String(unit?.status || '').trim().toUpperCase() === 'AVAILABLE',
      title: klTitle,
      listing_price: klListingPrice,
      updatedAt: now,
      source: 'kaufland-sync',
    };

    batch.set(collection.doc(docId), payload, { merge: true });
    batchCount += 1;
    if (batchCount >= 400) await commitBatch();
  }
  await commitBatch();

  // Mark stale cached rows inactive (units no longer returned by API).
  const existingSnap = await collection.where('storefront', '==', sf).where('active', '==', true).get();
  if (!existingSnap.empty) {
    batch = firestore.batch();
    batchCount = 0;
    existingSnap.docs.forEach((doc) => {
      if (seenIds.has(doc.id)) return;
      batch.set(
        collection.doc(doc.id),
        { active: false, updatedAt: now, source: 'kaufland-sync' },
        { merge: true }
      );
      batchCount += 1;
    });
    await commitBatch();
  }

  // ── Backfill ops.kaufland.unitId into products_v2 ────────────────────────
  // For every active unit, find the matching product_v2 doc (by SKU/EAN) and
  // write ops.kaufland.unitId so the stock-sync-dispatcher can push to
  // Kaufland without a separate lookup. Fire-and-forget, non-critical.
  try {
    // D.0c-style tenant fallback: prefer Firestore-side filter when a
    // tenantId is provided, else fall back to legacy global read.
    const allProds = tenantId
      ? await getAllProductsV2ForTenant(tenantId)
      : await getAllProductsV2();
    const skuToProduct = new Map();
    const eanToProduct = new Map();
    for (const p of allProds) {
      const sku = (p?.identification?.sku || p?.details?.identifiers?.sku || '').trim();
      if (sku) skuToProduct.set(sku.toLowerCase(), p);
      const ean = (p?.identification?.ean || p?.details?.identifiers?.ean || '').trim();
      if (ean) eanToProduct.set(ean, p);
    }

    let opsBatch = firestore.batch();
    let opsBatchCount = 0;
    for (const unit of units) {
      const idUnit = Number(unit?.id_unit || 0);
      if (!Number.isFinite(idUnit) || idUnit <= 0) continue;
      const unitSku = String(unit?.id_offer || '').trim();
      const unitEan = String(unit?.ean || '').trim();
      const prod = (unitSku && skuToProduct.get(unitSku.toLowerCase()))
        || (unitEan && eanToProduct.get(unitEan)) || null;
      if (!prod) continue;
      const existing = prod?.ops?.kaufland?.unitId;
      if (String(existing || '') === String(idUnit)) continue; // already correct
      opsBatch.update(firestore.collection('products_v2').doc(prod.id), {
        'ops.kaufland.unitId': String(idUnit),
      });
      opsBatchCount++;
      if (opsBatchCount >= 400) {
        await opsBatch.commit();
        opsBatch = firestore.batch();
        opsBatchCount = 0;
      }
    }
    if (opsBatchCount > 0) await opsBatch.commit();
    if (opsBatchCount > 0) console.log(`[kaufland-sync] Backfilled ops.kaufland.unitId for ${opsBatchCount} products`);
  } catch (opsErr) {
    console.error('[kaufland-sync] ops backfill error (non-fatal):', opsErr.message);
  }

  // ── Drift detection (marketplace > warehouse) ────────────────────────────
  // IMPORTANT: never pull `inventory.quantity` from marketplace into warehouse.
  // If Kaufland reports stock > 0 while warehouse is 0, we queue an outbound
  // stock sync to push local truth (and stop oversell).
  let reconciledCount = 0;
  let driftDetectedCount = 0;
  // Reverse drift (report-only): kaufland==0 or ONHOLD while warehouse>0.
  // We deliberately do NOT auto-reactivate — Kaufland may have deactivated
  // the listing for compliance / quality-gate / missing-data reasons.
  let reverseDriftsDetected = 0;
  const reverseDriftSamples = [];
  const MAX_REVERSE_SAMPLES = 10;
  try {
    const products = tenantId
      ? await getAllProductsV2ForTenant(tenantId)
      : await getAllProductsV2();
    const skuMap = new Map();
    const eanMap = new Map();
    const driftProducts = new Map();
    for (const p of products) {
      const sku = (p?.identification?.sku || '').trim().toLowerCase();
      if (sku) skuMap.set(sku, p);
      const ean = (p?.identification?.ean || '').trim();
      if (ean) eanMap.set(ean, p);
    }

    for (const unit of units) {
      const klAmount = Number(unit?.amount || 0);
      const klStatus = String(unit?.status || '').trim().toUpperCase();
      const idOffer = String(unit?.id_offer || '').trim().toLowerCase();
      const ean = String(unit?.ean || '').trim();
      const matched = (idOffer && skuMap.get(idOffer)) || (ean && eanMap.get(ean)) || null;
      if (!matched) continue;

      const whQty = typeof matched.inventory?.quantity === 'number' ? matched.inventory.quantity : null;

      // ── Forward drift: kaufland>0 while warehouse=0 (queue outbound sync) ──
      if (klAmount > 0 && whQty === 0) {
        driftDetectedCount++;
        if (matched?.id) {
          driftProducts.set(String(matched.id), matched);
        }
        console.warn(`[kaufland-sync] Stock drift detected sku=${matched?.identification?.sku || idOffer || 'unknown'} warehouse=0 kaufland=${klAmount} -> queue outbound sync`);
        continue;
      }

      // ── Reverse drift: warehouse>0 while kaufland=0 OR ONHOLD ──
      // Report-only — Kaufland may have deactivated for legitimate reasons
      // (compliance, quality-gate, missing data). We only surface to operator.
      if (whQty != null && whQty > 0 && (klAmount <= 0 || klStatus === 'ONHOLD')) {
        reverseDriftsDetected++;
        const sample = {
          sku: matched?.identification?.sku || idOffer || null,
          ean: matched?.identification?.ean || ean || null,
          productId: matched?.id || null,
          warehouseQty: whQty,
          kauflandAmount: klAmount,
          kauflandStatus: klStatus || null,
          idUnit: Number(unit?.id_unit || 0) || null,
        };
        if (reverseDriftSamples.length < MAX_REVERSE_SAMPLES) {
          reverseDriftSamples.push(sample);
        }
        console.warn(`[kaufland-sync] Reverse drift detected sku=${sample.sku || 'unknown'} warehouse=${whQty} kaufland=${klAmount} status=${klStatus || 'n/a'} -> REPORT-ONLY (no auto-reactivate)`);
      }
    }

    for (const product of driftProducts.values()) {
      try {
        await syncStockWithRetry({
          tenantId: product?.tenantId || tenantId || 'default',
          product,
          reason: 'kaufland-drift-detected',
        });
        reconciledCount++;
      } catch (syncErr) {
        console.warn(`[kaufland-sync] drift sync failed product=${product?.id || 'unknown'}: ${syncErr.message}`);
      }
    }
  } catch (reconErr) {
    console.error('[kaufland-sync] Reconciliation error (non-fatal):', reconErr.message);
  }

  return {
    storefront: sf,
    fetched: units.length,
    active: seenIds.size,
    driftsDetected: driftDetectedCount,
    reconciled: reconciledCount,
    reverseDriftsDetected,
    reverseDriftSamples,
  };
}

// ─── Marketplace identifier normalisers ──────────────────────────────────
// Kept module-local + identical to the originals in routes/marketplace.js so
// the extracted service has zero external coupling on those helpers.

function normalizeMarketplaceSku(value) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function normalizeMarketplaceEan(value) {
  return String(value || '').replace(/\D+/g, '').trim();
}

module.exports = { syncKauflandListingsCache };
