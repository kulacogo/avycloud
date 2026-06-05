'use strict';

/**
 * refund-sync.js — Detect marketplace refunds (eBay + Kaufland) and RAISE A
 * NOTIFICATION (bell alert) for each so a human issues the correction invoice
 * (Teil-Gutschrift). It does NOT auto-book anything — the VAT-relevant amount
 * needs manual confirmation.
 *
 * Amount shown (the revenue/VAT reduction):
 *   - eBay:     invoice gross − current eBay order total (= what the BUYER got
 *               back; eBay's Trading-API RefundAmount is the seller-net figure
 *               after fee credits and is NOT VAT-correct, so we derive it).
 *   - Kaufland: the refund amount from the bookings report (already buyer gross).
 *
 * Bell: writes to `stock_failure_alerts` (the collection the topbar bell polls
 * via /api/admin/alerts/recent) with kind:'refund_review',
 * terminalStatus:'needs_manual'. Idempotent per marketplace refundId via the
 * `refund_corrections` collection — a refund is alerted exactly once.
 *
 * SINCE/lookback bounds the window so the historical backlog isn't surfaced all
 * at once.
 */

const { Firestore } = require('@google-cloud/firestore');

const COLL = 'refund_corrections';
const ALERTS = 'stock_failure_alerts';
const INVOICES = 'invoices';

let _db;
function getDb() {
  if (!_db) _db = new Firestore();
  return _db;
}

function ymd(ms) {
  return new Date(ms).toISOString().split('T')[0];
}

async function findInvoiceForOrder(db, tenantId, orderNumber) {
  const snap = await db.collection(INVOICES)
    .where('tenantId', '==', tenantId)
    .where('orderNumber', '==', orderNumber)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const d = snap.docs[0].data();
  return { invoiceNumber: d.invoiceNumber || null, amountBrutto: d.amountBrutto ?? d.amountGross ?? null };
}

/**
 * @param {{ tenantId?: string, sinceDate?: string, lookbackDays?: number }} opts
 */
async function syncRefunds({ tenantId = 'default', sinceDate = null, lookbackDays = 14 } = {}) {
  const db = getDb();
  const to = ymd(Date.now());
  const from = sinceDate || ymd(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  const results = { from, to, ebay: 0, kaufland: 0, notified: 0, skipped: 0, noInvoice: 0, errors: [] };
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

  for (const r of refunds) {
    if (!r.orderId || !r.refundId) { results.skipped++; continue; }

    const key = `${tenantId}__${r.marketplace}__${r.refundId}`.replace(/[^a-zA-Z0-9_]/g, '_');
    const ref = db.collection(COLL).doc(key);
    if ((await ref.get()).exists) { results.skipped++; continue; } // already alerted

    const inv = await findInvoiceForOrder(db, tenantId, r.orderId);

    // Compute the VAT-relevant (buyer) refund amount.
    let amount = null;
    let basis = null;
    if (r.marketplace === 'ebay') {
      if (inv?.amountBrutto != null && r.ebayOrderTotal != null) {
        amount = Math.round(Math.max(0, inv.amountBrutto - r.ebayOrderTotal) * 100) / 100;
        basis = 'invoice_minus_ebay_total';
      } else {
        amount = r.sellerNetRefund ?? null; // fallback (flagged) when invoice/total missing
        basis = 'seller_net_fallback';
      }
    } else {
      amount = r.amount ?? null; // Kaufland bookings report is buyer-gross
      basis = 'kaufland_booking';
    }

    const amtLabel = amount != null ? `${amount.toFixed(2)} ${r.currency || 'EUR'}` : `? ${r.currency || 'EUR'}`;
    const invLabel = inv?.invoiceNumber ? ` / ${inv.invoiceNumber}` : ' (keine Rechnung gefunden)';
    const reason = `Erstattung ${r.marketplace} – Order ${r.orderId}${invLabel}: ${amtLabel} – bitte Gutschrift (Teil-Storno) prüfen/ausstellen.`;

    try {
      await db.collection(ALERTS).add({
        tenantId,
        kind: 'refund_review',
        terminalStatus: 'needs_manual',
        reason,
        failureDocId: `${r.marketplace}:${r.orderId}`,
        marketplace: r.marketplace,
        orderId: r.orderId,
        refundId: r.refundId,
        invoiceNumber: inv?.invoiceNumber || null,
        amount,
        amountBasis: basis,
        currency: r.currency || 'EUR',
        refundDate: r.date || null,
        createdAt: new Date().toISOString(),
      });
      await ref.set({
        tenantId, marketplace: r.marketplace, orderId: r.orderId, refundId: r.refundId,
        invoiceNumber: inv?.invoiceNumber || null, computedAmount: amount, amountBasis: basis,
        currency: r.currency || 'EUR', refundDate: r.date || null,
        status: inv ? 'notified' : 'notified_no_invoice',
        createdAt: new Date().toISOString(),
      }, { merge: true });
      if (!inv) results.noInvoice++;
      results.notified++;
    } catch (err) {
      results.errors.push({ refundId: r.refundId, error: err.message });
    }
  }

  console.log(`[refund-sync] tenant=${tenantId} ${from}–${to}: ebay=${results.ebay} kaufland=${results.kaufland} notified=${results.notified} skipped=${results.skipped} noInvoice=${results.noInvoice} errors=${results.errors.length}`);
  return results;
}

module.exports = { syncRefunds, findInvoiceForOrder };
