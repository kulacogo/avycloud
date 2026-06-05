#!/usr/bin/env node
/**
 * Repair-Skript: EU-Verantwortlicher faelschlich in den Hersteller-Feldern.
 *
 * Hintergrund: Chat-Assistent/Identify haben EU-Verantwortliche (z. B.
 * "Apex CE Specialists GmbH (fuer Ominia)", eVatmaster) nach Land statt nach
 * Rolle einsortiert -> die Daten landeten in gpsr.manufacturer_*, obwohl es der
 * EU-Verantwortliche ist. Fix in lib/gpsr-eu-rep.js (reclassifyEuRepAsManufacturer),
 * im zentralen Speicherpfad saveProduct verdrahtet. Dieses Script repariert
 * Bestandsdaten, die seit dem Fix noch nicht neu gespeichert wurden.
 *
 * SCOPE: standardmaessig NUR Produkte IM BESTAND (Lagermenge > 0) — nicht der
 * ganze Katalog. Mit --include-zero-stock auch Produkte ohne Bestand.
 *
 * Aufruf:
 *   # Read-only Audit (default-Tenant, nur Bestand) — schreibt nichts:
 *   node backend/scripts/repair-gpsr-eu-rep.js
 *
 *   # Anderer Tenant:
 *   node backend/scripts/repair-gpsr-eu-rep.js --tenant trendocean
 *
 *   # Repair anwenden (Opt-in, Confirm-Token Pflicht):
 *   node backend/scripts/repair-gpsr-eu-rep.js --apply --confirm REPAIR_GPSR_EU_REP
 *
 *   # Ganzen Katalog statt nur Bestand:
 *   node backend/scripts/repair-gpsr-eu-rep.js --include-zero-stock
 *
 * Sicherheits-Mechanismen:
 *   - Apply nur mit `--confirm REPAIR_GPSR_EU_REP` (verhindert versehentliches Ausfuehren).
 *   - Save mit allowWarehouseFields:false -> Bestand/inventory wird NIE angefasst (kein Oversell-Risiko).
 *   - Save mit overwriteTextFields/replaceAttributes/allowCategoryChange:false, skipTitlePolicy:true
 *     -> es aendert sich ausschliesslich gpsr.
 *   - Idempotent: reclassifyEuRepAsManufacturer() ist no-op, wenn bereits korrekt.
 *   - JSON-Audit-Report nach /tmp/repair-gpsr-eu-rep-<ISO>.json.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getAllProductsV2ForTenant, saveProductV2 } = require('../lib/product-store');
const {
  looksLikeEuRepEntity,
  reclassifyEuRepAsManufacturer,
  productStock,
} = require('../lib/gpsr-eu-rep');

const CONFIRM_TOKEN = 'REPAIR_GPSR_EU_REP';

function parseArgs(argv) {
  const out = {
    apply: false,
    confirm: null,
    tenantId: process.env.TENANT_ID || 'default',
    includeZeroStock: false,
    limit: null,
    outDir: '/tmp',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--apply') out.apply = true;
    else if (t === '--include-zero-stock') out.includeZeroStock = true;
    else if (t === '--confirm') { out.confirm = argv[i + 1] || null; i += 1; }
    else if (t === '--tenant') { out.tenantId = argv[i + 1] || out.tenantId; i += 1; }
    else if (t === '--out') { out.outDir = argv[i + 1] || out.outDir; i += 1; }
    else if (t === '--limit') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) out.limit = Math.floor(n);
      i += 1;
    }
  }
  return out;
}

function gpsrOf(p) {
  return (p && p.details && typeof p.details.gpsr === 'object' && p.details.gpsr) || null;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.apply && args.confirm !== CONFIRM_TOKEN) {
    throw new Error(`--apply requires --confirm ${CONFIRM_TOKEN}`);
  }

  // Safety: the canonical product collection is products_v2 (USE_PRODUCTS_V2=true in prod).
  // Without it, get/saveProductV2 would read/write the legacy `products` collection — wrong target.
  if (process.env.USE_PRODUCTS_V2 !== 'true') {
    throw new Error('Set USE_PRODUCTS_V2=true (same as production) so this reads/writes products_v2, not legacy products.');
  }

  const all = await getAllProductsV2ForTenant(args.tenantId);
  const inScope = args.includeZeroStock ? all : all.filter((p) => productStock(p) > 0);
  const list = args.limit ? inScope.slice(0, args.limit) : inScope;

  const report = {
    tenantId: args.tenantId,
    mode: args.apply ? 'apply' : 'audit',
    scope: args.includeZeroStock ? 'whole-catalog' : 'bestand-only',
    loaded: all.length,
    inScope: list.length,
    candidates: 0,
    repaired: 0,
    failed: 0,
    items: [],
  };

  for (const p of list) {
    const gpsr = gpsrOf(p);
    if (!gpsr) continue;
    const mfgName = typeof gpsr.manufacturer_name === 'string' ? gpsr.manufacturer_name.trim() : '';
    if (!mfgName || !looksLikeEuRepEntity(mfgName)) continue;

    const next = reclassifyEuRepAsManufacturer(gpsr);
    if (JSON.stringify(next) === JSON.stringify(gpsr)) continue; // already correct / no change

    report.candidates += 1;
    const item = {
      id: p.id,
      sku: p.sku || p.details?.sku || p.identification?.sku || null,
      before_manufacturer_name: mfgName,
      after_manufacturer_name: next.manufacturer_name || '',
      after_eu_responsible_name: next.eu_responsible_name || '',
      after_eu_responsible_city: next.eu_responsible_city || '',
    };

    if (args.apply) {
      try {
        p.details.gpsr = next;
        await saveProductV2(p, {
          source: 'script:repair-gpsr-eu-rep',
          overwriteTextFields: false,
          replaceAttributes: false,
          allowCategoryChange: false,
          allowWarehouseFields: false,
          skipTitlePolicy: true,
          skipKeyFeaturesNormalize: true,
        });
        report.repaired += 1;
        item.applied = true;
      } catch (e) {
        report.failed += 1;
        item.applied = false;
        item.error = e && e.message ? e.message : String(e);
        if (report.failed <= 20) console.warn('[repair-gpsr-eu-rep] failed:', p.id, item.error);
      }
    }
    report.items.push(item);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(args.outDir, `repair-gpsr-eu-rep-${stamp}.json`);
  try { fs.writeFileSync(outPath, JSON.stringify(report, null, 2)); } catch { /* best effort */ }

  console.log('[repair-gpsr-eu-rep]', JSON.stringify({ ...report, items: undefined }, null, 2));
  console.log(`[repair-gpsr-eu-rep] ${report.candidates} Kandidat(en) im ${report.scope}. Report: ${outPath}`);
  if (!args.apply && report.candidates > 0) {
    console.log(`[repair-gpsr-eu-rep] AUDIT-Modus — nichts geschrieben. Zum Anwenden: --apply --confirm ${CONFIRM_TOKEN}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
