'use strict';

/**
 * Admin-Finanzbericht — Orchestrator.
 *
 * Bündelt erprobte Quellen zu einem wahrheitsgemäßen P&L für einen Zeitraum:
 *   - getDashboardMetrics() liefert rohen Brutto-Umsatz + Kaufland-Gross + das Zeitfenster
 *     (range). WICHTIG: die LIB zieht Retouren NICHT ab (das macht nur die Route) → wir
 *     bekommen saubere Primitive und rechnen die P&L selbst, ohne Doppelzählung.
 *   - returns-Collection → Retouren-Erstattungen im Fenster.
 *   - eBay Finances API → exakte Auszahlung (sonst Schätzung in buildPnl).
 *   - orders (eigener Pass) → COGS + Markt­platz-Split + Zeitreihe (aggregateOrders).
 *   - products → Kostenindex + Bestandswert.
 *   - SevDesk/SendCloud → Versandkosten; SevDesk → Kontostand.
 *
 * Externe Quellen sind best-effort (Promise.allSettled): Ausfälle landen in `errors[]`,
 * nie als 500. Nur ein Fehler von getDashboardMetrics ist hart (Kern-Daten fehlen).
 */

const { getDashboardMetrics, firestore } = require('../lib/firestore');
const { getAllProductsV2ForTenant } = require('../lib/product-store');
const { getCheckAccountBalances, getShippingCostsFromSevDesk } = require('../lib/sevdesk');
const { getShippingCostsSummary: getSendCloudShippingSummary } = require('../lib/sendcloud');
const { getEbayNetRevenueSummary } = require('../lib/ebay-finances');
const { buildProductCostIndex, computeOrderCogs, computeInventoryValue } = require('../lib/cogs');
const { buildPnl } = require('../lib/financial-pnl');

const KAUFLAND_PAYOUT_FACTOR = 0.8334; // 1 - (0.14 * 1.19)

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}
function round2(x) {
  return Math.round((num(x) + Number.EPSILON) * 100) / 100;
}
function round1(x) {
  return Math.round((num(x) + Number.EPSILON) * 10) / 10;
}
function pad(n) {
  return String(n).padStart(2, '0');
}
function isoDateStr(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isCancelled(o) {
  const s = `${o && o.omsStatus || ''} ${o && o.status || ''} ${o && o.statusLabel || ''}`.toLowerCase();
  return /cancel|storn/.test(s);
}
function marketplaceOf(o) {
  const m = `${o && o.marketplace || ''} ${o && o.source || ''}`.toLowerCase();
  if (m.includes('ebay')) return 'ebay';
  if (m.includes('kaufland')) return 'kaufland';
  return 'other';
}
function bucketKey(date, bucket) {
  if (bucket === 'month') return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
  return isoDateStr(date); // day
}

/**
 * Pure: aggregiert Aufträge im Fenster zu COGS, Markt­platz-Split und Zeitreihe.
 * Storno + außerhalb des Fensters werden ausgeschlossen — gespiegelt aus getDashboardMetrics.
 */
function aggregateOrders(orders, costIndex, { fromIso, toIso, bucket = 'day' } = {}) {
  const from = parseDate(fromIso);
  const toExcl = parseDate(toIso);

  let cogs = 0;
  let matchedRevenue = 0;
  let totalItemRevenue = 0;
  let matchedItemCount = 0;
  let unmatchedItemCount = 0;
  let orderCount = 0;

  const mk = () => ({ orders: 0, units: 0, umsatz: 0, cogs: 0 });
  const byMarketplace = { ebay: mk(), kaufland: mk(), other: mk() };
  const bucketMap = new Map();

  for (const o of orders || []) {
    if (isCancelled(o)) continue;
    const created = parseDate(o && (o.createdAt || o.updatedAt));
    if (!created) continue;
    if (from && created < from) continue;
    if (toExcl && created >= toExcl) continue;

    orderCount += 1;
    const oc = computeOrderCogs(o, costIndex);
    cogs += oc.cogs;
    matchedRevenue += oc.matchedRevenue;
    totalItemRevenue += oc.totalItemRevenue;
    matchedItemCount += oc.matchedItemCount;
    unmatchedItemCount += oc.unmatchedItemCount;

    const umsatz = num(o.totalAmount);
    const units = Array.isArray(o.items) ? o.items.reduce((s, it) => s + Math.max(0, num(it.quantity)), 0) : 0;

    const bkt = byMarketplace[marketplaceOf(o)];
    bkt.orders += 1;
    bkt.units += units;
    bkt.umsatz += umsatz;
    bkt.cogs += oc.cogs;

    const k = bucketKey(created, bucket);
    const b = bucketMap.get(k) || { date: k, umsatz: 0, cogs: 0, orders: 0 };
    b.umsatz += umsatz;
    b.cogs += oc.cogs;
    b.orders += 1;
    bucketMap.set(k, b);
  }

  for (const v of Object.values(byMarketplace)) {
    v.umsatz = round2(v.umsatz);
    v.cogs = round2(v.cogs);
  }

  const buckets = [...bucketMap.values()]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((b) => ({
      date: b.date,
      umsatz: round2(b.umsatz),
      cogs: round2(b.cogs),
      rohertrag: round2(b.umsatz - b.cogs),
      orders: b.orders,
    }));

  return {
    cogs: round2(cogs),
    matchedRevenue: round2(matchedRevenue),
    totalItemRevenue: round2(totalItemRevenue),
    matchedItemCount,
    unmatchedItemCount,
    orderCount,
    byMarketplace,
    buckets,
  };
}

function pickBucket(fromIso, toIso) {
  const from = parseDate(fromIso);
  const to = parseDate(toIso);
  if (!from || !to) return 'day';
  const spanDays = (to.getTime() - from.getTime()) / 86400000;
  return spanDays > 62 ? 'month' : 'day';
}

/** Versand-Merge: SendCloud (netto, primär) + SevDesk-Direkt (brutto→netto); Fallback SevDesk. */
function mergeShipping(sevdesk, sendcloud) {
  const sv = sevdesk || null;
  const sc = sendcloud || null;
  const svDirectNetto = sv && num(sv.direct_shipping_cost) > 0
    ? round2(num(sv.direct_shipping_cost) / 1.19)
    : 0;

  if (sc && num(sc.parcel_count) > 0) {
    const dhl = num(sc.dhl_count);
    const dpd = num(sc.dpd_count);
    const other = sc.other_count != null ? num(sc.other_count) : Math.max(0, num(sc.parcel_count) - dhl - dpd);
    return {
      netto: round2(num(sc.total_cost) + svDirectNetto),
      parcelCount: num(sc.parcel_count),
      dhl, dpd, other,
      source: 'sendcloud',
    };
  }
  if (sv && num(sv.total_cost) > 0) {
    return {
      netto: round2(num(sv.total_cost) / 1.19), // SevDesk bank tx = brutto
      parcelCount: num(sv.voucher_count),
      dhl: 0, dpd: 0, other: 0,
      source: 'sevdesk',
    };
  }
  return null;
}

async function queryReturnsWindow(fromIso, toIso) {
  // Spiegelt routes/orders.js: returns-Collection ohne Tenant-Filter (Docs sind Legacy
  // single-tenant 'default'; ein tenantId-Filter würde feldlose Docs fälschlich droppen).
  const from = parseDate(fromIso);
  const toExcl = parseDate(toIso);
  const snap = await firestore.collection('returns').select('refundAmount', 'currency', 'createdAt').get();
  let value = 0;
  let count = 0;
  for (const doc of snap.docs) {
    const d = doc.data();
    const created = parseDate(d.createdAt);
    if (!created) continue;
    if (from && created < from) continue;
    if (toExcl && created >= toExcl) continue;
    value += num(d.refundAmount);
    count += 1;
  }
  return { value: round2(value), count };
}

/**
 * Haupteinstieg: vollständiger Finanzbericht für einen Zeitraum.
 */
async function getFinancialReport({ preset = null, fromDate = null, toDate = null, tenantId = 'default' } = {}) {
  const errors = [];

  // ── Kern: Umsatz-Primitive + Zeitfenster (hart; Fehler → throw → 500 in der Route) ──
  const metrics = await getDashboardMetrics({ preset, fromDate, toDate, tenantId });
  const range = metrics.range || {};
  const rev = metrics.revenue || {};
  const grossRevenue = num(rev.window_non_cancelled_total);
  const kauflandGross = num(rev.kaufland_gross_window);
  const kauflandPayout = round2(kauflandGross * KAUFLAND_PAYOUT_FACTOR);

  const fromIso = range.from_iso || null;
  const toIso = range.to_iso || null;
  const fromDateStr = fromIso ? isoDateStr(fromIso) : null;
  // External APIs treat toDate as INCLUSIVE → use the last day inside the exclusive window.
  const toDateStr = toIso ? isoDateStr(new Date(new Date(toIso).getTime() - 1)) : null;
  const bucket = pickBucket(fromIso, toIso);

  // ── Best-effort parallel IO ──
  const [returnsRes, ebayRes, ordersRes, productsRes, balancesRes, sevdeskRes, sendcloudRes] =
    await Promise.allSettled([
      queryReturnsWindow(fromIso, toIso),
      getEbayNetRevenueSummary(fromDateStr, toDateStr, { timeoutMs: 15000 }),
      firestore.collection('orders').where('tenantId', '==', tenantId).get(),
      getAllProductsV2ForTenant(tenantId),
      getCheckAccountBalances({ timeoutMs: 15000 }),
      getShippingCostsFromSevDesk(fromDateStr, toDateStr, { timeoutMs: 20000 }),
      getSendCloudShippingSummary(fromDateStr, toDateStr, { timeoutMs: 20000 }),
    ]);

  const returns = returnsRes.status === 'fulfilled' ? returnsRes.value : (errors.push('Retouren konnten nicht geladen werden.'), { value: 0, count: 0 });
  const ebayNet = ebayRes.status === 'fulfilled' && ebayRes.value ? ebayRes.value : null;
  if (ebayRes.status === 'rejected') errors.push('eBay-Auszahlung (Finances API) nicht verfügbar — Schätzung genutzt.');

  const products = productsRes.status === 'fulfilled' && Array.isArray(productsRes.value) ? productsRes.value : [];
  if (productsRes.status === 'rejected') errors.push('Produktkatalog konnte nicht geladen werden — COGS/Bestand unvollständig.');

  let orderDocs = [];
  if (ordersRes.status === 'fulfilled') {
    orderDocs = ordersRes.value.docs.map((d) => d.data());
  } else {
    errors.push('Aufträge konnten nicht geladen werden — COGS unvollständig.');
  }

  const balances = balancesRes.status === 'fulfilled' && balancesRes.value
    ? balancesRes.value
    : (errors.push('Kontostand (SevDesk) nicht verfügbar.'), { accounts: [], total: 0 });

  const shipping = mergeShipping(
    sevdeskRes.status === 'fulfilled' ? sevdeskRes.value : null,
    sendcloudRes.status === 'fulfilled' ? sendcloudRes.value : null,
  );
  if (!shipping) errors.push('Versandkosten nicht verfügbar (SevDesk + SendCloud).');

  // ── Aggregation + P&L ──
  const costIndex = buildProductCostIndex(products);
  const agg = aggregateOrders(orderDocs, costIndex, { fromIso, toIso, bucket });
  const inventory = computeInventoryValue(products);

  const pnl = buildPnl({
    grossRevenue,
    kauflandGross,
    kauflandPayout,
    ebayNetWindow: ebayNet ? num(ebayNet.net_revenue) : null,
    returnsValue: returns.value,
    shippingNetto: shipping ? shipping.netto : null,
    cogs: agg.cogs,
  });

  const coveragePct = agg.totalItemRevenue > 0
    ? round1((agg.matchedRevenue / agg.totalItemRevenue) * 100)
    : null;

  // ── Markt­platz-Aufschlüsselung mit Payout + effektiver Gebühr ──
  const mkOut = {};
  for (const key of ['ebay', 'kaufland', 'other']) {
    const m = agg.byMarketplace[key];
    let payout;
    if (key === 'kaufland') {
      payout = round2(m.umsatz * KAUFLAND_PAYOUT_FACTOR);
    } else if (key === 'ebay') {
      payout = ebayNet ? round2(num(ebayNet.net_revenue)) : round2(m.umsatz * 0.75);
    } else {
      payout = round2(m.umsatz * 0.75);
    }
    const fees = round2(m.umsatz - payout);
    mkOut[key] = {
      orders: m.orders,
      units: m.units,
      umsatz: m.umsatz,
      payout,
      fees,
      feePct: m.umsatz > 0 ? round1((fees / m.umsatz) * 100) : null,
      cogs: m.cogs,
    };
  }

  return {
    generated_at_iso: new Date().toISOString(),
    currency: 'EUR',
    range: {
      preset: range.preset || preset || 'last7',
      label: range.label || null,
      from_iso: fromIso,
      to_iso: toIso,
      bucket,
    },
    pnl: {
      ...pnl,
      coveragePct,
      matchedItemCount: agg.matchedItemCount,
      unmatchedItemCount: agg.unmatchedItemCount,
      orderCount: agg.orderCount,
    },
    marketplace: mkOut,
    inventory,
    balances: {
      accounts: Array.isArray(balances.accounts) ? balances.accounts : [],
      total: round2(balances.total),
    },
    shipping: shipping
      ? { brutto: round2(shipping.netto * 1.19), netto: shipping.netto, parcelCount: shipping.parcelCount, dhl: shipping.dhl, dpd: shipping.dpd, other: shipping.other, source: shipping.source }
      : null,
    timeseries: agg.buckets,
    quality: {
      cogsCoveragePct: coveragePct,
      matchedItemCount: agg.matchedItemCount,
      unmatchedItemCount: agg.unmatchedItemCount,
      payoutSource: pnl.auszahlungSource,
      shippingSource: shipping ? shipping.source : null,
      productCount: products.length,
    },
    errors,
  };
}

module.exports = {
  getFinancialReport,
  aggregateOrders,
  mergeShipping,
  pickBucket,
};
