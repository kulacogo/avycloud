#!/usr/bin/env node
'use strict';
/**
 * Remove old BaseLinker eBay order duplicates.
 *
 * Old BaseLinker eBay orders have:
 *   - Numeric Firestore doc IDs (BaseLinker order IDs)
 *   - 'baselinkerId' field set
 *   - No 'marketplaceKey' or 'orderId' (AVY-XXXX)
 *   - marketplace = 'ebay'
 *   - marketplaceOrderId = '-' or undefined
 *
 * New native eBay orders (authoritative) have:
 *   - Auto-generated Firestore doc IDs
 *   - marketplaceKey = 'ebay__XX-XXXXX-XXXXX'
 *   - orderId = 'AVY-XXXX'
 *
 * Strategy:
 *   1. Find all old BL eBay docs (has baselinkerId, no marketplaceKey)
 *   2. For each, find the new eBay doc with same createdAt + marketplace
 *   3. If the old doc has trackingNumber/shippingData missing from new → copy to new
 *   4. Delete the old doc
 *
 * Usage:
 *   GCLOUD_PROJECT=avycloud node backend/scripts/remove-bl-ebay-duplicates.js --dry-run
 *   GCLOUD_PROJECT=avycloud node backend/scripts/remove-bl-ebay-duplicates.js --write
 */
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

const DRY_RUN = !process.argv.includes('--write');

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'WRITE'}\n`);

  // Step 1: Fetch all orders (sorted by createdAt asc for consistent processing)
  console.log('Fetching all orders...');
  const snap = await db.collection('orders').orderBy('createdAt', 'asc').get();
  console.log(`Total orders: ${snap.size}\n`);

  // Separate into old BL docs and new eBay docs
  const blDocs = [];   // old BaseLinker eBay orders — to delete
  const ebayDocs = []; // new native eBay orders — to keep

  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.marketplace !== 'ebay') continue;

    if (d.baselinkerId && !d.marketplaceKey && !d.orderId) {
      blDocs.push({ id: doc.id, ref: doc.ref, data: d });
    } else if (d.marketplaceKey && d.orderId) {
      ebayDocs.push({ id: doc.id, ref: doc.ref, data: d });
    }
  }

  console.log(`Old BaseLinker eBay docs (no marketplaceKey): ${blDocs.length}`);
  console.log(`New native eBay docs (with marketplaceKey):   ${ebayDocs.length}\n`);

  // Build lookup: createdAt → new eBay doc
  const ebayByCreatedAt = {};
  for (const doc of ebayDocs) {
    const key = doc.data.createdAt;
    if (key) {
      if (!ebayByCreatedAt[key]) ebayByCreatedAt[key] = [];
      ebayByCreatedAt[key].push(doc);
    }
  }

  // Step 2: Match old BL docs to new eBay docs
  let matched = 0, unmatched = 0;
  const pairs = [];
  const unmatchedBl = [];

  for (const blDoc of blDocs) {
    const candidates = ebayByCreatedAt[blDoc.data.createdAt] || [];
    // If multiple candidates at same timestamp, match by customer name
    let counterpart = candidates[0];
    if (candidates.length > 1) {
      counterpart = candidates.find(c => c.data.customer?.name === blDoc.data.customer?.name) || candidates[0];
    }

    if (counterpart) {
      matched++;
      pairs.push({ old: blDoc, new: counterpart });
    } else {
      unmatched++;
      unmatchedBl.push(blDoc);
    }
  }

  console.log(`Matched pairs (old BL → new eBay): ${matched}`);
  console.log(`Unmatched old BL docs (no counterpart): ${unmatched}\n`);

  // Step 3: Report and optionally process
  const deleteRefs = [];
  const updates = []; // { ref, fields }

  for (const { old: blDoc, new: ebayDoc } of pairs) {
    const bd = blDoc.data;
    const nd = ebayDoc.data;

    console.log(`PAIR: BL:${blDoc.id}(${bd.status}) → eBay:${ebayDoc.id}(${nd.omsStatus||nd.status})`);
    console.log(`  customer: ${bd.customer?.name} | created: ${bd.createdAt}`);
    console.log(`  BL status: ${bd.status} | eBay status: ${nd.omsStatus || nd.status}`);

    // Check for data in old doc that new doc is missing
    const missingInNew = {};
    if (bd.trackingNumber && !nd.trackingNumber) {
      missingInNew.trackingNumber = bd.trackingNumber;
      console.log(`  → Copy trackingNumber: ${bd.trackingNumber}`);
    }
    if (bd.carrier && !nd.carrier) {
      missingInNew.carrier = bd.carrier;
    }
    if (bd.shippedAt && !nd.shippedAt) {
      missingInNew.shippedAt = bd.shippedAt;
    }
    if (bd.notes && !nd.notes) {
      missingInNew.notes = bd.notes;
      console.log(`  → Copy notes: ${bd.notes}`);
    }
    // If old BL had a more advanced OMS status and new doesn't reflect it
    const OMS_RANK = { pending: 0, new: 0, confirmed: 1, picking: 2, picked: 3, packing: 4, packed: 5, shipped: 6, delivered: 7, completed: 8, cancelled: 9, returned: 10 };
    const blRank = OMS_RANK[bd.status] ?? 0;
    const ndStatus = nd.omsStatus || nd.status;
    const ndRank = OMS_RANK[ndStatus] ?? 0;
    if (blRank > ndRank && bd.status !== 'picked') { // don't override if eBay reports more authoritative status
      // Only copy if significantly more advanced and it's not just a local workflow state
      // (picking/picked are local states that don't map to eBay statuses)
    }

    if (Object.keys(missingInNew).length > 0) {
      missingInNew.updatedAt = new Date().toISOString();
      updates.push({ ref: ebayDoc.ref, fields: missingInNew });
    }

    console.log(`  ACTION: DELETE BL:${blDoc.id}`);
    deleteRefs.push(blDoc.ref);
    console.log('');
  }

  // Show unmatched old BL docs (will NOT delete — no counterpart found)
  if (unmatchedBl.length > 0) {
    console.log('\n=== Unmatched old BL docs (will NOT delete) ===');
    for (const blDoc of unmatchedBl) {
      const bd = blDoc.data;
      console.log(`  BL:${blDoc.id} customer=${bd.customer?.name} created=${bd.createdAt} status=${bd.status}`);
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Pairs found: ${pairs.length}`);
  console.log(`  Docs to delete: ${deleteRefs.length}`);
  console.log(`  Docs to update (copy missing data): ${updates.length}`);
  console.log(`  Unmatched BL docs (kept): ${unmatched}`);

  if (DRY_RUN) {
    console.log('\nDRY RUN — no changes made. Run with --write to apply.');
    return;
  }

  // Apply updates first
  for (const { ref, fields } of updates) {
    await ref.update(fields);
    console.log(`Updated ${ref.id}`);
  }

  // Delete in batches of 400
  let deleted = 0;
  for (let i = 0; i < deleteRefs.length; i += 400) {
    const batch = db.batch();
    deleteRefs.slice(i, i + 400).forEach((ref) => batch.delete(ref));
    await batch.commit();
    deleted += Math.min(400, deleteRefs.length - i);
    console.log(`Deleted ${deleted}/${deleteRefs.length}...`);
  }
  console.log(`\nDone. Deleted ${deleted} old BaseLinker eBay duplicate orders.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
