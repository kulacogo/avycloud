'use strict';
/**
 * fix-numeric-zips.js
 * Converts zip/postal code stored as number to string in all orders.
 */
const { Firestore } = require('@google-cloud/firestore');
const db = new Firestore();

async function main() {
  const snap = await db.collection('orders').get();
  let fixed = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.customer && typeof data.customer.zip === 'number') {
      await doc.ref.update({ 'customer.zip': String(data.customer.zip) });
      console.log(`Fixed zip for ${doc.id} (${data.marketplaceOrderId || data.orderId || '?'}): ${data.customer.zip} → "${data.customer.zip}"`);
      fixed++;
    }
  }
  console.log(`Done. Fixed ${fixed} orders.`);
}

main().catch(err => { console.error(err); process.exit(1); });
