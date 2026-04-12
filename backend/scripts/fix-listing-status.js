#!/usr/bin/env node
'use strict';

/**
 * Fix listing status cache — updates active booleans in ebayListingsLive and kauflandUnitsLive
 * to match the correct logic:
 *
 * eBay: active = (listingStatus !== 'Completed' && listingStatus !== 'Ended')
 *       where previously active was set
 *
 * Kaufland: active = (status === 'AVAILABLE' && amount > 0)
 *           Previously: active = (status === 'AVAILABLE') — ignored amount
 *
 * Also re-propagates corrected status to products_v2.ops.listingStatus
 *
 * Usage: node backend/scripts/fix-listing-status.js [--dry-run]
 */

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`\n🔧 LISTING STATUS FIX ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}\n`);

  // ─── 1. Fix Kaufland active flags ───────────────────────────
  console.log('🏪 Fixing Kaufland kauflandUnitsLive.active...');
  const klSnap = await db.collection('kauflandUnitsLive').get();
  let klFixed = 0;
  let klBatch = db.batch();
  let klBatchCount = 0;

  for (const doc of klSnap.docs) {
    const d = doc.data();
    const status = String(d.status || '').trim().toUpperCase();
    const amount = Number.isFinite(Number(d.amount)) ? Number(d.amount) : null;
    const correctActive = status === 'AVAILABLE' && (amount !== null ? amount > 0 : false);
    const currentActive = d.active === true;

    if (currentActive !== correctActive) {
      console.log(`  ${d.id_offer || doc.id}: active=${currentActive} → ${correctActive} (status=${d.status}, amount=${d.amount})`);
      if (!DRY_RUN) {
        klBatch.update(doc.ref, { active: correctActive });
        klBatchCount++;
        if (klBatchCount >= 400) {
          await klBatch.commit();
          klBatch = db.batch();
          klBatchCount = 0;
        }
      }
      klFixed++;
    }
  }
  if (klBatchCount > 0) await klBatch.commit();
  console.log(`  Fixed: ${klFixed} Kaufland units\n`);

  // ─── 2. Fix eBay active flags ─────────────────────────────
  console.log('🛒 Fixing eBay ebayListingsLive.active...');
  const ebaySnap = await db.collection('ebayListingsLive').get();
  let ebayFixed = 0;
  let ebayBatch = db.batch();
  let ebayBatchCount = 0;

  for (const doc of ebaySnap.docs) {
    const d = doc.data();
    const ls = d.listingStatus || null;
    const isEnded = ls === 'Completed' || ls === 'Ended';
    const currentActive = d.active === true;

    // If listing is ended but still marked active, fix it
    if (isEnded && currentActive) {
      console.log(`  ${doc.id}: active=true → false (listingStatus=${ls})`);
      if (!DRY_RUN) {
        ebayBatch.update(doc.ref, { active: false });
        ebayBatchCount++;
        if (ebayBatchCount >= 400) {
          await ebayBatch.commit();
          ebayBatch = db.batch();
          ebayBatchCount = 0;
        }
      }
      ebayFixed++;
    }

    // If listing is active but marked inactive AND listingStatus=Active, fix it
    if (!currentActive && ls === 'Active') {
      console.log(`  ${doc.id}: active=false → true (listingStatus=Active)`);
      if (!DRY_RUN) {
        ebayBatch.update(doc.ref, { active: true });
        ebayBatchCount++;
        if (ebayBatchCount >= 400) {
          await ebayBatch.commit();
          ebayBatch = db.batch();
          ebayBatchCount = 0;
        }
      }
      ebayFixed++;
    }
  }
  if (ebayBatchCount > 0) await ebayBatch.commit();
  console.log(`  Fixed: ${ebayFixed} eBay listings\n`);

  // ─── 3. Re-propagate to products_v2 ─────────────────────────
  if (!DRY_RUN) {
    console.log('📊 Re-propagating status to products_v2...');
    const { propagateEbayStatusToProducts, propagateKauflandStatusToProducts } = require('../services/listing-sync-runner');
    const ebayResult = await propagateEbayStatusToProducts();
    console.log(`  eBay: updated=${ebayResult.updated}, staleFixed=${ebayResult.staleFixed || 0}`);
    const klResult = await propagateKauflandStatusToProducts();
    console.log(`  Kaufland: updated=${klResult.updated}, staleFixed=${klResult.staleFixed || 0}`);
  }

  console.log(`\n✅ Done. Kaufland: ${klFixed} fixed, eBay: ${ebayFixed} fixed`);
  if (DRY_RUN) console.log('  (DRY RUN — no changes made)');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('Fix failed:', e);
  process.exit(1);
});
