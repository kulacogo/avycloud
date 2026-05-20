#!/usr/bin/env node
'use strict';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

async function main() {
  // Load all orders
  const snap = await db.collection('orders').orderBy('createdAt', 'desc').limit(400).get();
  const docs = snap.docs;
  console.log('Loaded:', docs.length);

  // BL order 30897156 - check all fields
  const blOrder = docs.find(d => d.id === '30897156');
  if (blOrder) {
    console.log('\n=== BL order 30897156 full data ===');
    const dd = blOrder.data();
    const fields = Object.keys(dd).sort();
    for (const f of fields) {
      const v = dd[f];
      if (typeof v === 'string' || typeof v === 'number') {
        console.log(`  ${f}: ${v}`);
      }
    }
  } else {
    console.log('\nBL order 30897156 NOT in top 400');
  }

  // Search all docs for 19-14202-50540 in any string field
  console.log('\n=== Searching for 19-14202-50540 in all field values ===');
  let found = false;
  for (const doc of docs) {
    const dd = doc.data();
    const str = JSON.stringify(dd);
    if (str.includes('19-14202-50540')) {
      console.log('FOUND in doc:', doc.id, '| omsStatus:', dd.omsStatus || dd.status);
      found = true;
    }
  }
  if (!found) console.log('Not found in any field in top 400');

  // Show all BL eBay picked orders with their key fields
  console.log('\n=== BL eBay picked orders (first 10) ===');
  const blPicked = docs.filter(d => {
    const dd = d.data();
    return dd.baselinkerId && dd.marketplace === 'ebay' && (dd.omsStatus === 'picked' || dd.status === 'picked');
  }).slice(0, 10);
  for (const d of blPicked) {
    const dd = d.data();
    console.log(`  id=${d.id} | orderId=${dd.orderId||'—'} | number=${dd.number||'—'} | externalOrderId=${dd.externalOrderId||'—'} | blOrderId=${dd.baselinkerId} | createdAt=${dd.createdAt?.slice(0,10)}`);
  }

  // Check current count of docs for 09-14368-92522
  console.log('\n=== All docs mentioning 09-14368-92522 ===');
  for (const doc of docs) {
    const str = JSON.stringify(doc.data());
    if (str.includes('09-14368-92522')) {
      const dd = doc.data();
      console.log('  id:', doc.id, '| omsStatus:', dd.omsStatus || dd.status, '| marketplaceKey:', dd.marketplaceKey || 'NONE', '| createdAt:', dd.createdAt?.slice(0,16));
    }
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
