/* eslint-disable no-console */
/**
 * Einzellose eines Monats zu EINEM Monatslos zusammenlegen.
 *
 *   node backend/scripts/consolidate-lots.js --into L-0726
 *   node backend/scripts/consolidate-lots.js --into L-0726 --apply --confirm LOS_KONSOLIDIEREN_V1
 *
 * Betreiber-Anweisung 2026-10-08: „L-0726XX konsolidieren zu L-0726,
 * L-0926XX konsolidieren zu L-0926." Quellen sind ALLE Lose im Altformat
 * L-MMYYNN desselben Monats (parseLotCode liefert dafür `legacy:true`).
 *
 * Was ein Lauf tut, in dieser Reihenfolge — jede Stufe fail-closed:
 *   1. Ziel-Los anlegen, falls es fehlt. ekBrutto = SUMME der Quell-Beträge,
 *      die Herkunft steht in der Notiz. Existiert das Ziel schon MIT eigenem
 *      ekBrutto, wird NICHT still addiert, sondern abgebrochen — ein doppelt
 *      gezählter Einkauf fällt später niemandem mehr auf.
 *   2. Produkte umhängen: nur ops-Marker (sourceLot/sourceLotAt), wie in
 *      assign-initial-lot.js und move-lot-products.js. Der alte Code bleibt
 *      additiv in ops.sourceLotPrevious — der Lauf ist umkehrbar.
 *   3. Quell-Lose löschen, aber erst nach einer frischen count()-Prüfung, dass
 *      dort wirklich 0 Produkte hängen (gleicher Guard wie deleteLot).
 *
 * Was es NICHT tut: warehouseEvents anfassen (meta.lotCode der alten
 * Buchungen bleibt als Historie stehen; die Kennzahlen hängen ohnehin am
 * Produkt, nicht am Ereignis) und Bestandsfelder berühren.
 *
 * Collection HART auf products_v2 — ein fehlender Env-Export darf nicht still
 * die falsche Collection treffen.
 */

const { Firestore, Timestamp } = require('@google-cloud/firestore');
const { parseLotCode } = require('../lib/warehouse-lots');
const { parseApplyArgs } = require('./_apply-guard');

process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const firestore = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT });

const { apply: APPLY, argv } = parseApplyArgs();
const CONFIRM_TOKEN = 'LOS_KONSOLIDIEREN_V1';

function argValue(name, fallback) {
  const idx = argv.indexOf(name);
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  return fallback;
}

const PRODUCTS_COLLECTION = 'products_v2';
const LOTS_COLLECTION = 'warehouse_lots';

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}
function round2(x) {
  return Math.round((num(x) + Number.EPSILON) * 100) / 100;
}

async function main() {
  const zielInput = argValue('--into', null);
  if (!zielInput) {
    console.error('Aufruf: --into <L-MMYY> [--apply --confirm LOS_KONSOLIDIEREN_V1]');
    process.exitCode = 1;
    return;
  }
  const ziel = parseLotCode(zielInput);
  if (!ziel || ziel.type !== 'L' || ziel.legacy) {
    console.error(`Ziel muss ein Monatslos im Format L-MMYY sein, nicht: ${zielInput}`);
    process.exitCode = 1;
    return;
  }
  if (APPLY && argValue('--confirm', '') !== CONFIRM_TOKEN) {
    console.error(`--apply verlangt --confirm ${CONFIRM_TOKEN}`);
    process.exitCode = 1;
    return;
  }

  // Quellen: alle Alt-Lose desselben Monats/Jahres.
  const alleLose = await firestore.collection(LOTS_COLLECTION).get();
  const quellen = alleLose.docs
    .map((d) => ({ code: d.id, ...(d.data() || {}) }))
    .filter((l) => {
      const p = parseLotCode(l.code);
      return p && p.type === 'L' && p.legacy && p.month === ziel.month && p.year === ziel.year;
    })
    .sort((a, b) => a.code.localeCompare(b.code));

  console.log(`\n=== Konsolidieren → ${ziel.code} (${APPLY ? 'ANWENDEN' : 'PROBELAUF'}) ===`);
  console.log(`Projekt: ${process.env.GOOGLE_CLOUD_PROJECT}\n`);

  if (!quellen.length) {
    console.log(`Keine Alt-Lose L-${String(ziel.month).padStart(2, '0')}${String(ziel.year % 100).padStart(2, '0')}NN vorhanden — nichts zu tun.`);
    return;
  }

  // Mengen je Quelle
  let ekSumme = 0;
  let produkteGesamt = 0;
  const produktDocs = [];
  console.log('Quelle      EK brutto  Produkte');
  for (const q of quellen) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await firestore.collection(PRODUCTS_COLLECTION).where('ops.sourceLot', '==', q.code).get();
    ekSumme += num(q.ekBrutto);
    produkteGesamt += snap.size;
    snap.docs.forEach((d) => produktDocs.push({ ref: d.ref, von: q.code }));
    console.log(`${q.code.padEnd(11)} ${String(q.ekBrutto ?? '—').padStart(9)} ${String(snap.size).padStart(9)}`);
  }
  ekSumme = round2(ekSumme);
  console.log(`${'SUMME'.padEnd(11)} ${String(ekSumme).padStart(9)} ${String(produkteGesamt).padStart(9)}`);

  // Ziel
  const zielRef = firestore.collection(LOTS_COLLECTION).doc(ziel.code);
  const zielSnap = await zielRef.get();
  if (zielSnap.exists && num(zielSnap.data()?.ekBrutto) > 0) {
    console.error(`\nABBRUCH: ${ziel.code} existiert bereits mit ekBrutto=${zielSnap.data().ekBrutto}. Ein Addieren wäre ein doppelt gezählter Einkauf — bitte von Hand klären.`);
    process.exitCode = 1;
    return;
  }
  const note = `Zusammengelegt am ${new Date().toISOString().slice(0, 10)} aus ${quellen.map((q) => `${q.code} (${q.ekBrutto ?? '—'} €)`).join(', ')}`;
  console.log(`\nZiel ${ziel.code}: ${zielSnap.exists ? 'existiert (ohne EK) — EK wird gesetzt' : 'wird angelegt'} mit ekBrutto=${ekSumme} €`);
  console.log(`Notiz: ${note}`);
  console.log(`\nDanach: ${produkteGesamt} Produkte hängen an ${ziel.code}; ${quellen.length} Alt-Lose werden gelöscht.`);

  if (!APPLY) {
    console.log('\nProbelauf — es wurde NICHTS geändert.');
    return;
  }

  // 1. Ziel
  const vorlage = quellen[0];
  await zielRef.set(
    {
      code: ziel.code,
      tenantId: vorlage.tenantId || 'default',
      type: 'L',
      month: ziel.month,
      year: ziel.year,
      number: null,
      ekBrutto: ekSumme,
      note: String(note).slice(0, 500),
      createdAt: zielSnap.exists ? zielSnap.data().createdAt || Timestamp.now() : Timestamp.now(),
      createdBy: zielSnap.exists ? zielSnap.data().createdBy || null : { uid: 'script:consolidate-lots', email: null },
    },
    { merge: true }
  );
  console.log(`\n${ziel.code} geschrieben.`);

  // 2. Produkte
  const nowIso = new Date().toISOString();
  const bulk = firestore.bulkWriter();
  bulk.onWriteError((err) => {
    if (err.failedAttempts < 5) return true;
    console.error(`Update dauerhaft fehlgeschlagen: ${err.documentRef.path}: ${err.message}`);
    return false;
  });
  for (const { ref, von } of produktDocs) {
    bulk.update(ref, {
      'ops.sourceLot': ziel.code,
      'ops.sourceLotAt': nowIso,
      'ops.sourceLotPrevious': von,
      'ops.sourceLotMovedAt': Timestamp.now(),
    });
  }
  await bulk.close();
  console.log(`${produktDocs.length} Produkte auf ${ziel.code} umgehängt.`);

  // 3. Quellen löschen — fail-closed gegen frischen Count.
  for (const q of quellen) {
    // eslint-disable-next-line no-await-in-loop
    const rest = await firestore.collection(PRODUCTS_COLLECTION).where('ops.sourceLot', '==', q.code).count().get();
    const n = rest.data().count || 0;
    if (n > 0) {
      console.error(`${q.code} NICHT gelöscht: noch ${n} Produkte zugeordnet.`);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await firestore.collection(LOTS_COLLECTION).doc(q.code).delete();
    console.log(`${q.code} gelöscht.`);
  }
  console.log('\nFertig. Rückweg: Produkte tragen ops.sourceLotPrevious; die Alt-Lose müssten dafür neu angelegt werden (Beträge stehen in der Notiz des Monatsloses).');
}

main().catch((err) => {
  console.error(`FEHLER: ${err.message}`);
  process.exitCode = 1;
});
