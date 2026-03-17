#!/usr/bin/env node
'use strict';
/**
 * Purge ALL BL-imported order docs from Firestore.
 * BL docs: have baselinkerId field, no marketplaceKey field.
 * These are legacy BaseLinker imports that duplicate native eBay/Kaufland docs.
 */
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();
const DRY_RUN = process.env.DRY_RUN !== 'false';

async function main() {
  const snap = await db.collection('orders').get();
  const blDocs = snap.docs.filter(d => {
    const dd = d.data();
    return dd.baselinkerId && !dd.marketplaceKey;
  });
  console.log(`Total orders: ${snap.size} | BL docs to delete: ${blDocs.length}`);

  if (blDocs.length === 0) { console.log('Nothing to delete.'); return; }

  const batch = db.batch();
  blDocs.forEach(d => batch.delete(d.ref));
  if (!DRY_RUN) {
    await batch.commit();
    console.log(`DELETED ${blDocs.length} BL docs`);
  } else {
    console.log(`DRY RUN — would delete ${blDocs.length} BL docs`);
    blDocs.slice(0, 10).forEach(d => console.log(`  ${d.id} | number=${d.data().number||'—'} | status=${d.data().status}`));
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
