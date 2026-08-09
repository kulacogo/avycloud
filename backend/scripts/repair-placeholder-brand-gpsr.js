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
    if (!isPlaceholderBrand(brand)) continue;
    if (args.liveOnly && !isLive(p)) continue;

    const gpsr = p?.details?.gpsr || {};
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

    const next = { ...p, details: { ...p.details, gpsr: { ...gpsr } } };
    for (const k of toClear) delete next.details.gpsr[k];
    next.ops = next.ops || {};
    next.ops.data_quality = next.ops.data_quality || {};
    next.ops.data_quality.gpsr_placeholder_cleanup = {
      at: new Date().toISOString(),
      cleared: toClear,
      reason: 'platzhalter_marke_registry_verschmierung',
    };

    try {
      await saveProductV2(next, {
        source: 'repair-placeholder-gpsr',
        skipStockEvent: true,
        overwriteTextFields: false,
        replaceAttributes: false,
        allowCategoryChange: false,
        allowWarehouseFields: false,
        skipTitlePolicy: true,
        skipKeyFeaturesNormalize: true,
      });
      entry.applied = true;
    } catch (err) {
      entry.applied = false;
      entry.error = err.message;
    }
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
