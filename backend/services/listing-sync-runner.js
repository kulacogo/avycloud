/**
 * Listing Sync Runner
 *
 * Periodischer Runner der eBay + Kaufland Listing-Status synchronisiert
 * und ops.listingStatus in Produkt-Dokumente schreibt.
 *
 * Feature-Flag: LISTING_SYNC_ENABLED=true (default: false)
 * Intervall: LISTING_SYNC_INTERVAL_MS (default: 20 Minuten)
 *
 * ops.listingStatus Schema:
 * { ebay: 'active'|'inactive'|'not_listed', kaufland: 'active'|'inactive'|'not_listed', lastSyncAt: ISO }
 */
const { firestore } = require('../lib/firestore');
const { syncLiveListingsLight } = require('../lib/ebay-direct');

const LISTING_SYNC_ENABLED = process.env.LISTING_SYNC_ENABLED === 'true';
const LISTING_SYNC_INTERVAL_MS = parseInt(
  process.env.LISTING_SYNC_INTERVAL_MS || String(20 * 60 * 1000),
  10
);
const LISTING_SYNC_INITIAL_DELAY_MS = parseInt(
  process.env.LISTING_SYNC_INITIAL_DELAY_MS || String(3 * 60 * 1000),
  10
);
const PRODUCTS_COLLECTION = process.env.PRODUCT_COLLECTION || 'products';

let runnerTimer = null;
let runInFlight = false;

// ─── eBay Status Propagation ─────────────────────────────────────────────────

async function propagateEbayStatusToProducts() {
  // 1. Read all eBay listing links (itemId → productId)
  const linksSnap = await firestore.collection('ebayListingLinks').get();
  if (linksSnap.empty) return { linked: 0, updated: 0 };

  const itemToProduct = new Map();
  for (const doc of linksSnap.docs) {
    const productId = doc.data()?.productId;
    if (productId) itemToProduct.set(doc.id, String(productId));
  }
  if (itemToProduct.size === 0) return { linked: 0, updated: 0 };

  // 2. Read listing statuses from ebayListingsLive
  const listingSnap = await firestore.collection('ebayListingsLive').get();
  const listingStatusByItemId = new Map();
  for (const doc of listingSnap.docs) {
    const data = doc.data();
    const status = (data?.listingStatus || '').toLowerCase();
    const active = Boolean(data?.active);
    listingStatusByItemId.set(doc.id, active && status === 'active' ? 'active' : 'inactive');
  }

  // 3. Group by productId — if any listing is active, product is active on eBay
  const productStatusMap = new Map();
  for (const [itemId, productId] of itemToProduct.entries()) {
    const status = listingStatusByItemId.get(itemId) || 'not_listed';
    if (status === 'active' || !productStatusMap.has(productId)) {
      productStatusMap.set(productId, status);
    }
  }

  // 4. Batch-update products
  const now = new Date().toISOString();
  let batch = firestore.batch();
  let batchCount = 0;
  let updated = 0;

  for (const [productId, status] of productStatusMap.entries()) {
    batch.set(
      firestore.collection(PRODUCTS_COLLECTION).doc(productId),
      { ops: { listingStatus: { ebay: status, lastSyncAt: now } } },
      { merge: true }
    );
    batchCount++;
    updated++;
    if (batchCount >= 400) {
      await batch.commit();
      batch = firestore.batch();
      batchCount = 0;
    }
  }
  if (batchCount > 0) await batch.commit();

  return { linked: itemToProduct.size, updated };
}

// ─── Kaufland Status Propagation ─────────────────────────────────────────────

async function propagateKauflandStatusToProducts() {
  // Read units from kauflandUnitsLive (synced by POST /kaufland/listings/sync)
  const unitsSnap = await firestore.collection('kauflandUnitsLive').get();
  if (unitsSnap.empty) return { units: 0, updated: 0 };

  // Build id_offer → status map (id_offer = product SKU)
  const offerStatusMap = new Map();
  for (const doc of unitsSnap.docs) {
    const data = doc.data();
    const idOffer = String(data?.id_offer || '').trim();
    if (!idOffer) continue;
    const status = String(data?.status || '').toUpperCase();
    // If product already has an 'active' entry, keep it
    if (!offerStatusMap.has(idOffer) || offerStatusMap.get(idOffer) !== 'active') {
      offerStatusMap.set(idOffer, status === 'AVAILABLE' ? 'active' : 'inactive');
    }
  }
  if (offerStatusMap.size === 0) return { units: 0, updated: 0 };

  // Query products by SKU in chunks of 10 (Firestore 'in' limit)
  const offerIds = Array.from(offerStatusMap.keys());
  const now = new Date().toISOString();
  let updated = 0;
  let batch = firestore.batch();
  let batchCount = 0;

  for (let i = 0; i < offerIds.length; i += 10) {
    const chunk = offerIds.slice(i, i + 10);
    try {
      const snap = await firestore.collection(PRODUCTS_COLLECTION)
        .where('identification.sku', 'in', chunk)
        .get();
      for (const doc of snap.docs) {
        const sku = String(doc.data()?.identification?.sku || '');
        const status = offerStatusMap.get(sku) || 'not_listed';
        batch.set(
          doc.ref,
          { ops: { listingStatus: { kaufland: status, lastSyncAt: now } } },
          { merge: true }
        );
        batchCount++;
        updated++;
        if (batchCount >= 400) {
          await batch.commit();
          batch = firestore.batch();
          batchCount = 0;
        }
      }
    } catch (err) {
      console.warn(`[ListingSyncRunner] Kaufland SKU query failed: ${err.message}`);
    }
  }
  if (batchCount > 0) await batch.commit();

  return { units: offerIds.length, updated };
}

// ─── Sync Cycle ───────────────────────────────────────────────────────────────

async function runListingSyncCycle() {
  if (runInFlight) {
    console.log('[ListingSyncRunner] Run already in flight, skipping.');
    return;
  }
  runInFlight = true;
  console.log('[ListingSyncRunner] Starting listing sync cycle...');
  try {
    // eBay: trigger light sync (handles its own cooldown/locking) + propagate
    const ebaySync = await syncLiveListingsLight({
      runId: `auto-${Date.now()}`,
      maxPages: 50,
      entriesPerPage: 200,
      timeoutMs: 30000,
      actor: 'listing-sync-runner',
    }).catch(err => ({ error: err.message }));

    if (ebaySync?.skipped) {
      console.log(`[ListingSyncRunner] eBay sync skipped (${ebaySync.reason})`);
    } else if (ebaySync?.error) {
      console.warn(`[ListingSyncRunner] eBay sync failed: ${ebaySync.error}`);
    }

    // Always propagate — listings may have been synced in a previous cycle
    const ebayProp = await propagateEbayStatusToProducts().catch(err => ({ error: err.message, updated: 0 }));
    if (ebayProp.error) {
      console.warn(`[ListingSyncRunner] eBay propagation failed: ${ebayProp.error}`);
    } else {
      console.log(`[ListingSyncRunner] eBay: updated ${ebayProp.updated} products`);
    }

    // Kaufland: propagate from cached kauflandUnitsLive (full sync is triggered manually)
    const kauflandProp = await propagateKauflandStatusToProducts().catch(err => ({ error: err.message, updated: 0 }));
    if (kauflandProp.error) {
      console.warn(`[ListingSyncRunner] Kaufland propagation failed: ${kauflandProp.error}`);
    } else {
      console.log(`[ListingSyncRunner] Kaufland: updated ${kauflandProp.updated} products`);
    }
  } catch (err) {
    console.error('[ListingSyncRunner] Cycle failed:', err.message);
  } finally {
    runInFlight = false;
  }
}

function startListingSyncRunner() {
  if (!LISTING_SYNC_ENABLED) {
    console.log('[ListingSyncRunner] Disabled. Set LISTING_SYNC_ENABLED=true to enable.');
    return;
  }
  console.log(
    `[ListingSyncRunner] Starting — interval: ${LISTING_SYNC_INTERVAL_MS}ms, initial delay: ${LISTING_SYNC_INITIAL_DELAY_MS}ms`
  );
  setTimeout(() => runListingSyncCycle(), LISTING_SYNC_INITIAL_DELAY_MS);
  runnerTimer = setInterval(() => runListingSyncCycle(), LISTING_SYNC_INTERVAL_MS);
}

function stopListingSyncRunner() {
  if (runnerTimer) {
    clearInterval(runnerTimer);
    runnerTimer = null;
  }
}

module.exports = { startListingSyncRunner, stopListingSyncRunner };
