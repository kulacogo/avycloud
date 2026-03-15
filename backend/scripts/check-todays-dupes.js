#!/usr/bin/env node
'use strict';
/**
 * Check today's specific duplicate orders in Firestore.
 * Run from backend/ directory:
 *   GCLOUD_PROJECT=avycloud node backend/scripts/check-todays-dupes.js
 */
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

// The eBay order IDs from today's screenshot
const targetEbayIds = [
  '15-14360-91743',
  '09-14368-92522',
  '10-14367-14035',
];

async function main() {
  console.log('Checking today\'s duplicate orders...\n');

  for (const ebayId of targetEbayIds) {
    console.log(`\n=== eBay Order ID: ${ebayId} ===`);

    // Check by marketplaceOrderId
    const byMpId = await db.collection('orders')
      .where('marketplaceOrderId', '==', ebayId)
      .get();
    console.log(`  By marketplaceOrderId: ${byMpId.size} docs`);
    for (const doc of byMpId.docs) {
      const d = doc.data();
      console.log(`    doc=${doc.id} orderId=${d.orderId} marketplaceKey=${d.marketplaceKey} status=${d.omsStatus||d.status} created=${d.createdAt}`);
    }

    // Check by marketplaceKey
    const byMpKey = await db.collection('orders')
      .where('marketplaceKey', '==', `ebay__${ebayId}`)
      .get();
    console.log(`  By marketplaceKey (ebay__${ebayId}): ${byMpKey.size} docs`);
    for (const doc of byMpKey.docs) {
      const d = doc.data();
      console.log(`    doc=${doc.id} orderId=${d.orderId} marketplaceKey=${d.marketplaceKey} status=${d.omsStatus||d.status} created=${d.createdAt}`);
    }

    // Also check externalOrderId
    const byExtId = await db.collection('orders')
      .where('externalOrderId', '==', ebayId)
      .get();
    console.log(`  By externalOrderId: ${byExtId.size} docs`);
    for (const doc of byExtId.docs) {
      const d = doc.data();
      console.log(`    doc=${doc.id} orderId=${d.orderId} marketplaceKey=${d.marketplaceKey} status=${d.omsStatus||d.status} created=${d.createdAt}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
