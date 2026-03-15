#!/usr/bin/env node
'use strict';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

async function check() {
  const snap = await db.collection('products_v2').limit(200).get();
  let hasIdentSku = 0, hasDetSku = 0, hasBoth = 0, hasNeither = 0;
  for (const doc of snap.docs) {
    const p = doc.data();
    const iSku = p?.identification?.sku;
    const dSku = p?.details?.identifiers?.sku;
    if (iSku && dSku) hasBoth++;
    else if (iSku) hasIdentSku++;
    else if (dSku) hasDetSku++;
    else hasNeither++;
  }
  console.log('Total:', snap.size);
  console.log('Has BOTH identification.sku AND details.identifiers.sku:', hasBoth);
  console.log('Has ONLY identification.sku:', hasIdentSku);
  console.log('Has ONLY details.identifiers.sku:', hasDetSku);
  console.log('Has NEITHER:', hasNeither);
}
check().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
