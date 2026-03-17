#!/usr/bin/env node
'use strict';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

async function main() {
  // Get exact fields of both dup docs
  for (const id of ['33543293', '33689483']) {
    const doc = await db.collection('orders').doc(id).get();
    if (!doc.exists) { console.log(id, 'NOT FOUND'); continue; }
    const dd = doc.data();
    console.log('\n=== Doc', id, '===');
    const fields = Object.keys(dd).sort();
    for (const f of fields) {
      const v = dd[f];
      if (Array.isArray(v)) console.log(`  ${f}: [array, len=${v.length}]`);
      else if (typeof v === 'object' && v !== null) console.log(`  ${f}: {obj}`);
      else console.log(`  ${f}: ${v}`);
    }
  }
  // Check native counterparts
  for (const id of ['1zUt26ooOhv2M7rbPPSx', 'seIvjAkeNbUJ7DcTEfTk']) {
    const doc = await db.collection('orders').doc(id).get();
    if (!doc.exists) { console.log(id, 'NOT FOUND'); continue; }
    const dd = doc.data();
    console.log('\n=== Native doc', id, '===');
    const fields = ['omsStatus', 'status', 'marketplaceKey', 'marketplaceOrderId', 'number', 'source', 'orderSource', 'createdAt', 'baselinkerId', 'orderId'];
    for (const f of fields) {
      console.log(`  ${f}: ${dd[f] !== undefined ? dd[f] : 'UNDEFINED'}`);
    }
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
