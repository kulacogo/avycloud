#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Web-Anreicherung der Bestandsprodukte OHNE lesbares Verpackungs-Etikett
 * (Ergänzung zu gpsr-backfill-from-images-instock.js).
 *
 * Für jedes Produkt wird über die MARKE per getOrFetchBrandGpsr (lib/gpsr-gemini-
 * lookup.js) im Web nach dem Impressum/Hersteller gesucht — und die Angaben gegen
 * die echte Seite geprüft (lib/gpsr-evidence.js). Übernommen werden NUR belegte
 * Ergebnisse (evidence.status 'verified' | 'partial'); 'unverifiable'/null werden
 * verworfen — lieber nichts als etwas Erfundenes.
 *
 * Aufruf:
 *   USE_PRODUCTS_V2=true node backend/scripts/gpsr-backfill-web-instock.js [--limit N] [--concurrency N]
 *   ... --apply         (schreibt; default Dry-Run)
 *   ... --only-verified  (nur 'verified' übernehmen, 'partial' überspringen)
 */

const fs = require('fs');
const path = require('path');
const { firestore, PRODUCTS_COLLECTION } = require('../lib/firestore');
const { productStock, isNonEuManufacturer, DEFAULT_EU_REP } = require('../lib/gpsr-eu-rep');
const { normalizeGpsrObject } = require('../lib/gpsr-manufacturer-registry');
const { getOrFetchBrandGpsr } = require('../lib/gpsr-gemini-lookup');

const TENANT_ID = process.env.TENANT_ID || 'default';
const MFR_KEYS = ['manufacturer_name', 'manufacturer_address', 'manufacturer_city', 'manufacturer_postalcode', 'manufacturer_state_province', 'entity_country', 'country_code', 'email', 'manufacturer_phone', 'phone'];

function parseArgs(argv) {
  const out = { apply: false, limit: null, concurrency: 4, onlyVerified: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--only-verified') out.onlyVerified = true;
    else if (a === '--limit') out.limit = parseInt(argv[++i], 10);
    else if (a === '--concurrency') out.concurrency = Math.max(1, parseInt(argv[++i], 10) || 4);
  }
  return out;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

const JUNK_BRAND = /^(markenlos|no ?name|marke|noname|generic|ohne marke|unbekannt|diverse|sonstige)$/i;

function pickBrand(data) {
  const brand = safeString(data?.identification?.brand);
  if (brand && !JUNK_BRAND.test(brand)) return brand;
  const mfr = safeString(data?.details?.gpsr?.manufacturer_name);
  if (mfr && !JUNK_BRAND.test(mfr)) return mfr;
  return '';
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function next() {
    while (idx < items.length) { const cur = idx++; results[cur] = await worker(items[cur], cur); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = new Date().toISOString();
  const reportDir = process.env.SCRATCHPAD_DIR || '/tmp';
  const reportPath = path.join(reportDir, `gpsr-web-backfill-${startedAt.replace(/[:.]/g, '-')}.jsonl`);
  const idsPath = path.join(reportDir, `gpsr-web-backfill-${startedAt.replace(/[:.]/g, '-')}.material-ids.txt`);

  console.log(`[gpsr-web] Modus=${args.apply ? 'APPLY' : 'DRY-RUN'} onlyVerified=${args.onlyVerified} concurrency=${args.concurrency} limit=${args.limit ?? '-'}`);

  const snap = await firestore.collection(PRODUCTS_COLLECTION).get();
  const targets = [];
  snap.forEach((doc) => {
    const data = doc.data() || {};
    const t = data.tenantId;
    if (t && t !== TENANT_ID) return;
    if (!(productStock(data) >= 1)) return;
    // Nur Produkte, die das Etikett NICHT belegt hat (kein product_image-Beleg).
    const ev = safeString(data?.details?.gpsr?.evidence?.status);
    if (ev === 'product_image' || ev === 'verified') return; // schon belegt
    const brand = pickBrand(data);
    if (!brand) return;
    targets.push({ docId: doc.id, sku: safeString(data?.identification?.sku), brand, gpsr: data?.details?.gpsr || {} });
  });
  targets.sort((a, b) => String(a.docId).localeCompare(String(b.docId)));
  let work = targets;
  if (Number.isFinite(args.limit) && args.limit > 0) work = work.slice(0, args.limit);
  console.log(`[gpsr-web] ${targets.length} Kandidaten (Bestand, Marke, noch nicht belegt), ${work.length} zu verarbeiten`);

  const stream = fs.createWriteStream(reportPath, { flags: 'a' });
  const counts = { processed: 0, verified: 0, partial: 0, unverifiable: 0, null: 0, no_brand: 0, written: 0, errors: 0 };
  const materialIds = [];
  const samples = [];

  await runPool(work, args.concurrency, async (t) => {
    const rec = { docId: t.docId, sku: t.sku || null, brand: t.brand };
    try {
      const r = await getOrFetchBrandGpsr(t.brand, { timeoutMs: 22000 });
      const status = safeString(r?.evidence?.status);
      if (!r || !r.gpsr || (status !== 'verified' && status !== 'partial')) {
        rec.outcome = r ? (status || 'null') : 'null';
        counts[status === 'unverifiable' ? 'unverifiable' : 'null']++;
        stream.write(JSON.stringify(rec) + '\n'); counts.processed++; return rec;
      }
      if (args.onlyVerified && status !== 'verified') {
        rec.outcome = 'partial_skipped'; counts.partial++;
        stream.write(JSON.stringify(rec) + '\n'); counts.processed++; return rec;
      }

      // Hersteller-Rolle durch die belegte Web-Firma ersetzen (vollständiger,
      // rechtsform-korrekter, beleg-gestützter Block). EU-Rep unberührt lassen.
      const web = r.gpsr;
      const next = { ...t.gpsr };
      for (const k of MFR_KEYS) delete next[k];
      for (const k of ['manufacturer_name', 'manufacturer_address', 'manufacturer_city', 'manufacturer_postalcode', 'entity_country', 'country_code', 'email']) {
        const v = safeString(web[k]);
        if (v) next[k] = v;
      }
      const normalized = normalizeGpsrObject(next) || next;
      // Nicht-EU-Hersteller ohne EU-Rep -> Firmen-Default (wie im Bild-Pfad).
      if (isNonEuManufacturer(normalized) && !safeString(normalized.eu_responsible_name)) {
        Object.assign(normalized, DEFAULT_EU_REP);
      }
      const material = safeString(t.gpsr.manufacturer_name) !== safeString(normalized.manufacturer_name)
        || safeString(t.gpsr.entity_country) !== safeString(normalized.entity_country);
      normalized.evidence = {
        ...(r.evidence || {}),
        status,
        source: 'web_impressum',
        brand: t.brand,
        checked_at: r.evidence?.checked_at || startedAt,
        ...(material && status === 'verified' ? { pendingEbayRegulatoryPush: true } : {}),
      };

      rec.outcome = status;
      rec.before = { manufacturer_name: t.gpsr.manufacturer_name || null, entity_country: t.gpsr.entity_country || null };
      rec.after = { manufacturer_name: normalized.manufacturer_name || null, entity_country: normalized.entity_country || null, url: r.evidence?.url || web.url || null };
      rec.material = material;
      counts[status]++;
      if (material && status === 'verified') materialIds.push(t.docId);

      if (args.apply) {
        await firestore.collection(PRODUCTS_COLLECTION).doc(t.docId).update({ 'details.gpsr': normalized });
        counts.written++; rec.written = true;
      }
      stream.write(JSON.stringify(rec) + '\n');
      if (samples.length < 40) samples.push(rec);
      counts.processed++;
      return rec;
    } catch (err) {
      counts.errors++; rec.outcome = 'error'; rec.error = err?.message || String(err);
      stream.write(JSON.stringify(rec) + '\n'); counts.processed++; return rec;
    }
  });

  await new Promise((res) => stream.end(res));
  fs.writeFileSync(idsPath, materialIds.join('\n') + (materialIds.length ? '\n' : ''));

  console.log('\n===== ZUSAMMENFASSUNG =====');
  console.log(JSON.stringify(counts, null, 2));
  console.log('\n----- BELEGTE TREFFER (bis 40) -----');
  for (const s of samples) {
    if (s.outcome === 'verified' || s.outcome === 'partial') {
      console.log(`[${s.outcome}${s.material ? ' *neu*' : ''}] ${s.brand}: "${s.before?.manufacturer_name}" -> "${s.after?.manufacturer_name}" (${s.after?.entity_country}) | ${s.after?.url}`);
    }
  }
  console.log(`\nReport: ${reportPath}`);
  console.log(`Push-fähig (verified+material): ${materialIds.length} -> ${idsPath}`);
  console.log(args.apply ? 'APPLY fertig.' : 'DRY-RUN — nichts geschrieben.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e.stack); process.exit(1); });
