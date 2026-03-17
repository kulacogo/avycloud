#!/usr/bin/env node
'use strict';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

async function main() {
  const snap = await db.collection('orders').orderBy('createdAt', 'desc').limit(500).get();
  const docs = snap.docs;
  console.log('Total docs:', docs.length);

  // Find all docs for 09-14368-92522 and 17-14364-70950
  const targets = ['09-14368-92522', '17-14364-70950'];
  for (const t of targets) {
    const related = docs.filter(d => JSON.stringify(d.data()).includes(t));
    console.log(`\n=== ${t} (${related.length} docs) ===`);
    related.forEach(d => {
      const dd = d.data();
      console.log(`  id=${d.id} | omsStatus=${dd.omsStatus||dd.status} | marketplaceKey=${dd.marketplaceKey||'NONE'} | baselinkerId=${dd.baselinkerId||'NONE'} | marketplaceOrderId=${dd.marketplaceOrderId||'NONE'} | number=${dd.number||'NONE'} | createdAt=${dd.createdAt?.slice(0,16)}`);
    });
  }

  // Find all duplicate marketplaceOrderIds
  console.log('\n=== Duplicate marketplaceOrderIds ===');
  const byOrderId = {};
  docs.forEach(d => {
    const mid = d.data().marketplaceOrderId;
    if (mid && mid !== '-') {
      if (!byOrderId[mid]) byOrderId[mid] = [];
      byOrderId[mid].push(d);
    }
  });
  const dupes = Object.entries(byOrderId).filter(([, ds]) => ds.length > 1);
  console.log('Duplicate marketplaceOrderId groups:', dupes.length);
  dupes.forEach(([mid, ds]) => {
    console.log(`  ${mid}:`);
    ds.forEach(d => {
      const dd = d.data();
      console.log(`    id=${d.id} | omsStatus=${dd.omsStatus||dd.status} | marketplaceKey=${dd.marketplaceKey||'NONE'} | createdAt=${dd.createdAt?.slice(0,16)}`);
    });
  });

  // Check number field duplicates for docs without marketplaceKey
  console.log('\n=== Docs with same number but different ids ===');
  const byNumber = {};
  docs.forEach(d => {
    const num = d.data().number;
    if (num && num !== '-' && !d.data().marketplaceKey) {
      if (!byNumber[num]) byNumber[num] = [];
      byNumber[num].push(d);
    }
  });
  const numDupes = Object.entries(byNumber).filter(([, ds]) => ds.length > 1);
  console.log('Duplicate number groups (no marketplaceKey):', numDupes.length);
  numDupes.slice(0, 5).forEach(([num, ds]) => {
    console.log(`  ${num}:`);
    ds.forEach(d => console.log(`    id=${d.id} | omsStatus=${d.data().omsStatus||d.data().status}`));
  });
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
