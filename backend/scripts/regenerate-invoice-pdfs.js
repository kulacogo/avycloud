'use strict';

/**
 * regenerate-invoice-pdfs.js — Re-render the STORED invoice PDFs with the
 * current (fixed) layout. The PDF is generated once at invoice creation and
 * stored in GCS; a code fix only affects NEW invoices, so existing stored PDFs
 * keep the old broken layout (text overlap, missing logo, duplicate header).
 * This script rebuilds each PDF from the SAME invoice data and overwrites the
 * GCS file in place.
 *
 * Content is unchanged — same number, amounts, dates, parties. ONLY the visual
 * layout is refreshed (logo, no text overlap, no redundant header).
 *
 * Scope: invoices with a gs:// pdfUrl. Line items come from the linked order;
 * if none, a single summary line is synthesized from the stored amounts.
 *
 * SAFETY: DRY-RUN by default; --apply overwrites. --limit N for a canary.
 *
 * Usage:
 *   node backend/scripts/regenerate-invoice-pdfs.js
 *   node backend/scripts/regenerate-invoice-pdfs.js --apply --limit 5
 *   node backend/scripts/regenerate-invoice-pdfs.js --apply
 */

const { Firestore } = require('@google-cloud/firestore');
const { Storage } = require('@google-cloud/storage');
const { getCompanySettings, buildInvoicePdf } = require('../services/invoice-engine');

const TENANT = process.env.TENANT_ID || 'default';
const APPLY = process.argv.includes('--apply');
const li = process.argv.indexOf('--limit');
const LIMIT = li >= 0 ? parseInt(process.argv[li + 1], 10) : null;

function parseGs(url) {
  const m = String(url).replace('gs://', '');
  const i = m.indexOf('/');
  return { bucket: m.slice(0, i), path: m.slice(i + 1) };
}

(async () => {
  console.log(`\n${'─'.repeat(64)}`);
  console.log(`  Rechnungs-PDFs neu rendern  [${APPLY ? 'APPLY — überschreibt GCS' : 'DRY-RUN'}]${LIMIT ? `  (--limit ${LIMIT})` : ''}`);
  console.log(`${'─'.repeat(64)}\n`);

  const db = new Firestore();
  const storage = new Storage();

  // Company + logo fetched ONCE (same for every invoice of this tenant).
  const company = await getCompanySettings(TENANT);
  if (company.logoUrl) {
    try { const r = await fetch(company.logoUrl); company._logoBuffer = Buffer.from(await r.arrayBuffer()); }
    catch (e) { console.log('Logo-Fetch fehlgeschlagen:', e.message); }
  }
  console.log('Logo:', company._logoBuffer ? 'geladen ✓' : 'nicht verfügbar (Text-Fallback)');

  const snap = await db.collection('invoices').where('tenantId', '==', TENANT).get();
  const targets = snap.docs
    .map((d) => ({ id: d.id, ref: d.ref, ...d.data() }))
    .filter((x) => typeof x.pdfUrl === 'string' && x.pdfUrl.startsWith('gs://'));

  const work = (LIMIT && LIMIT > 0) ? targets.slice(0, LIMIT) : targets;
  console.log(`Rechnungen mit gespeichertem PDF: ${targets.length}${LIMIT ? ` (in diesem Lauf: ${work.length})` : ''}\n`);

  if (!APPLY) {
    console.log('  Beispiele (erste 10):');
    for (const inv of work.slice(0, 10)) console.log(`    ${(inv.invoiceNumber || '?').padEnd(10)} ${inv.pdfUrl}`);
    console.log(`\n  DRY-RUN: nichts verändert. Mit --apply neu rendern. Inhalt bleibt gleich, nur Layout.\n`);
    return;
  }

  let done = 0, failed = 0;
  for (const inv of work) {
    try {
      let items = [];
      if (inv.orderId) {
        const o = await db.collection('orders').doc(inv.orderId).get();
        if (o.exists) items = o.data().items || [];
      }
      if (!items.length) {
        items = [{ name: `Bestellung ${inv.orderNumber || inv.marketplaceOrderId || inv.invoiceNumber}`, priceBrutto: inv.amountBrutto || inv.amountGross || 0, quantity: 1 }];
      }
      const buf = await buildInvoicePdf({
        type: 'invoice', number: inv.invoiceNumber, date: inv.date, dueDate: inv.dueDate,
        company, customer: inv.customer || {}, items,
        totalNetto: inv.amountNetto || inv.amountNet || 0, vatRate: inv.vatRate || 0.19,
        vatAmount: inv.vatAmount || 0, totalBrutto: inv.amountBrutto || inv.amountGross || 0,
        orderNumber: inv.orderNumber || inv.marketplaceOrderId || null,
      });
      const { bucket, path } = parseGs(inv.pdfUrl);
      await storage.bucket(bucket).file(path).save(buf, { contentType: 'application/pdf', resumable: false, metadata: { cacheControl: 'private, max-age=0' } });
      await inv.ref.set({ pdfRegeneratedAt: new Date().toISOString() }, { merge: true });
      done++;
      if (done % 50 === 0) console.log(`  … ${done} PDFs neu gerendert`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${inv.invoiceNumber} (${inv.id}): ${err.message}`);
    }
  }

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`  Fertig. Neu gerendert: ${done} | Fehler: ${failed}`);
  console.log(`${'─'.repeat(64)}\n`);
})().catch((err) => {
  console.error(`[regenerate-invoice-pdfs] ${err.message}`);
  process.exit(1);
});
