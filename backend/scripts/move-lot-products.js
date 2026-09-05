/* eslint-disable no-console */
/**
 * Produkte von einem Los auf ein anderes umhängen.
 *
 *   node backend/scripts/move-lot-products.js --from NL-0826 --to L-072643
 *   node backend/scripts/move-lot-products.js --from NL-0826 --to L-072643 --apply
 *
 * Bewusst DIREKTER Firestore-Update statt saveProductV2(): es werden
 * AUSSCHLIESSLICH ops-Marker geschrieben (sourceLot/sourceLotAt/sourceLotPrevious)
 * — keine Inventar-, Titel- oder Inhaltsfelder. Das ist exakt das Muster von
 * `assign-initial-lot.js`. Ein Massen-Lauf durch saveProductV2 würde Titel- und
 * Aspect-Policies auf alle betroffenen Produkte anwenden (Massen-Mutations-Risiko).
 * Kein emitSyncEvent nötig: kein Bestands-Feld wird berührt.
 *
 * UMKEHRBAR: der bisherige Los-Code wird additiv in `ops.sourceLotPrevious`
 * festgehalten (mit `ops.sourceLotMovedAt`). Ein Rücklauf ist damit ein
 * Aufruf mit vertauschtem --from/--to.
 *
 * WAS DAS SCRIPT NICHT TUT (bewusst):
 *   - Es fasst den Einkaufsbetrag (`ekBrutto`) KEINES Loses an. Wer Produkte
 *     umhängt, verschiebt die Bezugsmenge des Ziel-Loses und damit dessen
 *     EK je Einheit. Ob der Einkaufsbetrag des Quell-Loses mitwandern soll,
 *     ist eine kaufmännische Entscheidung — das Script zeigt die Auswirkung
 *     an und überlässt sie dem Bediener.
 *   - Es löscht das leergeräumte Quell-Los nicht (dafür gibt es den
 *     fail-closed Löschweg in der Oberfläche).
 *
 * Collection ist bewusst HART auf products_v2 gesetzt (Single Source of Truth),
 * unabhängig von USE_PRODUCTS_V2 — ein fehlender Env-Export darf nicht still
 * die falsche Collection treffen.
 */

const { Firestore, Timestamp } = require('@google-cloud/firestore');
const { parseLotCode } = require('../lib/warehouse-lots');
const { parseApplyArgs } = require('./_apply-guard');

// GOOGLE_CLOUD_PROJECT selbst setzen, BEVOR irgendetwas den Client baut:
// gcloud steht lokal oft auf einem fremden Projekt.
process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';

const firestore = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT });

// Gemeinsame Schutz-Wache aller schreibenden Operator-Scripts: Probelauf ist
// der Standard, --apply ist die bewusste Entscheidung.
const { apply: APPLY, argv } = parseApplyArgs();

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

/** Fail-closed: ein Ziel-Los, das es nicht gibt, würde Produkte ins Nichts hängen. */
async function ladeLos(code, rolle) {
  const parsed = parseLotCode(code);
  if (!parsed) throw new Error(`Ungültiger Los-Code für ${rolle}: ${code} (erwartet L-MMYYNN oder NL-MMYY)`);
  const snap = await firestore.collection(LOTS_COLLECTION).doc(parsed.code).get();
  if (!snap.exists) throw new Error(`Los ${parsed.code} (${rolle}) existiert nicht — Abbruch.`);
  return { code: parsed.code, ...(snap.data() || {}) };
}

async function mengeVonLos(code) {
  const snap = await firestore.collection(PRODUCTS_COLLECTION).where('ops.sourceLot', '==', code).get();
  let einheiten = 0;
  snap.docs.forEach((d) => { einheiten += num(d.data()?.inventory?.quantity); });
  return { docs: snap.docs, produkte: snap.size, einheiten };
}

async function main() {
  const vonCode = argValue('--from', null);
  const nachCode = argValue('--to', null);
  if (!vonCode || !nachCode) {
    console.error('Aufruf: --from <Los-Code> --to <Los-Code> [--apply]');
    process.exitCode = 1;
    return;
  }
  if (vonCode.trim().toUpperCase() === nachCode.trim().toUpperCase()) {
    console.error('Quelle und Ziel sind dasselbe Los — nichts zu tun.');
    process.exitCode = 1;
    return;
  }

  const von = await ladeLos(vonCode, 'Quelle');
  const nach = await ladeLos(nachCode, 'Ziel');

  console.log(`\n=== Produkte umhängen: ${von.code} → ${nach.code} (${APPLY ? 'ANWENDEN' : 'PROBELAUF'}) ===`);
  console.log(`Projekt: ${process.env.GOOGLE_CLOUD_PROJECT} · Collection: ${PRODUCTS_COLLECTION}\n`);

  const quelle = await mengeVonLos(von.code);
  const ziel = await mengeVonLos(nach.code);

  console.log(`${von.code}: ${quelle.produkte} Produkte · ${quelle.einheiten} Einheiten auf Bestand · EK ${von.ekBrutto ?? '—'} €`);
  console.log(`${nach.code}: ${ziel.produkte} Produkte · ${ziel.einheiten} Einheiten auf Bestand · EK ${nach.ekBrutto ?? '—'} €`);

  if (!quelle.produkte) {
    console.log(`\n${von.code} hat keine zugeordneten Produkte — nichts zu tun.`);
    return;
  }

  console.log(`\nNACHHER: ${nach.code} hätte ${ziel.produkte + quelle.produkte} Produkte · ${ziel.einheiten + quelle.einheiten} Einheiten auf Bestand.`);
  console.log(`         ${von.code} bliebe leer (0 Produkte) — sein Einkaufsbetrag von ${von.ekBrutto ?? '—'} € würde auf KEINE Einheiten mehr entfallen.`);
  console.log('\nHINWEIS zum Einkaufspreis: dieses Script fasst keinen ekBrutto an.');
  console.log(`  Der EK je Einheit von ${nach.code} sinkt, weil dieselbe Summe auf mehr Einheiten verteilt wird.`);
  console.log(`  Soll der Einkaufsbetrag mitwandern, danach ${nach.code} auf ${num(von.ekBrutto) + num(nach.ekBrutto)} € setzen (Los-Struktur-Tab).`);

  const nowIso = new Date().toISOString();
  let geschrieben = 0;

  const bulkWriter = APPLY ? firestore.bulkWriter() : null;
  if (bulkWriter) {
    bulkWriter.onWriteError((err) => {
      if (err.failedAttempts < 5) return true;
      console.error(`Update dauerhaft fehlgeschlagen: ${err.documentRef.path}: ${err.message}`);
      return false;
    });
  }

  console.log('\nBeispiele:');
  quelle.docs.slice(0, 5).forEach((d) => {
    const p = d.data() || {};
    console.log(`  ${p?.identification?.sku || d.id}  Menge=${num(p?.inventory?.quantity)}  ${String(p?.identification?.name || '').slice(0, 46)}`);
  });

  for (const doc of quelle.docs) {
    if (!APPLY) { geschrieben += 1; continue; }
    bulkWriter.update(doc.ref, {
      'ops.sourceLot': nach.code,
      'ops.sourceLotAt': nowIso,
      // Additiv, macht den Lauf umkehrbar und nachvollziehbar.
      'ops.sourceLotPrevious': von.code,
      'ops.sourceLotMovedAt': Timestamp.now(),
    });
    geschrieben += 1;
  }

  if (bulkWriter) await bulkWriter.close();

  console.log(`\n${APPLY ? 'Umgehängt' : 'Würde umhängen'}: ${geschrieben} Produkte.`);
  if (!APPLY) console.log('\nProbelauf — es wurde NICHTS geändert. Mit --apply ausführen.');
  else console.log(`\nRücklauf möglich mit: --from ${nach.code} --to ${von.code} (betrifft dann aber ALLE Produkte des Ziel-Loses).`);
}

main().catch((err) => {
  console.error(`FEHLER: ${err.message}`);
  process.exitCode = 1;
});
