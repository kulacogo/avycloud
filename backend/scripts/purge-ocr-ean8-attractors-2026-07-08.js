/* eslint-disable no-console */
/**
 * purge-ocr-ean8-attractors-2026-07-08.js
 *
 * Entfernt OCR-Müll-EAN-8-Codes aus den Identity-Feldern von products_v2
 * (Incident 2026-07-08, PRODUKTIONS-STOP). OCR liest 8-stellige Nicht-Barcodes
 * (Hersteller-Telefonnummern, Datumsangaben, Größenläufe, entstrichelte MPNs,
 * "00000000"), die zufällig die schwache EAN-8-Prüfziffer bestehen. Sie wurden
 * als `details.identifiers.ean` UND `identification.barcodes` persistiert und
 * kollabieren beim Erfassen verschiedene Produkte desselben Herstellers zu
 * einem Datenblatt (findProductByStrictIdentifier matcht sie ohne Marken-/
 * Namens-Check). Audit belegt: ALLE Bestands-EAN-8 sind Nicht-Barcodes.
 *
 * Konservativ: entfernt 8-stellige NUMERISCHE Codes NUR aus den drei Feldern,
 * die findProductByStrictIdentifier abfragt (der Reuse-Attraktor):
 * identification.barcodes[], details.identifiers.ean, details.identifiers.gtin.
 * ops.identity_aliases und details.identifiers.upc bleiben UNANGETASTET (nicht
 * vom Capture-Reuse-Pfad abgefragt; Aliase enthalten legitime Modellnummern-Tokens).
 * Längere (echte) Codes bleiben unangetastet. Backup jedes Docs vor Mutation.
 * DRY-RUN default, --apply.
 *
 *   USE_PRODUCTS_V2=true node backend/scripts/purge-ocr-ean8-attractors-2026-07-08.js
 *   USE_PRODUCTS_V2=true node backend/scripts/purge-ocr-ean8-attractors-2026-07-08.js --apply
 */
const { Firestore, FieldValue } = require('@google-cloud/firestore');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const COLLECTION = 'products_v2';
const BACKUP_COLLECTION = 'products_v2_ean8_backup_2026_07';
const firestore = new Firestore({ projectId: PROJECT_ID });

// Nur rein-numerische 8-stellige Strings (EAN-8-Kandidaten), NICHT 8-Buchstaben-
// Wörter wie "original" (die als Namens-Token in ops.identity_aliases stehen).
const isLen8 = (c) => typeof c === 'string' && /^\d{8}$/.test(c.trim());

function parseArgs(argv) {
  return { apply: argv.includes('--apply'), tenant: (() => {
    const i = argv.indexOf('--tenant'); return i >= 0 && argv[i + 1] ? argv[i + 1] : 'default';
  })() };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[ean8-purge] tenant=${args.tenant} mode=${args.apply ? 'APPLY' : 'DRY-RUN'}`);
  const snap = await firestore.collection(COLLECTION).get();

  const targets = [];
  snap.forEach((doc) => {
    const d = doc.data();
    if ((d.tenantId || 'default') !== args.tenant) return;
    const barcodes = Array.isArray(d.identification?.barcodes) ? d.identification.barcodes.map((c) => String(c).trim()) : [];
    const bad = barcodes.filter(isLen8);
    const eanBad = isLen8(String(d.details?.identifiers?.ean || '').trim());
    const gtinBad = isLen8(String(d.details?.identifiers?.gtin || '').trim());
    if (bad.length || eanBad || gtinBad) {
      targets.push({ id: doc.id, d, barcodes, bad, eanBad, gtinBad });
    }
  });

  console.log(`\n${targets.length} Docs mit EAN-8-Müll in Match-Feldern:`);
  for (const t of targets) {
    const codes = [...new Set([...t.bad, ...(t.eanBad ? [String(t.d.details.identifiers.ean).trim()] : []), ...(t.gtinBad ? [String(t.d.details.identifiers.gtin).trim()] : [])])];
    console.log(`  ${t.id}  ${t.d.identification?.brand || ''} "${(t.d.identification?.name || '').slice(0, 40)}"  bad=[${codes.join(',')}]`);
  }
  if (!args.apply) { console.log('\nDRY-RUN — mit --apply ausführen.'); process.exit(0); }

  let done = 0;
  for (const t of targets) {
    await firestore.collection(BACKUP_COLLECTION).doc(t.id).set({
      backedUpAt: new Date().toISOString(), incident: 'ocr-ean8-attractors-2026-07-08', data: t.d,
    });
    const update = {};
    if (t.bad.length) update['identification.barcodes'] = t.barcodes.filter((c) => !isLen8(c));
    if (t.eanBad) update['details.identifiers.ean'] = '';
    if (t.gtinBad) update['details.identifiers.gtin'] = '';
    update['ops.ean8_purge_2026_07_08'] = {
      removed: [...new Set([...t.bad, ...(t.eanBad ? [String(t.d.details.identifiers.ean).trim()] : []), ...(t.gtinBad ? [String(t.d.details.identifiers.gtin).trim()] : [])])],
      at: new Date().toISOString(),
    };
    await firestore.collection(COLLECTION).doc(t.id).update(update);
    done++;
  }
  console.log(`\n✅ ${done} Docs bereinigt. Backups in ${BACKUP_COLLECTION}.`);
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
