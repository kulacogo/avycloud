'use strict';
/**
 * end-duplicate-ebay-listings.js — Incident 2026-07-19/20
 *
 * Am 2026-07-19 wurden in drei Bursts (04:00Z, 08:00Z, 15:00Z; +Vorläufer
 * 2026-07-17 08:4xZ) ~2.904 DUPLIKAT-Listings direkt auf eBay erzeugt (nicht
 * via avycloud): 632 von 733 SKUs haben 5-6 parallele Angebote, jedes mit dem
 * VOLLEN Bestand → ~11.600 Phantom-Einheiten, akutes Oversell-Risiko, Verstoß
 * gegen eBays Doppeleinstellungs-Richtlinie.
 *
 * Strategie: pro SKU bleibt GENAU EIN Listing — das ÄLTESTE aktive (Original
 * mit Verkaufshistorie/Watchern). Beendet werden NUR Listings, die ALLE
 * Bedingungen erfüllen:
 *   1. StartTime in einem der Burst-Fenster (17.07. 08:00-10:00Z,
 *      19.07. 03:30-16:30Z)
 *   2. NICHT das älteste aktive Listing seiner SKU
 *   3. GetItem-Verify unmittelbar vor dem End: Status Active UND
 *      QuantitySold == 0 (Duplikate mit Verkäufen → manuelle Liste)
 *   4. SKU behält nach dem End mindestens 1 aktives Listing
 *
 * DESTRUKTIV — läuft NUR mit --apply, default Dry-Run. Resumierbar: bereits
 * beendete ItemIDs werden in /tmp/end-duplicates-progress.json fortgeschrieben;
 * bei eBay-Rate-Limit stoppt das Script sauber (einfach später erneut starten).
 *
 * Usage:
 *   node scripts/end-duplicate-ebay-listings.js               # dry-run (Plan)
 *   node scripts/end-duplicate-ebay-listings.js --apply       # beenden
 *   node scripts/end-duplicate-ebay-listings.js --apply --max 500   # Tranche
 */

const fs = require('fs');

const APPLY = process.argv.includes('--apply');
const MAX = (() => {
  const i = process.argv.indexOf('--max');
  return i >= 0 ? Number(process.argv[i + 1]) || Infinity : Infinity;
})();
const PROGRESS_FILE = '/tmp/end-duplicates-progress.json';

const BURST_WINDOWS = [
  ['2026-07-17T08:00:00Z', '2026-07-17T10:00:00Z'],
  ['2026-07-19T03:30:00Z', '2026-07-19T16:30:00Z'],
];

function inBurstWindow(startTime) {
  const t = String(startTime || '');
  return BURST_WINDOWS.some(([a, b]) => t >= a && t <= b);
}

async function fetchAllActive() {
  const { getMyeBaySellingActive } = require('../lib/ebay-trading-api');
  const all = [];
  let page = 1;
  let totalPages = 1;
  do {
    const res = await getMyeBaySellingActive({ pageNumber: page, entriesPerPage: 200 });
    const items = res?.items || res?.listings || [];
    all.push(...items);
    totalPages = Number(res?.pagination?.totalPages || res?.totalPages || 1);
    page += 1;
    await new Promise((r) => setTimeout(r, 700));
  } while (page <= totalPages);
  return all;
}

async function main() {
  console.log(`[end-duplicates] Modus: ${APPLY ? 'APPLY (destruktiv!)' : 'DRY-RUN'} max=${MAX === Infinity ? '∞' : MAX}`);

  const progress = fs.existsSync(PROGRESS_FILE)
    ? JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'))
    : { ended: [], manualReview: [], errors: [] };
  const alreadyEnded = new Set(progress.ended.map((e) => e.itemId));

  console.log('[end-duplicates] Lade alle aktiven Listings von eBay …');
  const active = await fetchAllActive();
  console.log(`[end-duplicates] ${active.length} aktive Listings geladen`);

  // Gruppieren nach SKU
  const bySku = new Map();
  for (const l of active) {
    const sku = String(l.sku || '').trim().toUpperCase();
    if (!sku) continue;
    if (!bySku.has(sku)) bySku.set(sku, []);
    bySku.get(sku).push(l);
  }

  // Kandidaten bestimmen
  const candidates = [];
  let keptOriginals = 0;
  for (const [sku, listings] of bySku) {
    if (listings.length < 2) continue;
    const sorted = [...listings].sort((a, b) => String(a.startTime || '').localeCompare(String(b.startTime || '')));
    const keeper = sorted[0]; // ältestes = Original
    keptOriginals++;
    for (const dup of sorted.slice(1)) {
      const itemId = String(dup.itemId || '');
      if (!itemId || alreadyEnded.has(itemId)) continue;
      if (!inBurstWindow(dup.startTime)) {
        progress.manualReview.push({ sku, itemId, reason: `Duplikat außerhalb Burst-Fenster (start=${dup.startTime})` });
        continue;
      }
      candidates.push({ sku, itemId, startTime: dup.startTime, keeper: String(keeper.itemId || '') });
    }
  }

  console.log(`\n[end-duplicates] PLAN: ${candidates.length} Burst-Duplikate beenden, ${keptOriginals} Originale bleiben, ${progress.manualReview.length} manuell prüfen`);
  const histo = {};
  for (const c of candidates) {
    const h = String(c.startTime || '').slice(0, 13);
    histo[h] = (histo[h] || 0) + 1;
  }
  Object.entries(histo).sort().forEach(([h, n]) => console.log(`   ${h}xx: ${n}`));

  if (!APPLY) {
    fs.writeFileSync('/tmp/end-duplicates-plan.json', JSON.stringify({ candidates, manualReview: progress.manualReview }, null, 2));
    console.log(`\nDRY-RUN — nichts beendet. Plan: /tmp/end-duplicates-plan.json (${candidates.length} Kandidaten). Mit --apply ausführen.`);
    return;
  }

  const { getItemDetails, endFixedPriceItem } = require('../lib/ebay-trading-api');
  let done = 0;
  for (const c of candidates) {
    if (done >= MAX) { console.log(`[end-duplicates] Tranche-Limit ${MAX} erreicht — später fortsetzen.`); break; }
    try {
      // GetItem-Verify direkt vor dem End: Active? Verkäufe auf dem Duplikat?
      const detail = await getItemDetails(c.itemId);
      const status = String(detail?.item?.listingStatus || '').toLowerCase();
      const sold = Number(detail?.item?.quantitySold ?? detail?.item?.soldQuantity ?? 0);
      if (status !== 'active') {
        progress.ended.push({ ...c, note: `bereits ${status}` });
        continue;
      }
      if (sold > 0) {
        progress.manualReview.push({ ...c, reason: `Duplikat hat ${sold} Verkäufe — NICHT automatisch beendet` });
        continue;
      }
      await endFixedPriceItem(c.itemId, { reason: 'OtherListingError' });
      progress.ended.push({ ...c, endedAt: new Date().toISOString() });
      done++;
      if (done % 25 === 0) {
        fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
        console.log(`[end-duplicates] ${done}/${candidates.length} beendet …`);
      }
      await new Promise((r) => setTimeout(r, 400));
    } catch (err) {
      const msg = String(err.message || '');
      if (/usage limit|call usage|rate/i.test(msg)) {
        console.warn(`[end-duplicates] eBay-Rate-Limit erreicht nach ${done} — Fortschritt gespeichert, später fortsetzen.`);
        break;
      }
      progress.errors.push({ ...c, error: msg.slice(0, 200) });
      console.error(`✖ [${c.sku}] ${c.itemId}: ${msg.slice(0, 120)}`);
    }
  }

  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
  console.log(`\n[end-duplicates] Beendet: ${done} in diesem Lauf (gesamt ${progress.ended.length}), manuell: ${progress.manualReview.length}, Fehler: ${progress.errors.length}`);
  console.log(`Fortschritt: ${PROGRESS_FILE}`);
}

main().catch((err) => { console.error('[end-duplicates] FATAL:', err); process.exit(1); });
