#!/usr/bin/env node
/**
 * Bereinigt GPSR-Daten, die über einen Platzhalter-"Marken"-Registry-Eintrag
 * auf unverwandte Produkte verschmiert wurden.
 *
 * BEFUND 2026-08-10 (read-only gemessen, Tenant 'default'):
 * `gpsrManufacturers/markenlos` (confidence 0, sources []) trug
 *
 *   manufacturer_name          "Markenlos"
 *   manufacturer_address       "78 avenue des Champs Elysees Bureau 326", Paris
 *   manufacturer_state_province"Zhejiang"            <- CN-Provinz in Pariser Adresse
 *   email                      "mjcm190928@gmail.com"<- Freemail als Herstellerkontakt
 *   eu_responsible_name        "Geaplan GmbH"        <- unbeteiligte fremde Firma
 *
 * `lib/firestore.js` legte diesen Block über JEDES Produkt mit der "Marke"
 * Markenlos — beim Speichern UND beim Lesen. Dadurch überlebte auch keine
 * manuelle Korrektur. 32 Live-Angebote trugen den zeichengleichen Block.
 *
 * Die Ursache ist im Code behoben (lib/gpsr-registry-guard.js: Platzhalter
 * keyen keinen Lookup mehr, unbelegte Einträge werden nicht durchgesetzt,
 * und upsertManufacturerGpsr legt sie gar nicht mehr an). Dieses Script
 * räumt den ALTBESTAND auf.
 *
 * WAS ES BEWUSST NICHT TUT: den richtigen Hersteller raten. Genau das Raten
 * hat den Schaden erzeugt. Es entfernt nur nachweislich fremde Angaben und
 * hinterlässt ein leeres, ehrliches Feld — kein erfundenes.
 *
 * Aufruf (read-only ist Default, schreibt NIE ohne beides):
 *   node backend/scripts/repair-placeholder-brand-gpsr.js
 *   node backend/scripts/repair-placeholder-brand-gpsr.js --live-only
 *   node backend/scripts/repair-placeholder-brand-gpsr.js --apply --confirm PLACEHOLDER_GPSR_V1
 *
 * Schreiben läuft ausschließlich über saveProductV2 (source
 * 'repair-placeholder-gpsr', skipStockEvent, allowWarehouseFields:false) —
 * Bestand wird NIE angefasst.
 */

'use strict';

process.env.USE_PRODUCTS_V2 = process.env.USE_PRODUCTS_V2 || 'true';

const fsNode = require('fs');
const path = require('path');
const { isPlaceholderBrand } = require('../lib/gpsr-registry-guard');

const CONFIRM_TOKEN = 'PLACEHOLDER_GPSR_V1';
const TENANT = process.env.TENANT_ID || 'default';

/**
 * Felder, die bei einem Platzhalter-"Hersteller" nachweislich nicht zum
 * Produkt gehören können. `manufacturer_name` bleibt BEWUSST stehen — es ist
 * eBay-Pflichtfeld; es zu leeren würde laufende Angebote gefährden (goldene
 * Regel: Production darf nie negativ beeinflusst werden).
 */
const CLEARABLE = [
  'manufacturer_address',
  'manufacturer_city',
  'manufacturer_postalcode',
  'manufacturer_state_province',
  'manufacturer_phone',
  'email',
  'url',
  'entity_country',
  'country_code',
  'eu_responsible_name',
  'eu_responsible_address',
  'eu_responsible_city',
  'eu_responsible_postalcode',
  'eu_responsible_state_province',
  'eu_responsible_country',
  'eu_responsible_country_code',
  'eu_responsible_email',
  'eu_responsible_phone',
];

function s(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function parseArgs(argv) {
  const out = { apply: false, confirm: '', liveOnly: false, outDir: '/tmp' };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--apply') out.apply = true;
    else if (t === '--confirm') out.confirm = argv[++i] || '';
    else if (t === '--live-only') out.liveOnly = true;
    else if (t === '--out') out.outDir = argv[++i] || '/tmp';
  }
  return out;
}

function isLive(p) {
  const eb = p?.marketplace?.ebay;
  const kl = p?.marketplace?.kaufland;
  return Boolean(
    (eb && (eb.itemId || eb.listingId) && eb.status !== 'ended')
      || (kl && kl.unitId && kl.status !== 'retired')
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.apply && args.confirm !== CONFIRM_TOKEN) {
    throw new Error(`--apply braucht --confirm ${CONFIRM_TOKEN}`);
  }

  const { getAllProductsV2ForTenant, saveProductV2 } = require('../lib/product-store');
  const products = await getAllProductsV2ForTenant(TENANT);

  const report = { tenant: TENANT, apply: args.apply, scanned: products.length, affected: [], skipped: [] };

  for (const p of products) {
    const brand = s(p?.identification?.brand);
    const gpsr = p?.details?.gpsr || {};
    // Maßgeblich ist der GPSR-HERSTELLERNAME, nicht die Produktmarke: der
    // verschmierte Block sitzt in `details.gpsr.manufacturer_name`. Der erste
    // Lauf prüfte nur `identification.brand` und übersah dadurch Produkte mit
    // echter Marke (OFFCUP, AERZETIX) bei Hersteller "Markenlos".
    const placeholderManufacturer = isPlaceholderBrand(s(gpsr.manufacturer_name));
    if (!isPlaceholderBrand(brand) && !placeholderManufacturer) continue;
    if (args.liveOnly && !isLive(p)) continue;

    const toClear = CLEARABLE.filter((k) => s(gpsr[k]));
    if (!toClear.length) continue;

    // Etikett-gelesene Daten sind Ground Truth vom eigenen Produkt und werden
    // NIE angefasst — auch nicht bei Platzhalter-Marke.
    if (s(gpsr?.evidence?.status) === 'product_image' || s(gpsr?.source) === 'product_image') {
      report.skipped.push({ id: p.id, sku: s(p?.identification?.sku), reason: 'etikett_beleg' });
      continue;
    }

    const entry = {
      id: p.id,
      sku: s(p?.identification?.sku),
      name: s(p?.identification?.name).slice(0, 70),
      brand,
      live: isLive(p),
      ebayItemId: s(p?.marketplace?.ebay?.itemId) || null,
      clearing: toClear.map((k) => ({ feld: k, alterWert: s(gpsr[k]).slice(0, 80) })),
    };
    report.affected.push(entry);

    if (!args.apply) continue;

    // ACHTUNG: `saveProductV2` ist ein MERGE — ein `delete` am In-Memory-Objekt
    // entfernt den Schlüssel in Firestore NICHT. Der erste Lauf dieses Scripts
    // meldete deshalb 43x Erfolg, ohne dass ein einziges Feld verschwand.
    // Löschen MUSS über einen gezielten update() mit FieldValue.delete() auf
    // Dot-Paths laufen (gleiches Muster wie audit-gpsr-evidence.js).
    try {
      const { FieldValue } = require('@google-cloud/firestore');
      const { firestore } = require('../lib/firestore');
      const { getCollection } = require('../lib/product-store');

      const updates = {};
      for (const k of toClear) updates[`details.gpsr.${k}`] = FieldValue.delete();
      updates['ops.data_quality.gpsr_placeholder_cleanup'] = {
        at: new Date().toISOString(),
        cleared: toClear,
        reason: 'platzhalter_marke_registry_verschmierung',
      };
      await firestore.collection(getCollection()).doc(p.id).update(updates);

      // NACHPRÜFEN statt glauben. Genau das Vertrauen in einen Rückgabewert
      // war die Ursache des Vorfalls, den dieses Script aufräumt.
      const after = await firestore.collection(getCollection()).doc(p.id).get();
      const afterGpsr = (after.data() || {}).details?.gpsr || {};
      const stillThere = toClear.filter((k) => s(afterGpsr[k]));
      if (stillThere.length) {
        entry.applied = false;
        entry.error = `Felder überlebten das Löschen: ${stillThere.join(', ')}`;
      } else {
        entry.applied = true;
      }
    } catch (err) {
      entry.applied = false;
      entry.error = err.message;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Zweiter Durchgang: WERTGENAUE Bereinigung.
  //
  // Der erste Durchgang greift über den Platzhalter-Hersteller. Er übersieht
  // Produkte, bei denen der Schmier-Block nur EINZELNE Felder überschrieben
  // hat, während der Herstellername echt blieb (gemessen: 25 Live-Angebote
  // von STOOLINK, Dongguan Haoxun u.a. trugen die erfundene Website
  // tiger-zhou.com). Diese Werte stammen nachweislich aus
  // `gpsrManufacturers/markenlos` (confidence 0, keine Quellen) und gehören
  // zu KEINEM dieser Hersteller.
  //
  // Bewusst eng: nur diese exakten, belegbar fremden Werte — kein Muster,
  // keine Heuristik. Raten hat den Schaden erzeugt.
  const POISONED_VALUES = [
    'https://www.tiger-zhou.com/',
    'http://www.tiger-zhou.com/',
    'www.tiger-zhou.com',
    'mjcm190928@gmail.com',
    '78 avenue des Champs Elysees Bureau 326',
    'Geaplan GmbH',
    'info@geaplan.de',
    '+49540781770',
  ].map((v) => v.toLowerCase());

  report.poisoned = [];
  for (const p of products) {
    const gpsr = p?.details?.gpsr || {};
    // KEINE Etikett-Beleg-Schonung in diesem Durchgang — anders als oben.
    // Der Beleg schützt die Werte, die das Etikett GELIEFERT hat. Ein
    // Exakttreffer auf diese Liste kann nicht vom Etikett stammen: kein
    // STOOLINK-Karton nennt "tiger-zhou.com". Die Werte kommen belegbar aus
    // dem markenlos-Registry-Eintrag und gehören zu keinem dieser Hersteller.
    const hits = Object.entries(gpsr).filter(
      ([, v]) => typeof v === 'string' && POISONED_VALUES.includes(v.trim().toLowerCase())
    );
    if (!hits.length) continue;

    const entry = {
      id: p.id,
      sku: s(p?.identification?.sku),
      hersteller: s(gpsr.manufacturer_name).slice(0, 45),
      live: isLive(p),
      ebayItemId: s(p?.marketplace?.ebay?.itemId) || null,
      clearing: hits.map(([k, v]) => ({ feld: k, alterWert: s(v).slice(0, 60) })),
    };
    report.poisoned.push(entry);
    if (!args.apply) continue;

    try {
      const { FieldValue } = require('@google-cloud/firestore');
      const { firestore } = require('../lib/firestore');
      const { getCollection } = require('../lib/product-store');
      const updates = {};
      for (const [k] of hits) updates[`details.gpsr.${k}`] = FieldValue.delete();
      updates['ops.data_quality.gpsr_poisoned_value_cleanup'] = {
        at: new Date().toISOString(),
        cleared: hits.map(([k]) => k),
        reason: 'wert_aus_markenlos_registry_eintrag',
      };
      await firestore.collection(getCollection()).doc(p.id).update(updates);

      const after = await firestore.collection(getCollection()).doc(p.id).get();
      const afterGpsr = (after.data() || {}).details?.gpsr || {};
      const stillThere = hits.map(([k]) => k).filter((k) => s(afterGpsr[k]));
      entry.applied = stillThere.length === 0;
      if (stillThere.length) entry.error = `überlebte: ${stillThere.join(', ')}`;
    } catch (err) {
      entry.applied = false;
      entry.error = err.message;
    }
  }

  const poisonLive = report.poisoned.filter((a) => a.live).length;
  console.log('\n--- Zweiter Durchgang: wertgenaue Bereinigung ---');
  console.log(`Produkte mit belegbar fremden Werten: ${report.poisoned.length} (live: ${poisonLive})`);
  if (args.apply) {
    console.log(`  erfolgreich: ${report.poisoned.filter((a) => a.applied === true).length}`
      + ` | Fehler: ${report.poisoned.filter((a) => a.applied === false).length}`);
  }

  const outPath = path.join(args.outDir, `repair-placeholder-gpsr-${args.apply ? 'apply' : 'dryrun'}.json`);
  fsNode.writeFileSync(outPath, JSON.stringify(report, null, 2));

  const liveCount = report.affected.filter((a) => a.live).length;
  console.log('\n=== Platzhalter-Marken-GPSR Bereinigung ===');
  console.log(`Modus            : ${args.apply ? 'APPLY (schreibt)' : 'TROCKENLAUF (read-only)'}`);
  console.log(`Produkte geprüft : ${report.scanned}`);
  console.log(`Betroffen        : ${report.affected.length}  (davon live: ${liveCount})`);
  console.log(`Übersprungen     : ${report.skipped.length} (Etikett-Beleg vorhanden)`);
  console.log(`Report           : ${outPath}`);
  console.log('\nBetroffene Live-Angebote:');
  report.affected.filter((a) => a.live).slice(0, 40).forEach((a) => {
    console.log(`  ${(a.sku || a.id).padEnd(20)} eBay ${(a.ebayItemId || '-').padEnd(14)} ${a.name}`);
  });
  if (!args.apply && report.affected.length) {
    console.log(`\nZum Anwenden:  node backend/scripts/repair-placeholder-brand-gpsr.js --apply --confirm ${CONFIRM_TOKEN}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('FEHLER:', err.message);
    process.exit(1);
  });
}

module.exports = { CLEARABLE, CONFIRM_TOKEN };
