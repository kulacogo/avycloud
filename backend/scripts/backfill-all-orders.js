#!/usr/bin/env node
'use strict';
/**
 * Full backfill: sync all eBay + Kaufland orders for the last 90 days.
 * Run once after purging BL docs to restore all native order history.
 */
const { syncEbayOrders } = require('../services/order-intake-ebay');
const { syncKauflandOrders } = require('../services/order-intake-kaufland');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });

const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS || '90', 10);

async function main() {
  console.log(`Starting backfill: last ${LOOKBACK_DAYS} days`);
  console.log('Time:', new Date().toISOString());

  console.log('\n=== eBay sync ===');
  try {
    const ebayResult = await syncEbayOrders({ tenantId: 'default', lookbackDays: LOOKBACK_DAYS });
    console.log('eBay result:', JSON.stringify(ebayResult));
  } catch (err) {
    console.error('eBay sync failed:', err.message);
  }

  console.log('\n=== Kaufland sync ===');
  try {
    const klResult = await syncKauflandOrders({ tenantId: 'default', lookbackDays: LOOKBACK_DAYS });
    console.log('Kaufland result:', JSON.stringify(klResult));
  } catch (err) {
    console.error('Kaufland sync failed:', err.message);
  }

  const snap = await admin.firestore().collection('orders').count().get();
  console.log('\nTotal orders in Firestore after backfill:', snap.data().count);
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
