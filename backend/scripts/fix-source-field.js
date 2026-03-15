#!/usr/bin/env node
'use strict';

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

const KNOWN = new Set(['ebay', 'kaufland', 'amazon', 'otto', 'shopify']);

async function fix() {
  const snap = await db.collection('orders').where('source', '==', 'baselinker').get();
  console.log('Found', snap.size, 'orders with source=baselinker');

  let fixed = 0;
  let batch = db.batch();
  let count = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const mp = String(data.marketplace || '').toLowerCase();
    if (KNOWN.has(mp)) {
      batch.update(doc.ref, { source: mp });
      count++;
      fixed++;
      if (count >= 400) {
        await batch.commit();
        batch = db.batch();
        count = 0;
      }
    }
  }
  if (count > 0) await batch.commit();
  console.log('Fixed source field for', fixed, 'orders');
}

fix().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
