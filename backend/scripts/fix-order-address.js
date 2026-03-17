'use strict';
/**
 * fix-order-address.js
 * Manually fix a customer address field on an order.
 * Usage: node scripts/fix-order-address.js <firestoreDocId> <street> [city] [zip]
 */
const { Firestore } = require('@google-cloud/firestore');
const db = new Firestore();

const orderId = process.argv[2];
const street = process.argv[3];
const city = process.argv[4];
const zip = process.argv[5];

if (!orderId || !street) {
  console.error('Usage: node scripts/fix-order-address.js <firestoreDocId> <street> [city] [zip]');
  process.exit(1);
}

async function main() {
  const snap = await db.collection('orders').doc(orderId).get();
  if (!snap.exists) { console.error('Order not found:', orderId); process.exit(1); }

  const current = snap.data();
  const updatedCustomer = { ...current.customer, street };
  if (city) updatedCustomer.city = city;
  if (zip !== undefined) updatedCustomer.zip = String(zip);

  await snap.ref.update({ customer: updatedCustomer });
  console.log(`Updated customer for ${orderId}:`);
  console.log('  street:', updatedCustomer.street);
  console.log('  city:', updatedCustomer.city);
  console.log('  zip:', updatedCustomer.zip);
}

main().catch(err => { console.error(err); process.exit(1); });
