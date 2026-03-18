'use strict';
/**
 * Cleanup the 24 locally-generated RE-2026-XXXX invoices.
 * - Deletes them from SevDesk
 * - Removes Firestore docs
 * - Unlinks invoiceId from orders so they can be re-assigned proper SevDesk numbers
 */
const { Firestore } = require('@google-cloud/firestore');
const { getSecretValue } = require('../lib/secret-values');

const db = new Firestore();
const DRY_RUN = !process.argv.includes('--fix');

(async () => {
  console.log(`\nCleanup local RE-2026-XXXX invoices [${DRY_RUN ? 'DRY-RUN' : 'FIX'}]\n`);

  const token = await getSecretValue('SEVDESK_API_TOKEN');
  const headers = { Authorization: token, 'Content-Type': 'application/json' };

  // Load all locally-generated invoices (number starts with RE-2026-)
  const snap = await db.collection('invoices')
    .where('tenantId', '==', 'default')
    .get();

  const locals = snap.docs
    .map(d => ({ _id: d.id, _ref: d.ref, ...d.data() }))
    .filter(inv => inv.invoiceNumber && inv.invoiceNumber.startsWith('RE-2026-') && !inv.type);

  console.log(`Found ${locals.length} local RE-2026-XXXX invoices to clean up:\n`);
  for (const inv of locals) {
    console.log(`  ${inv.invoiceNumber} | ${inv.amountBrutto || inv.amountGross || '?'}€ | sevdeskId: ${inv.sevdeskId || 'none'} | orderId: ${inv.orderId || 'none'}`);
  }

  if (DRY_RUN) {
    console.log('\nRun with --fix to delete these.\n');
    return;
  }

  console.log('\nDeleting...\n');
  let deletedSevdesk = 0;
  let deletedFirestore = 0;
  let unlinkedOrders = 0;

  for (const inv of locals) {
    // 1. Delete from SevDesk
    if (inv.sevdeskId) {
      try {
        const r = await fetch(`https://my.sevdesk.de/api/v1/Invoice/${inv.sevdeskId}`, {
          method: 'DELETE', headers,
        });
        if (r.ok) {
          console.log(`  ✓ SevDesk DELETE ${inv.invoiceNumber} (ID ${inv.sevdeskId})`);
          deletedSevdesk++;
        } else {
          const text = await r.text().catch(() => '');
          console.log(`  ✗ SevDesk DELETE failed for ${inv.invoiceNumber}: ${r.status} ${text.slice(0, 100)}`);
        }
      } catch (err) {
        console.log(`  ✗ SevDesk DELETE error: ${err.message}`);
      }
    }

    // 2. Delete correction docs that reference this invoice
    const corrSnap = await db.collection('invoices')
      .where('originalInvoiceId', '==', inv._id)
      .get();
    for (const corrDoc of corrSnap.docs) {
      const corr = corrDoc.data();
      if (corr.sevdeskId) {
        try {
          await fetch(`https://my.sevdesk.de/api/v1/Invoice/${corr.sevdeskId}`, {
            method: 'DELETE', headers,
          });
        } catch {}
      }
      await corrDoc.ref.delete();
      console.log(`  ✓ Deleted correction doc ${corrDoc.id} (${corr.type} for ${inv.invoiceNumber})`);
    }

    // 3. Unlink from order
    if (inv.orderId) {
      try {
        const orderRef = db.collection('orders').doc(inv.orderId);
        const orderSnap = await orderRef.get();
        if (orderSnap.exists && orderSnap.data().invoiceId === inv._id) {
          await orderRef.update({
            invoiceId: null,
            invoiceNumber: null,
            sevdeskInvoiceId: null,
            updatedAt: new Date().toISOString(),
          });
          console.log(`  ✓ Unlinked order ${inv.orderId} from ${inv.invoiceNumber}`);
          unlinkedOrders++;
        }
      } catch (err) {
        console.log(`  ✗ Unlink order error: ${err.message}`);
      }
    }

    // 4. Delete Firestore invoice doc
    await inv._ref.delete();
    console.log(`  ✓ Deleted Firestore doc ${inv._id} (${inv.invoiceNumber})\n`);
    deletedFirestore++;
  }

  console.log(`\nSummary:`);
  console.log(`  SevDesk deleted: ${deletedSevdesk}`);
  console.log(`  Firestore deleted: ${deletedFirestore}`);
  console.log(`  Orders unlinked: ${unlinkedOrders}`);
  console.log('\nDone. Run importFromSevDesk to re-match orders to SevDesk invoices.\n');
})().catch(console.error);
