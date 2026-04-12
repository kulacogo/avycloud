#!/usr/bin/env node
'use strict';

/**
 * Rebuild listing cache from live marketplace APIs.
 *
 * Fetches ALL current listings from eBay and Kaufland APIs,
 * then rebuilds the cache collections from scratch.
 * Entries not in the API response are deleted.
 *
 * This is the nuclear option — use when cache has drifted too far
 * from reality (e.g., 1177 cached eBay docs but only 328 real listings).
 *
 * Usage: node backend/scripts/rebuild-listing-cache.js [--dry-run]
 */

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();
const { Timestamp } = require('@google-cloud/firestore');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`\n🔄 REBUILD LISTING CACHE ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}\n`);

  // ─── 1. Kaufland: Fetch all units from API ────────────────────
  console.log('🏪 Fetching Kaufland units from live API...');
  const { listUnits } = require('../lib/kaufland-api');
  const klUnits = await listUnits({ storefront: 'de', limit: 100, maxPages: 300 });
  console.log(`  API returned ${klUnits.length} units`);

  // Count active/inactive from API
  let klApiActive = 0, klApiInactive = 0, klApiPaused = 0;
  for (const u of klUnits) {
    const status = String(u?.status || '').toUpperCase();
    const amount = Number(u?.amount || 0);
    if (status === 'AVAILABLE' && amount > 0) klApiActive++;
    else if (status === 'ONHOLD') klApiInactive++;
    else klApiPaused++;
  }
  console.log(`  Active (AVAILABLE + amount>0): ${klApiActive}`);
  console.log(`  Inactive (ONHOLD): ${klApiInactive}`);
  console.log(`  Other (AVAILABLE amount=0 / paused): ${klApiPaused}`);

  // Build set of API unit IDs
  const klApiIds = new Set();
  for (const u of klUnits) {
    const id = String(u?.id_unit || 0);
    if (id && id !== '0') klApiIds.add(id);
  }

  // Compare with cache
  const klCacheSnap = await db.collection('kauflandUnitsLive').get();
  const klCacheIds = new Set(klCacheSnap.docs.map(d => d.id));
  const klToDelete = [];
  for (const doc of klCacheSnap.docs) {
    if (!klApiIds.has(doc.id)) {
      klToDelete.push(doc);
    }
  }
  console.log(`\n  Cache has ${klCacheSnap.size} docs, API has ${klApiIds.size} units`);
  console.log(`  ${klToDelete.length} cache entries NOT in API → will delete`);
  const klNewInApi = [...klApiIds].filter(id => !klCacheIds.has(id)).length;
  console.log(`  ${klNewInApi} API entries NOT in cache → will add`);

  if (!DRY_RUN) {
    // Delete stale entries
    for (let i = 0; i < klToDelete.length; i += 400) {
      const batch = db.batch();
      klToDelete.slice(i, i + 400).forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }
    console.log(`  Deleted ${klToDelete.length} stale Kaufland cache entries`);

    // Upsert current API data
    const now = Timestamp.now();
    let written = 0;
    for (let i = 0; i < klUnits.length; i += 400) {
      const batch = db.batch();
      for (const unit of klUnits.slice(i, i + 400)) {
        const idUnit = Number(unit?.id_unit || 0);
        if (!Number.isFinite(idUnit) || idUnit <= 0) continue;
        const docId = String(idUnit);
        const unitAmount = Number.isFinite(Number(unit?.amount)) ? Number(unit.amount) : null;
        const unitStatus = String(unit?.status || '').trim().toUpperCase();
        const isActive = unitStatus === 'AVAILABLE' && (unitAmount !== null ? unitAmount > 0 : false);

        batch.set(db.collection('kauflandUnitsLive').doc(docId), {
          id_unit: idUnit,
          id_offer: String(unit?.id_offer || '').trim() || null,
          ean: String(unit?.ean || '').replace(/\D+/g, '').trim() || null,
          id_product: Number.isFinite(Number(unit?.id_product)) && Number(unit.id_product) > 0
            ? Number(unit.id_product) : null,
          amount: unitAmount,
          status: String(unit?.status || '').trim() || null,
          storefront: 'de',
          active: isActive,
          updatedAt: now,
          source: 'rebuild-cache',
        }, { merge: true });
        written++;
      }
      await batch.commit();
    }
    console.log(`  Wrote ${written} Kaufland entries to cache`);
  }

  // ─── 2. eBay: Fetch active listings from API ─────────────────
  console.log('\n🛒 Fetching eBay listings from live API...');
  const { fetchLiveListingSummariesFromEbay } = require('../lib/ebay-direct');
  // Fetch all active listings (max 50 pages × 200)
  const ebayResult = await fetchLiveListingSummariesFromEbay({
    maxPages: 50,
    entriesPerPage: 200,
  });
  const ebayListings = ebayResult?.listings || [];
  console.log(`  API returned ${ebayListings.length} active listings (pages: ${ebayResult?.summary?.pagesFetched}/${ebayResult?.summary?.totalPagesReported})`);

  // Build set of API item IDs
  const ebayApiIds = new Set();
  for (const listing of ebayListings) {
    const id = String(listing?.itemId || '').trim();
    if (id) ebayApiIds.add(id);
  }

  // Compare with cache
  const ebayCacheSnap = await db.collection('ebayListingsLive').get();
  const ebayCacheIds = new Set(ebayCacheSnap.docs.map(d => d.id));
  const ebayToDelete = [];
  for (const doc of ebayCacheSnap.docs) {
    if (!ebayApiIds.has(doc.id)) {
      ebayToDelete.push(doc);
    }
  }
  console.log(`\n  Cache has ${ebayCacheSnap.size} docs, API has ${ebayApiIds.size} listings`);
  console.log(`  ${ebayToDelete.length} cache entries NOT in API → will delete`);
  const ebayNewInApi = [...ebayApiIds].filter(id => !ebayCacheIds.has(id)).length;
  console.log(`  ${ebayNewInApi} API entries NOT in cache → will add`);

  if (!DRY_RUN) {
    // Delete stale entries
    for (let i = 0; i < ebayToDelete.length; i += 400) {
      const batch = db.batch();
      ebayToDelete.slice(i, i + 400).forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }
    console.log(`  Deleted ${ebayToDelete.length} stale eBay cache entries`);

    // Upsert current API data via existing function
    const { upsertLiveListingSummaries } = require('../lib/ebay-direct');
    const upsertResult = await upsertLiveListingSummaries(ebayListings, {
      runId: 'rebuild-cache',
      actor: 'rebuild-script',
    });
    console.log(`  Upserted: ${upsertResult.written} (${upsertResult.changed} changed, ${upsertResult.unchanged} unchanged)`);

    // Also clean orphaned listing links
    const linksSnap = await db.collection('ebayListingLinks').get();
    let linksDeleted = 0;
    for (let i = 0; i < linksSnap.docs.length; i += 400) {
      const batch = db.batch();
      let bc = 0;
      for (const doc of linksSnap.docs.slice(i, i + 400)) {
        if (!ebayApiIds.has(doc.id)) {
          batch.delete(doc.ref);
          bc++;
          linksDeleted++;
        }
      }
      if (bc > 0) await batch.commit();
    }
    console.log(`  Deleted ${linksDeleted} orphaned eBay listing links`);
  }

  // ─── 3. Re-propagate to products_v2 ──────────────────────────
  if (!DRY_RUN) {
    console.log('\n📊 Re-propagating to products_v2...');
    const { propagateEbayStatusToProducts, propagateKauflandStatusToProducts } = require('../services/listing-sync-runner');
    const ebayProp = await propagateEbayStatusToProducts();
    console.log(`  eBay: updated=${ebayProp.updated}, staleFixed=${ebayProp.staleFixed || 0}`);
    const klProp = await propagateKauflandStatusToProducts();
    console.log(`  Kaufland: updated=${klProp.updated}, staleFixed=${klProp.staleFixed || 0}`);
  }

  console.log('\n✅ Done!');
  if (DRY_RUN) console.log('  (DRY RUN — no changes made)');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('Rebuild failed:', e);
  process.exit(1);
});
