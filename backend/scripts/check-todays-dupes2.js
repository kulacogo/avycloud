#!/usr/bin/env node
'use strict';
/**
 * Check all eBay orders from today to find duplicates.
 * Run from backend/ directory:
 *   GCLOUD_PROJECT=avycloud node backend/scripts/check-todays-dupes2.js
 */
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

async function main() {
  // Fetch recent orders (no composite index needed — filter in memory)
  const snap = await db.collection('orders')
    .orderBy('createdAt', 'desc')
    .limit(200)
    .get();

  const ebayDocs = snap.docs.filter(d => d.data().marketplace === 'ebay');
  console.log(`Recent orders total: ${snap.size}, eBay: ${ebayDocs.length}\n`);

  // Group by marketplaceOrderId
  const byMpId = {};
  for (const doc of ebayDocs) {
    const d = doc.data();
    const mpId = d.marketplaceOrderId || d.externalOrderId || '(none)';
    if (!byMpId[mpId]) byMpId[mpId] = [];
    byMpId[mpId].push({ id: doc.id, data: d });
  }

  // Show all groups
  for (const [mpId, docs] of Object.entries(byMpId)) {
    if (docs.length > 1) {
      console.log(`\n*** DUPLICATE GROUP: ${mpId} (${docs.length} docs) ***`);
    } else {
      console.log(`\nGroup: ${mpId}`);
    }
    for (const { id, data: d } of docs) {
      console.log(`  doc=${id} orderId=${d.orderId} key=${d.marketplaceKey} status=${d.omsStatus||d.status} created=${d.createdAt} customer=${d.customer?.name}`);
    }
  }

  // Also show orders WITHOUT marketplaceKey (potential old BaseLinker imports)
  console.log('\n\n=== eBay Orders WITHOUT marketplaceKey ===');
  for (const doc of ebayDocs) {
    const d = doc.data();
    if (!d.marketplaceKey) {
      console.log(`  doc=${doc.id} orderId=${d.orderId} mpId=${d.marketplaceOrderId} status=${d.omsStatus||d.status} created=${d.createdAt} customer=${d.customer?.name}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
