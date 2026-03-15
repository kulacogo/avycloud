#!/usr/bin/env node
'use strict';
/**
 * Check Kaufland orders for BaseLinker-style duplicates.
 * Run from backend/ directory:
 *   GCLOUD_PROJECT=avycloud node backend/scripts/check-kaufland-dupes.js
 */
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

async function main() {
  const snap = await db.collection('orders').orderBy('createdAt', 'desc').limit(500).get();
  const klDocs = snap.docs.filter(d => d.data().marketplace === 'kaufland');
  console.log(`Total in batch: ${snap.size}, Kaufland: ${klDocs.length}\n`);

  // Separate BL-style (no marketplaceKey, has baselinkerId) vs native
  const blDocs = klDocs.filter(d => { const dd = d.data(); return dd.baselinkerId && !dd.marketplaceKey; });
  const nativeDocs = klDocs.filter(d => d.data().marketplaceKey);

  console.log(`Old BaseLinker Kaufland docs: ${blDocs.length}`);
  console.log(`Native Kaufland docs: ${nativeDocs.length}`);

  // Check for matching pairs by createdAt
  const nativeByCreatedAt = {};
  for (const doc of nativeDocs) {
    const key = doc.data().createdAt;
    if (key) nativeByCreatedAt[key] = doc;
  }

  let pairs = 0, unmatched = 0;
  for (const blDoc of blDocs) {
    const bd = blDoc.data();
    const pair = nativeByCreatedAt[bd.createdAt];
    if (pair) {
      pairs++;
      console.log(`PAIR: BL:${blDoc.id}(${bd.status}) → KL:${pair.id}(${pair.data().omsStatus||pair.data().status}) | ${bd.customer?.name} | ${bd.createdAt}`);
    } else {
      unmatched++;
    }
  }

  console.log(`\nPairs (duplicates): ${pairs}`);
  console.log(`Unmatched BL Kaufland docs (no counterpart): ${unmatched}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
