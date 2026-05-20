'use strict';
const { Firestore } = require('@google-cloud/firestore');
const db = new Firestore();

db.collection('orders').get().then(snap => {
  const allOrders = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // BL legacy docs with external_order_id
  const blDocs = allOrders.filter(o => o.baselinkerId && !o.marketplaceKey && o.raw && o.raw.external_order_id);
  // OMS docs with marketplaceOrderId
  const omsDocs = allOrders.filter(o => o.marketplaceOrderId);
  const omsIds = new Set(omsDocs.map(o => o.marketplaceOrderId));

  // Find BL docs whose external_order_id matches an OMS doc
  const dupes = blDocs.filter(o => omsIds.has(o.raw.external_order_id));

  console.log('BL docs total:', blDocs.length);
  console.log('OMS docs total:', omsDocs.length);
  console.log('BL docs that are duplicates of OMS docs:', dupes.length);
  dupes.forEach(o => {
    console.log('  BL doc:', o.id, '| external_order_id:', o.raw.external_order_id, '| status:', o.status);
  });
}).catch(console.error);
