'use strict';

/**
 * dedup-barcode-conflicts-2026-07-08.js
 *
 * Bereinigt die Barcode-Konflikte, die der Audit von
 * `repair-foreign-barcode-poisoning.js` am 2026-07-08 fand: EIN Barcode steht
 * auf MEHREREN products_v2-Docs. Ursachen (siehe Incident 2026-07-08):
 *   a) Duplikat-Datenblatt — dasselbe Produkt zweimal erfasst, z. B. ein Doc
 *      mit Doc-ID = nackte EAN UND ein zweites mit Doc-ID = SKU-… (gleicher
 *      Name). Klassiker aus alten Erfassungen/Imports.
 *   b) Fremd-Barcode — zwei VERSCHIEDENE Produkte, ein Code steht faelschlich
 *      auf dem falschen Doc (wie die ATE-Faelle, die separat behoben wurden).
 *
 * Diese Bereinigung fasst NUR die eindeutig sichere Klasse an:
 *   SAFE_DELETE — genau 2 aktive Docs, GLEICHES Produkt (normalisierter Name
 *   identisch), eines ist ein inertes Duplikat (kein Bestand, kein Listing,
 *   keine Orders, kein pending intake, keine Bilder, kein Textinhalt), das
 *   andere ist kanonisch (Listing ODER Bestand ODER Inhalt). Das inerte Doc
 *   wird — nach vollstaendigem Backup — geloescht.
 *
 * ALLES andere -> REVIEW/SKIP (nicht angefasst):
 *   - Fremd-Barcode (Namen verschieden): kann nicht sicher entschieden werden,
 *     welchem Doc der Code gehoert -> manuell.
 *   - Beide Docs mit Commerce (Bestand/Listing/Orders): echter Merge noetig,
 *     Datenverlust-Risiko -> manuell.
 *   - 3+ Docs pro Barcode: zu komplex fuer Automatik.
 *
 * Sicherheit (spiegelt cleanup-ghost-products-2026-03.js):
 *   - DRY-RUN ist Default; --apply zum Ausfuehren.
 *   - Vor JEDEM Delete komplettes Original-Doc nach
 *     `products_v2_dedup_backup_2026_07/{id}` gesichert (Undo-Pfad).
 *   - Konservativ: jedes unerwartete Signal am Loesch-Kandidaten -> REVIEW.
 *
 * Aufruf:
 *   USE_PRODUCTS_V2=true node backend/scripts/dedup-barcode-conflicts-2026-07-08.js
 *   USE_PRODUCTS_V2=true node backend/scripts/dedup-barcode-conflicts-2026-07-08.js --apply
 *   ... [--tenant default]
 */

const NAME_PLACEHOLDERS = new Set(['', 'unbekannt', 'unbekanntes produkt', 'unknown', 'n/a', 'na', '-', '—', 'produkt', 'produkt 1']);
const BACKUP_COLLECTION = 'products_v2_dedup_backup_2026_07';

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9äöüß ]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectBarcodes(d) {
  return new Set(
    [
      ...(Array.isArray(d.identification?.barcodes) ? d.identification.barcodes : []),
      d.details?.identifiers?.ean,
      d.details?.identifiers?.gtin,
      d.details?.identifiers?.upc,
    ]
      .map((c) => (c == null ? '' : String(c).trim()))
      .filter(Boolean)
  );
}

/** Commerce-/Inhalts-Signale eines Docs sammeln. */
function signals(d) {
  const ops = d.ops || {};
  const details = d.details || {};
  const hasText = (v) => typeof v === 'string' && v.trim().length >= 3;

  const ebay = Boolean(
    (ops.ebay?.itemId && !ops.ebay?.itemIdCleared) || d.marketplace?.ebay?.itemId
  );
  const kaufland = Boolean(
    (ops.kaufland?.unitId && !ops.kaufland?.unitIdCleared) || d.marketplace?.kaufland?.unitId
  );
  const stock = Number(d.inventory?.quantity ?? 0) || 0;
  const pending = Number(ops.pending_intake_quantity ?? 0) || 0;
  const orders = Number(ops.order_count ?? 0) + Number(ops.salesCount ?? 0);
  const images = Array.isArray(details.images) ? details.images.length : 0;
  const bins = Array.isArray(d.storageBins) ? d.storageBins.length : 0;

  const contentLen =
    (hasText(d.identification?.brand) ? 1 : 0) +
    (hasText(details.description) ? 1 : 0) +
    (hasText(details.short_description) ? 1 : 0) +
    (Array.isArray(details.key_features) && details.key_features.some(hasText) ? 1 : 0);

  const uiSaved = String(ops.last_saved_source || '') === 'ui';
  const archived = Boolean(ops.archived || ops.mergedInto);

  // Inert = gefahrlos loeschbar: keinerlei Commerce, kein pending, keine BINs,
  // keine Bilder, kein Textinhalt.
  const inert =
    !ebay && !kaufland && stock === 0 && pending === 0 && orders === 0 &&
    images === 0 && bins === 0 && contentLen === 0 && !uiSaved && !d.storage;

  // "Hat Substanz" = irgendein Commerce- oder Inhaltssignal.
  const hasSubstance = ebay || kaufland || stock > 0 || orders > 0 || images > 0 || contentLen > 0 || uiSaved;

  return { ebay, kaufland, stock, pending, orders, images, bins, contentLen, uiSaved, archived, inert, hasSubstance };
}

function classifyGroup(docs) {
  // Nur aktive (nicht-archivierte) Docs betrachten.
  const active = docs.filter((d) => !d._sig.archived);
  if (active.length <= 1) return { action: 'RESOLVED', reason: '≤1 aktives Doc' };
  if (active.length > 2) return { action: 'REVIEW', reason: `${active.length} Docs teilen den Code` };

  const [a, b] = active;
  const sameProduct =
    a._norm && b._norm && a._norm === b._norm &&
    !NAME_PLACEHOLDERS.has(a._norm) && !NAME_PLACEHOLDERS.has(b._norm);

  if (!sameProduct) {
    return { action: 'REVIEW', reason: 'verschiedene Produkte (Fremd-Barcode?) — manuell' };
  }

  // Gleiches Produkt: genau eines muss inert sein, das andere Substanz haben.
  const aInert = a._sig.inert;
  const bInert = b._sig.inert;
  const aSub = a._sig.hasSubstance;
  const bSub = b._sig.hasSubstance;

  if (aInert && bSub && !bInert) return { action: 'SAFE_DELETE', keep: b, remove: a };
  if (bInert && aSub && !aInert) return { action: 'SAFE_DELETE', keep: a, remove: b };

  // Beide Substanz (z. B. beide gelistet / beide Bestand) -> echter Merge.
  if (aSub && bSub) return { action: 'REVIEW', reason: 'beide mit Bestand/Listing/Inhalt — Merge manuell' };

  // Beide inert (zwei leere Huellen desselben Produkts): eine loeschen ist
  // gefahrlos. Behalte die mit Doc-ID = nackte EAN (stabiler), sonst die erste.
  if (aInert && bInert) {
    const keep = /^\d{8,14}$/.test(b.id) && !/^\d{8,14}$/.test(a.id) ? b : a;
    const remove = keep === a ? b : a;
    return { action: 'SAFE_DELETE', keep, remove, reason: 'zwei inerte Huellen' };
  }

  return { action: 'REVIEW', reason: 'uneindeutig' };
}

function parseArgs(argv) {
  const val = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  return { apply: argv.includes('--apply'), csv: val('--csv'), tenant: val('--tenant') || 'default' };
}

/** RFC-4180 CSV-Feld (Excel-kompatibel, Semikolon-Trenner fuer DE). */
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = { normalizeName, signals, classifyGroup };

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    if (process.env.USE_PRODUCTS_V2 !== 'true') {
      console.error('❌ USE_PRODUCTS_V2=true erforderlich. Abbruch.');
      process.exit(1);
    }
    const { firestore } = require('../lib/firestore');
    console.log(`[dedup-cleanup] tenant=${args.tenant} mode=${args.apply ? 'APPLY' : 'DRY-RUN'}`);

    const snap = await firestore.collection('products_v2').get();
    const byCode = new Map();
    const docsById = new Map();

    snap.forEach((doc) => {
      const d = { id: doc.id, ...doc.data() };
      if ((d.tenantId || 'default') !== args.tenant) return;
      d._sig = signals(d);
      d._norm = normalizeName(d.identification?.name);
      docsById.set(doc.id, d);
      for (const code of collectBarcodes(d)) {
        if (!byCode.has(code)) byCode.set(code, []);
        byCode.get(code).push(doc.id);
      }
    });

    const stats = { RESOLVED: 0, SAFE_DELETE: 0, REVIEW: 0 };
    const reviews = [];
    const deletes = [];
    const seenGroups = new Set();

    // Token-Jaccard zur Unterscheidung "gleiches Produkt, andere Titel-Wortwahl"
    // vs "wirklich verschiedene Produkte (Fremd-Barcode)".
    const STOP = new Set(['der','die','das','und','für','fur','mit','set','stück','stuck','gr','deutsch','ausgabe','gebundene','hardcover','damen','herren','stk','x','ab','jahre','jahren']);
    const tokens = (s) => new Set(normalizeName(s).split(' ').filter((t) => t.length >= 3 && !STOP.has(t)));
    const jaccard = (a, b) => { const A = tokens(a), B = tokens(b); if (!A.size || !B.size) return 0; let inter = 0; for (const t of A) if (B.has(t)) inter++; return inter / (A.size + B.size - inter); };

    for (const [code, ids] of byCode) {
      if (ids.length < 2) continue;
      const uniq = [...new Set(ids)];
      if (uniq.length < 2) continue;
      const key = uniq.slice().sort().join('|');
      if (seenGroups.has(key)) continue; // dieselbe Doc-Menge nicht doppelt (mehrere geteilte Codes)
      seenGroups.add(key);

      const docs = uniq.map((id) => docsById.get(id)).filter(Boolean);
      const res = classifyGroup(docs);
      stats[res.action === 'SAFE_DELETE' ? 'SAFE_DELETE' : res.action === 'RESOLVED' ? 'RESOLVED' : 'REVIEW']++;

      if (res.action === 'SAFE_DELETE') {
        deletes.push({ code, keep: res.keep, remove: res.remove, reason: res.reason });
      } else if (res.action === 'REVIEW') {
        reviews.push({ code, docs, reason: res.reason });
      }
    }

    // ── Ausgabe ──
    console.log(`\n=== SAFE_DELETE (${deletes.length}) — inerte Duplikat-Huelle loeschen ===`);
    for (const x of deletes) {
      console.log(`  [${x.code}] keep ${x.keep.id} "${(x.keep.identification?.name||'').slice(0,50)}" — delete ${x.remove.id}${x.reason ? ` (${x.reason})` : ''}`);
    }

    // REVIEW-Faelle in Unterklassen buckets.
    const buckets = { DUP_PAIR: [], FOREIGN: [], MULTI: [], OTHER: [] };
    for (const x of reviews) {
      if (x.docs.length > 2) { buckets.MULTI.push(x); continue; }
      const [a, b] = x.docs;
      const sim = jaccard(a.identification?.name, b.identification?.name);
      const sameBrand = normalizeName(a.identification?.brand) === normalizeName(b.identification?.brand) && normalizeName(a.identification?.brand);
      x._sim = sim; x._sameBrand = sameBrand;
      if (sim >= 0.5 || (sim >= 0.3 && sameBrand)) buckets.DUP_PAIR.push(x);
      else buckets.FOREIGN.push(x);
    }

    const bothListed = (x) => x.docs.filter((d) => d._sig.ebay || d._sig.kaufland).length >= 2;
    const anyStock = (x) => x.docs.some((d) => d._sig.stock > 0);
    const fmt = (x) => x.docs.map((d) => `${d.id}[${d._sig.ebay?'E':''}${d._sig.kaufland?'K':''}${d._sig.stock>0?`s${d._sig.stock}`:''}${d._sig.images>0?`i${d._sig.images}`:''}]`).join(' + ');

    console.log(`\n=== A) DUP_PAIR (${buckets.DUP_PAIR.length}) — gleiches Produkt, 2 Datenblaetter -> MERGE ===`);
    for (const x of buckets.DUP_PAIR) {
      const flag = bothListed(x) ? ' ⚠BEIDE-GELISTET' : (anyStock(x) ? ' •Bestand' : '');
      console.log(`  [${x.code}] sim=${x._sim.toFixed(2)}${flag}: ${fmt(x)}`);
      x.docs.forEach((d) => console.log(`        - ${d.id}  "${(d.identification?.name||'').slice(0,70)}"`));
    }
    console.log(`\n=== B) FOREIGN (${buckets.FOREIGN.length}) — verschiedene Produkte teilen 1 Barcode -> Code pruefen ===`);
    for (const x of buckets.FOREIGN) {
      console.log(`  [${x.code}] sim=${(x._sim||0).toFixed(2)}: ${fmt(x)}`);
      x.docs.forEach((d) => console.log(`        - ${d.id}  "${(d.identification?.name||'').slice(0,70)}"`));
    }
    if (buckets.MULTI.length) {
      console.log(`\n=== C) MULTI (${buckets.MULTI.length}) — 3+ Docs teilen 1 Barcode -> manuell ===`);
      for (const x of buckets.MULTI) {
        console.log(`  [${x.code}]: ${fmt(x)}`);
        x.docs.forEach((d) => console.log(`        - ${d.id}  "${(d.identification?.name||'').slice(0,70)}"`));
      }
    }

    // ── CSV-Export (read-only Deliverable) ──
    if (args.csv) {
      const fs = require('fs');
      const STATUS = {
        DUP_PAIR: 'doppelt_gleiches_produkt',
        FOREIGN: 'verschiedene_produkte_gleicher_barcode',
        MULTI: 'mehrfach_3plus_docs_gleicher_barcode',
        SAFE_DELETE: 'inerte_huelle_loeschbar',
      };
      const header = ['barcode', 'status', 'doc_id', 'sku', 'titel', 'marke', 'bestand', 'ebay_gelistet', 'kaufland_gelistet', 'bilder', 'gruppe_docs', 'namens_aehnlichkeit'];
      const rows = [header.map(csvCell).join(';')];

      const emitGroup = (x, statusKey) => {
        const groupIds = x.docs.map((d) => d.id).join(' | ');
        for (const d of x.docs) {
          const sku = d.identification?.sku || d.details?.identifiers?.sku || '';
          rows.push([
            x.code,
            STATUS[statusKey],
            d.id,
            sku,
            d.identification?.name || '',
            d.identification?.brand || '',
            d._sig.stock,
            d._sig.ebay ? 'ja' : 'nein',
            d._sig.kaufland ? 'ja' : 'nein',
            d._sig.images,
            groupIds,
            x._sim != null ? x._sim.toFixed(2) : '',
          ].map(csvCell).join(';'));
        }
      };
      for (const x of buckets.DUP_PAIR) emitGroup(x, 'DUP_PAIR');
      for (const x of buckets.FOREIGN) emitGroup(x, 'FOREIGN');
      for (const x of buckets.MULTI) emitGroup(x, 'MULTI');
      for (const x of deletes) emitGroup({ code: x.code, docs: [x.remove, x.keep] }, 'SAFE_DELETE');

      // BOM fuer korrekte Umlaut-Darstellung in Excel.
      fs.writeFileSync(args.csv, '﻿' + rows.join('\r\n') + '\r\n', 'utf8');
      console.log(`\n📄 CSV geschrieben: ${args.csv} (${rows.length - 1} Zeilen)`);
    }

    const dupBothListed = buckets.DUP_PAIR.filter(bothListed).length;
    const dupStock = buckets.DUP_PAIR.filter((x) => anyStock(x) && !bothListed(x)).length;
    console.log(`\n=== Zusammenfassung ===`);
    console.log(`  SAFE_DELETE (inerte Huelle):        ${deletes.length}`);
    console.log(`  A) DUP_PAIR gleiches Produkt/Merge:  ${buckets.DUP_PAIR.length}  (davon beide gelistet: ${dupBothListed}, mit Bestand: ${dupStock})`);
    console.log(`  B) FOREIGN verschiedene Produkte:    ${buckets.FOREIGN.length}`);
    console.log(`  C) MULTI 3+ Docs:                    ${buckets.MULTI.length}`);

    if (!args.apply) {
      console.log('\nDRY-RUN — nichts veraendert. Mit --apply die SAFE_DELETE-Faelle ausfuehren.');
      process.exit(0);
    }

    console.log(`\n[apply] Loesche ${deletes.length} inerte Huellen (mit Backup in ${BACKUP_COLLECTION}) …`);
    let done = 0;
    for (const x of deletes) {
      await firestore.collection(BACKUP_COLLECTION).doc(x.remove.id).set({
        backedUpAt: new Date().toISOString(),
        incident: 'dedup-barcode-conflicts-2026-07-08',
        sharedBarcode: x.code,
        keptSibling: x.keep.id,
        data: (() => { const { _sig, _norm, ...clean } = x.remove; return clean; })(),
      });
      await firestore.collection('products_v2').doc(x.remove.id).delete();
      done++;
    }
    console.log(`\n✅ Fertig. ${done} geloescht. Backups in ${BACKUP_COLLECTION}. ${reviews.length} REVIEW-Faelle bleiben manuell.`);
    process.exit(0);
  })().catch((err) => {
    console.error(`[dedup-cleanup] FATAL: ${err.message}`, err);
    process.exit(1);
  });
}
