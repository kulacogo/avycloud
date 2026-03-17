'use strict';
/**
 * fix-kaufland-createdat.js
 * Fixes createdAt for Kaufland orders that were saved with the import timestamp
 * instead of the actual Kaufland order creation date (ts_created_iso).
 */

const { Firestore } = require('@google-cloud/firestore');
const { kauflandRequest } = require('../lib/kaufland-api');

const db = new Firestore();

async function main() {
  const snap = await db.collection('orders').get();
  const today = '2026-03-17';

  // Kaufland orders where createdAt was set to import time (today)
  const toFix = snap.docs
    .map(d => ({ firestoreId: d.id, ...d.data() }))
    .filter(o =>
      (o.marketplace === 'kaufland' || o.source === 'kaufland') &&
      o.createdAt && o.createdAt.startsWith(today) &&
      o.marketplaceOrderId
    );

  console.log(`Found ${toFix.length} Kaufland orders with wrong createdAt`);

  for (const order of toFix) {
    try {
      const result = await kauflandRequest('GET', `/orders/${order.marketplaceOrderId}`);
      const full = result?.data?.data || result?.data || result;
      const correctDate = full?.ts_created_iso || full?.ts_created;
      if (!correctDate) {
        console.log(`  No date from API for ${order.marketplaceOrderId}`);
        continue;
      }
      await db.collection('orders').doc(order.firestoreId).update({ createdAt: correctDate });
      console.log(`  Fixed ${order.marketplaceOrderId}: ${order.createdAt} → ${correctDate}`);
    } catch (err) {
      console.log(`  FAILED ${order.marketplaceOrderId}: ${err.message}`);
    }
  }

  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
