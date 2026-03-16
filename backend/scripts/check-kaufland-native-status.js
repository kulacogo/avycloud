#!/usr/bin/env node
'use strict';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

async function main() {
  // Native Kaufland orders have marketplaceKey
  const snap = await db.collection('orders').orderBy('createdAt', 'desc').limit(500).get();
  const native = snap.docs.filter(d => {
    const dd = d.data();
    return dd.marketplace === 'kaufland' && dd.marketplaceKey;
  });
  console.log('Native Kaufland orders:', native.length);

  const counts = {};
  for (const doc of native) {
    const d = doc.data();
    const s = d.omsStatus || d.status || 'unknown';
    counts[s] = (counts[s] || 0) + 1;
  }
  console.log('\nOMS status counts (native):');
  for (const [s, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s}: ${n}`);
  }

  // Show picked/confirmed orders with item statuses
  const nonShipped = native.filter(d => {
    const s = d.data().omsStatus || d.data().status;
    return s === 'picked' || s === 'confirmed' || s === 'pending';
  });
  console.log('\nNon-shipped native Kaufland orders:');
  for (const doc of nonShipped.slice(0, 20)) {
    const d = doc.data();
    const itemStatuses = (d.items || []).map(i => i.status || '—').join(',');
    console.log(`  [${d.omsStatus||d.status}] mpId=${d.marketplaceOrderId} itemStatuses=[${itemStatuses}] created=${d.createdAt?.slice(0,10)}`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
