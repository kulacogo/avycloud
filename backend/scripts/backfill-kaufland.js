#!/usr/bin/env node
'use strict';
const { syncKauflandOrders } = require('../services/order-intake-kaufland');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });

const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS || '90', 10);

async function main() {
  console.log('Kaufland backfill: last', LOOKBACK_DAYS, 'days');
  try {
    const result = await syncKauflandOrders({ tenantId: 'default', lookbackDays: LOOKBACK_DAYS });
    console.log('Result:', JSON.stringify(result));
  } catch (err) {
    console.error('Error:', err.message);
    // Try with shorter lookback
    console.log('\nRetrying with 30 days...');
    try {
      const result2 = await syncKauflandOrders({ tenantId: 'default', lookbackDays: 30 });
      console.log('Result (30d):', JSON.stringify(result2));
    } catch (err2) {
      console.error('30d also failed:', err2.message);
      // Try 14 days
      console.log('\nRetrying with 14 days...');
      const result3 = await syncKauflandOrders({ tenantId: 'default', lookbackDays: 14 });
      console.log('Result (14d):', JSON.stringify(result3));
    }
  }

  const snap = await admin.firestore().collection('orders').count().get();
  console.log('Total orders:', snap.data().count);
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
