#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Rollt einzelne GPSR-Etikett-Korrekturen zurück, die die adversariale
 * Verifikation als Verschlechterung (OCR-Müll, ungültiges Land, Marke-statt-
 * Hersteller) eingestuft hat.
 *
 * Setzt die Hersteller-Rolle (und optional EU-Rep) auf den VORHER-Wert aus dem
 * Backfill-Report zurück, entfernt die vom Etikett stammenden Sub-Felder und den
 * product_image-Autoritäts-Marker (damit nichts Falsches an eBay geht und die
 * Registry das Feld wieder normal behandelt).
 *
 * Aufruf:
 *   ... gpsr-revert-corrections.js --corrections corrections-36.json --ids docId1,docId2 [--apply]
 *   ... gpsr-revert-corrections.js --corrections corrections-36.json --ids-file reverts.txt [--apply]
 */

const fs = require('fs');
const { firestore, PRODUCTS_COLLECTION } = require('../lib/firestore');

const MFR_SUBFIELDS = ['manufacturer_address', 'manufacturer_city', 'manufacturer_postalcode', 'manufacturer_state_province', 'country_code', 'email', 'manufacturer_phone', 'phone'];
const EUREP_SUBFIELDS = ['eu_responsible_address', 'eu_responsible_city', 'eu_responsible_postalcode', 'eu_responsible_state_province', 'eu_responsible_country', 'eu_responsible_country_code', 'eu_responsible_email', 'eu_responsible_phone'];

function parseArgs(argv) {
  const out = { apply: false, corrections: null, ids: [], idsFile: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--corrections') out.corrections = argv[++i];
    else if (a === '--ids') out.ids = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--ids-file') out.idsFile = argv[++i];
  }
  return out;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.corrections) { console.error('--corrections <file> erforderlich'); process.exit(1); }
  const corr = JSON.parse(fs.readFileSync(args.corrections, 'utf8'));
  const byId = new Map(corr.map((c) => [c.docId, c]));

  let ids = args.ids;
  if (args.idsFile) ids = fs.readFileSync(args.idsFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) { console.error('Keine IDs (--ids oder --ids-file)'); process.exit(1); }

  console.log(`[gpsr-revert] Modus=${args.apply ? 'APPLY' : 'DRY-RUN'} — ${ids.length} Rückrollungen`);

  for (const docId of ids) {
    const c = byId.get(docId);
    if (!c) { console.warn(`  SKIP ${docId}: nicht im Report`); continue; }
    const snap = await firestore.collection(PRODUCTS_COLLECTION).doc(docId).get();
    if (!snap.exists) { console.warn(`  SKIP ${docId}: Doc fehlt`); continue; }
    const gpsr = { ...((snap.data()?.details?.gpsr) || {}) };

    // Hersteller-Rolle auf VORHER zurück: Name + Land setzen, Etikett-Sub-Felder entfernen.
    if (safeString(c.before_mfr)) gpsr.manufacturer_name = c.before_mfr; else delete gpsr.manufacturer_name;
    if (safeString(c.before_country)) gpsr.entity_country = c.before_country; else delete gpsr.entity_country;
    for (const k of MFR_SUBFIELDS) delete gpsr[k];

    // EU-Rep-Rolle auf VORHER zurück (Name; Sub-Felder entfernen).
    if (safeString(c.before_eurep)) gpsr.eu_responsible_name = c.before_eurep;
    else delete gpsr.eu_responsible_name;
    for (const k of EUREP_SUBFIELDS) delete gpsr[k];

    // product_image-Autorität entfernen — die Etikett-Lesung war unzuverlässig.
    const ev = { ...(gpsr.evidence && typeof gpsr.evidence === 'object' ? gpsr.evidence : {}) };
    delete ev.pendingEbayRegulatoryPush;
    ev.status = 'reverted_ocr';
    ev.revertedAt = new Date().toISOString();
    gpsr.evidence = ev;

    console.log(`  ${c.sku} (${docId}): mfr -> "${gpsr.manufacturer_name || '-'}" (${gpsr.entity_country || '-'}), euRep -> "${gpsr.eu_responsible_name || '-'}"`);
    if (args.apply) {
      await firestore.collection(PRODUCTS_COLLECTION).doc(docId).update({ 'details.gpsr': gpsr });
      console.log('     -> geschrieben');
    }
  }
  console.log(args.apply ? '[gpsr-revert] APPLY fertig.' : '[gpsr-revert] DRY-RUN — nichts geschrieben.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e.stack); process.exit(1); });
