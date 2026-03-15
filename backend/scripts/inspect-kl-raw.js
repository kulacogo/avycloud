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

  for (const doc of blKl.slice(0, 3)) {
    const d = doc.data();
    console.log(`\n=== doc=${doc.id} created=${d.createdAt} ===`);
    const raw = d.raw || {};
    // Print top-level raw fields (non-nested)
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v !== 'object') console.log(`  raw.${k} = ${v}`);
    }
    // Print raw keys
    console.log(`  raw keys: ${Object.keys(raw).join(', ')}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
