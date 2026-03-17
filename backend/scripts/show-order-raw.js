'use strict';
const { Firestore } = require('@google-cloud/firestore');
const db = new Firestore();
const orderId = process.argv[2];

db.collection('orders').doc(orderId).get().then(d => {
  if (!d.exists) { console.log('Not found'); return; }
  const data = d.data();
  console.log('customer:', JSON.stringify(data.customer, null, 2));
  if (data.shippingAddress) console.log('shippingAddress:', JSON.stringify(data.shippingAddress, null, 2));
  if (data.buyerAddress) console.log('buyerAddress:', JSON.stringify(data.buyerAddress, null, 2));
}).catch(console.error);
