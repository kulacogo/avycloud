'use strict';

/**
 * refund-sync.js — Detect marketplace refunds (money returned to buyers, with
 * or without a return) and create a GoBD-correct correction invoice
 * (Teil-Gutschrift / Stornorechnung) for each, so the invoice reflects the
 * reduced revenue + VAT.
 *
 * Sources: eBay Finances API (transactionType REFUND) + Kaufland bookings
 * (refund-text entries). Each refund is matched to its order's invoice and
 * passed to createCorrectionInvoice({type:'gutschrift'}).
 *
 * SAFETY:
 *   - Idempotent per refund: every marketplace refundId is recorded in the
 *     `refund_corrections` collection; a refund is never processed twice.
 *   - SINCE cutoff: only refunds within the lookback window are processed, so
 *     enabling this does NOT mass-correct the entire history at once. Historical
 *     backfill is a separate, explicit run.
 *   - Refunds whose order/invoice can't be found are recorded as 'no_order'
 *     (logged, not retried forever) for manual handling.
 *
 * Known limitation: createCorrectionInvoice enforces one correction per order;
 * if an order receives MULTIPLE partial refunds, only the first is auto-booked,
 * the rest are recorded as 'skipped_existing_correction' for manual handling.
 */

const { Firestore } = require('@google-cloud/firestore');

const COLL = 'refund_corrections';
const ORDERS = 'orders';
const INVOICES = 'invoices';

let _db;
function getDb() {
  if (!_db) _db = new Firestore();
  return _db;
}

function ymd(d) {
  return new Date(d).toISOString().split('T')[0];
}

/**
 * Resolve the AvyCloud order doc id for a marketplace refund.
 * Order doc ids follow `<marketplace>__<orderNumber>`; fall back to looking up
 * the invoice by orderNumber to read its orderId.
 */
async function resolveOrderDocId(db, tenantId, refund) {
  const guess = `${refund.marketplace}__${refund.orderId}`;
  const o = await db.collection(ORDERS).doc(guess).get();
  if (o.exists && (o.data().tenantId || 'default') === tenantId) return guess;

  const inv = await db.collection(INVOICES)
    .where('tenantId', '==', tenantId)
    .where('orderNumber', '==', refund.orderId)
    .limit(1)
    .get();
  if (!inv.empty) return inv.docs[0].data().orderId || null;
  return null;
}

/**
 * Sync marketplace refunds → correction invoices.
 * @param {{ tenantId?: string, sinceDate?: string, lookbackDays?: number }} opts
 */
async function syncRefunds({ tenantId = 'default', sinceDate = null, lookbackDays = 14 } = {}) {
  const db = getDb();
  const to = ymd(Date.now());
  const from = sinceDate || ymd(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  const results = { from, to, ebay: 0, kaufland: 0, corrected: 0, skipped: 0, noOrder: 0, errors: [] };
  const refunds = [];

  try {
    const { getEbayRefunds } = require('../lib/ebay-finances');
    const eb = await getEbayRefunds(from, to);
    if (Array.isArray(eb)) { for (const r of eb) refunds.push({ ...r, marketplace: 'ebay' }); results.ebay = eb.length; }
  } catch (err) { results.errors.push({ src: 'ebay', error: err.message }); }

  try {
    const { getKauflandRefunds } = require('../lib/kaufland-api');
    const kl = await getKauflandRefunds({ from, to });
    if (Array.isArray(kl)) { for (const r of kl) refunds.push({ ...r, marketplace: 'kaufland' }); results.kaufland = kl.length; }
  } catch (err) { results.errors.push({ src: 'kaufland', error: err.message }); }

  const { createCorrectionInvoice } = require('./invoice-engine');

  for (const r of refunds) {
    if (!r.orderId || !r.amount) { results.skipped++; continue; }

    const key = `${tenantId}__${r.marketplace}__${r.refundId}`.replace(/[^a-zA-Z0-9_]/g, '_');
    const ref = db.collection(COLL).doc(key);
    const existing = await ref.get();
    if (existing.exists) { results.skipped++; continue; } // already processed

    const orderDocId = await resolveOrderDocId(db, tenantId, r);
    if (!orderDocId) {
      await ref.set({ tenantId, ...r, status: 'no_order', createdAt: new Date().toISOString() }, { merge: true });
      results.noOrder++;
      continue;
    }

    try {
      const res = await createCorrectionInvoice({
        orderId: orderDocId,
        tenantId,
        type: 'gutschrift',
        refundAmount: r.amount,
        reason: `Erstattung ${r.marketplace} ${r.orderId} (${r.amount.toFixed(2)} ${r.currency || 'EUR'})`,
      });
      const status = !res.ok ? (res.reason || 'failed')
        : res.skipped ? 'skipped_existing_correction'
        : 'corrected';
      await ref.set({ tenantId, ...r, orderDocId, status, correctionId: res.correctionId || null, createdAt: new Date().toISOString() }, { merge: true });
      if (status === 'corrected') results.corrected++; else results.skipped++;
    } catch (err) {
      results.errors.push({ refundId: r.refundId, error: err.message });
    }
  }

  console.log(`[refund-sync] tenant=${tenantId} ${from}–${to}: ebay=${results.ebay} kaufland=${results.kaufland} corrected=${results.corrected} skipped=${results.skipped} noOrder=${results.noOrder} errors=${results.errors.length}`);
  return results;
}

module.exports = { syncRefunds, resolveOrderDocId };
