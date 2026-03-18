'use strict';

/**
 * cross-check-invoices.js
 *
 * Cross-checks orders ↔ invoices ↔ returns in Firestore.
 * Reports mismatches and applies corrections where needed.
 *
 * Usage: node backend/scripts/cross-check-invoices.js [--fix]
 *   --fix   actually apply corrections (default: dry-run)
 */

const { Firestore } = require('@google-cloud/firestore');

const FIX_MODE = process.argv.includes('--fix');
const TENANT_ID = 'default';

const db = new Firestore();

const fmt = (n) => (typeof n === 'number' ? n.toFixed(2) : '—');

// Normalize: local invoices use amountBrutto, SevDesk imports use amountGross
const gross = (inv) => inv.amountBrutto ?? inv.amountGross ?? inv.totalBrutto ?? 0;
const netto = (inv) => inv.amountNetto ?? inv.amountNet ?? inv.totalNetto ?? 0;

async function main() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`INVOICE CROSS-CHECK  [${FIX_MODE ? 'FIX MODE' : 'DRY-RUN'}]`);
  console.log(`${'='.repeat(70)}\n`);

  // ── Load data ──────────────────────────────────────────────────────────
  console.log('Loading Firestore data...');

  const [ordersSnap, invoicesSnap, returnsSnap] = await Promise.all([
    db.collection('orders').where('tenantId', '==', TENANT_ID).get(),
    db.collection('invoices').where('tenantId', '==', TENANT_ID).get(),
    db.collection('returns').where('tenantId', '==', TENANT_ID).get(),
  ]);

  const orders = ordersSnap.docs.map((d) => ({ _id: d.id, _ref: d.ref, ...d.data() }));
  const invoices = invoicesSnap.docs.map((d) => ({ _id: d.id, _ref: d.ref, ...d.data() }));
  const returns = returnsSnap.docs.map((d) => ({ _id: d.id, _ref: d.ref, ...d.data() }));

  console.log(`  Orders:   ${orders.length}`);
  console.log(`  Invoices: ${invoices.length}`);
  console.log(`  Returns:  ${returns.length}\n`);

  // ── Index structures ───────────────────────────────────────────────────
  const invoiceByOrderId = new Map(); // orderId → invoice
  const correctionsByOriginalId = new Map(); // originalInvoiceId → correction

  for (const inv of invoices) {
    if (inv.orderId && !inv.type) {
      invoiceByOrderId.set(inv.orderId, inv);
    }
    if (inv.type && inv.originalInvoiceId) {
      if (!correctionsByOriginalId.has(inv.originalInvoiceId)) {
        correctionsByOriginalId.set(inv.originalInvoiceId, []);
      }
      correctionsByOriginalId.get(inv.originalInvoiceId).push(inv);
    }
  }

  const ELIGIBLE_STATUSES = new Set(['picked', 'packed', 'shipped', 'delivered', 'completed']);
  const CANCELLED_STATUS = 'cancelled';

  const issues = {
    missingInvoice: [],
    amountMismatch: [],
    cancelledNeedStorno: [],
    returnNeedsCorrection: [],
    invoiceNoOrder: [],
    sevdeskMissing: [],
  };

  // ── CHECK 1: Orders needing invoices ───────────────────────────────────
  for (const order of orders) {
    if (!ELIGIBLE_STATUSES.has(order.omsStatus)) continue;
    if (order.invoiceId) {
      // Has invoice ID — verify invoice exists and amounts match
      const inv = invoiceByOrderId.get(order._id);
      if (!inv) {
        issues.missingInvoice.push({ order, reason: 'invoiceId set but no matching invoice doc' });
        continue;
      }
      // Amount check: invoice.amountGross vs order.totalAmount (tolerance ±1€)
      const orderTotal = order.totalAmount || 0;
      const invTotal = gross(inv);
      if (orderTotal > 0 && invTotal > 0 && Math.abs(orderTotal - invTotal) > 1.5) {
        issues.amountMismatch.push({ order, invoice: inv, orderTotal, invTotal });
      }
    } else {
      issues.missingInvoice.push({ order, reason: 'no invoiceId' });
    }
  }

  // ── CHECK 2: Cancelled orders needing Storno ───────────────────────────
  for (const order of orders) {
    if (order.omsStatus !== CANCELLED_STATUS) continue;
    const inv = invoiceByOrderId.get(order._id);
    if (!inv) continue; // No invoice → nothing to storno
    const corrections = correctionsByOriginalId.get(inv._id) || [];
    const hasStorno = corrections.some((c) => c.type === 'storno');
    if (!hasStorno) {
      issues.cancelledNeedStorno.push({ order, invoice: inv });
    }
  }

  // ── CHECK 3: Returns needing correction invoices ───────────────────────
  for (const ret of returns) {
    if (!['erstattet', 'teilweise_erstattet'].includes(ret.status)) continue;
    const inv = ret.orderId ? invoiceByOrderId.get(ret.orderId) : null;
    if (!inv) continue; // No invoice for this order
    const corrections = correctionsByOriginalId.get(inv._id) || [];
    const expectedType = ret.status === 'teilweise_erstattet' ? 'gutschrift' : 'storno';
    const hasCorrection = corrections.some((c) => c.type === expectedType);
    if (!hasCorrection) {
      issues.returnNeedsCorrection.push({ ret, order: orders.find((o) => o._id === ret.orderId), invoice: inv, expectedType });
    }
  }

  // ── CHECK 4: Invoices without linked order ─────────────────────────────
  const orderIds = new Set(orders.map((o) => o._id));
  for (const inv of invoices) {
    if (inv.type) continue; // Corrections don't need an order link
    if (!inv.orderId || !orderIds.has(inv.orderId)) {
      issues.invoiceNoOrder.push({ invoice: inv });
    }
  }

  // ── CHECK 5: Invoices not yet in SevDesk ──────────────────────────────
  for (const inv of invoices) {
    if (!inv.sevdeskId && !inv.type && inv.source !== 'sevdesk_import') {
      issues.sevdeskMissing.push({ invoice: inv });
    }
  }

  // ── REPORT ─────────────────────────────────────────────────────────────
  console.log('─'.repeat(70));
  console.log(`MISSING INVOICES: ${issues.missingInvoice.length}`);
  for (const { order, reason } of issues.missingInvoice) {
    const name = order.customer?.name || order.shippingAddress?.name || '?';
    console.log(`  ✗ [${order._id}] ${order.marketplaceOrderId || order.orderId || '?'} | ${name} | ${fmt(order.totalAmount)}€ | ${order.omsStatus} — ${reason}`);
  }

  console.log(`\nAMOUNT MISMATCHES: ${issues.amountMismatch.length}`);
  for (const { order, invoice, orderTotal, invTotal } of issues.amountMismatch) {
    const name = order.customer?.name || order.shippingAddress?.name || '?';
    console.log(`  ⚠ [${order._id}] ${name} | Order: ${fmt(orderTotal)}€ ≠ Invoice: ${fmt(invTotal)}€ (${invoice.invoiceNumber})`);
  }

  console.log(`\nCANCELLED — MISSING STORNO: ${issues.cancelledNeedStorno.length}`);
  for (const { order, invoice } of issues.cancelledNeedStorno) {
    const name = order.customer?.name || '?';
    console.log(`  ✗ [${order._id}] ${name} | ${fmt(order.totalAmount)}€ | Invoice: ${invoice.invoiceNumber}`);
  }

  console.log(`\nRETURNS — MISSING CORRECTION: ${issues.returnNeedsCorrection.length}`);
  for (const { ret, order, invoice, expectedType } of issues.returnNeedsCorrection) {
    const name = ret.customerName || order?.customer?.name || '?';
    console.log(`  ✗ [${ret._id}] ${name} | Refund: ${fmt(ret.refundAmount)}€ (${ret.status}) | Invoice: ${invoice.invoiceNumber} → needs ${expectedType}`);
  }

  console.log(`\nINVOICES WITHOUT ORDER: ${issues.invoiceNoOrder.length}`);
  for (const { invoice } of issues.invoiceNoOrder) {
    if (invoice.source === 'sevdesk_import') continue; // Expected for imported SevDesk docs
    console.log(`  ⚠ [${invoice._id}] ${invoice.invoiceNumber} | ${fmt(gross(invoice))}€ | orderId: ${invoice.orderId || 'none'}`);
  }

  console.log(`\nINVOICES NOT IN SEVDESK: ${issues.sevdeskMissing.length}`);
  for (const { invoice } of issues.sevdeskMissing) {
    console.log(`  ⚠ [${invoice._id}] ${invoice.invoiceNumber} | ${fmt(gross(invoice))}€ | orderId: ${invoice.orderId}`);
  }

  console.log(`\n${'─'.repeat(70)}`);
  const totalIssues = issues.missingInvoice.length + issues.cancelledNeedStorno.length + issues.returnNeedsCorrection.length;
  console.log(`TOTAL ACTIONABLE ISSUES: ${totalIssues}`);

  if (!FIX_MODE) {
    if (totalIssues > 0) {
      console.log('\nRun with --fix to apply corrections.\n');
    } else {
      console.log('\nAll good — no corrections needed.\n');
    }
    return;
  }

  // ── APPLY FIXES ────────────────────────────────────────────────────────
  console.log('\nApplying fixes...\n');

  const { generateInvoice, exportToSevDesk, createCorrectionInvoice } = require('../services/invoice-engine');

  // Fix 1: Generate missing invoices
  let fixedInvoices = 0;
  for (const { order } of issues.missingInvoice) {
    if (order.reason === 'no invoiceId' || order.reason?.includes('no matching')) {
      try {
        const inv = await generateInvoice({ orderId: order._id, tenantId: TENANT_ID });
        console.log(`  ✓ Invoice created: ${inv.invoiceNumber} for ${order._id} (${order.marketplaceOrderId || '?'})`);
        if (inv.invoiceId) {
          exportToSevDesk({ invoiceId: inv.invoiceId })
            .then(() => console.log(`    → SevDesk export queued: ${inv.invoiceNumber}`))
            .catch((e) => console.warn(`    ⚠ SevDesk export failed: ${e.message}`));
        }
        fixedInvoices++;
      } catch (err) {
        console.error(`  ✗ Failed to generate invoice for ${order._id}: ${err.message}`);
      }
    }
  }

  // Fix 1b: Gutschrift for invoices that are higher than the order amount
  let fixedAmounts = 0;
  for (const { order, invoice, orderTotal, invTotal } of issues.amountMismatch) {
    if (invTotal > orderTotal) {
      const diff = Math.round((invTotal - orderTotal) * 100) / 100;
      try {
        const result = await createCorrectionInvoice({
          orderId: order._id, tenantId: TENANT_ID, type: 'gutschrift',
          refundAmount: diff,
          reason: `Betragskorrektur: Rechnung (${fmt(invTotal)}€) > Bestellung (${fmt(orderTotal)}€)`,
        });
        if (result.ok) {
          console.log(`  ✓ Gutschrift ${fmt(diff)}€ für ${invoice.invoiceNumber} (${order.customer?.name || '?'})`);
          fixedAmounts++;
        }
      } catch (err) {
        console.error(`  ✗ Gutschrift failed for ${order._id}: ${err.message}`);
      }
    }
  }

  // Fix 2: Storno for cancelled orders
  let fixedStornos = 0;
  for (const { order, invoice } of issues.cancelledNeedStorno) {
    try {
      const result = await createCorrectionInvoice({
        orderId: order._id, tenantId: TENANT_ID, type: 'storno',
        reason: 'Stornierung Bestellung',
      });
      if (result.ok) {
        console.log(`  ✓ Storno created: ${result.correctionId} for order ${order._id} (Invoice: ${invoice.invoiceNumber})`);
        fixedStornos++;
      } else {
        console.warn(`  ⚠ Storno skipped for ${order._id}: ${result.reason}`);
      }
    } catch (err) {
      console.error(`  ✗ Storno failed for ${order._id}: ${err.message}`);
    }
  }

  // Fix 3: Correction invoices for returns
  let fixedCorrections = 0;
  for (const { ret, invoice, expectedType } of issues.returnNeedsCorrection) {
    try {
      const result = await createCorrectionInvoice({
        orderId: ret.orderId, tenantId: TENANT_ID,
        type: expectedType,
        refundAmount: ret.refundAmount || null,
        reason: expectedType === 'gutschrift' ? 'Teilerstattung Retoure' : 'Vollerstattung Retoure',
      });
      if (result.ok) {
        console.log(`  ✓ ${expectedType} created: ${result.correctionId} for return ${ret._id} (Invoice: ${invoice.invoiceNumber}, Amount: ${fmt(result.amount)}€)`);
        fixedCorrections++;
      } else {
        console.warn(`  ⚠ Correction skipped for return ${ret._id}: ${result.reason}`);
      }
    } catch (err) {
      console.error(`  ✗ Correction failed for return ${ret._id}: ${err.message}`);
    }
  }

  // Fix 4: Push missing SevDesk exports
  let fixedSevDesk = 0;
  for (const { invoice } of issues.sevdeskMissing) {
    try {
      const result = await exportToSevDesk({ invoiceId: invoice._id });
      if (result.ok) {
        console.log(`  ✓ SevDesk export: ${invoice.invoiceNumber} → SevDesk ID ${result.sevdeskId}`);
        fixedSevDesk++;
      }
    } catch (err) {
      console.error(`  ✗ SevDesk export failed for ${invoice._id}: ${err.message}`);
    }
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`FIX SUMMARY`);
  console.log(`  Invoices generated:    ${fixedInvoices}`);
  console.log(`  Amount corrections:    ${fixedAmounts}`);
  console.log(`  Stornos created:       ${fixedStornos}`);
  console.log(`  Corrections created:   ${fixedCorrections}`);
  console.log(`  SevDesk exports sent:  ${fixedSevDesk}`);
  console.log(`${'='.repeat(70)}\n`);
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
