#!/usr/bin/env node
'use strict';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

async function main() {
  // Check for duplicate 09-14368-92522
  const snap = await db.collection('orders').where('marketplaceOrderId', '==', '09-14368-92522').get();
  console.log('Docs with marketplaceOrderId=09-14368-92522:', snap.size);
  snap.docs.forEach(d => {
    const dd = d.data();
    console.log('  id:', d.id, '| omsStatus:', dd.omsStatus || dd.status, '| marketplaceKey:', dd.marketplaceKey || 'NONE', '| baselinkerId:', dd.baselinkerId || 'NONE', '| createdAt:', dd.createdAt ? dd.createdAt.slice(0,16) : 'none');
  });

  // Count total orders
  const countSnap = await db.collection('orders').count().get();
  console.log('\nTotal orders in Firestore:', countSnap.data().count);

  // Count picked
  const pickSnap = await db.collection('orders').where('omsStatus', '==', 'picked').count().get();
  console.log('Total picked (omsStatus=picked):', pickSnap.data().count);
  const pickSnap2 = await db.collection('orders').where('status', '==', 'picked').count().get();
  console.log('Total picked (status=picked):', pickSnap2.data().count);

  // Check 19-14202-50540
  const snap2 = await db.collection('orders').where('marketplaceOrderId', '==', '19-14202-50540').get();
  console.log('\nDocs with marketplaceOrderId=19-14202-50540:', snap2.size);
  snap2.docs.forEach(d => {
    const dd = d.data();
    console.log('  id:', d.id, '| omsStatus:', dd.omsStatus || dd.status, '| marketplace:', dd.marketplace);
  });
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
