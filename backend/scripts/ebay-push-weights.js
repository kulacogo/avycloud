#!/usr/bin/env node
/**
 * Operator-Skript: GEWICHT auf BESTEHENDE aktive eBay-Listings nachschieben
 * (Owner-Auftrag 2026-07-19: alle Angebote brauchen asap ein realistisches
 * Gewicht).
 *
 * WICHTIGER BEFUND (empirisch verifiziert 2026-07-19, itemId 800368789222):
 * Dieses Konto nutzt Business Policies mit Festpreis-Versand — eBay
 * PERSISTIERT ShippingPackageDetails (WeightMajor/WeightMinor) NICHT, weder
 * beim Publish noch beim Revise (GetItem zeigt immer 0/0, Warning 21919456).
 * Der einzige funktionierende, käufersichtbare Gewichts-Kanal ist das
 * ARTIKELMERKMAL ('Gewicht (kg)' bzw. Kategorie-Aspect) via ItemSpecifics.
 *
 * Mechanik pro Produkt (Bestand ≥ min-qty, plausibles numerisches Gewicht):
 *   1. Kandidaten-itemIds aus ebayListingsLive (alle active-Docs der SKU,
 *      neueste zuerst; Spiegel enthält nach den Duplikat-Relists vom
 *      2026-07-19 mehrere "aktive" Docs pro SKU, von denen eBay einige
 *      bereits beendet hat) + ops.ebay.itemId als Fallback.
 *   2. GetItem: erst wenn listingStatus=Active + FixedPrice → weiter,
 *      sonst nächster Kandidat ("Beendete Angebote können nicht ...").
 *   3. Lokale Specifics aus mapProductToEbayItem (EXAKT wie Publish,
 *      enthält das numerische Gewichts-Merkmal aus dem Backfill).
 *   4. UNION-Merge: live Specifics + lokale, lokale gewinnen pro Key —
 *      REIN ADDITIV, auf eBay geht kein Merkmal verloren. Cap 45 Aspects
 *      (lokale zuerst, dann live-only).
 *   5. ReviseFixedPriceItem mit NUR { itemId, itemSpecifics } — KEIN Titel,
 *      KEIN Preis, KEINE Menge, KEINE Bilder, KEIN startPrice.
 *
 * HARTE GUARDS (CLAUDE.md Nicht-verhandelbar Punkt 14):
 *   - endItem/endFixedPriceItem werden NICHT importiert und NIE aufgerufen.
 *     Kein Fehlerpfad beendet, löscht oder deaktiviert ein Listing.
 *   - Fehler werden klassifikationsfrei GESAMMELT (Report), Lauf geht weiter.
 *   - Keine products_v2-Writes (rein lesend auf Firestore).
 *   - Rate-Limit: 2s Pause pro Produkt (GetItem + Revise ≈ 2 Calls/Produkt).
 *
 * Aufruf:
 *   node backend/scripts/ebay-push-weights.js                    # Dry-Run
 *   node backend/scripts/ebay-push-weights.js --apply            # max 20 (Erstlauf)
 *   node backend/scripts/ebay-push-weights.js --apply --no-cap   # Vollauf
 *   node backend/scripts/ebay-push-weights.js --skip-items-file done.txt  # Resume
 */

'use strict';

process.env.USE_PRODUCTS_V2 = process.env.USE_PRODUCTS_V2 || 'true';

const fs = require('fs');
const path = require('path');

const { readCanonicalWeightKg, clampShippingKg } = require('../lib/weight-derive');

const EBAY_LISTINGS_COLLECTION = 'ebayListingsLive';
const DEFAULT_APPLY_CAP = 20;
const REVISE_DELAY_MS = 2000;
const MAX_ASPECTS = 45;
const WEIGHT_KEY_RE = /gewicht|weight/i;

function safeString(v) {
  return v == null ? '' : String(v).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const out = {
    apply: false,
    noCap: false,
    tenantId: process.env.TENANT_ID || 'default',
    limit: null,
    outDir: process.env.SCRATCHPAD_DIR || '/tmp',
    idsFile: null,
    skipItemsFile: null,
    minQty: 1,
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--apply') out.apply = true;
    else if (t === '--no-cap') out.noCap = true;
    else if (t === '--tenant') { out.tenantId = argv[i + 1] || out.tenantId; i += 1; }
    else if (t === '--out') { out.outDir = argv[i + 1] || out.outDir; i += 1; }
    else if (t === '--ids-file') { out.idsFile = argv[i + 1] || null; i += 1; }
    else if (t === '--skip-items-file') { out.skipItemsFile = argv[i + 1] || null; i += 1; }
    else if (t === '--min-qty') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n >= 0) out.minQty = n;
      i += 1;
    } else if (t === '--limit') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) out.limit = Math.floor(n);
      i += 1;
    } else if (t === '--help' || t === '-h') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`ebay-push-weights.js — Gewichts-Merkmal (ItemSpecifics) auf aktive eBay-Listings reviden.

  Kandidaten: Produkte mit inventory.quantity ≥ min-qty UND plausiblem
  numerischem Gewicht UND aktivem Fixed-Price-Listing. ShippingPackageDetails
  wird von eBay bei diesem Konto NICHT gespeichert (Business Policies) — das
  Gewicht geht als Artikelmerkmal raus (Union-Merge, rein additiv).

  Optionen:
    --apply                Revisen wirklich senden (default: Dry-Run)
    --no-cap               ${DEFAULT_APPLY_CAP}er-Cap im Apply-Lauf aufheben
    --tenant <id>          Tenant (default: TENANT_ID env oder 'default')
    --limit <n>            Max. Kandidaten (auch im Dry-Run)
    --min-qty <n>          Mindest-Lagerbestand (default 1; 0 = alle)
    --ids-file <f>         Nur diese Produkt-Doc-IDs (1 ID/Zeile)
    --skip-items-file <f>  SKUs oder itemIds überspringen (Resume; 1/Zeile)
    --out <dir>            Report-Verzeichnis (default: SCRATCHPAD_DIR oder /tmp)
`);
}

/**
 * Kandidaten aus Produkten + Listing-Index bauen. PURE — kein I/O.
 *
 * @param {Array<object>} products  products_v2-Docs (mit .id)
 * @param {Map<string,Array<string>>} skuToItemIds  SKU -> Kandidaten-itemIds (neueste zuerst)
 * @param {{minQty:number, skipKeys?:Set<string>}} opts  skipKeys matcht SKU ODER itemId
 * @returns {{candidates: Array<{product:object,sku:string,itemIds:string[],weightKg:number}>, skipped: Array<object>}}
 */
function buildCandidates(products, skuToItemIds, opts = {}) {
  const minQty = Number.isFinite(opts.minQty) ? opts.minQty : 1;
  const skipKeys = opts.skipKeys || new Set();
  const candidates = [];
  const skipped = [];

  for (const product of products) {
    const qty = Number(product?.inventory?.quantity);
    if (!Number.isFinite(qty) || qty < minQty) continue;

    const sku = safeString(product?.identification?.sku) || null;
    const fromMirror = (sku && skuToItemIds.get(sku)) || [];
    const opsItemId = safeString(product?.ops?.ebay?.itemId);
    const itemIds = [...fromMirror];
    if (opsItemId && !itemIds.includes(opsItemId)) itemIds.push(opsItemId);
    if (!itemIds.length) continue; // kein eBay-Listing — kein Report-Rauschen

    if (sku && skipKeys.has(sku)) {
      skipped.push({ productId: product.id, sku, reason: 'skip_file' });
      continue;
    }
    const remaining = itemIds.filter((id) => !skipKeys.has(id));
    if (!remaining.length) {
      skipped.push({ productId: product.id, sku, reason: 'skip_file' });
      continue;
    }

    const raw = readCanonicalWeightKg(product);
    const weightKg = clampShippingKg(raw);
    if (weightKg == null) {
      skipped.push({ productId: product.id, sku, reason: 'no_valid_weight', raw: raw ?? null });
      continue;
    }

    candidates.push({ product, sku, itemIds: remaining, weightKg });
  }
  return { candidates, skipped };
}

/**
 * Union-Merge der Specifics: lokale (kuratierte) gewinnen pro Key, live-only
 * Keys bleiben erhalten (REIN ADDITIV auf eBay). Cap: MAX_ASPECTS, lokale
 * zuerst — das Gewichts-Merkmal ist lokal und überlebt immer. PURE.
 *
 * @returns {{specifics: object, localCount: number, liveKept: number, dropped: number}}
 */
function mergeSpecificsUnion(localSpecifics, liveSpecifics) {
  const local = (localSpecifics && typeof localSpecifics === 'object') ? localSpecifics : {};
  const live = (liveSpecifics && typeof liveSpecifics === 'object') ? liveSpecifics : {};
  const specifics = {};
  for (const [k, v] of Object.entries(local)) {
    if (Object.keys(specifics).length >= MAX_ASPECTS) break;
    if (v == null || String(v).trim() === '') continue;
    specifics[k] = v;
  }
  const localKeysLower = new Set(Object.keys(specifics).map((k) => k.toLowerCase()));
  let liveKept = 0;
  let dropped = 0;
  for (const [k, v] of Object.entries(live)) {
    if (localKeysLower.has(k.toLowerCase())) continue;
    if (Object.keys(specifics).length >= MAX_ASPECTS) { dropped += 1; continue; }
    if (v == null) continue;
    specifics[k] = v;
    liveKept += 1;
  }
  return { specifics, localCount: Object.keys(local).length, liveKept, dropped };
}

/** Hat der Specifics-Satz ein nicht-leeres Gewichts-Merkmal? PURE. */
function hasWeightAspect(specifics) {
  return Object.entries(specifics || {}).some(([k, v]) => {
    if (!WEIGHT_KEY_RE.test(k)) return false;
    const val = Array.isArray(v) ? v[0] : v;
    return val != null && String(val).trim() !== '';
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  // Lazy Requires — bewusst NUR revise/get; endItem/endFixedPriceItem werden
  // absichtlich NICHT importiert (CLAUDE.md Punkt 14).
  const { firestore, PRODUCTS_COLLECTION, getAllProductsForTenant } = require('../lib/firestore');
  const { reviseFixedPriceItem, getItemDetails } = require('../lib/ebay-trading-api');
  const { mapProductToEbayItem } = require('../lib/ebay-direct');

  const startedAt = new Date().toISOString();
  console.log(`[ebay-push-weights] Modus=${args.apply ? 'APPLY' : 'DRY-RUN'} tenant=${args.tenantId} cap=${args.apply && !args.noCap ? DEFAULT_APPLY_CAP : 'aus'} limit=${args.limit ?? '-'} minQty=${args.minQty}`);

  let products = await getAllProductsForTenant(args.tenantId);
  console.log(`[ebay-push-weights] ${products.length} Produkte geladen (${PRODUCTS_COLLECTION}, tenant=${args.tenantId})`);

  if (args.idsFile) {
    const wanted = new Set(
      fs.readFileSync(args.idsFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean),
    );
    const before = products.length;
    products = products.filter((p) => wanted.has(String(p.id)));
    console.log(`[ebay-push-weights] --ids-file: ${wanted.size} IDs -> ${products.length}/${before} Produkte gefiltert`);
  }

  let skipKeys = new Set();
  if (args.skipItemsFile) {
    skipKeys = new Set(
      fs.readFileSync(args.skipItemsFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean),
    );
    console.log(`[ebay-push-weights] --skip-items-file: ${skipKeys.size} Einträge werden übersprungen`);
  }

  // SKU -> Kandidaten-itemIds aus ebayListingsLive (Doc-ID = itemId), neueste
  // zuerst. Der Spiegel kann mehrere "aktive" Docs pro SKU halten, von denen
  // eBay einige längst beendet hat — GetItem entscheidet später verbindlich.
  const skuToItemIds = new Map();
  const liveSnap = await firestore.collection(EBAY_LISTINGS_COLLECTION).get();
  const rowsBySku = new Map();
  liveSnap.forEach((d) => {
    const x = d.data() || {};
    if (x.active === true && x.sku) {
      const sku = String(x.sku);
      if (!rowsBySku.has(sku)) rowsBySku.set(sku, []);
      rowsBySku.get(sku).push({ itemId: d.id, start: Date.parse(x.startTime || x.startTimeIso || '') || 0 });
    }
  });
  for (const [sku, rows] of rowsBySku) {
    rows.sort((a, b) => b.start - a.start);
    skuToItemIds.set(sku, rows.map((r) => r.itemId));
  }
  console.log(`[ebay-push-weights] ${skuToItemIds.size} SKUs mit aktiven Listings aus ${EBAY_LISTINGS_COLLECTION} indiziert`);

  // Deterministische Reihenfolge — der gecappte Erstlauf ist reproduzierbar.
  products.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const { candidates: allCandidates, skipped } = buildCandidates(products, skuToItemIds, {
    minQty: args.minQty,
    skipKeys,
  });
  const candidates = args.limit ? allCandidates.slice(0, args.limit) : allCandidates;

  console.log(`[ebay-push-weights] ${candidates.length} Kandidaten (Bestand≥${args.minQty} + Gewicht + Listing), ${skipped.length} geskippt`);

  const results = [];
  const errors = [];
  const revisedItemIds = new Set();
  let revised = 0;
  let wouldRevise = 0;
  let processed = 0;
  const applyCap = args.apply && !args.noCap ? DEFAULT_APPLY_CAP : Infinity;

  for (const cand of candidates) {
    if (args.apply && revised >= applyCap) {
      skipped.push({ productId: cand.product.id, sku: cand.sku, reason: 'apply_cap_reached', cap: DEFAULT_APPLY_CAP });
      continue;
    }

    // Lokale Specifics EXAKT wie beim Publish; ohne Gewichts-Merkmal kein Push.
    let localSpecifics;
    try {
      localSpecifics = mapProductToEbayItem(cand.product)?.itemSpecifics || {};
    } catch (err) {
      errors.push({ productId: cand.product.id, sku: cand.sku, stage: 'map_product', error: err?.message || String(err) });
      continue;
    }
    if (!hasWeightAspect(localSpecifics)) {
      skipped.push({ productId: cand.product.id, sku: cand.sku, reason: 'no_weight_aspect_local' });
      continue;
    }

    if (!args.apply) {
      wouldRevise += 1;
      results.push({
        productId: cand.product.id,
        sku: cand.sku,
        itemIds: cand.itemIds,
        action: 'would_revise',
        weightKg: cand.weightKg,
        localSpecifics: Object.keys(localSpecifics).length,
      });
      continue;
    }

    // Rate-Limit: 2s pro Produkt (GetItem + Revise).
    if (processed > 0) await sleep(REVISE_DELAY_MS);
    processed += 1;

    // Kandidaten-itemIds durchprobieren bis eines wirklich Active+FixedPrice ist.
    let done = false;
    let lastProbeError = null;
    for (const itemId of cand.itemIds) {
      if (revisedItemIds.has(itemId)) continue;
      let liveItem = null;
      try {
        liveItem = (await getItemDetails(itemId))?.item || null;
      } catch (err) {
        lastProbeError = { itemId, stage: 'get_item', error: err?.message || String(err) };
        continue;
      }
      const status = safeString(liveItem?.listingStatus);
      if (status !== 'Active') { lastProbeError = { itemId, stage: 'status', error: `listingStatus=${status || '?'}` }; continue; }
      const listingType = safeString(liveItem?.listingType);
      if (/chinese|auction/i.test(listingType)) {
        skipped.push({ productId: cand.product.id, sku: cand.sku, itemId, reason: 'not_fixed_price', listingType });
        done = true;
        break;
      }

      const merged = mergeSpecificsUnion(localSpecifics, liveItem?.itemSpecifics || {});
      try {
        // Minimal-Patch: NUR itemId + ItemSpecifics (Union). Titel/Preis/Menge/
        // Bilder/startPrice bleiben unangetastet (Best-Offer-Schwelle sicher).
        const response = await reviseFixedPriceItem({ itemId, itemSpecifics: merged.specifics });
        revised += 1;
        revisedItemIds.add(itemId);
        results.push({
          productId: cand.product.id,
          sku: cand.sku,
          itemId,
          action: 'revised',
          weightKg: cand.weightKg,
          ack: response?.ack || null,
          specificsSent: Object.keys(merged.specifics).length,
          liveKept: merged.liveKept,
          droppedAtCap: merged.dropped,
        });
        console.log(`[ebay-push-weights] OK itemId=${itemId} sku=${cand.sku || '-'} ${cand.weightKg}kg specifics=${Object.keys(merged.specifics).length} ack=${response?.ack || '?'} (${revised}${Number.isFinite(applyCap) ? `/${applyCap}` : `/${candidates.length}`})`);
      } catch (err) {
        const msg = err?.message || String(err);
        // Race nach Duplikat-Relists: GetItem meldete Active, Revise sagt
        // beendet — dann den nächsten Kandidaten der SKU probieren.
        if (/beendete angebote|ended (item|listing)|item.*ended/i.test(msg)) {
          lastProbeError = { itemId, stage: 'revise_ended', error: msg };
          continue;
        }
        // GUARD (CLAUDE.md Punkt 14): NIE EndItem, NIE deaktivieren — Fehler nur
        // sammeln und weitermachen. Das Listing bleibt unverändert auf eBay.
        errors.push({ productId: cand.product.id, sku: cand.sku, itemId, stage: 'revise', error: msg, code: err?.code || null });
        console.warn(`[ebay-push-weights] FEHLER itemId=${itemId} sku=${cand.sku || '-'}: ${msg}`);
      }
      done = true;
      break;
    }
    if (!done) {
      skipped.push({ productId: cand.product.id, sku: cand.sku, reason: 'no_live_active_listing', lastProbe: lastProbeError });
    }
  }

  const skippedByReason = {};
  for (const s of skipped) skippedByReason[s.reason] = (skippedByReason[s.reason] || 0) + 1;

  const report = {
    script: 'ebay-push-weights',
    mode: args.apply ? 'apply' : 'dry-run',
    tenantId: args.tenantId,
    startedAt,
    finishedAt: new Date().toISOString(),
    params: { limit: args.limit, noCap: args.noCap, minQty: args.minQty, applyCap: Number.isFinite(applyCap) ? applyCap : null },
    counts: {
      productsTotal: products.length,
      candidates: candidates.length,
      revised,
      wouldRevise,
      failed: errors.length,
      skipped: skipped.length,
      skippedByReason,
    },
    results,
    errors,
    skipped,
  };

  const outFile = path.join(args.outDir, `ebay-push-weights-${startedAt.replace(/[:.]/g, '-')}.json`);
  try {
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log(`[ebay-push-weights] Report: ${outFile}`);
  } catch (err) {
    console.warn(`[ebay-push-weights] Report-Write fehlgeschlagen: ${err?.message}`);
  }

  // Resume-Hilfe: erfolgreich behandelte SKUs als skip-Datei ablegen.
  if (args.apply && revised > 0) {
    const doneFile = path.join(args.outDir, `ebay-push-weights-done-${startedAt.replace(/[:.]/g, '-')}.txt`);
    try {
      fs.writeFileSync(doneFile, results.filter((r) => r.action === 'revised').map((r) => r.sku || r.itemId).join('\n'));
      console.log(`[ebay-push-weights] Done-Liste (für --skip-items-file): ${doneFile}`);
    } catch (_) { /* best effort */ }
  }

  console.log(`[ebay-push-weights] Fertig — ${args.apply ? `revised=${revised}` : `would_revise=${wouldRevise}`} failed=${errors.length} skipped=${skipped.length} (${Object.entries(skippedByReason).map(([k, v]) => `${k}=${v}`).join(', ') || '-'})`);
  if (args.apply && !args.noCap && revised >= DEFAULT_APPLY_CAP) {
    console.log(`[ebay-push-weights] Cap von ${DEFAULT_APPLY_CAP} erreicht. Nach Prüfung des Reports: erneut mit --apply --no-cap laufen lassen.`);
  }
  if (errors.length) process.exitCode = 1;
}

module.exports = {
  parseArgs,
  buildCandidates,
  mergeSpecificsUnion,
  hasWeightAspect,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`[ebay-push-weights] Abbruch: ${err?.message}`, err);
    process.exitCode = 1;
  });
}
