#!/usr/bin/env node
'use strict';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

async function main() {
  // Load all orders in memory for filtering
  const allSnap = await db.collection('orders').orderBy('createdAt', 'desc').limit(500).get();
  const docs1 = allSnap.docs;
  const allSnap2 = await db.collection('orders').orderBy('createdAt', 'asc').limit(500).get();
  const docs2 = allSnap2.docs;
  // Merge unique docs
  const seenIds = new Set();
  const allDocs = [];
  for (const d of [...docs1, ...docs2]) {
    if (!seenIds.has(d.id)) { seenIds.add(d.id); allDocs.push(d); }
  }
  console.log('Total unique docs loaded:', allDocs.length);

  // 1. Find ALL docs related to eBay order 09-14368-92522
  console.log('\n=== 09-14368-92522 ALL related docs ===');
  const related = allDocs.filter(d => {
    const dd = d.data();
    return dd.marketplaceOrderId === '09-14368-92522' ||
           dd.externalOrderId === '09-14368-92522' ||
           dd.orderId === '09-14368-92522';
  });
  console.log('Found:', related.length);
  related.forEach(d => {
    const dd = d.data();
    console.log('  id:', d.id, '| omsStatus:', dd.omsStatus || dd.status, '| marketplaceKey:', dd.marketplaceKey || 'NONE', '| baselinkerId:', dd.baselinkerId || 'NONE', '| createdAt:', dd.createdAt ? dd.createdAt.slice(0,16) : 'none');
  });

  // 2. Find cancelled eBay order 19-14202-50540
  console.log('\n=== 19-14202-50540 search ===');
  const c1 = allDocs.filter(d => {
    const dd = d.data();
    return dd.marketplaceOrderId === '19-14202-50540' || dd.orderId === '19-14202-50540' || dd.externalOrderId === '19-14202-50540';
  });
  console.log('Found:', c1.length);
  c1.forEach(d => {
    const dd = d.data();
    console.log('  id:', d.id, '| omsStatus:', dd.omsStatus || dd.status, '| marketplace:', dd.marketplace, '| marketplaceOrderId:', dd.marketplaceOrderId || 'NONE', '| orderId:', dd.orderId || 'NONE');
  });

  // 3. Status distribution (all loaded docs)
  console.log('\n=== Status distribution ===');
  const counts = {};
  allDocs.forEach(d => {
    const dd = d.data();
    const s = dd.omsStatus || dd.status || 'unknown';
    counts[s] = (counts[s] || 0) + 1;
  });
  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([s, n]) => console.log(`  ${s}: ${n}`));

  // 4. eBay picked orders
  console.log('\n=== eBay picked/Kommissioniert orders ===');
  const pickedEbay = allDocs.filter(d => {
    const dd = d.data();
    return dd.marketplace === 'ebay' && (dd.omsStatus === 'picked' || (dd.status === 'picked' && !dd.omsStatus));
  });
  console.log('Count:', pickedEbay.length);
  pickedEbay.slice(0, 10).forEach(d => {
    const dd = d.data();
    console.log('  id:', d.id, '| mpOrderId:', dd.marketplaceOrderId || 'NONE', '| marketplaceKey:', dd.marketplaceKey || 'NONE', '| baselinkerId:', dd.baselinkerId || 'NONE', '| createdAt:', dd.createdAt ? dd.createdAt.slice(0, 10) : 'none');
  });

  // 5. BL-ebay orders with status picked (no marketplaceKey)
  console.log('\n=== BL-imported eBay orders with status=picked ===');
  const blPicked = allDocs.filter(d => {
    const dd = d.data();
    return dd.marketplace === 'ebay' && dd.baselinkerId && dd.status === 'picked';
  });
  console.log('Count:', blPicked.length);
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
