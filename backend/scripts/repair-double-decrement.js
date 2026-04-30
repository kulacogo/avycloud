#!/usr/bin/env node
/**
 * Repair-Skript fuer das Doppel-Decrement-Pattern.
 *
 * Hintergrund: CLAUDE.md Punkt 13 (Stock Single Writer Invariant) +
 * docs/architecture/stock-single-source-of-truth.md.
 *
 * Erkennt Produkte, bei denen sowohl ein `stock_out flow=pick` als auch
 * ein `order_decrement` warehouseEvent fuer dieselbe Order-Einheit
 * geschrieben wurde — was vor dem Fix vom 2026-04-29 zu doppeltem Decrement
 * fuehrte.
 *
 * Aufruf:
 *   # Read-only Audit (gibt Bericht aus, schreibt nichts):
 *   node backend/scripts/repair-double-decrement.js
 *
 *   # Bestimmte SKUs explizit (nur Audit):
 *   node backend/scripts/repair-double-decrement.js --skus SKU-0000108900,SKU-0000041030
 *
 *   # Repair anwenden (Opt-in):
 *   node backend/scripts/repair-double-decrement.js --apply --confirm REPAIR_2026_04_29 \
 *     --skus SKU-0000108900,SKU-0000041030
 *
 * Apply-Mode rekonstruiert pro SKU:
 *   - +1 Bin-Eintrag im urspruenglichen Bin (aus stock_out warehouseEvent)
 *   - +1 inventory.quantity ueber `bookStockIn` mit `meta.action: 'repair-double-decrement'`
 *   - inventory_ledger-Eintrag via notifyStockChange (im bookStockIn-Pfad)
 *
 * Apply-Mode reaktiviert KEINE Marketplace-Listings — das ist explizit
 * NICHT Aufgabe dieses Scripts (separate Operation, da es Re-Listing-
 * Entscheidungen erfordert).
 *
 * Sicherheits-Mechanismen:
 *   - Apply nur mit `--confirm REPAIR_2026_04_29` (verhindert versehentliches Ausfuehren).
 *   - Apply nur fuer explizit per `--skus` angegebene SKUs.
 *   - Pre-/Post-Snapshot pro SKU.
 *   - Idempotenz: skippt SKU, wenn der Repair-Marker bereits existiert
 *     (`ops.last_repair.id === REPAIR_ID`).
 *   - Schreibt einen JSON-Audit-Report nach `/tmp/repair-double-decrement-<ISO>.json`.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { firestore, getProduct, findProductByStrictIdentifier } = require('../lib/firestore');
const { Timestamp } = require('@google-cloud/firestore');

const REPAIR_ID = 'REPAIR_2026_04_29_double_decrement';

function parseArgs(argv) {
  const out = {
    apply: false,
    confirm: null,
    skus: [],
    tenantId: 'default',
    sinceIso: null,
    untilIso: null,
    outDir: '/tmp',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--apply') { out.apply = true; }
    else if (a === '--confirm' && v) { out.confirm = v; i++; }
    else if (a === '--skus' && v) { out.skus = v.split(',').map((s) => s.trim()).filter(Boolean); i++; }
    else if (a === '--tenantId' && v) { out.tenantId = v; i++; }
    else if (a === '--since' && v) { out.sinceIso = v; i++; }
    else if (a === '--until' && v) { out.untilIso = v; i++; }
    else if (a === '--outDir' && v) { out.outDir = v; i++; }
    else if (a === '--help' || a === '-h') { out.help = true; }
  }
  return out;
}

function tsToIso(t) {
  if (!t) return null;
  if (typeof t === 'string') return t;
  if (typeof t === 'object' && typeof t._seconds === 'number') {
    return new Date(t._seconds * 1000 + Math.floor((t._nanoseconds || 0) / 1e6)).toISOString();
  }
  if (t instanceof Date) return t.toISOString();
  if (typeof t.toDate === 'function') return t.toDate().toISOString();
  return null;
}

async function loadEvents({ sinceIso }) {
  const since = sinceIso ? new Date(sinceIso) : null;
  const limit = 5000;
  let q = firestore.collection('warehouseEvents');
  if (since) q = q.where('createdAt', '>=', Timestamp.fromDate(since));
  q = q.orderBy('createdAt', 'desc').limit(limit);
  const snap = await q.get();
  const events = [];
  snap.forEach((d) => events.push({ id: d.id, ...d.data() }));
  return events;
}

function detectDoubleDecrementPairs(events, { maxLagHours = 24 } = {}) {
  // Group events by productId.
  const byProduct = new Map();
  for (const ev of events) {
    const pid = ev.productId;
    if (!pid) continue;
    if (!byProduct.has(pid)) byProduct.set(pid, []);
    byProduct.get(pid).push(ev);
  }

  const pairs = [];
  const maxLagMs = maxLagHours * 3600 * 1000;
  for (const [productId, evs] of byProduct) {
    const stockOuts = evs
      .filter((e) => e.type === 'stock_out' && e?.meta?.flow === 'pick' && e?.meta?.orderId)
      .map((e) => ({ ...e, _tsIso: tsToIso(e.createdAt) }))
      .sort((a, b) => String(a._tsIso || '').localeCompare(String(b._tsIso || '')));
    const orderDecrements = evs
      .filter((e) => e.type === 'order_decrement')
      .map((e) => ({ ...e, _tsIso: tsToIso(e.createdAt), _matched: false }))
      .sort((a, b) => String(a._tsIso || '').localeCompare(String(b._tsIso || '')));

    // Greedy 1:1 matching: pro stock_out das naechste unbenutzte order_decrement
    // mit (a) gleichem binCode in appliedBinDeltas, (b) gleichem |delta|, (c) zeitlich nach stock_out und innerhalb maxLag.
    for (const so of stockOuts) {
      if (!so._tsIso) continue;
      const soTime = Date.parse(so._tsIso);
      const stockOutDelta = Math.abs(Number(so.delta) || 0) || 1;
      const od = orderDecrements.find((d) => {
        if (d._matched) return false;
        if (!d._tsIso) return false;
        const odTime = Date.parse(d._tsIso);
        if (odTime < soTime) return false;
        if (odTime - soTime > maxLagMs) return false;
        // Bin + Delta match
        const bins = Array.isArray(d.appliedBinDeltas) ? d.appliedBinDeltas : [];
        const matchBin = bins.find((b) => String(b?.code || '').trim() === String(so.binCode || '').trim());
        if (!matchBin) return false;
        const odDelta = Math.abs(Number(matchBin.delta) || 0) || 0;
        if (odDelta !== stockOutDelta) return false;
        return true;
      });
      if (od) {
        od._matched = true;
        pairs.push({
          productId,
          sku: so.sku || null,
          orderId: so?.meta?.orderId || null,
          binCode: so.binCode || null,
          stockOutAt: so._tsIso,
          stockOutDelta: so.delta,
          orderDecrementAt: od._tsIso,
          orderDecrementBins: od.appliedBinDeltas || [],
          orderDecrementInventoryAfter: od.inventoryAfter,
          lagSeconds: Math.round((Date.parse(od._tsIso) - soTime) / 1000),
          stockOutEventId: so.id,
          orderDecrementEventId: od.id,
        });
      }
    }
  }
  return pairs;
}

async function loadCurrentProductState(productId) {
  const product = await getProduct(productId);
  if (!product) return null;
  return {
    id: productId,
    sku:
      product?.identification?.sku ||
      product?.details?.identifiers?.sku ||
      null,
    inventoryQuantity: product?.inventory?.quantity ?? null,
    storageBins: Array.isArray(product?.storageBins) ? product.storageBins : [],
    opsLastRepair: product?.ops?.last_repair || null,
    tenantId: product?.tenantId || null,
  };
}

async function applyRepairForSku({ sku, productId, binCode, repairId }) {
  // Use bookStockIn so existing telemetry (warehouseEvents stock_in + notifyStockChange) fires.
  const { bookStockIn } = require('../lib/warehouse');
  const result = await bookStockIn({
    productId,
    sku,
    binCode,
    quantity: 1,
    meta: {
      flow: 'repair',
      action: 'repair-double-decrement',
      repairId,
      source: 'cli',
      note: 'CLAUDE.md Punkt 13 — repair of duplicate decrement that ended listing prematurely',
    },
  });

  // Mark on product for idempotency.
  const productsCol = firestore.collection(
    (process.env.USE_PRODUCTS_V2 || '').toLowerCase() === 'true' ? 'products_v2' : 'products'
  );
  await productsCol.doc(productId).set(
    {
      ops: {
        last_repair: {
          id: repairId,
          appliedAt: new Date().toISOString(),
          deltaQuantity: 1,
          binCode: binCode || null,
        },
      },
    },
    { merge: true }
  );

  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf-8').split('\n').slice(0, 50).join('\n'));
    process.exit(0);
  }

  const startedAt = new Date().toISOString();
  const report = {
    repairId: REPAIR_ID,
    startedAt,
    args,
    pairsDetected: [],
    pairsConsidered: [],
    actions: [],
    errors: [],
  };

  console.error(`[repair-double-decrement] starting (apply=${args.apply}) since=${args.sinceIso || 'none'} skus=${args.skus.join(',') || '<all>'}`);

  const events = await loadEvents({ sinceIso: args.sinceIso });
  console.error(`[repair-double-decrement] loaded ${events.length} warehouseEvents`);
  const pairs = detectDoubleDecrementPairs(events);
  report.pairsDetected = pairs;
  console.error(`[repair-double-decrement] detected ${pairs.length} potential double-decrement pairs`);

  // Filter: nur SKUs die explizit angefragt wurden.
  let candidates = pairs;
  if (args.skus.length) {
    const wanted = new Set(args.skus.map((s) => s.toUpperCase()));
    candidates = pairs.filter((p) => p.sku && wanted.has(p.sku.toUpperCase()));
  }
  report.pairsConsidered = candidates;

  // Per SKU: aktueller Zustand
  const seenProductIds = new Set();
  const currentStates = [];
  for (const p of candidates) {
    if (seenProductIds.has(p.productId)) continue;
    seenProductIds.add(p.productId);
    const state = await loadCurrentProductState(p.productId);
    currentStates.push({ pair: p, state });
  }
  report.currentStates = currentStates;

  if (!args.apply) {
    console.log(JSON.stringify(report, null, 2));
    console.error(`[repair-double-decrement] AUDIT-ONLY mode. ${candidates.length} candidate(s).`);
    return;
  }

  // ── APPLY MODE ────────────────────────────────────────────────────────
  if (args.confirm !== REPAIR_ID) {
    console.error(`[repair-double-decrement] --apply refused: missing or wrong --confirm. Expected: --confirm ${REPAIR_ID}`);
    process.exit(2);
  }
  if (!args.skus.length) {
    console.error('[repair-double-decrement] --apply requires explicit --skus list (refusing to bulk-mutate).');
    process.exit(2);
  }

  for (const { pair, state } of currentStates) {
    const { productId, sku, binCode, orderId } = pair;
    try {
      if (!state) {
        report.errors.push({ productId, sku, error: 'product not found' });
        continue;
      }
      if (state.opsLastRepair?.id === REPAIR_ID) {
        report.actions.push({ productId, sku, status: 'skipped', reason: 'repair already applied', appliedAt: state.opsLastRepair.appliedAt });
        continue;
      }
      console.error(`[repair-double-decrement] applying repair sku=${sku} productId=${productId} bin=${binCode}`);
      const result = await applyRepairForSku({
        sku,
        productId,
        binCode,
        repairId: REPAIR_ID,
      });
      const post = await loadCurrentProductState(productId);
      report.actions.push({
        productId,
        sku,
        orderId,
        binCode,
        status: 'applied',
        before: state,
        after: post,
        bookStockInResult: !!result,
      });
    } catch (err) {
      console.error(`[repair-double-decrement] FAILED productId=${productId} sku=${sku}: ${err.message}`);
      report.errors.push({ productId, sku, error: err.message, stack: err.stack });
    }
  }

  // Persist report
  const file = path.join(args.outDir, `repair-double-decrement-${startedAt.replace(/[:.]/g, '-')}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.error(`[repair-double-decrement] report written: ${file}`);
  } catch (err) {
    console.error(`[repair-double-decrement] failed to write report: ${err.message}`);
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ fatal: err.message, stack: err.stack }, null, 2));
  process.exit(1);
});
