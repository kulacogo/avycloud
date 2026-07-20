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
const { bus } = require('./sync-event-bus');

const LISTING_SYNC_ENABLED = process.env.LISTING_SYNC_ENABLED !== 'false'; // Default ON
const LISTING_SYNC_INTERVAL_MS = parseInt(
  process.env.LISTING_SYNC_INTERVAL_MS || String(15 * 60 * 1000), // 15 minutes (was 3 min — too aggressive)
  10
);
const LISTING_SYNC_INITIAL_DELAY_MS = parseInt(
  process.env.LISTING_SYNC_INITIAL_DELAY_MS || String(3 * 60 * 1000),
  10
);
const PRODUCTS_COLLECTION = process.env.PRODUCT_COLLECTION || 'products_v2';

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
    // Explizites active:false GEWINNT (seit 2026-07-05): es wird nur noch vom
    // bestätigten Deaktivierungs-Pfad gesetzt (Zwei-Ingest-Confirm in
    // lib/ebay-direct.js) und heilt sich beim nächsten erfolgreichen Sync
    // selbst (Upsert setzt active:true). Der listingStatus-STRING ist nach
    // einer Deaktivierung veraltete Information vom letzten Fetch davor —
    // die frühere OR-Logik hielt damit 615 Produkte auf "aktiv", obwohl der
    // Spiegel längst korrekt deaktiviert war. String-Fallback bleibt nur
    // für Alt-Docs, die das boolean-Feld noch nie geschrieben bekamen.
    const isActive = data?.active === false
      ? false
      : (data?.active === true || status === 'active');
    listingStatusByItemId.set(doc.id, isActive ? 'active' : 'inactive');
  }

  // 3. Group by productId — if any listing is active, product is active on eBay
  const productStatusMap = new Map();
  for (const [itemId, productId] of itemToProduct.entries()) {
    const status = listingStatusByItemId.get(itemId) || 'not_listed';
    if (status === 'active' || !productStatusMap.has(productId)) {
      productStatusMap.set(productId, status);
    }
  }

  // 4. Batch-update products — verify existence first to prevent ghost documents.
  // set({merge:true}) on a non-existent doc silently creates an empty shell.
  const now = new Date().toISOString();
  let batch = firestore.batch();
  let batchCount = 0;
  let updated = 0;
  let skippedOrphans = 0;

  const productIds = Array.from(productStatusMap.keys());
  const existingIds = new Set();
  for (let i = 0; i < productIds.length; i += 10) {
    const chunk = productIds.slice(i, i + 10);
    const refs = chunk.map(id => firestore.collection(PRODUCTS_COLLECTION).doc(id));
    const docs = await firestore.getAll(...refs);
    for (const doc of docs) {
      if (doc.exists) existingIds.add(doc.id);
    }
  }

  for (const [productId, status] of productStatusMap.entries()) {
    if (!existingIds.has(productId)) {
      skippedOrphans++;
      continue;
    }
    batch.update(
      firestore.collection(PRODUCTS_COLLECTION).doc(productId),
      { 'ops.listingStatus.ebay': status, 'ops.listingStatus.lastSyncAt': now }
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
  if (skippedOrphans > 0) {
    console.warn(`[ListingSyncRunner] Skipped ${skippedOrphans} orphaned ebayListingLinks (product not found)`);
  }

  // 5. Cleanup: find products with stale ops.listingStatus.ebay='active' that are NOT truly active.
  // These are products without an ebayListingLinks entry or whose listing is no longer active on eBay.
  const activeProductIds = new Set();
  for (const [productId, status] of productStatusMap.entries()) {
    if (status === 'active') activeProductIds.add(productId);
  }

  let staleFixed = 0;
  const staleSnap = await firestore.collection(PRODUCTS_COLLECTION)
    .where('ops.listingStatus.ebay', '==', 'active')
    .get();

  let staleBatch = firestore.batch();
  let staleBatchCount = 0;
  for (const doc of staleSnap.docs) {
    if (activeProductIds.has(doc.id)) continue; // truly active, skip
    staleBatch.update(doc.ref, {
      'ops.listingStatus.ebay': 'not_listed',
      'ops.listingStatus.lastSyncAt': now,
    });
    staleBatchCount++;
    staleFixed++;
    if (staleBatchCount >= 400) {
      await staleBatch.commit();
      staleBatch = firestore.batch();
      staleBatchCount = 0;
    }
  }
  if (staleBatchCount > 0) await staleBatch.commit();
  if (staleFixed > 0) {
    console.log(`[ListingSyncRunner] Fixed ${staleFixed} stale ops.listingStatus.ebay='active' products`);
  }

  return { linked: itemToProduct.size, updated, staleFixed };
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

  // Cleanup: find products with stale ops.listingStatus.kaufland='active' that are NOT truly active.
  const activeKauflandSkus = new Set();
  for (const [sku, status] of offerStatusMap.entries()) {
    if (status === 'active') activeKauflandSkus.add(sku);
  }

  let staleFixed = 0;
  const staleSnap = await firestore.collection(PRODUCTS_COLLECTION)
    .where('ops.listingStatus.kaufland', '==', 'active')
    .get();

  let staleBatch = firestore.batch();
  let staleBatchCount = 0;
  for (const doc of staleSnap.docs) {
    const sku = String(doc.data()?.identification?.sku || '');
    if (activeKauflandSkus.has(sku)) continue; // truly active, skip
    staleBatch.update(doc.ref, {
      'ops.listingStatus.kaufland': 'not_listed',
      'ops.listingStatus.lastSyncAt': now,
    });
    staleBatchCount++;
    staleFixed++;
    if (staleBatchCount >= 400) {
      await staleBatch.commit();
      staleBatch = firestore.batch();
      staleBatchCount = 0;
    }
  }
  if (staleBatchCount > 0) await staleBatch.commit();
  if (staleFixed > 0) {
    console.log(`[ListingSyncRunner] Fixed ${staleFixed} stale ops.listingStatus.kaufland='active' products`);
  }

  return { units: offerIds.length, updated, staleFixed };
}

// ─── Kaufland API Sync ────────────────────────────────────────────────────────

async function syncKauflandUnitsToCache() {
  const { listUnits } = require('../lib/kaufland-api');
  const { Timestamp } = require('@google-cloud/firestore');

  const units = await listUnits({ storefront: 'de', limit: 100, maxPages: 300 });
  if (!units.length) return { fetched: 0 };

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

    const payload = {
      id_unit: idUnit,
      id_offer: String(unit?.id_offer || '').trim() || null,
      ean: String(unit?.ean || '').replace(/\D+/g, '').trim() || null,
      id_product: Number.isFinite(Number(unit?.id_product)) && Number(unit.id_product) > 0
        ? Number(unit.id_product) : null,
      amount: Number.isFinite(Number(unit?.amount)) ? Number(unit.amount) : null,
      status: String(unit?.status || '').trim() || null,
      storefront: 'de',
      active: String(unit?.status || '').trim().toUpperCase() === 'AVAILABLE',
      updatedAt: now,
      source: 'listing-sync-runner',
    };

    batch.set(collection.doc(docId), payload, { merge: true });
    batchCount += 1;
    if (batchCount >= 400) await commitBatch();
  }
  await commitBatch();

  // Mark stale rows inactive
  const existingSnap = await collection.where('storefront', '==', 'de').where('active', '==', true).get();
  if (!existingSnap.empty) {
    batch = firestore.batch();
    batchCount = 0;
    for (const doc of existingSnap.docs) {
      if (seenIds.has(doc.id)) continue;
      batch.set(doc.ref, { active: false, updatedAt: now, source: 'listing-sync-runner' }, { merge: true });
      batchCount += 1;
      if (batchCount >= 400) await commitBatch();
    }
    await commitBatch();
  }

  return { fetched: units.length, active: seenIds.size };
}

// ─── Auto-Heal: Detect and fix stock discrepancies ──────────────────────────

// Track last heal time per SKU to avoid redundant pushes
const lastHealedAt = new Map();
const HEAL_COOLDOWN_MS = parseInt(process.env.AUTO_HEAL_COOLDOWN_MS || String(30 * 60 * 1000), 10); // 30 min
const MAX_HEALS_PER_CYCLE = parseInt(process.env.AUTO_HEAL_MAX_PER_CYCLE || '5', 10);

// EISERNE REGEL (Oversell-Incident 2026-07-11, SKU-2510094553): der Auto-Heal
// darf Marktplatz-Mengen NUR SENKEN, NIE ERHÖHEN.
//
// Warum: Marktplätze dekrementieren ihre Angebots-Menge bei jedem Kauf sofort
// selbst — unser Order-Intake erfährt vom Kauf aber erst Minuten später
// (Poll-Latenz). In diesem Fenster ist marketplace < available der ERWARTETE
// Zustand einer frischen, noch nicht importierten Bestellung. Ein
// Upward-"Heal" macht das faktisch ausverkaufte Listing wieder kaufbar:
// Kauf 08:12 → Kaufland 1→0 → Auto-Heal pushte 08:14 wieder qty=1 →
// Zweitkauf 08:16 → Oversell. Legitime Bestandserhöhungen (Wareneingang,
// Storno-Re-Credit) laufen ereignisgetrieben über saveProductV2 +
// stock:changed und brauchen den Heal nicht.
//
// Zusätzlich pro Kanal geklemmt (onlyChannels): ein nötiger Down-Push für
// Kanal A darf denselben (evtl. stale-hohen) Wert nicht auf Kanal B
// spiegeln und dort ein frisch ausverkauftes Listing re-armieren.
//
// Pure Funktion, exportiert für Tests.
function decideAutoHealPush({ availableQty, ebayMpQty, kauflandMpQty }) {
  const avail = Number(availableQty);
  if (!Number.isFinite(avail) || avail < 0) return { push: false, reason: 'invalid availableQty' };
  const needsDown = (mp) => mp !== undefined && mp !== null && Number(mp) > avail;
  const ebayDown = needsDown(ebayMpQty);
  const kauflandDown = needsDown(kauflandMpQty);
  if (!ebayDown && !kauflandDown) {
    // marketplace <= available auf allen Kanälen: entweder synchron oder
    // Upward-Drift (= möglicher Kauf im Intake-Fenster) → NIE pushen.
    return { push: false, reason: 'no channel above available (upward drift = report-only)' };
  }
  return {
    push: true,
    isOversell: avail === 0,
    onlyChannels: [
      ...(ebayDown ? ['ebay'] : []),
      ...(kauflandDown ? ['kaufland'] : []),
    ],
  };
}

async function autoHealStockDiscrepancies() {
  const { syncStockWithRetry, computeAvailableQuantity } = require('./stock-sync-dispatcher');

  // Check eBay listings for quantity mismatches
  const ebaySnap = await firestore.collection('ebayListingsLive')
    .where('active', '==', true)
    .get();

  // Also check Kaufland units
  const kauflandSnap = await firestore.collection('kauflandUnitsLive')
    .where('active', '==', true)
    .get();

  if (ebaySnap.empty && kauflandSnap.empty) return;

  // Build SKU → marketplace qty maps
  const ebayQtyMap = new Map();
  for (const doc of ebaySnap.docs) {
    const data = doc.data();
    const sku = String(data?.sku || '').trim();
    if (sku) {
      ebayQtyMap.set(sku, Number(data?.quantityAvailable ?? data?.quantity ?? 0));
    }
  }

  const kauflandQtyMap = new Map();
  for (const doc of kauflandSnap.docs) {
    const data = doc.data();
    const sku = String(data?.id_offer || '').trim();
    if (sku) {
      kauflandQtyMap.set(sku, Number(data?.amount ?? 0));
    }
  }

  // Merge all SKUs that need checking
  const allSkus = new Set([...ebayQtyMap.keys(), ...kauflandQtyMap.keys()]);
  if (allSkus.size === 0) return;

  const skus = Array.from(allSkus);
  let healed = 0;
  const now = Date.now();

  // Prune stale cooldown entries (older than 2h)
  for (const [key, ts] of lastHealedAt) {
    if (now - ts > 2 * 60 * 60 * 1000) lastHealedAt.delete(key);
  }

  for (let i = 0; i < skus.length && healed < MAX_HEALS_PER_CYCLE; i += 10) {
    const chunk = skus.slice(i, i + 10);
    try {
      const snap = await firestore.collection(PRODUCTS_COLLECTION)
        .where('identification.sku', 'in', chunk)
        .get();
      for (const doc of snap.docs) {
        if (healed >= MAX_HEALS_PER_CYCLE) break;
        const product = { id: doc.id, ...doc.data() };
        const sku = String(product?.identification?.sku || '').trim();

        // Compute true available quantity (physical - reserved)
        const { availableQty } = await computeAvailableQuantity(product, 'default');

        const ebayMpQty = ebayQtyMap.get(sku);
        const kauflandMpQty = kauflandQtyMap.get(sku);

        const decision = decideAutoHealPush({ availableQty, ebayMpQty, kauflandMpQty });
        if (!decision.push) {
          // Upward-Drift (marketplace < available) NIE hochpushen — siehe
          // decideAutoHealPush. Nur loggen wenn überhaupt eine Abweichung da
          // ist, sonst wird der Log bei synchronen Beständen geflutet.
          const anyDrift =
            (ebayMpQty !== undefined && ebayMpQty !== availableQty) ||
            (kauflandMpQty !== undefined && kauflandMpQty !== availableQty);
          if (anyDrift) {
            console.log(
              `[ListingSyncRunner] Auto-heal REPORT-ONLY: ${sku} available=${availableQty} ebay=${ebayMpQty ?? '-'} kaufland=${kauflandMpQty ?? '-'} — marketplace<=available (möglicher Kauf im Intake-Fenster, kein Upward-Push)`
            );
          }
          continue;
        }

        const { isOversell, onlyChannels } = decision;

        // Skip non-critical mismatches if we already pushed recently (cooldown)
        if (!isOversell) {
          const lastHealed = lastHealedAt.get(sku) || 0;
          if (now - lastHealed < HEAL_COOLDOWN_MS) continue;
        }

        console.log(
          `[ListingSyncRunner] Auto-heal: ${sku} available=${availableQty} ebay=${ebayMpQty ?? '-'} kaufland=${kauflandMpQty ?? '-'}${isOversell ? ' ⚠️ OVERSELL' : ''} → pushing down (channels=${onlyChannels.join(',')})`
        );
        lastHealedAt.set(sku, now);
        syncStockWithRetry({ tenantId: 'default', product, reason: isOversell ? 'oversell-fix' : 'auto-heal', onlyChannels })
          .catch((err) => console.warn(`[auto-heal] push failed for ${sku}: ${err.message}`));
        healed++;
      }
    } catch (err) {
      console.warn(`[ListingSyncRunner] Auto-heal SKU query failed: ${err.message}`);
    }
  }

  if (healed > 0) {
    console.log(`[ListingSyncRunner] Auto-heal: pushed corrections for ${healed} product(s)`);
  }
}

// Safety-Net-Detektor (Incident 2026-07-19, SKU-6656556112): findet Produkte,
// deren eBay-Listing der Stock-Sync selbst beendet hat (ops.ebay.zeroStockEnd-
// Marker) und die wieder verkäuflichen Bestand haben — und stößt den
// Dispatcher an, der über den Marker relistet. Produkte OHNE Marker (manuell/
// eBay-seitig beendet) werden hier bewusst NIE angefasst.
const ENDED_HEAL_MAX_PER_CYCLE = 10;

async function healEndedListingsWithStock() {
  const { syncStockWithRetry, computeAvailableQuantity } = require('./stock-sync-dispatcher');

  // Single-Field-Range auf dem Marker-Zeitstempel (automatischer Index).
  // Kein tenantId-Composite nötig: alle Prod-Daten sind tenantId='default'
  // (siehe decisions.md) — in-code gefiltert. Nach erfolgreichem Relist setzt
  // der Dispatcher zeroStockEnd auf null → Doc fällt aus dem Index.
  // NEUESTE Marker zuerst (Review-Finding 2/11): ohne orderBy liefert die
  // Range-Query aufsteigend — hätten sich ≥50 dauerhaft ausverkaufte Alt-
  // Marker angesammelt, käme ein FRISCHER Incident-Marker nie ins Fenster.
  const snap = await firestore.collection(PRODUCTS_COLLECTION)
    .where('ops.ebay.zeroStockEnd.at', '>', '')
    .orderBy('ops.ebay.zeroStockEnd.at', 'desc')
    .limit(50)
    .get();
  if (snap.empty) return;

  const RELIST_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
  let healed = 0;
  for (const doc of snap.docs) {
    if (healed >= ENDED_HEAL_MAX_PER_CYCLE) break;
    const product = { id: doc.id, ...doc.data() };
    if ((product.tenantId || 'default') !== 'default') continue;
    try {
      const { availableQty } = await computeAvailableQuantity(product, 'default');
      if (availableQty <= 0) {
        // Legitim beendet — Marker bleibt für später. AUSSER er ist älter als
        // das 90-Tage-Relist-Fenster: dann kann er nie mehr heilen und würde
        // die Query nur zumüllen → verfallen lassen (Audit-Feld bleibt).
        const at = Date.parse(product?.ops?.ebay?.zeroStockEnd?.at || '');
        if (Number.isFinite(at) && Date.now() - at > RELIST_WINDOW_MS) {
          await firestore.collection(PRODUCTS_COLLECTION).doc(product.id)
            .update({
              'ops.ebay.zeroStockEnd': null,
              'ops.ebay.zeroStockEndExpiredAt': new Date().toISOString(),
            })
            .catch(() => {});
        }
        continue;
      }
      const sku = String(product?.identification?.sku || product?.details?.identifiers?.sku || '').trim();
      console.log(
        `[ListingSyncRunner] Ended-with-stock heal: ${sku || product.id} available=${availableQty} → Relist via stock-sync`
      );
      await syncStockWithRetry({ tenantId: 'default', product, reason: 'ended-with-stock-heal', onlyChannels: ['ebay'] });
      healed++;
    } catch (err) {
      console.warn(`[ListingSyncRunner] Ended-with-stock heal failed for ${product.id}: ${err.message}`);
    }
  }

  if (healed > 0) {
    console.log(`[ListingSyncRunner] Ended-with-stock heal: triggered relist for ${healed} product(s)`);
  }
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
      maxPages: 10,
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

    // Kaufland: fetch units from API, update cache, then propagate
    const kauflandSync = await syncKauflandUnitsToCache().catch(err => ({ error: err.message }));
    if (kauflandSync?.error) {
      console.warn(`[ListingSyncRunner] Kaufland API sync failed: ${kauflandSync.error}`);
    } else if (kauflandSync?.fetched !== undefined) {
      console.log(`[ListingSyncRunner] Kaufland: fetched ${kauflandSync.fetched} units from API`);
    }

    const kauflandProp = await propagateKauflandStatusToProducts().catch(err => ({ error: err.message, updated: 0 }));
    if (kauflandProp.error) {
      console.warn(`[ListingSyncRunner] Kaufland propagation failed: ${kauflandProp.error}`);
    } else {
      console.log(`[ListingSyncRunner] Kaufland: updated ${kauflandProp.updated} products`);
    }

    // Auto-heal: detect stock discrepancies and push corrections
    await autoHealStockDiscrepancies().catch(err => {
      console.warn(`[ListingSyncRunner] Auto-heal failed: ${err.message}`);
    });

    // Safety-Net (Incident 2026-07-19): Produkte, deren eBay-Listing der
    // Stock-Sync selbst wegen Null-Bestand beendet hat (zeroStockEnd-Marker),
    // aber die inzwischen wieder Bestand haben → Relist anstoßen. Fängt Fälle,
    // in denen der eventgetriebene Selbstheilungs-Pfad nicht lief (Worker-
    // Restart, Event verpasst). Beendete Listings sind für den normalen
    // Auto-Heal unsichtbar (der iteriert nur über active==true-Mirror-Docs).
    await healEndedListingsWithStock().catch(err => {
      console.warn(`[ListingSyncRunner] Ended-with-stock heal failed: ${err.message}`);
    });

    // Emit SSE event so frontend React Query caches get invalidated
    try {
      bus.emit('listings:sync_completed', {
        source: 'listing-sync-runner',
        active: ebaySync?.ingest?.activeListings || 0,
        inactive: ebaySync?.deactivation?.deactivated || 0,
      });
    } catch {
      // Non-critical
    }

    // Record today's active-listing snapshot (idempotent, 1×/day) → builds the
    // exact historical "Ø Artikel online" series. Never let this break the cycle.
    try {
      const { recordDailyListingSnapshot } = require('../lib/listing-snapshot');
      await recordDailyListingSnapshot({ tenantId: 'default' });
    } catch (err) {
      console.warn(`[ListingSyncRunner] snapshot failed: ${err.message}`);
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

module.exports = { startListingSyncRunner, stopListingSyncRunner, propagateEbayStatusToProducts, decideAutoHealPush, healEndedListingsWithStock };
