'use strict';
const { Firestore } = require('@google-cloud/firestore');
const db = new Firestore();

const ORDER_ID = process.argv[2] || '15-14360-91743';

db.collection('orders').where('marketplaceOrderId', '==', ORDER_ID).get().then(snap => {
  if (snap.empty) {
    console.log('Not found by marketplaceOrderId, trying orderId field...');
    return db.collection('orders').where('orderId', '==', ORDER_ID).get();
  }
  return snap;
}).then(snap => {
  if (snap.empty) {
    console.log('Order not found:', ORDER_ID);
    return;
  }
  snap.docs.forEach(d => {
    const data = d.data();
    console.log('Firestore ID:', d.id);
    console.log('  omsStatus:', data.omsStatus);
    console.log('  status:', data.status);
    console.log('  marketplace:', data.marketplace || data.source);
    console.log('  customer:', JSON.stringify(data.customer));
    console.log('  items:', JSON.stringify((data.items || []).map(i => ({ name: i.name, sku: i.sku }))));
    console.log('  trackingNumber:', data.trackingNumber);
    console.log('  shipmentId:', data.shipmentId);
  });
}).catch(console.error);
