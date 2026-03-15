#!/usr/bin/env node
'use strict';
/**
 * Delete ALL remaining old BaseLinker eBay docs from Firestore.
 * Criteria: marketplace=ebay, has baselinkerId, no marketplaceKey
 * Before deleting: tries to copy tracking/notes to matching native doc.
 * Run: GCLOUD_PROJECT=avycloud node backend/scripts/delete-remaining-bl-ebay.js
 */
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

const DRY_RUN = process.env.DRY_RUN === 'true';

async function main() {
  // 1. Load all orders and filter in memory (avoids composite index requirement)
  const snap = await db.collection('orders').orderBy('createdAt', 'desc').limit(2000).get();
  const allEbay = snap.docs.filter(d => d.data().marketplace === 'ebay');

  console.log(`Total eBay docs loaded: ${allEbay.length}`);

  // Separate BL docs (no marketplaceKey, has baselinkerId) from native docs
  const blDocs = allEbay.filter(d => {
    const dd = d.data();
    return dd.baselinkerId && !dd.marketplaceKey;
  });
  const nativeDocs = allEbay.filter(d => d.data().marketplaceKey);

  console.log(`BL eBay docs (to delete): ${blDocs.length}`);
  console.log(`Native eBay docs: ${nativeDocs.length}`);

  if (blDocs.length === 0) {
    console.log('Nothing to delete.');
    return;
  }

  // Build lookup by createdAt for native docs
  const nativeByCreatedAt = new Map();
  for (const doc of nativeDocs) {
    const d = doc.data();
    if (d.createdAt) {
      if (!nativeByCreatedAt.has(d.createdAt)) nativeByCreatedAt.set(d.createdAt, []);
      nativeByCreatedAt.get(d.createdAt).push(doc);
    }
  }

  // Build lookup by marketplaceOrderId for native docs
  const nativeByOrderId = new Map();
  for (const doc of nativeDocs) {
    const d = doc.data();
    const oid = d.marketplaceOrderId || d.orderId;
    if (oid && oid !== '-') nativeByOrderId.set(String(oid), doc);
  }

  let deleteCount = 0;
  let noMatchCount = 0;
  let trackingCopied = 0;

  for (const blDoc of blDocs) {
    const bd = blDoc.data();
    const blId = blDoc.id;

    // Find matching native doc
    let nativeDoc = null;

    // Try createdAt match
    const byTime = nativeByCreatedAt.get(bd.createdAt) || [];
    if (byTime.length > 0) nativeDoc = byTime[0];

    // Try marketplaceOrderId match (BL stores as orderId field)
    if (!nativeDoc) {
      const oid = bd.marketplaceOrderId || bd.orderId;
      if (oid && oid !== '-') nativeDoc = nativeByOrderId.get(String(oid)) || null;
    }

    if (nativeDoc) {
      const nd = nativeDoc.data();
      const updates = {};

      // Copy tracking number if native doc doesn't have one
      if (bd.trackingNumber && !nd.trackingNumber) {
        updates.trackingNumber = bd.trackingNumber;
        trackingCopied++;
      }
      if (bd.notes && !nd.notes) updates.notes = bd.notes;

      if (!DRY_RUN) {
        if (Object.keys(updates).length > 0) {
          await nativeDoc.ref.update(updates);
        }
        await blDoc.ref.delete();
      }
      console.log(`${DRY_RUN ? '[DRY]' : 'DELETED'} BL doc=${blId} (bl_id=${bd.baselinkerId}) → matched native ${nativeDoc.id} | createdAt=${bd.createdAt} | customer=${bd.customer?.name}`);
      deleteCount++;
    } else {
      // No matching native doc — keep! These are historical BL-only orders, not duplicates.
      noMatchCount++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Deleted: ${deleteCount} BL eBay docs${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`Tracking numbers copied: ${trackingCopied}`);
  console.log(`Kept (no native counterpart, historical): ${noMatchCount}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
