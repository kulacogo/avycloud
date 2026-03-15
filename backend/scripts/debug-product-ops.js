#!/usr/bin/env node
'use strict';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

async function check() {
  const snap = await db.collection('products_v2').limit(500).get();
  let hasKauflandUnitId = 0;
  let hasEbayItemId = 0;
  let hasOps = 0;
  const total = snap.size;
  for (const doc of snap.docs) {
    const p = doc.data();
    const klId = p?.ops?.kaufland?.unitId || p?.ops?.kaufland?.id_unit || p?.marketplace?.kaufland?.unitId;
    const ebayId = p?.ops?.ebay?.itemId || p?.ops?.ebay?.item_id || p?.marketplace?.ebay?.itemId;
    if (klId) hasKauflandUnitId++;
    if (ebayId) hasEbayItemId++;
    if (p?.ops) hasOps++;
  }
  console.log('Total products checked:', total);
  console.log('Has ops.kaufland.unitId:', hasKauflandUnitId);
  console.log('Has ops.ebay.itemId:', hasEbayItemId);
  console.log('Has any ops field:', hasOps);
}
check().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
