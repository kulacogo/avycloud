'use strict';

/**
 * repair-invoices.js — Bereinigt die DUBLETTEN-Entwürfe in SevDesk.
 *
 * Entfernt AUSSCHLIESSLICH die eindeutig überflüssigen Entwürfe (Status 100),
 * für die eine echte finalisierte Rechnung MIT GLEICHER NUMMER existiert.
 * Diese Entwürfe sind reine Duplikate aus dem AvyCloud↔SevDesk-Bug.
 *
 * BEWUSST NICHT angefasst (zu heikel / steuerrelevant — separat + mit
 * Steuerberater zu behandeln):
 *   - Entwürfe OHNE finalisierten Zwilling (die 30 "einsamen", inkl. RE-2026-00xx)
 *   - Rechnungen ohne Nummer (blank)
 *   - die 47 finalisierten 0,00-€-eBay-Rechnungen (GoBD: nur Storno)
 *
 * Zusätzlich: repariert die Firestore-Verknüpfung. Der Bug hatte die `sevdeskId`
 * vieler Firestore-Rechnungen auf den ENTWURF zeigen lassen; nach dem Löschen
 * wird sie auf die echte finalisierte Rechnung umgebogen.
 *
 * SICHERHEIT: Standard ist DRY-RUN (zeigt nur an). Erst mit --apply wird gelöscht.
 *
 * Usage:
 *   node backend/scripts/repair-invoices.js            # Dry-Run (nichts wird geändert)
 *   node backend/scripts/repair-invoices.js --apply    # führt das Löschen wirklich aus
 */

const { Firestore } = require('@google-cloud/firestore');
const { getSecretValue } = require('../lib/secret-values');

const SEVDESK_BASE_URL = 'https://my.sevdesk.de/api/v1';
const APPLY = process.argv.includes('--apply');
const TENANT = process.env.TENANT_ID || 'default';

const isDraft = (s) => String(s) === '100';
const isFinalized = (s) => ['200', '750', '1000'].includes(String(s));

async function fetchAllSevdeskInvoices(token) {
  const PAGE = 100;
  const all = [];
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = `${SEVDESK_BASE_URL}/Invoice?limit=${PAGE}&offset=${offset}&orderBy=invoiceDate%2Cdesc`;
    const res = await fetch(url, { headers: { Authorization: token, 'Content-Type': 'application/json' } });
    if (!res.ok) throw new Error(`SevDesk API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const data = await res.json();
    const page = Array.isArray(data?.objects) ? data.objects : [];
    all.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

(async () => {
  console.log(`\n${'─'.repeat(64)}`);
  console.log(`  SevDesk Rechnungs-Reparatur  [${APPLY ? 'APPLY — LÖSCHT WIRKLICH' : 'DRY-RUN — nichts wird geändert'}]`);
  console.log(`${'─'.repeat(64)}\n`);

  const token = await getSecretValue('SEVDESK_API_TOKEN');
  if (!token) throw new Error('SEVDESK_API_TOKEN not configured');
  const headers = { Authorization: token, 'Content-Type': 'application/json' };
  const db = new Firestore();

  const invoices = await fetchAllSevdeskInvoices(token);

  // Build: number -> { finalized: [...], drafts: [...] }
  const byNumber = new Map();
  for (const inv of invoices) {
    const num = (inv.invoiceNumber || '').trim();
    if (!num) continue; // blank-number invoices are handled separately, never here
    if (!byNumber.has(num)) byNumber.set(num, { finalized: [], drafts: [] });
    if (isDraft(inv.status)) byNumber.get(num).drafts.push(inv);
    else if (isFinalized(inv.status)) byNumber.get(num).finalized.push(inv);
  }

  // SAFE-DELETE set: drafts whose number ALSO has a finalized invoice.
  const deletable = [];
  for (const [num, grp] of byNumber.entries()) {
    if (grp.finalized.length >= 1 && grp.drafts.length >= 1) {
      const keepId = String(grp.finalized[0].id); // the real invoice to repoint Firestore to
      for (const d of grp.drafts) deletable.push({ number: num, draftId: String(d.id), keepId });
    }
  }

  console.log(`  SevDesk Rechnungen gesamt        : ${invoices.length}`);
  console.log(`  Sicher löschbare Dubletten-Entwürfe: ${deletable.length}`);
  console.log(`  (jeweils existiert die echte Rechnung mit gleicher Nummer)\n`);

  // Firestore docs that point at a soon-to-be-deleted draft → must be repointed
  let repointPlanned = 0;
  const repointOps = [];
  for (const d of deletable) {
    const snap = await db.collection('invoices')
      .where('tenantId', '==', TENANT)
      .where('sevdeskId', '==', d.draftId)
      .get();
    for (const doc of snap.docs) {
      repointOps.push({ docId: doc.id, fromId: d.draftId, toId: d.keepId, number: d.number });
      repointPlanned++;
    }
  }
  console.log(`  Firestore-Rechnungen, deren sevdeskId auf einen Entwurf zeigt: ${repointPlanned}`);
  console.log(`  → werden auf die echte Rechnung umgebogen (statt ins Leere zu zeigen)\n`);

  if (deletable.length) {
    console.log('  Beispiele (erste 15):');
    for (const d of deletable.slice(0, 15)) {
      console.log(`    Nr ${d.number.padEnd(10)} Entwurf-ID ${d.draftId}  → behalte echte ID ${d.keepId}`);
    }
    if (deletable.length > 15) console.log(`    … und ${deletable.length - 15} weitere`);
    console.log('');
  }

  if (!APPLY) {
    console.log(`${'─'.repeat(64)}`);
    console.log('  DRY-RUN: Es wurde NICHTS verändert.');
    console.log('  Mit  --apply  werden die Entwürfe gelöscht und Firestore repariert.');
    console.log(`${'─'.repeat(64)}\n`);
    console.log('  Bewusst NICHT angefasst (separat / mit Steuerberater):');
    console.log('   • einsame Entwürfe ohne Zwilling (inkl. RE-2026-00xx)');
    console.log('   • Rechnungen ohne Nummer');
    console.log('   • 47 finalisierte 0,00-€-eBay-Rechnungen (nur Storno erlaubt)\n');
    return;
  }

  // ── APPLY ──
  let deleted = 0, failed = 0, repointed = 0;

  // 1. Repoint Firestore first (so we never lose the link even if a delete fails)
  for (const op of repointOps) {
    try {
      await db.collection('invoices').doc(op.docId).set({
        sevdeskId: op.toId,
        sevdeskDraftRemoved: op.fromId,
        repairedAt: new Date().toISOString(),
      }, { merge: true });
      repointed++;
    } catch (err) {
      console.log(`  ✗ Repoint failed for doc ${op.docId}: ${err.message}`);
    }
  }
  console.log(`  Firestore umgebogen: ${repointed}/${repointOps.length}\n`);

  // 2. Delete the draft duplicates in SevDesk
  for (const d of deletable) {
    try {
      const r = await fetch(`${SEVDESK_BASE_URL}/Invoice/${d.draftId}`, { method: 'DELETE', headers });
      if (r.ok) {
        deleted++;
        if (deleted % 25 === 0) console.log(`  … ${deleted} Entwürfe gelöscht`);
      } else {
        failed++;
        console.log(`  ✗ DELETE ${d.number} (ID ${d.draftId}): ${r.status} ${(await r.text().catch(() => '')).slice(0, 120)}`);
      }
    } catch (err) {
      failed++;
      console.log(`  ✗ DELETE error ${d.draftId}: ${err.message}`);
    }
  }

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`  Fertig. Entwürfe gelöscht: ${deleted} | Fehler: ${failed} | Firestore umgebogen: ${repointed}`);
  console.log(`${'─'.repeat(64)}\n`);
})().catch((err) => {
  console.error(`[repair-invoices] ${err.message}`);
  process.exit(1);
});
