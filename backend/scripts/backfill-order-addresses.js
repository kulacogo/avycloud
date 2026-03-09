#!/usr/bin/env node

/**
 * Backfill missing address fields for BaseLinker-imported orders.
 *
 * BaseLinker orders imported before the BUG-022 fix have empty
 * street/zip/phone/email in customer data. This script reads the
 * raw BaseLinker data stored in each order's `raw` field and
 * backfills the missing address fields.
 *
 * Usage:
 *   node backend/scripts/backfill-order-addresses.js
 *   node backend/scripts/backfill-order-addresses.js --dry-run
 */

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'avycloud-hub',
  });
}

const firestore = admin.firestore();
const ORDERS_COLLECTION = 'orders';
const dryRun = process.argv.includes('--dry-run');

async function backfillOrderAddresses() {
  console.log(`[backfill-order-addresses] Starting... ${dryRun ? '(DRY RUN)' : ''}`);

  const snap = await firestore.collection(ORDERS_COLLECTION).get();
  console.log(`[backfill-order-addresses] Found ${snap.size} orders total`);

  let checked = 0;
  let repaired = 0;
  let skippedNoRaw = 0;
  let skippedComplete = 0;
  let errors = 0;

  for (const doc of snap.docs) {
    checked++;
    const order = doc.data();
    const customer = order?.customer || {};
    const raw = order?.raw;

    // Skip if address already complete
    if (customer.street && customer.zip && customer.phone) {
      skippedComplete++;
      continue;
    }

    // Skip if no raw data to extract from
    if (!raw) {
      skippedNoRaw++;
      continue;
    }

    // Extract missing fields from raw BaseLinker data
    const updates = {};
    let changed = false;

    if (!customer.street) {
      const street = [raw.delivery_address, raw.delivery_address2].filter(Boolean).join(', ')
        || [raw.invoice_address, raw.invoice_address2].filter(Boolean).join(', ')
        || null;
      if (street) {
        updates['customer.street'] = street;
        changed = true;
      }
    }

    if (!customer.zip) {
      const zip = raw.delivery_postcode || raw.invoice_postcode || null;
      if (zip) {
        updates['customer.zip'] = zip;
        changed = true;
      }
    }

    if (!customer.phone) {
      const phone = raw.delivery_phone || raw.invoice_phone || raw.phone || null;
      if (phone) {
        updates['customer.phone'] = phone;
        changed = true;
      }
    }

    if (!customer.email) {
      const email = raw.email || raw.invoice_email || null;
      if (email) {
        updates['customer.email'] = email;
        changed = true;
      }
    }

    if (!changed) {
      skippedComplete++;
      continue;
    }

    if (dryRun) {
      console.log(`  [DRY] Would update order ${doc.id}:`, updates);
      repaired++;
      continue;
    }

    try {
      await firestore.collection(ORDERS_COLLECTION).doc(doc.id).update(updates);
      repaired++;
      if (repaired % 50 === 0) {
        console.log(`  ... ${repaired} orders repaired so far`);
      }
    } catch (err) {
      console.error(`  ERROR updating order ${doc.id}:`, err.message);
      errors++;
    }
  }

  console.log(`\n[backfill-order-addresses] Done!`);
  console.log(`  Checked: ${checked}`);
  console.log(`  Repaired: ${repaired}`);
  console.log(`  Skipped (already complete): ${skippedComplete}`);
  console.log(`  Skipped (no raw data): ${skippedNoRaw}`);
  console.log(`  Errors: ${errors}`);
}

backfillOrderAddresses()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[backfill-order-addresses] Fatal error:', err);
    process.exit(1);
  });
