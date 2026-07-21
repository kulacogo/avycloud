'use strict';
/**
 * sevdesk-storno-duplicates.js — Bereinigung des Rechnungs-Duplikat-Incidents
 * 2026-07-20 (invoice-engine prägte pro Retry eine neue echte SevDesk-Rechnung).
 *
 * ZWEIFELSFREI-Kriterium (nur dann wird storniert):
 *   1. Mehrere Nicht-Storno-Rechnungen tragen im Belegkopf DIESELBE
 *      "Marktplatz-Bestellnummer: X" (den Ref schreibt die Engine in jede
 *      von ihr geprägte Rechnung).
 *   2. Pro Gruppe bleibt GENAU EIN Keeper: bevorzugt die Rechnung, auf die
 *      die avycloud-Order zeigt (order.invoiceSevdeskId bzw. order.invoiceId
 *      → invoices.sevdeskId); sonst die älteste finalisierte (niedrigste
 *      Rechnungsnummer). Alle übrigen der Gruppe sind Duplikate.
 *   3. Storniert wird NUR Status 200 (offen). Bezahlte (750/1000) und
 *      Entwürfe (100) werden NIE angefasst → manuelle Meldeliste.
 *
 * Storno via POST /Invoice/{id}/cancelInvoice (GoBD-konforme Stornorechnung).
 * Nach erfolgreichem Storno wird der lokale Spiegel-Doc markiert
 * (type='storniert'), damit die Rechnungen-KPI ihn nicht mehr zählt
 * (der Import ist one-shot und überschreibt die Markierung nicht).
 *
 * Default: DRY-RUN. Mutationen nur mit --apply. Abbruch wenn >100 Kandidaten.
 */

const { Firestore } = require('@google-cloud/firestore');
const db = new Firestore();

const APPLY = process.argv.includes('--apply');
const MAX_CANCELS = 100;

async function fetchAllSevdeskInvoices(token) {
  const headers = { Authorization: token };
  const all = [];
  let offset = 0;
  const limit = 500;
  for (;;) {
    const r = await fetch(`https://my.sevdesk.de/api/v1/Invoice?limit=${limit}&offset=${offset}`, { headers });
    if (!r.ok) throw new Error(`SevDesk GET /Invoice ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
    const data = await r.json();
    const rows = Array.isArray(data?.objects) ? data.objects : [];
    all.push(...rows);
    if (rows.length < limit) break;
    offset += limit;
  }
  return all;
}

function extractRef(headText) {
  const m = String(headText || '').match(/Marktplatz-Bestellnummer:\s*([^\s<]+)/);
  return m ? m[1].trim() : null;
}

function numPart(invoiceNumber) {
  const m = String(invoiceNumber || '').match(/(\d+)\s*$/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

async function main() {
  console.log(`[storno-dups] Modus: ${APPLY ? 'APPLY (storniert!)' : 'DRY-RUN'}`);

  const { getIntegrationSecret } = require('../services/integration-store');
  const token = await getIntegrationSecret('SEVDESK_API_TOKEN');
  if (!token) throw new Error('Kein SevDesk-Token auflösbar.');

  // 1) Alle SevDesk-Rechnungen + avycloud-Verknüpfungen laden
  const [sevInvoices, ordersSnap, invoicesSnap] = await Promise.all([
    fetchAllSevdeskInvoices(token),
    db.collection('orders').get(),
    db.collection('invoices').where('tenantId', '==', 'default').get(),
  ]);
  console.log(`[storno-dups] SevDesk: ${sevInvoices.length} Belege geladen`);

  // Keeper-Auflösung: sevdeskId(s), auf die eine Order zeigt
  const keeperSevdeskIds = new Set();
  const invoiceDocBySevdeskId = new Map();
  for (const doc of invoicesSnap.docs) {
    const d = doc.data();
    if (d.sevdeskId) invoiceDocBySevdeskId.set(String(d.sevdeskId), doc);
  }
  const invoiceDocIdToSevdesk = new Map();
  for (const doc of invoicesSnap.docs) {
    const d = doc.data();
    if (d.sevdeskId) invoiceDocIdToSevdesk.set(doc.id, String(d.sevdeskId));
  }
  for (const doc of ordersSnap.docs) {
    const o = doc.data();
    if (o.invoiceSevdeskId) keeperSevdeskIds.add(String(o.invoiceSevdeskId));
    if (o.invoiceId && invoiceDocIdToSevdesk.has(o.invoiceId)) {
      keeperSevdeskIds.add(invoiceDocIdToSevdesk.get(o.invoiceId));
    }
  }

  // 2) Nicht-Storno-Belege nach Marktplatz-Ref gruppieren
  const byRef = new Map();
  for (const inv of sevInvoices) {
    if (String(inv.invoiceType || '') === 'SR') continue; // Stornorechnungen selbst
    const ref = extractRef(inv.headText);
    if (!ref) continue;
    if (!byRef.has(ref)) byRef.set(ref, []);
    byRef.get(ref).push(inv);
  }

  const plan = { cancel: [], keep: [], skippedPaid: [], skippedDraft: [], singles: 0 };

  for (const [ref, group] of byRef) {
    if (group.length < 2) { plan.singles++; continue; }

    // Keeper wählen: von einer Order referenziert > älteste finalisierte
    let keeper = group.find((inv) => keeperSevdeskIds.has(String(inv.id)));
    if (!keeper) {
      const finalized = group.filter((inv) => Number(inv.status) >= 200);
      const pool = finalized.length ? finalized : group;
      keeper = pool.reduce((a, b) => (numPart(a.invoiceNumber) <= numPart(b.invoiceNumber) ? a : b));
    }
    plan.keep.push({ ref, id: String(keeper.id), nr: keeper.invoiceNumber, gross: keeper.sumGross });

    for (const inv of group) {
      if (String(inv.id) === String(keeper.id)) continue;
      const status = Number(inv.status);
      const row = { ref, id: String(inv.id), nr: inv.invoiceNumber, gross: inv.sumGross, status };
      if (status === 100) plan.skippedDraft.push(row);
      else if (status >= 750) plan.skippedPaid.push(row);
      else plan.cancel.push(row);
    }
  }

  console.log(`\n════ PLAN ════`);
  console.log(`Duplikat-Gruppen: ${plan.keep.length} | zu stornieren (offen): ${plan.cancel.length} | bezahlt (MANUELL): ${plan.skippedPaid.length} | Entwürfe (MANUELL): ${plan.skippedDraft.length} | Einzel-Refs: ${plan.singles}`);
  const cancelSum = plan.cancel.reduce((s, c) => s + (Number(c.gross) || 0), 0);
  console.log(`Storno-Summe: ${cancelSum.toFixed(2)} €`);
  plan.cancel.slice(0, 80).forEach((c) => console.log(`  ✂ ${c.nr} (${Number(c.gross).toFixed(2)} €) — Ref ${c.ref}`));
  plan.skippedPaid.forEach((c) => console.log(`  ⚠ BEZAHLT, manuell: ${c.nr} (${Number(c.gross).toFixed(2)} €) — Ref ${c.ref}`));

  const fs = require('fs');
  fs.writeFileSync(`/tmp/sevdesk-storno-${APPLY ? 'apply' : 'dry'}.json`, JSON.stringify(plan, null, 2));
  console.log(`Plan: /tmp/sevdesk-storno-${APPLY ? 'apply' : 'dry'}.json`);

  if (plan.cancel.length > MAX_CANCELS) {
    throw new Error(`Sicherheits-Abbruch: ${plan.cancel.length} Kandidaten > ${MAX_CANCELS} — bitte Plan prüfen.`);
  }
  if (!APPLY) { console.log('\nDRY-RUN — nichts storniert. Mit --apply ausführen.'); return; }

  // 3) Stornieren
  const headers = { Authorization: token, 'Content-Type': 'application/json' };
  let done = 0, failed = 0;
  for (const c of plan.cancel) {
    try {
      const r = await fetch(`https://my.sevdesk.de/api/v1/Invoice/${c.id}/cancelInvoice`, { method: 'POST', headers });
      if (!r.ok) throw new Error(`${r.status} ${(await r.text().catch(() => '')).slice(0, 150)}`);
      const res = await r.json().catch(() => ({}));
      const stornoId = res?.objects?.id || res?.objects?.invoice?.id || null;
      // Lokalen Spiegel markieren, damit die Rechnungen-KPI den Beleg nicht mehr zählt
      const localDoc = invoiceDocBySevdeskId.get(c.id);
      if (localDoc) {
        await localDoc.ref.update({
          type: 'storniert',
          cancelledAt: new Date().toISOString(),
          cancellationSevdeskId: stornoId ? String(stornoId) : null,
          cancelReason: 'duplikat_incident_2026-07-20',
        }).catch(() => {});
      }
      done++;
      console.log(`✂ ${c.nr} storniert (Storno-ID ${stornoId || '?'})`);
      await new Promise((r2) => setTimeout(r2, 300));
    } catch (err) {
      failed++;
      console.error(`✖ ${c.nr}: ${err.message}`);
    }
  }
  console.log(`\n[storno-dups] FERTIG: ${done} storniert, ${failed} Fehler, ${plan.skippedPaid.length} bezahlt→manuell, ${plan.skippedDraft.length} Entwürfe→manuell`);
}

main().catch((e) => { console.error('[storno-dups] FATAL:', e.message); process.exit(1); });
