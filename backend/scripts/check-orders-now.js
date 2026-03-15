#!/usr/bin/env node
'use strict';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

async function main() {
  // Check recent eBay orders — all docs with marketplace=ebay, looking for duplicates
  const snap = await db.collection('orders').orderBy('createdAt', 'desc').limit(300).get();

  // Separate by marketplaceKey presence
  const withKey = [];
  const withoutKey = [];
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.marketplace !== 'ebay') continue;
    if (d.marketplaceKey) withKey.push({ id: doc.id, data: d });
    else withoutKey.push({ id: doc.id, data: d });
  }

  console.log(`eBay docs WITH marketplaceKey: ${withKey.length}`);
  console.log(`eBay docs WITHOUT marketplaceKey: ${withoutKey.length}`);

  if (withoutKey.length > 0) {
    console.log('\neBay docs WITHOUT marketplaceKey (these are the "ghost" duplicates):');
    for (const { id, data: d } of withoutKey.slice(0, 20)) {
      console.log(`  doc=${id} orderId=${d.orderId} baselinkerId=${d.baselinkerId} status=${d.omsStatus||d.status} created=${d.createdAt} customer=${d.customer?.name}`);
    }
  }

  // Check for pairs by createdAt
  const byCreatedAt = {};
  for (const { id, data: d } of withKey) {
    const key = d.createdAt;
    if (!byCreatedAt[key]) byCreatedAt[key] = [];
    byCreatedAt[key].push({ id, data: d });
  }

  console.log('\nPairs with same createdAt (potential duplicates in withKey set):');
  let dupCount = 0;
  for (const [ts, docs] of Object.entries(byCreatedAt)) {
    if (docs.length > 1) {
      dupCount++;
      console.log(`  ${ts}: ${docs.map(d => d.id+'/'+d.data.marketplaceKey).join(' | ')}`);
    }
  }
  if (dupCount === 0) console.log('  None found');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
