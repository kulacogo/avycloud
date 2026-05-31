'use strict';

/**
 * dedupe-firestore-invoices.js — Remove duplicate invoice docs in the `invoices`
 * Firestore collection (the AvyCloud app list). For each invoice number with
 * multiple docs, keep the RICHEST (has orderId/customer/pdfUrl) and delete the
 * sparse leftovers (typically source=sevdesk_import).
 *
 * Touches ONLY the app database — never SevDesk. Single import docs (no
 * duplicate) are left untouched. Blank-number docs are left untouched.
 *
 * SAFETY:
 *   - DRY-RUN by default; only --apply deletes.
 *   - --limit N for a canary run.
 *   - Before deleting a doc, any order whose invoiceId points at it is repointed
 *     to the kept doc (so no order loses its invoice link).
 *
 * Usage:
 *   node backend/scripts/dedupe-firestore-invoices.js
 *   node backend/scripts/dedupe-firestore-invoices.js --apply --limit 5
 *   node backend/scripts/dedupe-firestore-invoices.js --apply
 */

const { Firestore } = require('@google-cloud/firestore');

const TENANT = process.env.TENANT_ID || 'default';
const APPLY = process.argv.includes('--apply');
const li = process.argv.indexOf('--limit');
const LIMIT = li >= 0 ? parseInt(process.argv[li + 1], 10) : null;

function richness(d) {
  let s = 0;
  if (d.orderId) s += 3;
  if (d.pdfUrl) s += 3;
  if (d.customer && (d.customer.street || d.customer.city)) s += 2;
  else if (d.customer && d.customer.name) s += 1;
  if (Array.isArray(d.items) && d.items.length) s += 1;
  if (d.source === 'sevdesk_import') s -= 2;
  return s;
}

(async () => {
  console.log(`\n${'─'.repeat(64)}`);
  console.log(`  Firestore-Rechnungen dedupe  [${APPLY ? 'APPLY — LÖSCHT WIRKLICH' : 'DRY-RUN — nichts wird geändert'}]${LIMIT ? `  (--limit ${LIMIT})` : ''}`);
  console.log(`${'─'.repeat(64)}\n`);

  const db = new Firestore();

  const snap = await db.collection('invoices').where('tenantId', '==', TENANT).get();
  const docs = snap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));

  // Group by number, compute keep + drops
  const byNumber = new Map();
  for (const d of docs) {
    const num = (d.invoiceNumber || '').trim();
    if (!num) continue;
    if (!byNumber.has(num)) byNumber.set(num, []);
    byNumber.get(num).push(d);
  }

  const plan = []; // { number, keepId, dropDoc }
  for (const [num, list] of byNumber.entries()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => richness(b) - richness(a));
    const keep = sorted[0];
    for (const drop of sorted.slice(1)) {
      plan.push({ number: num, keepId: keep.id, dropDoc: drop });
    }
  }

  const work = (LIMIT && LIMIT > 0) ? plan.slice(0, LIMIT) : plan;

  // Map order.invoiceId → [order refs] so we can repoint before deleting
  const ordersSnap = await db.collection('orders').where('tenantId', '==', TENANT).get();
  const ordersByInvoiceId = new Map();
  for (const o of ordersSnap.docs) {
    const iid = o.data().invoiceId;
    if (!iid) continue;
    if (!ordersByInvoiceId.has(iid)) ordersByInvoiceId.set(iid, []);
    ordersByInvoiceId.get(iid).push(o.ref);
  }

  let repoints = 0;
  for (const p of work) if (ordersByInvoiceId.has(p.dropDoc.id)) repoints += ordersByInvoiceId.get(p.dropDoc.id).length;

  console.log(`  Rechnungs-Docs gesamt        : ${docs.length}`);
  console.log(`  Löschbare Doppel-Docs (Plan) : ${plan.length}`);
  if (LIMIT) console.log(`  → in DIESEM Lauf             : ${work.length}`);
  console.log(`  Bestellungen umzubiegen      : ${repoints}\n`);

  console.log('  Beispiele (erste 15):');
  for (const p of work.slice(0, 15)) {
    console.log(`    ${p.number.padEnd(10)} lösche ${p.dropDoc.id} (Score ${richness(p.dropDoc)}, src=${p.dropDoc.source || '-'}) → behalte ${p.keepId}`);
  }
  if (work.length > 15) console.log(`    … und ${work.length - 15} weitere`);
  console.log('');

  if (!APPLY) {
    console.log(`  DRY-RUN: nichts verändert. Mit --apply ausführen (SevDesk bleibt unberührt).\n`);
    return;
  }

  let deleted = 0, repointed = 0, failed = 0;
  for (const p of work) {
    try {
      // 1. Repoint any order pointing at the doomed doc
      const refs = ordersByInvoiceId.get(p.dropDoc.id) || [];
      for (const oref of refs) {
        await oref.set({ invoiceId: p.keepId, invoiceNumber: p.number, updatedAt: new Date().toISOString() }, { merge: true });
        repointed++;
      }
      // 2. Delete the duplicate doc
      await p.dropDoc.ref.delete();
      deleted++;
      if (deleted % 50 === 0) console.log(`  … ${deleted} Doppel gelöscht`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${p.number} (${p.dropDoc.id}): ${err.message}`);
    }
  }

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`  Fertig. Gelöscht: ${deleted} | Bestellungen umgebogen: ${repointed} | Fehler: ${failed}`);
  console.log(`${'─'.repeat(64)}\n`);
})().catch((err) => {
  console.error(`[dedupe-firestore-invoices] ${err.message}`);
  process.exit(1);
});
