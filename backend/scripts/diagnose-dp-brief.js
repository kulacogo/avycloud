'use strict';
// Diagnose DP Brief label issue for a specific marketplace order.
// Usage: node scripts/diagnose-dp-brief.js 16-14525-45108

const { Firestore } = require('@google-cloud/firestore');
const { getSecretValue } = require('../lib/secret-values');

const db = new Firestore();
const marketplaceOrderId = process.argv[2];

if (!marketplaceOrderId) {
  console.error('Usage: node scripts/diagnose-dp-brief.js <marketplaceOrderId>');
  process.exit(1);
}

(async () => {
  console.log('=== ORDER LOOKUP ===');
  const orderSnap = await db.collection('orders')
    .where('marketplaceOrderId', '==', marketplaceOrderId)
    .limit(1)
    .get();
  if (orderSnap.empty) {
    console.log('No order with marketplaceOrderId', marketplaceOrderId);
    console.log('Trying by orderId field...');
    const bySnap = await db.collection('orders')
      .where('orderId', '==', marketplaceOrderId)
      .limit(1)
      .get();
    if (bySnap.empty) {
      console.log('Also not found by orderId. Aborting.');
      process.exit(1);
    }
    orderSnap.docs.push(...bySnap.docs);
  }
  const orderDoc = orderSnap.docs[0];
  const order = orderDoc.data();
  console.log('firestore orderId (doc.id):', orderDoc.id);
  console.log('marketplaceOrderId:', order.marketplaceOrderId);
  console.log('marketplace:', order.marketplace, '/', order.source);
  console.log('omsStatus:', order.omsStatus, '| status:', order.status);
  console.log('shipmentId:', order.shipmentId);
  console.log('trackingNumber:', order.trackingNumber);
  console.log('shippingService:', order.shippingService);
  console.log('weight:', order.weight);
  console.log('customer:', JSON.stringify(order.customer, null, 2).slice(0, 400));

  console.log('\n=== SHIPMENTS ===');
  const shipSnap = await db.collection('shipments')
    .where('orderId', '==', orderDoc.id)
    .orderBy('createdAt', 'desc')
    .limit(5)
    .get();
  console.log('count:', shipSnap.size);
  const latestShipments = [];
  shipSnap.docs.forEach(d => {
    const data = d.data();
    latestShipments.push({ id: d.id, ...data });
    console.log(`  --- shipment ${d.id} ---`);
    console.log('  sendcloudParcelId:', data.sendcloudParcelId);
    console.log('  trackingNumber:', data.trackingNumber);
    console.log('  labelUrl:', data.labelUrl);
    console.log('  carrier:', data.carrier);
    console.log('  shippingMethodId:', data.shippingMethodId);
    console.log('  status:', data.status, '/', data.statusRaw, 'id:', data.statusId);
    console.log('  createdAt:', data.createdAt);
  });

  if (!latestShipments.length) {
    console.log('\nNO SHIPMENT FOUND. Ship action likely failed before persistence.');
    return;
  }

  const parcelId = latestShipments[0].sendcloudParcelId;
  if (!parcelId) {
    console.log('\nNo parcelId on shipment — SendCloud parcel was never created.');
    return;
  }

  console.log('\n=== SENDCLOUD PARCEL ===');
  const pub = await getSecretValue('SENDCLOUD_PUBLIC_KEY');
  const sec = await getSecretValue('SENDCLOUD_SECRET_KEY');
  const auth = 'Basic ' + Buffer.from(`${pub}:${sec}`).toString('base64');

  const pRes = await fetch(`https://panel.sendcloud.sc/api/v2/parcels/${parcelId}`, {
    headers: { Authorization: auth },
  });
  console.log('GET /parcels/:id status:', pRes.status);
  if (pRes.ok) {
    const body = await pRes.json();
    const p = body.parcel || {};
    console.log('parcel.id:', p.id);
    console.log('parcel.status:', JSON.stringify(p.status));
    console.log('parcel.carrier:', JSON.stringify(p.carrier));
    console.log('parcel.shipment:', JSON.stringify(p.shipment));
    console.log('parcel.tracking_number:', p.tracking_number);
    console.log('parcel.label:', JSON.stringify(p.label, null, 2));
    console.log('parcel.documents:', JSON.stringify(p.documents, null, 2));
  } else {
    console.log('body:', (await pRes.text()).slice(0, 400));
  }

  console.log('\n=== LABEL PDF DOWNLOAD TEST ===');
  for (const printer of ['label_printer', 'normal_printer']) {
    const url = `https://panel.sendcloud.sc/api/v2/labels/${printer}/${parcelId}`;
    const r = await fetch(url, { headers: { Authorization: auth } });
    const ct = r.headers.get('content-type');
    console.log(`  ${printer}: status=${r.status} content-type=${ct}`);
    if (!r.ok) {
      console.log('    body:', (await r.text()).slice(0, 200));
    }
  }
})().catch(err => {
  console.error('DIAGNOSTIC FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
