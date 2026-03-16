#!/usr/bin/env node
'use strict';
/**
 * Force-reconcile Kaufland order statuses by querying the Kaufland API directly.
 * Targets orders with omsStatus=picked that may actually be shipped on Kaufland.
 * Run: GCLOUD_PROJECT=avycloud node backend/scripts/reconcile-kaufland-status.js
 */
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

const { mapKauflandStatus } = require('../services/order-intake-kaufland');
const { kauflandRequest } = require('../lib/kaufland-api');

const DRY_RUN = process.env.DRY_RUN !== 'false';

async function fetchOrderFromKaufland(orderId) {
  // GET /orders/{id} returns double-nested: { data: { data: { order_units: [...] } } }
  const result = await kauflandRequest('GET', `/orders/${orderId}`);
  return result?.data?.data || result?.data || result || null;
}

const OMS_RANK = {
  pending: 0, confirmed: 1, picking: 2, picked: 3, packing: 4,
  packed: 5, shipped: 6, delivered: 7, completed: 8, cancelled: 9, returned: 10,
};
const OMS_LABELS = {
  pending: 'Neu', confirmed: 'Bestätigt', picking: 'Kommissionierung',
  picked: 'Kommissioniert', packed: 'Verpackt', shipped: 'Versendet',
  delivered: 'Zugestellt', cancelled: 'Storniert', returned: 'Retoure',
};

async function main() {
  // Load all native Kaufland orders that aren't shipped/cancelled yet
  const snap = await db.collection('orders').orderBy('createdAt', 'desc').limit(2000).get();
  const targets = snap.docs.filter(d => {
    const dd = d.data();
    if (dd.marketplace !== 'kaufland') return false;
    if (!dd.marketplaceKey) return false; // native only
    const s = dd.omsStatus || dd.status;
    return s !== 'shipped' && s !== 'delivered' && s !== 'cancelled' && s !== 'returned' && s !== 'completed';
  });

  console.log(`Found ${targets.length} Kaufland orders to reconcile`);

  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const doc of targets) {
    const d = doc.data();
    const orderId = d.marketplaceOrderId;
    const currentStatus = d.omsStatus || d.status;

    try {
      const klOrder = await fetchOrderFromKaufland(orderId);
      const units = klOrder?.order_units || [];
      const unitStatus = units[0]?.status || null;
      const mappedStatus = unitStatus ? mapKauflandStatus(unitStatus) : null;

      const currentRank = OMS_RANK[currentStatus] ?? 0;
      const newRank = mappedStatus ? (OMS_RANK[mappedStatus] ?? 0) : -1;

      if (mappedStatus && mappedStatus !== currentStatus && (newRank > currentRank || mappedStatus === 'cancelled')) {
        console.log(`UPDATE ${orderId}: ${currentStatus} → ${mappedStatus} (unitStatus=${unitStatus})`);
        if (!DRY_RUN) {
          await doc.ref.update({
            omsStatus: mappedStatus,
            omsStatusLabel: OMS_LABELS[mappedStatus] || mappedStatus,
            status: mappedStatus,
            statusLabel: OMS_LABELS[mappedStatus] || mappedStatus,
            updatedAt: new Date().toISOString(),
            ...(mappedStatus === 'shipped' && !d.shippedAt ? { shippedAt: new Date().toISOString() } : {}),
          });
        }
        updated++;
      } else {
        console.log(`  OK  ${orderId}: ${currentStatus} (unitStatus=${unitStatus || 'n/a'}, mapped=${mappedStatus || 'n/a'})`);
        unchanged++;
      }
    } catch (err) {
      console.warn(`  FAIL ${orderId}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n=== Summary${DRY_RUN ? ' (DRY RUN — set DRY_RUN=false to apply)' : ''} ===`);
  console.log(`Updated: ${updated} | Unchanged: ${unchanged} | Failed: ${failed}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
