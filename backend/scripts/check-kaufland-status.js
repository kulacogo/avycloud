#!/usr/bin/env node
'use strict';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

async function main() {
  const snap = await db.collection('orders').where('marketplace', '==', 'kaufland').limit(500).get();
  const counts = {};
  const sampleByStatus = {};

  for (const doc of snap.docs) {
    const d = doc.data();
    const s = d.omsStatus || d.status || 'unknown';
    counts[s] = (counts[s] || 0) + 1;
    if (!sampleByStatus[s]) {
      const itemStatuses = (d.items || []).map(i => i.status).filter(Boolean);
      sampleByStatus[s] = { id: doc.id, mpId: d.marketplaceOrderId, itemStatuses, createdAt: d.createdAt };
    }
  }

  console.log('Total Kaufland orders:', snap.size);
  console.log('\nOMS status counts:');
  for (const [s, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s}: ${n}`);
  }
  console.log('\nSample per status (first occurrence):');
  for (const [s, sample] of Object.entries(sampleByStatus)) {
    console.log(`  [${s}] doc=${sample.id} mpId=${sample.mpId} itemStatuses=[${sample.itemStatuses.join(',')}] created=${sample.createdAt}`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
