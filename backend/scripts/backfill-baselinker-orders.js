#!/usr/bin/env node

/**
 * backfill-baselinker-orders.js — BUG-040
 *
 * Historische BaseLinker-Orders in Firestore haben `source: 'baselinker'` und
 * fehlende/falsche Felder: marketplace, Adresse, Zahlung, Status.
 *
 * Dieses Script:
 * 1. Findet alle Orders mit source === 'baselinker' (oder fehlendem marketplace-Feld)
 * 2. Bestimmt marketplace aus raw.order_source (ebay/kaufland)
 * 3. Backfilled Adresse aus raw.delivery_* Feldern
 * 4. Backfilled payment-Felder aus raw.payment_method / raw.date_pay_finish
 * 5. Mappt omsStatus vom BL-Status falls noch auf einem Legacy-Wert
 *
 * Usage:
 *   node backend/scripts/backfill-baselinker-orders.js
 *   node backend/scripts/backfill-baselinker-orders.js --dry-run
 *   node backend/scripts/backfill-baselinker-orders.js --limit 50
 */

'use strict';

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'avycloud-hub',
  });
}

const firestore = admin.firestore();
const ORDERS_COLLECTION = 'orders';

const dryRun = process.argv.includes('--dry-run');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0; // 0 = no limit

// Map BaseLinker order_source to AvyCloud marketplace key
function mapBLSourceToMarketplace(orderSource) {
  if (!orderSource) return null;
  const src = String(orderSource).toLowerCase();
  if (src.includes('ebay')) return 'ebay';
  if (src.includes('kaufland') || src.includes('real.de') || src.includes('real')) return 'kaufland';
  if (src.includes('amazon')) return 'amazon';
  if (src.includes('otto')) return 'otto';
  if (src.includes('shopify') || src.includes('shop')) return 'shopify';
  return src; // Keep as-is if unknown
}

// Map BaseLinker status (numeric or string) to OMS status
// BL statuses are user-defined; we use common status names as hints
function mapBLStatusToOms(raw) {
  const statusName = String(raw.order_status_name || '').toLowerCase();
  // Very conservative: only override if clearly terminal states
  if (statusName.includes('storniert') || statusName.includes('cancel') || statusName.includes('cancelled')) {
    return 'cancelled';
  }
  if (statusName.includes('versendet') || statusName.includes('shipped') || statusName.includes('verschickt')) {
    return 'shipped';
  }
  if (statusName.includes('abgeschlossen') || statusName.includes('completed') || statusName.includes('erledigt')) {
    return 'completed';
  }
  return null; // Don't override if unclear
}

// Extract address fields from BaseLinker raw order
function extractAddress(raw) {
  const updates = {};

  const name = raw.delivery_fullname || raw.delivery_company || raw.invoice_fullname || raw.invoice_company || null;
  const street = [raw.delivery_address, raw.delivery_address2].filter(Boolean).join(', ')
    || [raw.invoice_address, raw.invoice_address2].filter(Boolean).join(', ')
    || null;
  const city = raw.delivery_city || raw.invoice_city || null;
  const zip = raw.delivery_postcode || raw.invoice_postcode || null;
  const country = raw.delivery_country_code || raw.invoice_country_code || 'DE';
  const phone = raw.delivery_phone || raw.invoice_phone || raw.phone || null;
  const email = raw.email || raw.invoice_email || null;

  if (name) updates['customer.name'] = name;
  if (street) updates['customer.street'] = street;
  if (city) updates['customer.city'] = city;
  if (zip) updates['customer.zip'] = zip;
  if (country) updates['customer.country'] = country;
  if (phone) updates['customer.phone'] = phone;
  if (email) updates['customer.email'] = email;

  return updates;
}

// Extract payment fields from BaseLinker raw order
function extractPayment(raw) {
  const updates = {};

  if (raw.payment_method) {
    updates.paymentMethod = String(raw.payment_method);
  }

  // BL timestamps are Unix seconds
  if (raw.date_pay_finish && parseInt(raw.date_pay_finish, 10) > 0) {
    updates.paidAt = new Date(parseInt(raw.date_pay_finish, 10) * 1000).toISOString();
  } else if (raw.date_confirmed && parseInt(raw.date_confirmed, 10) > 0) {
    // Fallback: use confirmed date as paidAt estimate
    updates.paidAt = new Date(parseInt(raw.date_confirmed, 10) * 1000).toISOString();
  }

  return updates;
}

// Extract external order ID from BaseLinker raw order
function extractExternalOrderId(raw, marketplace) {
  // BL stores the external (marketplace) order ID in order_source_info or extra fields
  if (raw.order_source_info) return String(raw.order_source_info);
  if (raw.extra_field_1) return String(raw.extra_field_1);
  if (raw.extra_field_2) return String(raw.extra_field_2);
  return null;
}

async function backfillBaselinkerOrders() {
  console.log(`[backfill-bl-orders] Starting... ${dryRun ? '(DRY RUN)' : ''}${LIMIT ? ` (limit: ${LIMIT})` : ''}`);

  // Query: orders where source is 'baselinker'
  let query = firestore.collection(ORDERS_COLLECTION).where('source', '==', 'baselinker');
  if (LIMIT > 0) query = query.limit(LIMIT);

  const snap = await query.get();
  console.log(`[backfill-bl-orders] Found ${snap.size} orders with source='baselinker'`);

  if (snap.size === 0) {
    console.log('[backfill-bl-orders] Nothing to do. All orders already migrated.');
    return;
  }

  let checked = 0;
  let repaired = 0;
  let skippedNoRaw = 0;
  let errors = 0;

  const stats = {
    marketplaceSet: 0,
    addressRepaired: 0,
    paymentRepaired: 0,
    statusOverridden: 0,
  };

  for (const doc of snap.docs) {
    checked++;
    const order = doc.data();
    const raw = order?.raw;

    if (!raw) {
      console.log(`  [SKIP] ${doc.id} — no raw data`);
      skippedNoRaw++;
      continue;
    }

    const updates = {};
    let changed = false;

    // 1. Set marketplace from raw.order_source
    const detectedMarketplace = mapBLSourceToMarketplace(raw.order_source);
    if (detectedMarketplace && !order.marketplace) {
      updates.marketplace = detectedMarketplace;
      updates.source = detectedMarketplace; // also fix source
      changed = true;
      stats.marketplaceSet++;
    } else if (detectedMarketplace && order.marketplace === 'baselinker') {
      updates.marketplace = detectedMarketplace;
      updates.source = detectedMarketplace;
      changed = true;
      stats.marketplaceSet++;
    }

    // 2. External order ID
    const extId = extractExternalOrderId(raw, detectedMarketplace);
    if (extId && !order.externalOrderId) {
      updates.externalOrderId = extId;
      updates.marketplaceOrderId = extId;
      changed = true;
    }

    // 3. Address fields (only fill missing)
    const customer = order.customer || {};
    const addrUpdates = extractAddress(raw);
    let addrChanged = false;
    for (const [key, val] of Object.entries(addrUpdates)) {
      const field = key.replace('customer.', '');
      if (!customer[field] && val) {
        updates[key] = val;
        addrChanged = true;
      }
    }
    if (addrChanged) {
      changed = true;
      stats.addressRepaired++;
    }

    // 4. Payment fields (only fill missing)
    const payUpdates = extractPayment(raw);
    let payChanged = false;
    if (payUpdates.paymentMethod && !order.paymentMethod) {
      updates.paymentMethod = payUpdates.paymentMethod;
      payChanged = true;
    }
    if (payUpdates.paidAt && !order.paidAt) {
      updates.paidAt = payUpdates.paidAt;
      payChanged = true;
    }
    if (payChanged) {
      changed = true;
      stats.paymentRepaired++;
    }

    // 5. OMS status override (conservative — only for clearly terminal BL states)
    const mappedOmsStatus = mapBLStatusToOms(raw);
    if (mappedOmsStatus && order.omsStatus !== mappedOmsStatus) {
      // Only override if current omsStatus is a 'pending' variant (not already advanced)
      const advancedStatuses = ['picked', 'packing', 'packed', 'shipped', 'delivered', 'completed', 'cancelled'];
      if (!advancedStatuses.includes(order.omsStatus)) {
        updates.omsStatus = mappedOmsStatus;
        changed = true;
        stats.statusOverridden++;
      }
    }

    if (!changed) {
      // Already complete enough, just log
      continue;
    }

    if (dryRun) {
      console.log(`  [DRY] ${doc.id} (BL-src: ${raw.order_source} → ${detectedMarketplace}):`, JSON.stringify(updates, null, 2));
      repaired++;
      continue;
    }

    try {
      await firestore.collection(ORDERS_COLLECTION).doc(doc.id).update(updates);
      repaired++;
      if (repaired % 25 === 0) {
        console.log(`  ... ${repaired} orders repaired so far`);
      }
    } catch (err) {
      console.error(`  ERROR updating order ${doc.id}:`, err.message);
      errors++;
    }
  }

  console.log('\n[backfill-bl-orders] Done!');
  console.log(`  Checked:           ${checked}`);
  console.log(`  Repaired:          ${repaired}`);
  console.log(`  Skipped (no raw):  ${skippedNoRaw}`);
  console.log(`  Errors:            ${errors}`);
  console.log('  Details:');
  console.log(`    marketplace set:    ${stats.marketplaceSet}`);
  console.log(`    address repaired:   ${stats.addressRepaired}`);
  console.log(`    payment repaired:   ${stats.paymentRepaired}`);
  console.log(`    status overridden:  ${stats.statusOverridden}`);
}

backfillBaselinkerOrders()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[backfill-bl-orders] Fatal error:', err);
    process.exit(1);
  });
