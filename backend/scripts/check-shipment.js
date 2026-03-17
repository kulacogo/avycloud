'use strict';
const { Firestore } = require('@google-cloud/firestore');
const db = new Firestore();
const orderId = process.argv[2];

db.collection('shipments').where('orderId', '==', orderId).orderBy('createdAt', 'desc').limit(3).get().then(snap => {
  console.log('Shipments for order', orderId, ':', snap.size);
  snap.docs.forEach(d => {
    const data = d.data();
    console.log('  ID:', d.id);
    console.log('  sendcloudParcelId:', data.sendcloudParcelId);
    console.log('  trackingNumber:', data.trackingNumber);
    console.log('  labelUrl:', data.labelUrl);
    console.log('  status:', data.status, '/', data.statusRaw);
    console.log('  createdAt:', data.createdAt);
    console.log('---');
  });
}).catch(console.error);
