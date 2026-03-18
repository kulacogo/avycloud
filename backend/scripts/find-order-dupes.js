'use strict';
const { Firestore } = require('@google-cloud/firestore');
const db = new Firestore();
const marketplaceOrderId = process.argv[2];

async function main() {
  // Search by marketplaceOrderId
  const snap1 = await db.collection('orders').where('marketplaceOrderId', '==', marketplaceOrderId).get();
  // Search by orderId field
  const snap2 = await db.collection('orders').where('orderId', '==', marketplaceOrderId).get();
  // Search by number field (BL legacy)
  const snap3 = await db.collection('orders').where('number', '==', marketplaceOrderId).get();

  const seen = new Set();
  const docs = [];
  for (const snap of [snap1, snap2, snap3]) {
    for (const d of snap.docs) {
      if (!seen.has(d.id)) {
        seen.add(d.id);
        docs.push(d);
      }
    }
  }

  console.log(`Found ${docs.length} docs for "${marketplaceOrderId}":`);
  docs.forEach(d => {
    const data = d.data();
    console.log('\n  Firestore ID:', d.id);
    console.log('  marketplaceOrderId:', data.marketplaceOrderId);
    console.log('  orderId:', data.orderId);
    console.log('  number:', data.number);
    console.log('  omsStatus:', data.omsStatus);
    console.log('  status:', data.status);
    console.log('  statusLabel:', data.statusLabel);
    console.log('  baselinkerId:', data.baselinkerId);
    console.log('  marketplaceKey:', data.marketplaceKey);
    console.log('  source:', data.source);
    console.log('  marketplace:', data.marketplace);
    console.log('  customer:', data.customer?.name);
    console.log('  items:', data.items?.length || 0);
    console.log('  createdAt:', data.createdAt);
  });
}

main().catch(console.error);
