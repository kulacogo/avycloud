#!/usr/bin/env node
'use strict';

/**
 * Stock Health Audit — Comprehensive cross-system check.
 *
 * Checks:
 *  1. Firestore products_v2: inventory.quantity, storageBins, ops.listingStatus
 *  2. eBay live listings: quantity vs warehouse
 *  3. Kaufland live units: amount vs warehouse
 *  4. Orders by status (OMS): pending, confirmed, shipped, cancelled, etc.
 *  5. Stock reservations: active, expired, orphaned
 *  6. Oversell detection: marketplace qty > 0 but warehouse qty = 0
 *  7. Bin drift: inventory.quantity ≠ sum(storageBins)
 *
 * Usage: node backend/scripts/audit-stock-health.js
 */

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

const DIVIDER = '═'.repeat(70);
const SUBDIV = '─'.repeat(50);

async function main() {
  console.log(DIVIDER);
  console.log('  AVYCLOUD STOCK HEALTH AUDIT');
  console.log(`  ${new Date().toISOString()}`);
  console.log(DIVIDER);

  // ─── 1. Products Inventory Overview ───────────────────────────
  console.log('\n📦 PRODUCTS INVENTORY (products_v2)\n' + SUBDIV);

  const productsSnap = await db.collection('products_v2').limit(5000).get();
  const products = productsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  let totalProducts = products.length;
  let withStock = 0;
  let withoutStock = 0;
  let binDriftCount = 0;
  const binDriftProducts = [];
  let totalQuantity = 0;
  let withEbayListing = 0;
  let withKauflandListing = 0;
  let ebayActive = 0;
  let ebayInactive = 0;
  let kauflandActive = 0;
  let kauflandInactive = 0;

  for (const p of products) {
    const qty = Number(p.inventory?.quantity ?? 0);
    totalQuantity += qty;
    if (qty > 0) withStock++;
    else withoutStock++;

    // Check bin drift
    const bins = Array.isArray(p.storageBins) ? p.storageBins : [];
    const binSum = bins.reduce((s, b) => s + (Number(b?.quantity) || 0), 0);
    if (binSum !== qty && (binSum > 0 || qty > 0)) {
      binDriftCount++;
      if (binDriftProducts.length < 10) {
        binDriftProducts.push({
          id: p.id,
          sku: p.identification?.sku || '?',
          invQty: qty,
          binSum,
        });
      }
    }

    // Listing status
    const ebayStatus = p.ops?.listingStatus?.ebay;
    const kauflandStatus = p.ops?.listingStatus?.kaufland;
    if (ebayStatus && ebayStatus !== 'not_listed') {
      withEbayListing++;
      if (ebayStatus === 'active') ebayActive++;
      else ebayInactive++;
    }
    if (kauflandStatus && kauflandStatus !== 'not_listed') {
      withKauflandListing++;
      if (kauflandStatus === 'active') kauflandActive++;
      else kauflandInactive++;
    }
  }

  console.log(`Total products:        ${totalProducts}`);
  console.log(`Total quantity:        ${totalQuantity}`);
  console.log(`With stock (qty > 0):  ${withStock}`);
  console.log(`Without stock (qty=0): ${withoutStock}`);
  console.log(`\neBay listings:         ${withEbayListing} (active: ${ebayActive}, inactive: ${ebayInactive})`);
  console.log(`Kaufland listings:     ${withKauflandListing} (active: ${kauflandActive}, inactive: ${kauflandInactive})`);
  console.log(`\nBin drift detected:    ${binDriftCount}`);
  if (binDriftProducts.length > 0) {
    console.log('  Sample drifts:');
    for (const d of binDriftProducts) {
      console.log(`    ${d.sku} (${d.id}): inventory.quantity=${d.invQty} vs binSum=${d.binSum}`);
    }
  }

  // ─── 2. eBay Live Listings ────────────────────────────────────
  console.log('\n🛒 EBAY LIVE LISTINGS (ebayListingsLive)\n' + SUBDIV);

  const ebaySnap = await db.collection('ebayListingsLive').limit(5000).get();
  let ebayLiveTotal = 0;
  let ebayLiveActive = 0;
  let ebayLiveInactive = 0;
  let ebayLiveWithQty = 0;
  let ebayLiveZeroQty = 0;
  const ebayOversells = [];
  const ebayQtyMismatch = [];

  // Build SKU → product map
  const skuToProduct = new Map();
  for (const p of products) {
    const sku = String(p.identification?.sku || '').trim().toLowerCase();
    if (sku) skuToProduct.set(sku, p);
  }

  for (const doc of ebaySnap.docs) {
    const data = doc.data();
    ebayLiveTotal++;
    if (data.active) ebayLiveActive++;
    else ebayLiveInactive++;

    const ebayQty = Number(data.quantityAvailable ?? data.quantity ?? 0);
    if (ebayQty > 0) ebayLiveWithQty++;
    else ebayLiveZeroQty++;

    // Cross-check with warehouse
    const sku = String(data.sku || '').trim().toLowerCase();
    const product = sku ? skuToProduct.get(sku) : null;
    if (product) {
      const whQty = Number(product.inventory?.quantity ?? 0);
      if (whQty === 0 && ebayQty > 0 && data.active) {
        ebayOversells.push({
          itemId: doc.id,
          sku: data.sku,
          ebayQty,
          warehouseQty: whQty,
          title: (data.title || '').substring(0, 40),
        });
      } else if (ebayQty !== whQty && data.active) {
        ebayQtyMismatch.push({
          sku: data.sku,
          ebayQty,
          warehouseQty: whQty,
        });
      }
    }
  }

  console.log(`Total eBay listings:   ${ebayLiveTotal}`);
  console.log(`  Active:              ${ebayLiveActive}`);
  console.log(`  Inactive:            ${ebayLiveInactive}`);
  console.log(`  With qty > 0:        ${ebayLiveWithQty}`);
  console.log(`  Zero qty:            ${ebayLiveZeroQty}`);
  console.log(`\n⚠️  OVERSELL RISK (warehouse=0 but eBay>0): ${ebayOversells.length}`);
  for (const o of ebayOversells.slice(0, 15)) {
    console.log(`    ${o.sku} — eBay shows ${o.ebayQty}, warehouse has ${o.warehouseQty} — ${o.title}`);
  }
  if (ebayQtyMismatch.length > 0) {
    console.log(`\n📊 eBay qty mismatches (active, different from warehouse): ${ebayQtyMismatch.length}`);
    for (const m of ebayQtyMismatch.slice(0, 10)) {
      console.log(`    ${m.sku} — eBay=${m.ebayQty} vs warehouse=${m.warehouseQty}`);
    }
  }

  // ─── 3. Kaufland Live Units ───────────────────────────────────
  console.log('\n🏪 KAUFLAND LIVE UNITS (kauflandUnitsLive)\n' + SUBDIV);

  const klSnap = await db.collection('kauflandUnitsLive').limit(5000).get();
  let klTotal = 0;
  let klActive = 0;
  let klInactive = 0;
  let klWithQty = 0;
  let klZeroQty = 0;
  const klOversells = [];
  const klQtyMismatch = [];

  for (const doc of klSnap.docs) {
    const data = doc.data();
    klTotal++;
    if (data.active || data.status === 'AVAILABLE') klActive++;
    else klInactive++;

    const klQty = Number(data.amount ?? 0);
    if (klQty > 0) klWithQty++;
    else klZeroQty++;

    const sku = String(data.id_offer || '').trim().toLowerCase();
    const product = sku ? skuToProduct.get(sku) : null;
    if (product) {
      const whQty = Number(product.inventory?.quantity ?? 0);
      if (whQty === 0 && klQty > 0 && (data.active || data.status === 'AVAILABLE')) {
        klOversells.push({
          unitId: doc.id,
          sku: data.id_offer,
          klQty,
          warehouseQty: whQty,
        });
      } else if (klQty !== whQty && (data.active || data.status === 'AVAILABLE')) {
        klQtyMismatch.push({
          sku: data.id_offer,
          klQty,
          warehouseQty: whQty,
        });
      }
    }
  }

  console.log(`Total Kaufland units:  ${klTotal}`);
  console.log(`  Active/AVAILABLE:    ${klActive}`);
  console.log(`  Inactive/ONHOLD:     ${klInactive}`);
  console.log(`  With amount > 0:     ${klWithQty}`);
  console.log(`  Zero amount:         ${klZeroQty}`);
  console.log(`\n⚠️  OVERSELL RISK (warehouse=0 but Kaufland>0): ${klOversells.length}`);
  for (const o of klOversells.slice(0, 15)) {
    console.log(`    ${o.sku} — Kaufland shows ${o.klQty}, warehouse has ${o.warehouseQty}`);
  }
  if (klQtyMismatch.length > 0) {
    console.log(`\n📊 Kaufland qty mismatches (active, different from warehouse): ${klQtyMismatch.length}`);
    for (const m of klQtyMismatch.slice(0, 10)) {
      console.log(`    ${m.sku} — Kaufland=${m.klQty} vs warehouse=${m.warehouseQty}`);
    }
  }

  // ─── 4. Orders by OMS Status ──────────────────────────────────
  console.log('\n📋 ORDERS BY STATUS\n' + SUBDIV);

  const ordersSnap = await db.collection('orders').limit(10000).get();
  const ordersByStatus = {};
  const ordersByMarketplace = {};
  let ordersTotal = 0;

  for (const doc of ordersSnap.docs) {
    const d = doc.data();
    ordersTotal++;
    const status = d.omsStatus || d.status || 'unknown';
    ordersByStatus[status] = (ordersByStatus[status] || 0) + 1;
    const mp = d.marketplace || 'unknown';
    ordersByMarketplace[mp] = (ordersByMarketplace[mp] || 0) + 1;
  }

  console.log(`Total orders: ${ordersTotal}`);
  console.log('\nBy OMS status:');
  const statusOrder = ['pending', 'confirmed', 'picking', 'picked', 'packing', 'packed', 'shipped', 'delivered', 'completed', 'cancelled', 'returned', 'on_hold'];
  for (const s of statusOrder) {
    if (ordersByStatus[s]) {
      const icon = s === 'cancelled' ? '❌' : s === 'shipped' ? '📦' : s === 'delivered' ? '✅' : s === 'returned' ? '↩️' : s === 'pending' ? '🔵' : '  ';
      console.log(`  ${icon} ${s.padEnd(12)}: ${ordersByStatus[s]}`);
    }
  }
  // Show any unknown statuses
  for (const [s, n] of Object.entries(ordersByStatus)) {
    if (!statusOrder.includes(s)) {
      console.log(`  ❓ ${s.padEnd(12)}: ${n}`);
    }
  }
  console.log('\nBy marketplace:');
  for (const [mp, n] of Object.entries(ordersByMarketplace).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${mp.padEnd(12)}: ${n}`);
  }

  // ─── 5. Stock Reservations ────────────────────────────────────
  console.log('\n🔒 STOCK RESERVATIONS\n' + SUBDIV);

  const resSnap = await db.collection('stock_reservations').limit(5000).get();
  const resByStatus = {};
  let resTotal = 0;
  let resExpiredButReserved = 0;
  const now = new Date().toISOString();
  const activeReservationSkus = new Map(); // sku → totalQty

  for (const doc of resSnap.docs) {
    const d = doc.data();
    resTotal++;
    const status = d.status || 'unknown';
    resByStatus[status] = (resByStatus[status] || 0) + 1;

    if (status === 'reserved') {
      if (d.expiresAt && d.expiresAt < now) {
        resExpiredButReserved++;
      } else {
        // Active reservation
        const sku = String(d.sku || '').trim();
        if (sku) {
          activeReservationSkus.set(sku, (activeReservationSkus.get(sku) || 0) + (Number(d.quantity) || 0));
        }
      }
    }
  }

  console.log(`Total reservations:    ${resTotal}`);
  for (const [s, n] of Object.entries(resByStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(12)}: ${n}`);
  }
  console.log(`  Expired but still 'reserved': ${resExpiredButReserved}`);
  console.log(`\nActive reservations by SKU: ${activeReservationSkus.size}`);
  for (const [sku, qty] of [...activeReservationSkus.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${sku}: ${qty} reserved`);
  }

  // ─── 6. Stock Sync Log (recent) ──────────────────────────────
  console.log('\n📡 RECENT STOCK SYNC LOG (last 20)\n' + SUBDIV);

  const syncLogSnap = await db.collection('stock_sync_log')
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();

  for (const doc of syncLogSnap.docs) {
    const d = doc.data();
    const channels = (d.results || []).map((r) => `${r.channel}:${r.status}`).join(', ');
    console.log(`  ${d.createdAt} qty=${d.availableQuantity ?? '?'} ${d.reason || ''} [${channels}]`);
  }

  // ─── 7. Stock Sync Failures (recent) ─────────────────────────
  console.log('\n❗ STOCK SYNC FAILURES (recent)\n' + SUBDIV);

  const failSnap = await db.collection('stock_sync_failures')
    .orderBy('createdAt', 'desc')
    .limit(10)
    .get();

  if (failSnap.empty) {
    console.log('  No recent failures.');
  } else {
    for (const doc of failSnap.docs) {
      const d = doc.data();
      console.log(`  ${d.createdAt} product=${d.productId} channels=[${(d.failedChannels || []).join(',')}] errors=[${(d.errors || []).join('; ')}]`);
    }
  }

  // ─── 8. Stock Operation Failures ──────────────────────────────
  console.log('\n🚨 STOCK OPERATION FAILURES (pending)\n' + SUBDIV);

  const opFailSnap = await db.collection('stock_operation_failures')
    .where('status', '==', 'pending')
    .limit(10)
    .get();

  if (opFailSnap.empty) {
    console.log('  No pending stock operation failures.');
  } else {
    for (const doc of opFailSnap.docs) {
      const d = doc.data();
      console.log(`  ${d.createdAt} order=${d.orderId} op=${d.operation}`);
      for (const f of (d.failures || [])) {
        console.log(`    step=${f.step} sku=${f.sku || ''} error=${f.error || ''}`);
      }
    }
  }

  // ─── 9. Summary & Recommendations ────────────────────────────
  console.log('\n' + DIVIDER);
  console.log('  SUMMARY');
  console.log(DIVIDER);

  const issues = [];
  if (ebayOversells.length > 0) issues.push(`⚠️  ${ebayOversells.length} eBay OVERSELL risks (warehouse=0, eBay>0)`);
  if (klOversells.length > 0) issues.push(`⚠️  ${klOversells.length} Kaufland OVERSELL risks (warehouse=0, Kaufland>0)`);
  if (binDriftCount > 0) issues.push(`📊 ${binDriftCount} products with bin drift (inventory.qty ≠ bin sum)`);
  if (resExpiredButReserved > 0) issues.push(`🔒 ${resExpiredButReserved} expired reservations not yet cleaned up`);
  if (ebayQtyMismatch.length > 0) issues.push(`📊 ${ebayQtyMismatch.length} eBay quantity mismatches`);
  if (klQtyMismatch.length > 0) issues.push(`📊 ${klQtyMismatch.length} Kaufland quantity mismatches`);

  if (issues.length === 0) {
    console.log('\n✅ No critical issues detected!');
  } else {
    console.log(`\n${issues.length} issue(s) found:\n`);
    for (const issue of issues) {
      console.log(`  ${issue}`);
    }
  }

  console.log('\n' + DIVIDER);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('Audit failed:', e.message);
  process.exit(1);
});
