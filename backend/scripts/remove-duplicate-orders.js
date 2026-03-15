#!/usr/bin/env node
'use strict';
/**
 * Removes duplicate orders created by the eBay/Kaufland native sync
 * because old orders had no marketplaceKey field.
 *
 * Strategy: group by marketplaceOrderId + marketplace, keep the oldest doc
 * (lowest createdAt), delete the rest. Dry-run by default.
 *
 * Usage:
 *   GCLOUD_PROJECT=avycloud node backend/scripts/remove-duplicate-orders.js --dry-run
 *   GCLOUD_PROJECT=avycloud node backend/scripts/remove-duplicate-orders.js --write
 */
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

const DRY_RUN = !process.argv.includes('--write');

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'WRITE'}`);

  // Fetch all orders (in batches)
  const snap = await db.collection('orders').orderBy('createdAt', 'asc').get();
  console.log(`Total orders: ${snap.size}`);

  // Group by marketplaceOrderId + marketplace
  const groups = {};
  for (const doc of snap.docs) {
    const d = doc.data();
    const mpId = d.marketplaceOrderId || d.externalOrderId || '';
    const mp = d.marketplace || d.source || '';
    // Skip orders without a real marketplace order ID (e.g. empty, '-', 'undefined')
    if (!mpId || mpId === '-' || mpId === 'undefined' || mpId.length < 5 || !mp) continue;
    const key = `${mp}__${mpId}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push({ id: doc.id, ref: doc.ref, data: d });
  }

  let dupGroups = 0, toDelete = 0;
  const deleteRefs = [];

  for (const [key, docs] of Object.entries(groups)) {
    if (docs.length <= 1) continue;
    dupGroups++;

    // Keep the one with the most data (has orderId generated = has been processed)
    // Prefer docs with a proper orderId (not null), then oldest createdAt
    docs.sort((a, b) => {
      const aHasId = a.data.orderId ? 1 : 0;
      const bHasId = b.data.orderId ? 1 : 0;
      if (aHasId !== bHasId) return bHasId - aHasId; // prefer has orderId
      // prefer older (lower createdAt)
      return (a.data.createdAt || '') < (b.data.createdAt || '') ? -1 : 1;
    });

    const keep = docs[0];
    const dupes = docs.slice(1);
    toDelete += dupes.length;

    console.log(`\nDuplicate group: ${key}`);
    console.log(`  KEEP: ${keep.id} orderId=${keep.data.orderId} status=${keep.data.omsStatus||keep.data.status} created=${keep.data.createdAt}`);
    for (const dupe of dupes) {
      console.log(`  DELETE: ${dupe.id} orderId=${dupe.data.orderId} status=${dupe.data.omsStatus||dupe.data.status} created=${dupe.data.createdAt}`);
      deleteRefs.push(dupe.ref);
    }
  }

  console.log(`\nSummary: ${dupGroups} duplicate groups, ${toDelete} docs to delete`);

  if (DRY_RUN) {
    console.log('DRY RUN — no changes made. Run with --write to apply.');
    return;
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
  console.log(`Done. Deleted ${deleted} duplicate orders.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
