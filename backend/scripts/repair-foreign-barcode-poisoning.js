/* eslint-disable no-console */
/**
 * Repair: fremde Barcodes auf Produkt-Datenblaettern (Incident 2026-07-08)
 *
 * Hintergrund: products_v2/4006633149839 (ATE Bremsbelagsatz 13.0460-7195.2)
 * trug den GTIN-14 14006633314036, der physisch auf dem Karton der ATE
 * Bremsscheibe 24.0125-0184.1 gedruckt ist. Jede Neu-Erfassung der Scheibe
 * matchte damit "strikt" auf den falschen Belagsatz und wurde stillschweigend
 * als Duplikat wiederverwendet. Vergiftet wurde der Datensatz durch
 * Grounding-/OCR-Mischung im alten Stage-1-Barcode-Merge (seit 2026-07-08
 * gefixt, siehe lib/barcode-merge.js).
 *
 * Modi:
 *   Audit (default, read-only): findet Barcodes, die auf MEHREREN Docs stehen,
 *   und listet sie mit Doc-IDs/Namen.
 *     node backend/scripts/repair-foreign-barcode-poisoning.js
 *
 *   Apply (gezielte Entfernung eines Codes von einem Doc):
 *     node backend/scripts/repair-foreign-barcode-poisoning.js \
 *       --apply --product 4006633149839 --remove 14006633314036
 *
 * Safety: Apply ist update-only auf GENAU ein Doc, entfernt GENAU einen Code
 * aus identification.barcodes / details.identifiers.{ean,gtin,upc} /
 * ops.identity_aliases. Kein Create, kein Delete, kein Stock-Feld.
 */

const { Firestore, FieldValue } = require('@google-cloud/firestore');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const COLLECTION = 'products_v2';
const firestore = new Firestore({ projectId: PROJECT_ID });

function parseArgs(argv) {
  const args = { apply: false, product: null, remove: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--apply') args.apply = true;
    if (argv[i] === '--product') args.product = argv[i + 1];
    if (argv[i] === '--remove') args.remove = argv[i + 1];
  }
  return args;
}

async function audit() {
  console.log(`[audit] Scanne ${COLLECTION} nach Barcodes auf mehreren Docs …`);
  const snap = await firestore.collection(COLLECTION).get();
  const byCode = new Map();

  snap.forEach((doc) => {
    const d = doc.data();
    const codes = new Set(
      [
        ...(Array.isArray(d.identification?.barcodes) ? d.identification.barcodes : []),
        d.details?.identifiers?.ean,
        d.details?.identifiers?.gtin,
        d.details?.identifiers?.upc,
      ]
        .map((c) => (c == null ? '' : String(c).trim()))
        .filter(Boolean)
    );
    for (const code of codes) {
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code).push({ id: doc.id, name: d.identification?.name || '(ohne Name)' });
    }
  });

  let conflicts = 0;
  for (const [code, docs] of byCode) {
    if (docs.length > 1) {
      conflicts += 1;
      console.log(`\nKONFLIKT ${code} auf ${docs.length} Docs:`);
      docs.forEach((p) => console.log(`  - ${p.id}  ${p.name}`));
    }
  }
  console.log(`\n[audit] ${snap.size} Docs geprueft, ${conflicts} Barcode-Konflikte.`);
  if (conflicts) {
    console.log('[audit] Pro Konflikt pruefen, welchem Produkt der Code physisch gehoert,');
    console.log('        dann: --apply --product <falschesDoc> --remove <code>');
  }
}

async function apply({ product, remove }) {
  if (!product || !remove) {
    console.error('Fehler: --apply braucht --product <docId> und --remove <barcode>');
    process.exit(1);
  }
  const ref = firestore.collection(COLLECTION).doc(product);
  const doc = await ref.get();
  if (!doc.exists) {
    console.error(`Doc ${product} existiert nicht.`);
    process.exit(1);
  }
  const d = doc.data();
  const update = {};

  const barcodes = Array.isArray(d.identification?.barcodes) ? d.identification.barcodes : [];
  if (barcodes.includes(remove)) {
    update['identification.barcodes'] = barcodes.filter((c) => c !== remove);
  }
  for (const key of ['ean', 'gtin', 'upc']) {
    if (String(d.details?.identifiers?.[key] || '') === remove) {
      update[`details.identifiers.${key}`] = FieldValue.delete();
    }
  }
  const aliases = Array.isArray(d.ops?.identity_aliases) ? d.ops.identity_aliases : [];
  if (aliases.includes(remove)) {
    update['ops.identity_aliases'] = aliases.filter((a) => a !== remove);
  }

  if (!Object.keys(update).length) {
    console.log(`Code ${remove} steht nicht (mehr) auf ${product} — nichts zu tun.`);
    return;
  }

  console.log(`Entferne ${remove} von ${product} (${d.identification?.name || ''}):`);
  console.log(Object.keys(update).map((k) => `  - ${k}`).join('\n'));
  await ref.update({
    ...update,
    'ops.barcode_repair_2026_07_08': {
      removed: remove,
      at: new Date().toISOString(),
      reason: 'foreign barcode poisoning (Incident 2026-07-08)',
    },
  });
  console.log('OK — angewendet.');
}

(async () => {
  const args = parseArgs(process.argv);
  if (args.apply) {
    await apply(args);
  } else {
    await audit();
  }
  process.exit(0);
})().catch((err) => {
  console.error('Script-Fehler:', err?.message || err);
  process.exit(1);
});
