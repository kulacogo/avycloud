#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * EINMALIGER Bulk-Lauf (Owner-Auftrag 2026-07-17):
 * ALLE Produktdatenblätter mit Bestand >= 1 auf Hersteller- und EU-GPSR-Daten
 * prüfen und KORREKT anreichern — Quelle der Wahrheit ist das physische
 * Verpackungs-Etikett (lib/gpsr-image-extract.js, dedizierter Vision-Call).
 *
 * Ablauf pro Produkt:
 *   1) Etikett auslesen (extractGpsrFromImages). Kein lesbares Etikett -> null.
 *   2) ROLLENWEISER Merge auf die bestehende (rohe) GPSR:
 *        - Etikett liefert Hersteller  -> manufacturer_*-Block KOMPLETT ersetzen.
 *        - Etikett liefert EU-Rep       -> eu_responsible_*-Block ersetzen.
 *        - Rolle, die das Etikett NICHT zeigt, bleibt UNBERÜHRT (nie wegwischen!).
 *   3) Compliance-Vervollständigung: Hersteller Nicht-EU UND kein EU-Rep
 *        -> Firmen-Default-EU-Rep (eVatmaster) setzen (schließt die Lücke,
 *           statt sie durch die Etikett-Korrektur erst zu öffnen).
 *   4) Fake-Gates: eine erkennbar gefälschte Telefonnummer / verdächtige E-Mail
 *        wird gestrippt, nie persistiert.
 *   5) Nur wenn das ETIKETT beigetragen hat: evidence.status='product_image'
 *        -> autoritativ (überspringt die Marken-Registry beim Save/Read) UND
 *           für den eBay-Regulatory-Repush freigegeben.
 *
 * Schreibpfad: minimaler `details.gpsr`-Dot-Notation-Update (ersetzt NUR die
 * GPSR-Map, kein Full-Doc-Rewrite -> kein Lost-Update-Risiko auf Preis/Bestand
 * auf dem Live-System; genau wie der validierte Gr4tec-Einzelfix).
 *
 * Aufruf:
 *   # Dry-Run (default) — schreibt NICHTS, Report nach scratchpad/tmp:
 *   USE_PRODUCTS_V2=true node backend/scripts/gpsr-backfill-from-images-instock.js
 *   # Validierungs-Sample:
 *   ... gpsr-backfill-from-images-instock.js --limit 15
 *   # Apply (Opt-in):
 *   ... gpsr-backfill-from-images-instock.js --apply
 *   # Resume nach Abbruch (überspringt bereits verarbeitete IDs):
 *   ... gpsr-backfill-from-images-instock.js --apply --resume /tmp/gpsr-backfill-<ts>.jsonl
 */

const fs = require('fs');
const path = require('path');
const { firestore, PRODUCTS_COLLECTION } = require('../lib/firestore');
const { extractGpsrFromImages } = require('../lib/gpsr-image-extract');
const { productStock } = require('../lib/gpsr-eu-rep');
const { buildMergedGpsr } = require('../lib/gpsr-role-merge');

const TENANT_ID = process.env.TENANT_ID || 'default';

function parseArgs(argv) {
  const out = { apply: false, limit: null, concurrency: 6, resume: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--limit') out.limit = parseInt(argv[++i], 10);
    else if (a === '--concurrency') out.concurrency = Math.max(1, parseInt(argv[++i], 10) || 6);
    else if (a === '--resume') out.resume = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}


async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function next() {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await worker(items[cur], cur);
    }
  }
  const runners = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) runners.push(next());
  await Promise.all(runners);
  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: gpsr-backfill-from-images-instock.js [--apply] [--limit N] [--concurrency N] [--resume file.jsonl]');
    return;
  }

  const startedAt = new Date().toISOString();
  const reportDir = process.env.SCRATCHPAD_DIR || '/tmp';
  const stamp = startedAt.replace(/[:.]/g, '-');
  const reportPath = path.join(reportDir, `gpsr-backfill-${stamp}.jsonl`);

  // Resume: bereits verarbeitete Doc-IDs aus einem früheren JSONL überspringen.
  const done = new Set();
  if (args.resume && fs.existsSync(args.resume)) {
    for (const line of fs.readFileSync(args.resume, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r.docId) done.add(r.docId); } catch { /* skip */ }
    }
    console.log(`[gpsr-backfill] Resume: ${done.size} bereits verarbeitete IDs übersprungen (aus ${args.resume})`);
  }

  console.log(`[gpsr-backfill] Modus=${args.apply ? 'APPLY' : 'DRY-RUN'} tenant=${TENANT_ID} concurrency=${args.concurrency} limit=${args.limit ?? '-'}`);
  console.log(`[gpsr-backfill] Report -> ${reportPath}`);

  // Rohe Doc-Snapshots (echte doc.id, kein Read-Time-Registry-Enrichment).
  // Legacy-Compat wie getAllProductsForTenant: tenant 'default' schließt Docs
  // OHNE tenantId-Feld ein.
  const snapshot = await firestore.collection(PRODUCTS_COLLECTION).get();
  const targets = [];
  snapshot.forEach((doc) => {
    const data = doc.data() || {};
    const t = data.tenantId;
    if (t && t !== TENANT_ID) return;
    if (TENANT_ID !== 'default' && !t) return;
    const stock = productStock ? productStock(data) : Number(data?.inventory?.quantity || 0);
    if (!(stock >= 1)) return;
    const imgs = Array.isArray(data?.details?.images)
      ? data.details.images.filter((im) => typeof im?.url_or_base64 === 'string' && im.url_or_base64.startsWith('http'))
      : [];
    targets.push({ docId: doc.id, data, hasImages: imgs.length > 0 });
  });
  targets.sort((a, b) => String(a.docId).localeCompare(String(b.docId)));

  let work = targets.filter((t) => !done.has(t.docId));
  if (Number.isFinite(args.limit) && args.limit > 0) work = work.slice(0, args.limit);
  console.log(`[gpsr-backfill] ${targets.length} Bestandsprodukte, ${work.length} zu verarbeiten`);

  const reportStream = fs.createWriteStream(reportPath, { flags: 'a' });
  const counts = {
    processed: 0, no_images: 0, no_label: 0,
    material_corrections: 0, confirmed_only: 0,
    corrected_mfr: 0, corrected_eurep: 0, eurep_default_added: 0,
    gate_stripped: 0, written: 0, errors: 0,
  };
  const samples = [];
  // Doc-IDs mit MATERIELLER Regulatory-Änderung — nur diese gehen an eBay.
  const materialIds = [];

  await runPool(work, args.concurrency, async (t) => {
    const rec = { docId: t.docId, sku: safeString(t.data?.identification?.sku) || null };
    try {
      const existingGpsr = (t.data?.details?.gpsr && typeof t.data.details.gpsr === 'object') ? t.data.details.gpsr : {};
      if (!t.hasImages) {
        counts.no_images++;
        rec.outcome = 'no_images';
        reportStream.write(JSON.stringify(rec) + '\n');
        counts.processed++;
        return rec;
      }

      const extracted = await extractGpsrFromImages({ id: t.docId, details: t.data.details });
      if (!extracted || !extracted.gpsr) {
        counts.no_label++;
        rec.outcome = 'no_label';
        reportStream.write(JSON.stringify(rec) + '\n');
        counts.processed++;
        return rec;
      }

      const { next, contributedRoles, gateStripped, euRepDefaultApplied, materialChange } = buildMergedGpsr(existingGpsr, extracted.gpsr);
      if (!contributedRoles.length) {
        // Etikett lieferte keinen Rollen-Namen -> nicht autoritativ, nichts pushen.
        counts.no_label++;
        rec.outcome = 'no_label';
        reportStream.write(JSON.stringify(rec) + '\n');
        counts.processed++;
        return rec;
      }

      // Etikett hat beigetragen (Korrektur ODER Bestätigung) -> autoritativ
      // markieren, damit die Marken-Registry das Feld künftig nicht überschreibt.
      next.evidence = {
        ...(next.evidence && typeof next.evidence === 'object' ? next.evidence : {}),
        status: 'product_image',
        source: 'product_image',
        extractedAt: startedAt,
        contributedRoles,
        // Nur bei materieller Änderung setzen — Firestore verbietet undefined-Werte.
        ...(materialChange ? { pendingEbayRegulatoryPush: true } : {}),
      };

      rec.contributedRoles = contributedRoles;
      rec.euRepDefaultApplied = euRepDefaultApplied;
      rec.material = materialChange;
      if (gateStripped.length) { rec.gateStripped = gateStripped; counts.gate_stripped++; }
      rec.before = {
        manufacturer_name: existingGpsr.manufacturer_name || null,
        entity_country: existingGpsr.entity_country || null,
        eu_responsible_name: existingGpsr.eu_responsible_name || null,
      };
      rec.after = {
        manufacturer_name: next.manufacturer_name || null,
        entity_country: next.entity_country || null,
        eu_responsible_name: next.eu_responsible_name || null,
      };

      if (contributedRoles.includes('manufacturer')) counts.corrected_mfr++;
      if (contributedRoles.includes('eu_responsible')) counts.corrected_eurep++;
      if (euRepDefaultApplied) counts.eurep_default_added++;

      if (materialChange) {
        rec.outcome = 'corrected';
        counts.material_corrections++;
        materialIds.push({ docId: t.docId, sku: rec.sku, itemId: safeString(t.data?.ops?.ebay?.itemId) || null });
      } else {
        rec.outcome = 'confirmed';
        counts.confirmed_only++;
      }

      if (args.apply) {
        await firestore.collection(PRODUCTS_COLLECTION).doc(t.docId).update({ 'details.gpsr': next });
        counts.written++;
        rec.written = true;
      }

      reportStream.write(JSON.stringify(rec) + '\n');
      if (samples.length < 30) samples.push(rec);
      counts.processed++;
      return rec;
    } catch (err) {
      counts.errors++;
      rec.outcome = 'error';
      rec.error = err?.message || String(err);
      reportStream.write(JSON.stringify(rec) + '\n');
      counts.processed++;
      return rec;
    }
  });

  await new Promise((resolve) => reportStream.end(resolve));

  // IDs-Datei der MATERIELLEN Änderungen -> Input für den eBay-Repush
  // (nur echte Korrekturen/Ergänzungen anfassen, keine No-op-Revisen).
  const idsPath = path.join(reportDir, `gpsr-backfill-${stamp}.material-ids.txt`);
  fs.writeFileSync(idsPath, materialIds.map((m) => m.docId).join('\n') + (materialIds.length ? '\n' : ''));

  console.log('\n========== ZUSAMMENFASSUNG ==========');
  console.log(JSON.stringify(counts, null, 2));
  console.log('\n----- BEISPIEL-DIFFS (bis 30) -----');
  for (const s of samples) {
    if (s.outcome === 'corrected' || s.outcome === 'confirmed') {
      const b = s.before || {}; const a = s.after || {};
      console.log(`[${s.outcome}${s.material ? ' *MATERIAL*' : ''}] sku=${s.sku || '-'} roles=${(s.contributedRoles || []).join(',')} euRepDef=${s.euRepDefaultApplied ? 'Y' : 'n'}`);
      console.log(`    mfr:  "${b.manufacturer_name}" (${b.entity_country}) -> "${a.manufacturer_name}" (${a.entity_country})`);
      console.log(`    euRep:"${b.eu_responsible_name}" -> "${a.eu_responsible_name}"`);
      if (s.gateStripped) console.log(`    gateStripped: ${s.gateStripped.join(', ')}`);
    }
  }
  console.log(`\nReport:          ${reportPath}`);
  console.log(`Material-IDs:    ${idsPath} (${materialIds.length} für eBay-Push)`);
  console.log(args.apply ? 'APPLY abgeschlossen.' : 'DRY-RUN — nichts geschrieben. Mit --apply anwenden.');
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e.stack); process.exit(1); });
}
