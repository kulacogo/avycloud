/* eslint-disable no-console */
/**
 * Initialbuchung aller Produkte auf ein Los (Owner-Anweisung 2026-07-31):
 * Alle in avycloud erfassten Produkte — unabhängig vom Bestand — werden dem
 * Los NL-0626 zugeordnet (initialer Einkauf Mischware, EK 14.000 € brutto).
 * Gleichzeitig werden die Alt-Paletten-Marker (ops.sourcePalette/-At) geleert,
 * damit keine Reste des PEG-Formats in den Produktdaten bleiben.
 *
 * Bewusst DIREKTER Firestore-Update statt saveProductV2():
 * Es werden AUSSCHLIESSLICH ops-Marker geschrieben (sourceLot/sourceLotAt,
 * sourcePalette/sourcePaletteAt) — keine Inventar-, Titel- oder Inhaltsfelder.
 * Das ist exakt das Muster der Identify-Duplikat-Reuse-Pfade
 * (routes/identify.js). Ein Massen-Lauf durch saveProductV2 würde dagegen
 * Titel-/Aspect-Policies auf alle Produkte anwenden (Massen-Mutations-Risiko).
 * Kein emitSyncEvent nötig: kein Bestands-Feld wird berührt.
 *
 * Collection ist bewusst HART auf products_v2 gesetzt (Single Source of
 * Truth; legacy 'products' ist read-only) — unabhängig von USE_PRODUCTS_V2,
 * damit ein fehlender Env-Export nicht still die falsche Collection trifft.
 *
 * Safety:
 *   - Dry-run by default: zählt und zeigt Beispiele, schreibt NICHTS.
 *   - --apply führt die Updates aus (BulkWriter, idempotent — bereits
 *     zugeordnete Produkte werden übersprungen).
 *
 * Usage:
 *   node backend/scripts/assign-initial-lot.js
 *   node backend/scripts/assign-initial-lot.js --apply
 *   node backend/scripts/assign-initial-lot.js --lot NL-0626 --ek 14000 --apply
 */

const { Firestore, Timestamp } = require('@google-cloud/firestore');
const { parseLotCode } = require('../lib/warehouse-lots');

const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud',
});

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');

function argValue(name, fallback) {
  const idx = argv.indexOf(name);
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  return fallback;
}

const LOT_CODE_INPUT = argValue('--lot', 'NL-0626');
const EK_BRUTTO = Number(argValue('--ek', '14000'));
const LOT_NOTE = 'Initialer Einkauf Mischware';

const PRODUCTS_COLLECTION = 'products_v2';
const LOTS_COLLECTION = 'warehouse_lots';

async function ensureLot(parsed) {
  const ref = firestore.collection(LOTS_COLLECTION).doc(parsed.code);
  const snap = await ref.get();
  if (!snap.exists) {
    if (APPLY) {
      await ref.set({
        code: parsed.code,
        tenantId: 'default',
        type: parsed.type,
        month: parsed.month,
        year: parsed.year,
        number: parsed.number,
        ekBrutto: Number.isFinite(EK_BRUTTO) ? EK_BRUTTO : null,
        note: LOT_NOTE,
        createdAt: Timestamp.now(),
        createdBy: { uid: 'script:assign-initial-lot', email: null },
      });
      console.log(`Los ${parsed.code} angelegt (ekBrutto=${EK_BRUTTO}, note="${LOT_NOTE}").`);
    } else {
      console.log(`Los ${parsed.code} existiert noch nicht — würde angelegt (ekBrutto=${EK_BRUTTO}).`);
    }
    return;
  }
  const data = snap.data() || {};
  console.log(`Los ${parsed.code} existiert (ekBrutto=${data.ekBrutto ?? 'null'}).`);
  if ((data.ekBrutto === null || data.ekBrutto === undefined) && Number.isFinite(EK_BRUTTO)) {
    if (APPLY) {
      await ref.update({ ekBrutto: EK_BRUTTO, note: data.note || LOT_NOTE });
      console.log(`Los ${parsed.code}: ekBrutto=${EK_BRUTTO} nachgetragen.`);
    } else {
      console.log(`Los ${parsed.code}: ekBrutto=${EK_BRUTTO} würde nachgetragen.`);
    }
  }
}

async function main() {
  const parsed = parseLotCode(LOT_CODE_INPUT);
  if (!parsed) {
    console.error(`Ungültiger Los-Code: ${LOT_CODE_INPUT} (erwartet L-MMYYNN oder NL-MMYY)`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n=== Initialbuchung auf ${parsed.code} (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
  await ensureLot(parsed);

  const col = firestore.collection(PRODUCTS_COLLECTION);
  const nowIso = new Date().toISOString();

  let total = 0;
  let alreadySet = 0;
  let toSet = 0;
  let hadPalette = 0;
  let otherLot = 0;
  let otherLotCleaned = 0;
  let written = 0;
  const paletteSamples = new Map();
  const otherLotSamples = new Map();

  const bulkWriter = APPLY ? firestore.bulkWriter() : null;
  if (bulkWriter) {
    bulkWriter.onWriteError((err) => {
      if (err.failedAttempts < 5) return true;
      console.error(`Update dauerhaft fehlgeschlagen: ${err.documentRef.path}: ${err.message}`);
      return false;
    });
  }

  // Seitenweise über ALLE Produkte (Feld-Maske hält die Reads klein).
  let lastDoc = null;
  const pageSize = 500;
  for (;;) {
    let q = col
      .select('ops.sourceLot', 'ops.sourcePalette', 'ops.sourcePaletteAt')
      .orderBy('__name__')
      .limit(pageSize);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      total += 1;
      const ops = (doc.get('ops') || {});
      const sourceLot = ops.sourceLot || null;
      const sourcePalette = ops.sourcePalette || null;
      if (sourcePalette) {
        hadPalette += 1;
        paletteSamples.set(sourcePalette, (paletteSamples.get(sourcePalette) || 0) + 1);
      }
      // GUARD: Produkte, die bereits ein ANDERES Los tragen, werden NIE
      // umgebucht (Re-Run-Sicherheit) — nur ihre Alt-Paletten-Marker werden
      // geleert. Umbuchen bleibt eine bewusste manuelle Aktion.
      if (sourceLot && sourceLot !== parsed.code) {
        otherLot += 1;
        otherLotSamples.set(sourceLot, (otherLotSamples.get(sourceLot) || 0) + 1);
        const needsPaletteClear = sourcePalette !== null || (ops.sourcePaletteAt || null) !== null;
        if (needsPaletteClear) {
          otherLotCleaned += 1;
          if (bulkWriter) {
            bulkWriter.update(doc.ref, {
              'ops.sourcePalette': null,
              'ops.sourcePaletteAt': null,
            });
          }
        }
        continue;
      }

      const needsUpdate = sourceLot !== parsed.code || sourcePalette !== null || (ops.sourcePaletteAt || null) !== null;
      if (!needsUpdate) {
        alreadySet += 1;
        continue;
      }
      toSet += 1;
      if (bulkWriter) {
        bulkWriter.update(doc.ref, {
          'ops.sourceLot': parsed.code,
          'ops.sourceLotAt': nowIso,
          'ops.sourcePalette': null,
          'ops.sourcePaletteAt': null,
        });
        written += 1;
      }
    }

    lastDoc = snap.docs[snap.docs.length - 1];
    if (total % 500 === 0) console.log(`  … ${total} Produkte gelesen`);
    if (snap.size < pageSize) break;
  }

  if (bulkWriter) await bulkWriter.close();

  console.log(`\nProdukte gesamt:            ${total}`);
  console.log(`Bereits auf ${parsed.code}:     ${alreadySet}`);
  console.log(`${APPLY ? 'Aktualisiert' : 'Würden aktualisiert'}:        ${APPLY ? written : toSet}`);
  console.log(`Hatten Alt-Paletten-Marker: ${hadPalette}`);
  if (otherLot) {
    const top = [...otherLotSamples.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`Tragen bereits ANDERES Los:  ${otherLot} — NICHT umgebucht (${top.map(([c, n]) => `${c}×${n}`).join(', ')}); Paletten-Marker geleert bei ${otherLotCleaned}.`);
  }
  if (paletteSamples.size) {
    const top = [...paletteSamples.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`Paletten-Verteilung (Top):  ${top.map(([c, n]) => `${c}×${n}`).join(', ')}`);
  }

  if (APPLY) {
    const countSnap = await col.where('ops.sourceLot', '==', parsed.code).count().get();
    console.log(`\nVerifikation: ${countSnap.data().count} Produkte tragen jetzt ops.sourceLot=${parsed.code}.`);
  } else {
    console.log('\nDRY-RUN beendet — nichts geschrieben. Mit --apply ausführen.');
  }
}

main().catch((err) => {
  console.error('Initialbuchung fehlgeschlagen:', err);
  process.exitCode = 1;
});
