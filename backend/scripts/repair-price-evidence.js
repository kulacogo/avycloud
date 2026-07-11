#!/usr/bin/env node
/**
 * Repair-Skript: Müll-URLs in details.pricing.lowest_price.sources.
 *
 * Hintergrund (Incident 2026-07-11): Chat-Pipelines schrieben Modell-ERFUNDENE
 * Quell-URLs (404-Herstellerseiten, eBay-SUCH-Links) und die SerpAPI-Pfade
 * schrieben Such-/Thumbnail-URLs als "Preisquellen" (Bestandsaudit: 513
 * Such-URLs + ~320 gstatic-Thumbnails von 1943 Einträgen). Der Laufzeit-Fix
 * sitzt in lib/price-evidence.js + routes/identify.js validateChatPricing();
 * dieses Script räumt die BESTANDSDATEN auf.
 *
 * Klassifikation via classifyPriceSourceUrl (lib/price-evidence.js, PURE):
 *   candidate = strukturell taugliche Angebotsseite (bleibt erhalten)
 *   search    = Such-/Kategorie-/Vergleichsseite (wird entfernt)
 *   image     = Bild-CDN/Bild-Datei (wird entfernt)
 *   invalid   = keine URL ('ui', leer, non-http) (wird entfernt)
 *
 * Aufruf:
 *   # Read-only Audit (default) — schreibt nichts, Report nach /tmp:
 *   node backend/scripts/repair-price-evidence.js
 *
 *   # Anderer Tenant:
 *   node backend/scripts/repair-price-evidence.js --tenant trendocean
 *
 *   # Repair anwenden (Opt-in, Confirm-Token Pflicht):
 *   node backend/scripts/repair-price-evidence.js --apply --confirm REPAIR_PRICE_EVIDENCE_V1
 *
 *   # Vorsichtige Batches (max N Produkte mutieren):
 *   node backend/scripts/repair-price-evidence.js --apply --confirm REPAIR_PRICE_EVIDENCE_V1 --limit 25
 *
 * Apply-Verhalten pro betroffenem Produkt:
 *   - entfernt alle nicht-candidate-Quellen aus lowest_price.sources
 *   - bleibt KEINE Quelle übrig → sources=[] UND price_confidence auf max 0.3
 *   - amount wird NIEMALS angefasst
 *   - Schreiben über saveProductV2 (CLAUDE.md Regel 7) mit source:'script'
 *   - ops-Marker: ops.data_quality.price_evidence_repair_v1={at_iso, removed, kept}
 *
 * Sicherheits-Mechanismen:
 *   - Apply nur mit --confirm REPAIR_PRICE_EVIDENCE_V1.
 *   - --limit N für vorsichtige Batches.
 *   - Frischer Doc-Read direkt vor jeder Mutation; idempotent — ohne
 *     verbleibende Müll-Quellen wird geskippt (skipped_already_clean).
 *   - Save mit allowWarehouseFields:false → Bestand/inventory wird NIE angefasst.
 *   - JSON-Audit-Report nach /tmp/repair-price-evidence-<ISO>.json (immer).
 */

'use strict';

// Kanonische Collection ist products_v2 (Production: USE_PRODUCTS_V2=true).
// MUSS vor allen lib-Requires gesetzt sein, sonst zielen get/saveProductV2
// auf die Legacy-Collection `products`.
process.env.USE_PRODUCTS_V2 = process.env.USE_PRODUCTS_V2 || 'true';

const fs = require('fs');
const path = require('path');
const { classifyPriceSourceUrl } = require('../lib/price-evidence');

const CONFIRM_TOKEN = 'REPAIR_PRICE_EVIDENCE_V1';
const SKU_OUTPUT_CAP = 50;

function parseArgs(argv) {
  const out = {
    apply: false,
    confirm: null,
    tenantId: process.env.TENANT_ID || 'default',
    limit: null,
    outDir: '/tmp',
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--apply') out.apply = true;
    else if (t === '--confirm') { out.confirm = argv[i + 1] || null; i += 1; }
    else if (t === '--tenant') { out.tenantId = argv[i + 1] || out.tenantId; i += 1; }
    else if (t === '--out') { out.outDir = argv[i + 1] || out.outDir; i += 1; }
    else if (t === '--limit') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) out.limit = Math.floor(n);
      i += 1;
    } else if (t === '--help' || t === '-h') out.help = true;
  }
  return out;
}

function domainOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, '');
  } catch {
    return '(keine-url)';
  }
}

/**
 * Klassifiziert alle lowest_price.sources eines pricing-Objekts. PURE.
 * @returns {null|{total:number, byKind:object, entries:Array}} null = keine Quellen
 */
function auditPricingSources(pricing) {
  const sources = pricing?.lowest_price?.sources;
  if (!Array.isArray(sources) || sources.length === 0) return null;
  const byKind = { candidate: 0, search: 0, image: 0, invalid: 0 };
  const entries = sources.map((src) => {
    const url = (src && src.url) || null;
    const cls = classifyPriceSourceUrl(url);
    byKind[cls.kind] += 1;
    return { url, kind: cls.kind, reason: cls.reason };
  });
  return { total: sources.length, byKind, entries };
}

/**
 * Baut das reparierte pricing-Objekt: nicht-candidate-Quellen raus; bleibt
 * keine übrig → sources=[] und price_confidence auf max 0.3. amount wird
 * NIEMALS angefasst. PURE — mutiert die Eingabe nicht.
 * @returns {{changed:boolean, removed:number, kept:number, removedSources:Array, confidenceCapped:boolean, next:object}}
 */
function applyRepairToPricing(pricing) {
  const sources = pricing?.lowest_price?.sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    return { changed: false, removed: 0, kept: 0, removedSources: [], confidenceCapped: false, next: pricing };
  }
  const keptSources = [];
  const removedSources = [];
  for (const src of sources) {
    const cls = classifyPriceSourceUrl(src && src.url);
    if (cls.kind === 'candidate') keptSources.push(src);
    else removedSources.push({ url: (src && src.url) || null, kind: cls.kind, reason: cls.reason });
  }
  if (removedSources.length === 0) {
    return { changed: false, removed: 0, kept: keptSources.length, removedSources: [], confidenceCapped: false, next: pricing };
  }

  const next = JSON.parse(JSON.stringify(pricing));
  next.lowest_price.sources = JSON.parse(JSON.stringify(keptSources));

  let confidenceCapped = false;
  if (keptSources.length === 0) {
    const capped = Math.min(Number(next.price_confidence) || 0, 0.3);
    if (next.price_confidence !== capped) confidenceCapped = true;
    next.price_confidence = capped;
  }

  return {
    changed: true,
    removed: removedSources.length,
    kept: keptSources.length,
    removedSources,
    confidenceCapped,
    next,
  };
}

function skuOf(data) {
  return (
    data?.identification?.sku ||
    data?.details?.identifiers?.sku ||
    null
  );
}

async function loadProjectedDocs(firestore, collectionName, tenantId) {
  // Projektion hält den Scan billig: nur SKU + pricing + tenantId.
  // Regel 8: Queries mit tenantId. Für 'default' geht das NICHT als
  // where-Klausel — Bestands-Docs tragen kein tenantId-Feld (D.0b-Realität,
  // siehe product-store.js getAllProductsV2ForTenant) → in-memory filtern.
  let ref = firestore.collection(collectionName);
  if (tenantId !== 'default') ref = ref.where('tenantId', '==', tenantId);
  ref = ref.select('identification.sku', 'details.pricing', 'tenantId');
  const snap = await ref.get();
  const docs = [];
  snap.forEach((d) => {
    const data = d.data() || {};
    if (tenantId === 'default' && data.tenantId && data.tenantId !== 'default') return;
    docs.push({ id: d.id, data });
  });
  return docs;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf-8').split('\n').slice(0, 46).join('\n'));
    return;
  }

  if (args.apply && args.confirm !== CONFIRM_TOKEN) {
    throw new Error(`--apply braucht --confirm ${CONFIRM_TOKEN}`);
  }
  if (process.env.USE_PRODUCTS_V2 !== 'true') {
    throw new Error('USE_PRODUCTS_V2=true erforderlich (wie Production) — sonst liest/schreibt das Script die Legacy-Collection.');
  }

  // Lazy requires: erst NACH dem ENV-Setup oben, und nur wenn main() läuft
  // (hält den Modul-Export für Tests frei von Firestore-Clients).
  const { firestore } = require('../lib/firestore');
  const { saveProductV2, getCollection } = require('../lib/product-store');
  const collectionName = getCollection(); // 'products_v2' bei USE_PRODUCTS_V2=true

  const startedAt = new Date().toISOString();
  const report = {
    script: 'repair-price-evidence',
    confirmToken: CONFIRM_TOKEN,
    startedAt,
    mode: args.apply ? 'apply' : 'audit',
    tenantId: args.tenantId,
    limit: args.limit,
    summary: {
      productsScanned: 0,
      productsWithSources: 0,
      sourcesTotal: 0,
      sourcesByKind: { candidate: 0, search: 0, image: 0, invalid: 0 },
      affectedProducts: 0,
    },
    topDroppedDomains: [],
    affected: [],
    actions: [],
    errors: [],
  };

  console.error(`[repair-price-evidence] starte (mode=${report.mode}) tenant=${args.tenantId} collection=${collectionName}`);

  // ── AUDIT ──────────────────────────────────────────────────────────────────
  const docs = await loadProjectedDocs(firestore, collectionName, args.tenantId);
  const domainCounts = new Map();

  for (const { id, data } of docs) {
    report.summary.productsScanned += 1;
    const audit = auditPricingSources(data?.details?.pricing);
    if (!audit) continue;

    report.summary.productsWithSources += 1;
    report.summary.sourcesTotal += audit.total;
    for (const kind of Object.keys(audit.byKind)) {
      report.summary.sourcesByKind[kind] += audit.byKind[kind];
    }

    const bad = audit.entries.filter((e) => e.kind !== 'candidate');
    if (bad.length === 0) continue;

    report.summary.affectedProducts += 1;
    for (const e of bad) {
      const dom = domainOf(e.url);
      domainCounts.set(dom, (domainCounts.get(dom) || 0) + 1);
    }
    report.affected.push({
      id,
      sku: skuOf(data),
      sourcesTotal: audit.total,
      byKind: audit.byKind,
      badSources: bad.slice(0, 10),
    });
  }

  report.topDroppedDomains = Array.from(domainCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([domain, count]) => ({ domain, count }));

  const s = report.summary;
  console.log(`[repair-price-evidence] Produkte gescannt: ${s.productsScanned} (tenant=${args.tenantId})`);
  console.log(`  mit Preisquellen: ${s.productsWithSources}`);
  console.log(
    `  Quellen gesamt: ${s.sourcesTotal} — valide (candidate): ${s.sourcesByKind.candidate}` +
    ` | search: ${s.sourcesByKind.search} | image: ${s.sourcesByKind.image} | invalid: ${s.sourcesByKind.invalid}`
  );
  console.log(`  betroffene Produkte (>=1 Müll-Quelle): ${s.affectedProducts}`);
  if (report.topDroppedDomains.length) {
    console.log('  Top-Domains der Müll-Quellen:');
    for (const { domain, count } of report.topDroppedDomains) {
      console.log(`    ${count}x ${domain}`);
    }
  }
  if (report.affected.length) {
    const shown = report.affected.slice(0, SKU_OUTPUT_CAP);
    console.log(`  Betroffene SKUs (${shown.length}/${report.affected.length} angezeigt):`);
    for (const a of shown) {
      const bk = a.byKind;
      console.log(`    ${a.sku || a.id} — search:${bk.search} image:${bk.image} invalid:${bk.invalid} candidate:${bk.candidate}`);
    }
  }

  // ── APPLY ──────────────────────────────────────────────────────────────────
  if (args.apply) {
    const targets = args.limit ? report.affected.slice(0, args.limit) : report.affected;
    console.error(`[repair-price-evidence] APPLY: ${targets.length} von ${report.affected.length} Produkten (limit=${args.limit || 'kein'})`);

    for (const target of targets) {
      try {
        // Frischer Read direkt vor der Mutation — Audit-Snapshot kann alt sein.
        const snap = await firestore.collection(collectionName).doc(target.id).get();
        if (!snap.exists) {
          report.actions.push({ id: target.id, sku: target.sku, status: 'skipped_not_found' });
          continue;
        }
        const product = { id: snap.id, ...snap.data() };
        const repair = applyRepairToPricing(product?.details?.pricing);
        if (!repair.changed) {
          report.actions.push({ id: target.id, sku: target.sku, status: 'skipped_already_clean' });
          continue;
        }

        const beforeConfidence = product.details.pricing.price_confidence ?? null;
        product.details.pricing = repair.next;

        // ops-Marker (additiv), Muster wie firestore.js ops.data_quality.*
        product.ops = product.ops || {};
        product.ops.data_quality = product.ops.data_quality || {};
        product.ops.data_quality.price_evidence_repair_v1 = {
          at_iso: new Date().toISOString(),
          removed: repair.removed,
          kept: repair.kept,
        };

        await saveProductV2(product, {
          source: 'script:repair-price-evidence',
          overwriteTextFields: false,
          replaceAttributes: false,
          allowCategoryChange: false,
          allowWarehouseFields: false,
          skipTitlePolicy: true,
          skipKeyFeaturesNormalize: true,
        });

        report.actions.push({
          id: target.id,
          sku: target.sku,
          status: 'applied',
          removed: repair.removed,
          kept: repair.kept,
          confidenceCapped: repair.confidenceCapped,
          beforeConfidence,
          afterConfidence: repair.next.price_confidence ?? null,
          removedSources: repair.removedSources,
        });
        console.error(`[repair-price-evidence] repariert ${target.sku || target.id}: removed=${repair.removed} kept=${repair.kept}${repair.confidenceCapped ? ' confidence→0.3' : ''}`);
      } catch (err) {
        report.errors.push({ id: target.id, sku: target.sku, error: err.message });
        console.error(`[repair-price-evidence] FEHLER ${target.sku || target.id}: ${err.message}`);
      }
    }

    const applied = report.actions.filter((a) => a.status === 'applied').length;
    console.log(`[repair-price-evidence] APPLY fertig: ${applied} repariert, ${report.errors.length} Fehler.`);
  } else if (report.affected.length) {
    console.log(`[repair-price-evidence] AUDIT-Modus — nichts geschrieben. Zum Anwenden: --apply --confirm ${CONFIRM_TOKEN} [--limit N]`);
  }

  // ── Report persistieren (immer, beide Modi) ────────────────────────────────
  const stamp = startedAt.replace(/[:.]/g, '-');
  const outPath = path.join(args.outDir, `repair-price-evidence-${stamp}.json`);
  try {
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`[repair-price-evidence] Report: ${outPath}`);
  } catch (err) {
    console.error(`[repair-price-evidence] Report konnte nicht geschrieben werden: ${err.message}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[repair-price-evidence] FATAL:', err.message);
    process.exit(1);
  });
}

// Pure Helpers für Tests exportieren (kein Firestore-Client beim Require).
module.exports = { parseArgs, auditPricingSources, applyRepairToPricing, domainOf, CONFIRM_TOKEN };
