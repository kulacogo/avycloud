#!/usr/bin/env node
'use strict';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

async function main() {
  const snap = await db.collection('orders').orderBy('createdAt', 'desc').limit(200).get();
  const blKl = snap.docs.filter(d => {
    const dd = d.data();
    return dd.marketplace === 'kaufland' && dd.baselinkerId && !dd.marketplaceKey;
  });
  console.log(`\nSample Kaufland BL orders (first 5):`);
  for (const doc of blKl.slice(0, 5)) {
    const d = doc.data();
    console.log(`  doc=${doc.id} blId=${d.baselinkerId} mpId=${d.marketplaceOrderId} extId=${d.externalOrderId} status=${d.status} created=${d.createdAt} customer=${d.customer?.name}`);
    console.log(`  keys: ${Object.keys(d).join(', ')}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
