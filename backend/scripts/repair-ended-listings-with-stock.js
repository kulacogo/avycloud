'use strict';
/**
 * repair-ended-listings-with-stock.js — Incident 2026-07-19 (SKU-6656556112)
 *
 * Findet alle Produkte mit verkäuflichem Bestand (physisch − reserviert > 0),
 * die KEIN aktives eBay-Angebot haben, und repariert sie:
 *
 *   1. GetItem-first (Gotcha: Mirror lügt nach Duplikat-Relists): jede bekannte
 *      ItemID der SKU wird live gegen eBay verifiziert.
 *   2. Ist eine davon in Wahrheit AKTIV → nur Produkt/Mirror umhängen
 *      ('repointed', kein eBay-Write).
 *   3. Sonst: jüngste beendete ItemID (≤90 Tage) via RelistFixedPriceItem
 *      wiederbeleben ('relisted') — nutzt relistEndedEbayListing aus dem
 *      Dispatcher (Produkt + Mirror werden konsistent umgehängt).
 *   4. Ohne relistbare Historie → 'needs_publish' (Report; Publish ist ein
 *      bewusster separater Schritt über die Publish-Pipeline mit Readiness).
 *
 * Default: DRY-RUN (nur GetItem-Reads + Report). Mutationen NUR mit --apply.
 *
 * Usage:
 *   node scripts/repair-ended-listings-with-stock.js            # dry-run
 *   node scripts/repair-ended-listings-with-stock.js --apply
 *   node scripts/repair-ended-listings-with-stock.js --apply --publish   # + needs_publish via publishProduct (readiness-gated)
 *   node scripts/repair-ended-listings-with-stock.js --sku SKU-6656556112 [--apply]
 */

const { Firestore } = require('@google-cloud/firestore');
const db = new Firestore();

const APPLY = process.argv.includes('--apply');
const PUBLISH = process.argv.includes('--publish');
const ONLY_SKU = (() => {
  const i = process.argv.indexOf('--sku');
  return i >= 0 ? String(process.argv[i + 1] || '').trim() : null;
})();
const RELIST_MAX_AGE_DAYS = 90;
const GETITEM_CAP_PER_SKU = 5;

function skuOf(p) {
  return String(p?.identification?.sku || p?.details?.identifiers?.sku || '').trim();
}

async function getReserved(sku) {
  const snap = await db.collection('stock_reservations')
    .where('tenantId', '==', 'default')
    .where('status', '==', 'reserved')
    .where('sku', '==', sku)
    .get();
  const now = new Date().toISOString();
  let total = 0;
  snap.docs.forEach((d) => {
    const r = d.data();
    if (r.expiresAt && r.expiresAt < now) return;
    total += Number(r.quantity) || 0;
  });
  return total;
}

async function main() {
  console.log(`[repair] Modus: ${APPLY ? 'APPLY' : 'DRY-RUN'}${ONLY_SKU ? ` (nur ${ONLY_SKU})` : ''}`);

  // 1) Kandidaten: Bestand > 0, kein aktives Mirror-Listing
  const [productsSnap, liveSnap] = await Promise.all([
    db.collection('products_v2').where('tenantId', '==', 'default').get(),
    db.collection('ebayListingsLive').get(),
  ]);

  const liveBySku = new Map(); // sku → [{id, itemId, active, ...}]
  for (const doc of liveSnap.docs) {
    const d = doc.data();
    const sku = String(d?.sku || '').trim().toUpperCase();
    if (!sku) continue;
    if (!liveBySku.has(sku)) liveBySku.set(sku, []);
    liveBySku.get(sku).push({ docId: doc.id, ...d });
  }

  const candidates = [];
  for (const doc of productsSnap.docs) {
    const p = { id: doc.id, ...doc.data() };
    const sku = skuOf(p);
    if (!sku) continue;
    if (ONLY_SKU && sku !== ONLY_SKU) continue;
    const physical = Number(p?.inventory?.quantity ?? 0);
    if (physical <= 0) continue;
    const rows = liveBySku.get(sku.toUpperCase()) || [];
    const hasActive = rows.some((r) => r.active !== false);
    if (hasActive) continue;
    candidates.push({ p, sku, physical, mirrorRows: rows });
  }
  console.log(`[repair] ${candidates.length} Produkte mit Bestand>0 ohne aktives eBay-Mirror-Listing`);

  const { getItemDetails } = require('../lib/ebay-trading-api');
  const { relistEndedEbayListing } = require('../services/stock-sync-dispatcher');

  const report = { repointed: [], relisted: [], needs_publish: [], skipped_reserved: [], errors: [] };

  for (const { p, sku, physical, mirrorRows } of candidates) {
    try {
      const reserved = await getReserved(sku);
      const available = Math.max(0, physical - reserved);
      if (available <= 0) {
        report.skipped_reserved.push({ sku, physical, reserved });
        continue;
      }

      // Kandidaten-ItemIDs sammeln (Mirror + ops-Historie), jüngste zuerst
      const idSet = new Map(); // itemId → hint
      const push = (id, hint) => { const v = String(id || '').trim(); if (v && !idSet.has(v)) idSet.set(v, hint); };
      const sorted = [...mirrorRows].sort((a, b) => String(b.startTime || b.startTimeIso || '').localeCompare(String(a.startTime || a.startTimeIso || '')));
      for (const r of sorted) push(r.itemId || r.docId, 'mirror');
      push(p?.ops?.ebay?.itemId, 'ops.itemId');
      push(p?.ops?.ebay?.zeroStockEnd?.itemId, 'zeroStockEnd');
      push(p?.ops?.ebay?.relistedFrom, 'relistedFrom');
      push(p?.marketplace?.ebay?.itemId, 'marketplace.itemId');

      const itemIds = [...idSet.keys()].slice(0, GETITEM_CAP_PER_SKU);
      if (itemIds.length === 0) {
        report.needs_publish.push({ sku, productId: p.id, available, reason: 'keine ItemID-Historie' });
        continue;
      }

      // 2) GetItem-first: Wahrheit von eBay holen
      let activeItem = null;
      let bestEnded = null; // { itemId, endTime }
      for (const itemId of itemIds) {
        try {
          const res = await getItemDetails(itemId);
          const status = String(res?.item?.listingStatus || '').toLowerCase();
          const endTime = String(res?.item?.endTime || res?.item?.listingEndTime || '');
          if (status === 'active') { activeItem = itemId; break; }
          if (status === 'completed' || status === 'ended') {
            if (!bestEnded || endTime > bestEnded.endTime) bestEnded = { itemId, endTime };
          }
        } catch (err) {
          // Alt-Konto-IDs / entfernte Angebote werfen — nicht relistbar, weiter.
          console.log(`  [${sku}] GetItem ${itemId} → ${String(err.message).slice(0, 90)}`);
        }
      }

      if (activeItem) {
        console.log(`✔ [${sku}] ${activeItem} ist LIVE auf eBay (Mirror log falsch) → repoint${APPLY ? '' : ' (dry)'}`);
        if (APPLY) {
          await db.collection('products_v2').doc(p.id).update({
            'ops.ebay.itemId': activeItem,
            'ops.ebay.itemIdSource': 'repair-getitem',
            'ops.ebay.zeroStockEnd': null,
            'listingStatus.ebay': 'active',
          });
          await db.collection('ebayListingsLive').doc(activeItem).set(
            { itemId: activeItem, sku, active: true, repairedAt: new Date().toISOString(), source: 'repair-script' },
            { merge: true }
          );
        }
        report.repointed.push({ sku, productId: p.id, itemId: activeItem, available });
        continue;
      }

      if (bestEnded) {
        const ageDays = bestEnded.endTime
          ? (Date.now() - new Date(bestEnded.endTime).getTime()) / 86400000
          : null;
        if (ageDays !== null && ageDays > RELIST_MAX_AGE_DAYS) {
          report.needs_publish.push({ sku, productId: p.id, available, reason: `beendet vor ${Math.round(ageDays)}d (>90d, nicht relistbar)` });
          continue;
        }
        console.log(`↻ [${sku}] relist ${bestEnded.itemId} (beendet ${bestEnded.endTime || '?'}, qty=${available})${APPLY ? '' : ' (dry)'}`);
        if (APPLY) {
          try {
            const newItemId = await relistEndedEbayListing({
              productId: p.id,
              freshProduct: p,
              endedItemId: bestEnded.itemId,
              quantity: available,
            });
            report.relisted.push({ sku, productId: p.id, from: bestEnded.itemId, to: newItemId, qty: available });
          } catch (relistErr) {
            const msg = String(relistErr.message || '');
            // Alt-Konto-Listings (Cutover 2026-07-09): GetItem liefert fremde
            // Items, RelistFixedPriceItem verweigert sie ("nicht der
            // Verkäufer" / Code 17). Dann bleibt nur der Publish-Pfad.
            if (/verk[äa]ufer|not the seller|does not belong|another seller|belongs to another|cannot be relisted|kann nicht.*gelistet/i.test(msg)) {
              report.needs_publish.push({ sku, productId: p.id, available, reason: `relist verweigert (${msg.slice(0, 80)})` });
            } else {
              report.errors.push({ sku, error: `relist: ${msg}` });
              console.error(`✖ [${sku}] relist: ${msg}`);
            }
          }
        } else {
          report.relisted.push({ sku, productId: p.id, from: bestEnded.itemId, to: '(dry-run)', qty: available });
        }
        continue;
      }

      report.needs_publish.push({ sku, productId: p.id, available, reason: 'keine aktive/relistbare ItemID (GetItem)' });
    } catch (err) {
      report.errors.push({ sku, error: err.message });
      console.error(`✖ [${sku}] ${err.message}`);
    }
  }

  // 3) Publish-Backlog: nie auf dem aktuellen Konto gelistete Bestandsware
  //    über die reguläre Publish-Pipeline listen (validatePublishReadiness +
  //    Auto-Fix + Duplikat-Guard). Blocker landen sichtbar im
  //    Listing-Fehler-Cockpit — hier wird NICHTS an den Gates vorbeigedrückt.
  if (APPLY && PUBLISH && report.needs_publish.length) {
    const { publishProduct } = require('../lib/ebay-direct');
    report.published = [];
    report.publish_blocked = [];
    console.log(`\n[repair] Publish-Backlog: ${report.needs_publish.length} Produkte über publishProduct() …`);
    for (const entry of report.needs_publish) {
      try {
        const res = await publishProduct(entry.productId, {}, { actor: 'repair-ended-listings-script' });
        if (res?.ok) {
          report.published.push({ sku: entry.sku, itemId: res.itemId || res.listingId || null });
          console.log(`✚ [${entry.sku}] publiziert → ${res.itemId || res.listingId || '?'}`);
        } else {
          report.publish_blocked.push({ sku: entry.sku, blockers: res?.blockers || ['unbekannt'] });
          console.log(`⊘ [${entry.sku}] geblockt: ${(res?.blockers || []).join(' | ').slice(0, 140)}`);
        }
      } catch (err) {
        report.publish_blocked.push({ sku: entry.sku, blockers: [err.message] });
        console.error(`✖ [${entry.sku}] publish: ${err.message}`);
      }
    }
  }

  console.log('\n════════ ERGEBNIS ════════');
  console.log(`repointed (war live, Mirror falsch): ${report.repointed.length}`);
  report.repointed.forEach((r) => console.log(`   ${r.sku} → ${r.itemId}`));
  console.log(`relisted (wiederbelebt): ${report.relisted.length}`);
  report.relisted.forEach((r) => console.log(`   ${r.sku} ${r.from} → ${r.to} qty=${r.qty}`));
  console.log(`needs_publish (keine Historie — Publish-Pipeline nötig): ${report.needs_publish.length}`);
  report.needs_publish.slice(0, 100).forEach((r) => console.log(`   ${r.sku} avail=${r.available} (${r.reason})`));
  console.log(`skipped (Bestand komplett reserviert): ${report.skipped_reserved.length}`);
  console.log(`errors: ${report.errors.length}`);
  if (report.published) console.log(`published: ${report.published.length}, publish_blocked: ${report.publish_blocked.length}`);
  if (!APPLY) console.log('\nDRY-RUN — nichts geändert. Mit --apply ausführen.');

  const fs = require('fs');
  const out = `/tmp/repair-ended-listings-${APPLY ? 'apply' : 'dry'}-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.json`;
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`Report: ${out}`);
}

main().catch((err) => { console.error('[repair] FATAL:', err); process.exit(1); });
