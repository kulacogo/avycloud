/* eslint-disable no-console */
'use strict';

/**
 * compare-ebay-returns.js
 *
 * Fetches eBay orders with refunds/cancellations via Fulfillment API,
 * reads all eBay returns from AvyCloud Firestore, and compares statuses.
 *
 * Usage:  cd backend && node scripts/compare-ebay-returns.js [--days=30]
 *
 * Output: Console table + JSON report saved to ../compare-ebay-returns-report.json
 */

const { getValidEbayAccessToken } = require('../lib/ebay-oauth');
const { firestore } = require('../lib/firestore');

const RETURNS_COLLECTION = 'returns';

// ── Helpers ────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let days = 90; // Default: 90 days lookback
  for (const arg of args) {
    const m = arg.match(/^--days=(\d+)$/);
    if (m) days = parseInt(m[1], 10);
  }
  return { days };
}

function shortDate(iso) {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

function truncate(str, len = 50) {
  if (!str) return '—';
  return str.length > len ? str.slice(0, len) + '…' : str;
}

// ── eBay: Fetch orders with refunds / cancellations ──────────

async function fetchEbayReturns(lookbackDays) {
  console.log(`\n🔄 Fetching eBay orders (last ${lookbackDays} days)…`);

  const { accessToken } = await getValidEbayAccessToken();
  const fromDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  let allOrders = [];
  let offset = 0;
  const limit = 200;

  while (true) {
    const url = `https://api.ebay.com/sell/fulfillment/v1/order?limit=${limit}&offset=${offset}&filter=creationdate:[${encodeURIComponent(fromDate)}..]`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_DE',
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`eBay API ${res.status}: ${body.slice(0, 500)}`);
    }

    const json = await res.json();
    const orders = json.orders || [];
    allOrders = allOrders.concat(orders);
    console.log(`  📦 Fetched ${allOrders.length}/${json.total || '?'} orders (offset=${offset})`);

    if (allOrders.length >= (json.total || 0) || orders.length < limit) break;
    offset += limit;
  }

  // Extract only orders with refunds or cancellations
  const ebayReturns = [];

  for (const order of allOrders) {
    const isCanceled =
      order.cancelStatus?.cancelState &&
      order.cancelStatus.cancelState !== 'NONE_REQUESTED';
    const refundedItems = (order.lineItems || []).filter(
      (li) => li.refunds && li.refunds.length > 0
    );

    if (!isCanceled && refundedItems.length === 0) continue;

    let totalRefund = 0;
    for (const li of refundedItems) {
      for (const ref of li.refunds || []) {
        totalRefund += parseFloat(ref.amount?.value || '0') || 0;
      }
    }

    const cancelReason = order.cancelStatus?.cancelReason || '';
    const refundReason = refundedItems[0]?.refunds?.[0]?.reasonType || '';
    const productTitles = (order.lineItems || []).map((li) => li.title).filter(Boolean);

    const shipTo = order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo;
    const buyerName = shipTo?.fullName || order.buyer?.username || '?';

    ebayReturns.push({
      orderId: order.orderId,
      type: isCanceled ? 'CANCEL' : 'REFUND',
      ebayStatus: isCanceled
        ? `CANCEL:${order.cancelStatus.cancelState}`
        : 'REFUND',
      cancelReason: cancelReason || null,
      refundReason: refundReason || null,
      refundAmount: Math.round(totalRefund * 100) / 100,
      product: productTitles[0] || '—',
      buyer: buyerName,
      date: order.creationDate || null,
      orderStatus: order.orderFulfillmentStatus || order.orderPaymentStatus || '?',
    });
  }

  console.log(`  ✅ ${ebayReturns.length} eBay-Retouren/Stornos gefunden (von ${allOrders.length} Bestellungen)\n`);
  return ebayReturns;
}

// ── Firestore: Fetch AvyCloud returns ────────────────────────

async function fetchAvyCloudReturns() {
  console.log('🔄 Fetching AvyCloud returns from Firestore…');

  const snap = await firestore
    .collection(RETURNS_COLLECTION)
    .where('marketplace', '==', 'ebay')
    .orderBy('createdAt', 'desc')
    .get();

  const returns = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  console.log(`  ✅ ${returns.length} eBay-Retouren in AvyCloud\n`);
  return returns;
}

// ── Compare ──────────────────────────────────────────────────

function compare(ebayReturns, avyReturns) {
  // Build lookup by marketplaceReturnId (which is the eBay orderId)
  const avyByMpId = new Map();
  for (const r of avyReturns) {
    const key = r.marketplaceReturnId || r.marketplaceOrderId;
    if (key) avyByMpId.set(String(key), r);
  }

  const rows = [];
  const missingInAvy = [];
  const statusMismatches = [];

  for (const ebay of ebayReturns) {
    const avy = avyByMpId.get(String(ebay.orderId));

    if (!avy) {
      missingInAvy.push(ebay);
      rows.push({
        ebayOrderId: ebay.orderId,
        ebayType: ebay.type,
        ebayStatus: ebay.ebayStatus,
        avyStatus: '❌ FEHLT',
        avyMpStatus: '—',
        refundEbay: ebay.refundAmount,
        refundAvy: 0,
        product: truncate(ebay.product, 40),
        date: shortDate(ebay.date),
        match: 'MISSING',
      });
      continue;
    }

    // Compare statuses
    const ebayMpStatus = ebay.type === 'CANCEL' ? 'CANCELED' : 'REFUNDED';
    const avyMpStatus = avy.marketplaceStatus || '—';
    const avyStatus = avy.status || '—';
    const refundMatch = Math.abs((ebay.refundAmount || 0) - (avy.refundAmount || 0)) < 0.02;

    let match = 'OK';
    if (avyMpStatus !== ebayMpStatus) {
      match = 'STATUS_MISMATCH';
      statusMismatches.push({ ebay, avy });
    } else if (!refundMatch && ebay.refundAmount > 0) {
      match = 'REFUND_MISMATCH';
    }

    rows.push({
      ebayOrderId: ebay.orderId,
      ebayType: ebay.type,
      ebayStatus: ebay.ebayStatus,
      avyStatus,
      avyMpStatus,
      refundEbay: ebay.refundAmount,
      refundAvy: avy.refundAmount || 0,
      product: truncate(avy.product?.name || ebay.product, 40),
      date: shortDate(ebay.date),
      match,
    });

    // Remove from map to find orphans later
    avyByMpId.delete(String(ebay.orderId));
  }

  // AvyCloud returns that have no matching eBay order (orphans)
  const orphansInAvy = [];
  for (const [key, avy] of avyByMpId) {
    orphansInAvy.push(avy);
    rows.push({
      ebayOrderId: key,
      ebayType: '—',
      ebayStatus: '⚠️ NICHT BEI EBAY',
      avyStatus: avy.status,
      avyMpStatus: avy.marketplaceStatus || '—',
      refundEbay: 0,
      refundAvy: avy.refundAmount || 0,
      product: truncate(avy.product?.name || '—', 40),
      date: shortDate(avy.createdAt),
      match: 'ORPHAN',
    });
  }

  return { rows, missingInAvy, statusMismatches, orphansInAvy };
}

// ── Main ─────────────────────────────────────────────────────

async function run() {
  const { days } = parseArgs();

  console.log('══════════════════════════════════════════════════════════');
  console.log('  eBay Retouren vs. AvyCloud — Status-Vergleich');
  console.log(`  Lookback: ${days} Tage`);
  console.log('══════════════════════════════════════════════════════════');

  const [ebayReturns, avyReturns] = await Promise.all([
    fetchEbayReturns(days),
    fetchAvyCloudReturns(),
  ]);

  const { rows, missingInAvy, statusMismatches, orphansInAvy } = compare(ebayReturns, avyReturns);

  // ── Summary ──
  const okCount = rows.filter((r) => r.match === 'OK').length;
  const missingCount = missingInAvy.length;
  const mismatchCount = statusMismatches.length;
  const orphanCount = orphansInAvy.length;

  console.log('══════════════════════════════════════════════════════════');
  console.log('  ERGEBNIS');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  ✅ Status stimmt überein:    ${okCount}`);
  console.log(`  ❌ Fehlt in AvyCloud:        ${missingCount}`);
  console.log(`  ⚠️  Status-Abweichung:       ${mismatchCount}`);
  console.log(`  🔍 Nur in AvyCloud (Orphan): ${orphanCount}`);
  console.log(`  📊 Gesamt verglichen:        ${rows.length}`);
  console.log('──────────────────────────────────────────────────────────\n');

  // ── Detail: Missing in AvyCloud ──
  if (missingInAvy.length > 0) {
    console.log('❌ FEHLT IN AVYCLOUD (eBay hat Retoure, AvyCloud nicht):');
    console.log('─'.repeat(90));
    for (const e of missingInAvy) {
      console.log(
        `  ${shortDate(e.date)} | ${e.orderId} | ${e.type} | €${e.refundAmount.toFixed(2)} | ${truncate(e.product, 50)}`
      );
    }
    console.log('');
  }

  // ── Detail: Status Mismatch ──
  if (statusMismatches.length > 0) {
    console.log('⚠️  STATUS-ABWEICHUNG:');
    console.log('─'.repeat(90));
    for (const { ebay, avy } of statusMismatches) {
      console.log(
        `  ${shortDate(ebay.date)} | ${ebay.orderId}`
      );
      console.log(
        `    eBay:     ${ebay.ebayStatus}`
      );
      console.log(
        `    AvyCloud: status=${avy.status}, mpStatus=${avy.marketplaceStatus || '—'}`
      );
      console.log(
        `    Erstattung: eBay €${ebay.refundAmount.toFixed(2)} vs. AvyCloud €${(avy.refundAmount || 0).toFixed(2)}`
      );
    }
    console.log('');
  }

  // ── Detail: Orphans ──
  if (orphansInAvy.length > 0) {
    console.log('🔍 NUR IN AVYCLOUD (kein eBay-Match im Zeitraum):');
    console.log('─'.repeat(90));
    for (const avy of orphansInAvy) {
      console.log(
        `  ${shortDate(avy.createdAt)} | ${avy.marketplaceReturnId || '—'} | status=${avy.status} | mpStatus=${avy.marketplaceStatus || '—'} | €${(avy.refundAmount || 0).toFixed(2)}`
      );
    }
    console.log('');
  }

  // ── Full table ──
  if (rows.length > 0) {
    console.log('\n📋 VOLLSTÄNDIGE ÜBERSICHT:');
    console.table(
      rows.map((r) => ({
        Datum: r.date,
        'eBay Order': r.ebayOrderId?.slice(-12) || '—',
        Typ: r.ebayType,
        'eBay Status': r.ebayStatus,
        'Avy Status': r.avyStatus,
        'Avy MP-Status': r.avyMpStatus,
        '€ eBay': r.refundEbay,
        '€ Avy': r.refundAvy,
        Produkt: r.product,
        Ergebnis: r.match,
      }))
    );
  }

  // ── Save report ──
  const report = {
    generatedAt: new Date().toISOString(),
    lookbackDays: days,
    summary: { ok: okCount, missing: missingCount, mismatch: mismatchCount, orphan: orphanCount, total: rows.length },
    ebayReturnsCount: ebayReturns.length,
    avyCloudReturnsCount: avyReturns.length,
    rows,
    missingInAvyCloud: missingInAvy,
    statusMismatches: statusMismatches.map(({ ebay, avy }) => ({
      ebayOrderId: ebay.orderId,
      ebayStatus: ebay.ebayStatus,
      avyStatus: avy.status,
      avyMpStatus: avy.marketplaceStatus,
      refundEbay: ebay.refundAmount,
      refundAvy: avy.refundAmount,
    })),
    orphansInAvyCloud: orphansInAvy.map((a) => ({
      id: a.id,
      marketplaceReturnId: a.marketplaceReturnId,
      status: a.status,
      marketplaceStatus: a.marketplaceStatus,
      refundAmount: a.refundAmount,
    })),
  };

  const fs = require('fs');
  const reportPath = require('path').join(__dirname, '..', '..', 'compare-ebay-returns-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n💾 Report gespeichert: ${reportPath}`);
}

run().catch((err) => {
  console.error('\n💥 Fehler:', err.message);
  if (err.message.includes('401') || err.message.includes('token') || err.message.includes('Token')) {
    console.error('\n⚠️  eBay Token ist möglicherweise abgelaufen!');
    console.error('   → Erneuere den Token über die eBay OAuth-Einstellungen in AvyCloud.');
  }
  process.exit(1);
});
