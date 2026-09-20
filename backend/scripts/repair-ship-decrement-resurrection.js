/**
 * repair-ship-decrement-resurrection.js — Incident 2026-08-28 (Oversell, eBay 12-15087-51308).
 *
 * Repariert Phantom-Bestand aus der Ship-Decrement-Resurrektion:
 * `decrementProductByIdOrSku` schrieb sein `order_decrement`-warehouseEvent OHNE
 * `delta` — für den Ledger (Σ warehouseEvents.delta, STOCK_LEDGER=true) war der
 * Abgang unsichtbar. Der direkt folgende `refreshProductInventory` projizierte
 * Σ Ledger zurück in `inventory.quantity` und machte den Decrement rückgängig
 * (Signatur im inventory_ledger: `ship-decrement` before→after, Sekunden daneben
 * `warehouse-refresh` mit exakt invertiertem after→before).
 *
 * SICHERHEIT:
 *   - DEFAULT = DRY-RUN: liest, plant, druckt, schreibt NICHTS.
 *   - `--apply` wirkt nur ZUSAMMEN mit `--confirm SHIP_RESURRECTION_V1`.
 *   - Korrigiert NUR Produkte, bei denen (a) die Phantom-Summe der Signatur-
 *     Paare EXAKT der Differenz (Σ Ledger − Σ Bins) entspricht UND (b) die
 *     Projektion (`inventory.quantity`) EXAKT der Ledger-Summe entspricht —
 *     applyMovement schreibt Event UND Projektion, beide muessen vorher
 *     uebereinstimmen. Jede andere Abweichung wird gemeldet, nie angefasst.
 *   - Idempotent: eine `adjust`-Buchung je Signatur-Paar mit deterministischem
 *     Key `adjust:ship-resurrection:{productId}:{shipLedgerDocId}` — ein
 *     Doppellauf bucht nie doppelt (stock-core.buildMovementEventId). tenantId
 *     kommt aus dem PRODUKT-Doc (nie aus ENV — TENANT_ID='avycloud' ist die
 *     Scripts-Konvention, alle Prod-Daten tragen aber tenant 'default'; ein
 *     ENV-abhaengiger Idempotenz-Hash wuerde die Doppellauf-Garantie brechen).
 *   - Marktplatz-Abgleich: der stock:changed-Emit hat in einem lokalen Script
 *     keine registrierten Handler — den Abgleich uebernimmt der Reconcile-Cron
 *     des Workers (≤30 min). Fuer die Incident-Produkte ist das Listing bereits
 *     beendet bzw. der Bestand sinkt (fail-safe Richtung).
 *
 * Usage:
 *   node scripts/repair-ship-decrement-resurrection.js [--sku SKU-…]
 *       [--apply --confirm SHIP_RESURRECTION_V1]
 */

'use strict';

// Projekt-Pin VOR jedem Firestore-Require (lokales gcloud steht auf Fremd-Projekt).
if (!process.env.GOOGLE_CLOUD_PROJECT) process.env.GOOGLE_CLOUD_PROJECT = 'avycloud';
if (!process.env.USE_PRODUCTS_V2) process.env.USE_PRODUCTS_V2 = 'true';

const CONFIRM_TOKEN = 'SHIP_RESURRECTION_V1';
const PAIR_WINDOW_MS = 120 * 1000;

function parseArgs(argv) {
  const out = { sku: null, apply: false, confirm: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]; const v = argv[i + 1];
    if (a === '--sku' && v) { out.sku = v; i++; }
    else if (a === '--apply') { out.apply = true; }
    else if (a === '--confirm' && v) { out.confirm = v; i++; }
  }
  return out;
}

function ts(v) {
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

/**
 * Resurrektions-Signatur (pur, testbar): zu einem `ship-decrement`-Eintrag
 * existiert ein `warehouse-refresh`-Eintrag desselben Produkts innerhalb
 * PAIR_WINDOW_MS mit EXAKT invertierten before/after-Werten.
 * @param {{id:string, productId:string, before:number, after:number, createdAt:string}} ship
 * @param {Array<{before:number, after:number, createdAt:string}>} refreshes
 * @returns {{shipLedgerDocId:string, phantomQty:number, shipAt:string, refreshAt:string}|null}
 */
function matchResurrectionPair(ship, refreshes) {
  const shipMs = ts(ship.createdAt);
  if (shipMs === null) return null;
  const match = (refreshes || []).find((r) => {
    const rMs = ts(r.createdAt);
    return (
      rMs !== null &&
      Math.abs(rMs - shipMs) <= PAIR_WINDOW_MS &&
      Number(r.before) === Number(ship.after) &&
      Number(r.after) === Number(ship.before)
    );
  });
  if (!match) return null;
  return {
    shipLedgerDocId: ship.id,
    phantomQty: Number(ship.before) - Number(ship.after),
    shipAt: ship.createdAt,
    refreshAt: match.createdAt,
  };
}

async function main() {
  const { firestore } = require('../lib/firestore');
  const { applyMovement } = require('../lib/stock-core');
  const { withStockLock } = require('../lib/stock-lock');
  const { notifyStockChange } = require('../lib/stock-change-events');

  const args = parseArgs(process.argv);
  const applyMode = args.apply && args.confirm === CONFIRM_TOKEN;

  console.log(`[repair-ship-resurrection] project=${process.env.GOOGLE_CLOUD_PROJECT} mode=${applyMode ? 'APPLY' : 'DRY-RUN'}`);
  if (args.apply && !applyMode) {
    console.error(`--apply verlangt --confirm ${CONFIRM_TOKEN}. Abbruch.`);
    process.exit(1);
  }

  const shipSnap = await firestore.collection('inventory_ledger').where('reason', '==', 'ship-decrement').get();
  const ships = [];
  shipSnap.forEach((d) => ships.push({ id: d.id, ...d.data() }));
  console.log(`[repair-ship-resurrection] ship-decrement Eintraege im inventory_ledger: ${ships.length}`);

  const byProduct = new Map();
  for (const ship of ships) {
    if (!ship.productId) continue;
    if (args.sku && ship.sku !== args.sku) continue;
    if (!byProduct.has(ship.productId)) byProduct.set(ship.productId, { sku: ship.sku || null, pairs: [], unpaired: [] });
    const bucket = byProduct.get(ship.productId);

    const refreshSnap = await firestore
      .collection('inventory_ledger')
      .where('productId', '==', ship.productId)
      .where('reason', '==', 'warehouse-refresh')
      .get();
    const refreshes = [];
    refreshSnap.forEach((d) => refreshes.push(d.data()));

    const pair = matchResurrectionPair(ship, refreshes);
    if (pair) bucket.pairs.push(pair);
    else bucket.unpaired.push({ id: ship.id, at: ship.createdAt });
  }

  let corrected = 0;
  let failures = 0;
  for (const [productId, info] of byProduct) {
    if (!info.pairs.length) {
      if (info.unpaired.length) {
        console.log(`\n  ${info.sku || productId}: ${info.unpaired.length} ship-decrement(s) OHNE Resurrektions-Signatur — nichts zu reparieren.`);
      }
      continue;
    }
    const phantomSum = info.pairs.reduce((s, p) => s + p.phantomQty, 0);

    const prodSnap = await firestore.collection('products_v2').doc(productId).get();
    if (!prodSnap.exists) {
      console.warn(`  SKIP ${productId} (${info.sku}) — Produkt nicht gefunden`);
      continue;
    }
    const prod = prodSnap.data() || {};
    const tenantId = prod.tenantId || 'default';
    const projection = Number(prod.inventory?.quantity) || 0;
    const quantitySource = prod.inventory?.quantitySource || null;

    const ledgerEventsSnap = await firestore.collection('warehouseEvents').where('productId', '==', productId).select('delta').get();
    let ledgerOnHand = 0;
    ledgerEventsSnap.forEach((d) => {
      const x = Number(d.data() && d.data().delta);
      if (Number.isFinite(x)) ledgerOnHand += x;
    });

    const binsSnap = await firestore.collection('warehouseBins').get();
    let binQty = 0;
    binsSnap.forEach((doc) => {
      const products = Array.isArray(doc.data()?.products) ? doc.data().products : [];
      for (const p of products) {
        const pid = String(p?.productId || '').trim();
        const psku = String(p?.sku || '').trim();
        if (pid === productId || (info.sku && psku === info.sku)) binQty += Number(p?.quantity) || 0;
      }
    });
    const drift = ledgerOnHand - binQty;

    console.log(`\n  ${info.sku || productId} (tenant=${tenantId})`);
    console.log(`    Paare=${info.pairs.length} phantomSum=${phantomSum} ledger=${ledgerOnHand} bins=${binQty} projektion=${projection} quelle=${quantitySource}`);
    for (const p of info.pairs) {
      console.log(`    - ship ${p.shipAt} → refresh ${p.refreshAt} (phantom +${p.phantomQty}) [${p.shipLedgerDocId}]`);
    }
    for (const u of info.unpaired) {
      console.log(`    ○ ship ${u.at} ohne Signatur-Paar [${u.id}] — nicht Teil der Korrektur`);
    }

    if (quantitySource !== 'ledger') {
      console.log('    → SKIP: quantitySource ist nicht \'ledger\' — Resurrektion wirkt nur im Ledger-Modus (manual review).');
      continue;
    }
    if (drift !== phantomSum) {
      console.log(`    → SKIP: Drift (${drift}) ≠ Phantom-Summe (${phantomSum}) — es hat sich mehr veraendert als die Signatur erklaert (manual review).`);
      continue;
    }
    if (projection !== ledgerOnHand) {
      console.log(`    → SKIP: Projektion (${projection}) ≠ Ledger-Summe (${ledgerOnHand}) — applyMovement korrigiert BEIDE, die Basis muss uebereinstimmen (manual review).`);
      continue;
    }

    if (!applyMode) {
      console.log(`    → DRY-RUN: wuerde ${info.pairs.length} adjust-Buchung(en) ueber insgesamt −${phantomSum} schreiben.`);
      continue;
    }

    for (const p of info.pairs) {
      try {
        const before = Number((await firestore.collection('products_v2').doc(productId).get()).data()?.inventory?.quantity) || 0;
        const result = await applyMovement(
          {
            tenantId,
            productId,
            delta: -p.phantomQty,
            type: 'adjust',
            idempotencyKey: `adjust:ship-resurrection:${productId}:${p.shipLedgerDocId}`,
            meta: {
              repair: 'ship-decrement-resurrection',
              incident: '2026-08-28-oversell-ebay-12-15087-51308',
              sku: info.sku,
              shipLedgerDocId: p.shipLedgerDocId,
            },
          },
          { firestore, withStockLock }
        );
        if (result.applied) {
          corrected += p.phantomQty;
          console.log(`    ✓ adjust −${p.phantomQty} gebucht (event=${result.eventId}, onHand=${result.onHand})`);
          await notifyStockChange({
            tenantId,
            productId,
            sku: info.sku,
            before,
            after: result.onHand,
            reason: 'ship-resurrection-repair',
            source: 'scripts/repair-ship-decrement-resurrection',
          });
        } else {
          console.log(`    ○ uebersprungen (${result.reason}) — bereits gebucht?`);
        }
      } catch (err) {
        failures += 1;
        console.error(`    ✗ FEHLER bei ${productId} [${p.shipLedgerDocId}]: ${err.message} — Lauf faehrt mit den uebrigen fort`);
      }
    }
  }

  console.log(`\n[repair-ship-resurrection] fertig — ${applyMode ? `korrigiert: −${corrected}, Fehler: ${failures}` : 'DRY-RUN, nichts geschrieben'}`);
  if (failures > 0) process.exitCode = 1;
}

module.exports = { matchResurrectionPair, PAIR_WINDOW_MS };

if (require.main === module) {
  main().then(() => process.exit(process.exitCode || 0)).catch((err) => {
    console.error('[repair-ship-resurrection] FEHLER:', err);
    process.exit(1);
  });
}
