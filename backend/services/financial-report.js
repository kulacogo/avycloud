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
const { getCheckAccountBalances, getShippingCostsFromSevDesk, getMarketplacePayoutsFromSevDesk } = require('../lib/sevdesk');
const { getShippingCostsSummary: getSendCloudShippingSummary } = require('../lib/sendcloud');
const { getEbayNetRevenueSummary } = require('../lib/ebay-finances');
const { buildProductCostIndex, computeOrderCogs, computeInventoryValue } = require('../lib/cogs');
const { buildPnl } = require('../lib/financial-pnl');
const { resolveFees } = require('../lib/marketplace-fee-resolver');
const { deriveCostModel } = require('../lib/cost-model');
const { getCostModelConfig } = require('../lib/cost-model-store');
const { computeOnlineListings } = require('../lib/listings-online');
const { getListingSnapshotsInRange, snapshotAverage } = require('../lib/listing-snapshot');

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
function aggregateOrders(orders, costIndex, { fromIso, toIso, bucket = 'day', costModel = null } = {}) {
  const from = parseDate(fromIso);
  const toExcl = parseDate(toIso);

  let cogs = 0;
  let matchedRevenue = 0;
  let totalItemRevenue = 0;
  let matchedItemCount = 0;
  let exactItemCount = 0;
  let estimatedItemCount = 0;
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
    const oc = computeOrderCogs(o, costIndex, costModel);
    cogs += oc.cogs;
    matchedRevenue += oc.matchedRevenue;
    totalItemRevenue += oc.totalItemRevenue;
    matchedItemCount += oc.matchedItemCount;
    exactItemCount += oc.exactItemCount;
    estimatedItemCount += oc.estimatedItemCount;
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
    exactItemCount,
    estimatedItemCount,
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

/**
 * Sendungen im Zeitraum — aus der EIGENEN Liste, nicht von SendCloud.
 *
 * SendCloud liefert seit dem 29.06.2026 keine einzige Sendung mehr an die
 * Auswertung: die Labels entstehen ueber die v3-Schnittstelle, abgefragt wurde
 * v2, und v2 kennt die neuen Pakete nicht (GET /v2/parcels/<v3-id> → 404).
 * Ergebnis: Paketzahl und Dienstleister-Aufteilung standen sechs Wochen lang
 * auf null, obwohl 562 Sendungen entstanden.
 *
 * Die eigene `shipments`-Sammlung ist vollstaendig, braucht keinen Fremdaufruf
 * und kann nicht durch einen Schnittstellenwechsel still auf null fallen.
 */
async function countShipmentsWindow(fromIso, toIso, tenantId = 'default') {
  const from = parseDate(fromIso);
  const toExcl = parseDate(toIso);
  const snap = await firestore.collection('shipments').select('createdAt', 'carrier', 'status').get();
  let parcelCount = 0;
  let dhl = 0;
  let dpd = 0;
  let dp = 0;
  let other = 0;
  for (const doc of snap.docs) {
    const d = doc.data();
    const created = parseDate(d.createdAt);
    if (!created) continue;
    if (from && created < from) continue;
    if (toExcl && created >= toExcl) continue;
    // Stornierte Sendungen sind kein Versand.
    const status = `${d.status || ''}`.toLowerCase();
    if (status === 'cancelled' || status === 'storniert') continue;
    parcelCount += 1;
    const c = `${d.carrier || ''}`.toLowerCase();
    if (c.startsWith('dhl')) dhl += 1;
    else if (c.startsWith('dpd')) dpd += 1;
    else if (c === 'dp' || c.startsWith('deutsche')) dp += 1;
    else other += 1;
  }
  return { parcel_count: parcelCount, dhl_count: dhl, dpd_count: dpd, dp_count: dp, other_count: other };
}

async function queryReturnsWindow(fromIso, toIso) {
  // Spiegelt routes/orders.js: returns-Collection ohne Tenant-Filter (Docs sind Legacy
  // single-tenant 'default'; ein tenantId-Filter würde feldlose Docs fälschlich droppen).
  const from = parseDate(fromIso);
  const toExcl = parseDate(toIso);
  const snap = await firestore.collection('returns')
    .select('refundAmount', 'currency', 'createdAt', 'marketplace', 'orderId')
    .get();

  // Im Fenster liegende Retouren einsammeln, DANN erst die zugehoerigen
  // Auftraege laden — sonst ein Firestore-Lesevorgang je Retoure ueber die
  // ganze Sammlung.
  const imFenster = [];
  for (const doc of snap.docs) {
    const d = doc.data();
    const created = parseDate(d.createdAt);
    if (!created) continue;
    if (from && created < from) continue;
    if (toExcl && created >= toExcl) continue;
    imFenster.push(d);
  }

  // Stornierte Auftraege sind im Umsatz gar nicht enthalten — ihre Retouren ein
  // zweites Mal abzuziehen war der groesste Einzelfehler im Bericht:
  // gemessen 1.120,66 € von 2.210,53 € (50,7 %). Details + Fail-open-Regel in
  // lib/finance-returns-filter.js.
  const { retoureDarfAbgezogenWerden } = require('../lib/finance-returns-filter');
  const orderIds = Array.from(new Set(imFenster.map((d) => String(d.orderId || '').trim()).filter(Boolean)));
  const orders = new Map();
  if (orderIds.length) {
    const refs = orderIds.map((id) => firestore.collection('orders').doc(id));
    // getAll vertraegt viele Refs; bei sehr grossen Fenstern in Bloecken lesen.
    for (let i = 0; i < refs.length; i += 300) {
      const teil = await firestore.getAll(...refs.slice(i, i + 300)).catch(() => []);
      teil.forEach((docSnap) => {
        if (docSnap && docSnap.exists) orders.set(docSnap.id, docSnap.data());
      });
    }
  }

  let value = 0;
  let count = 0;
  let uebersprungen = 0;
  let uebersprungenWert = 0;
  const byMarketplace = { ebay: 0, kaufland: 0, other: 0 };
  for (const d of imFenster) {
    const amount = num(d.refundAmount);
    if (!retoureDarfAbgezogenWerden(d, orders)) {
      uebersprungen += 1;
      uebersprungenWert += amount;
      continue;
    }
    value += amount;
    count += 1;
    const mk = `${d.marketplace || ''}`.toLowerCase();
    if (mk.includes('ebay')) byMarketplace.ebay += amount;
    else if (mk.includes('kaufland')) byMarketplace.kaufland += amount;
    else byMarketplace.other += amount;
  }

  if (uebersprungen > 0) {
    console.log(
      `[finanzbericht] ${uebersprungen} Retouren an stornierten Auftraegen nicht abgezogen (${round2(uebersprungenWert)} €) — deren Umsatz war nie gebucht`
    );
  }

  return {
    value: round2(value),
    count,
    cancelledSkipped: uebersprungen,
    cancelledSkippedValue: round2(uebersprungenWert),
    byMarketplace: { ebay: round2(byMarketplace.ebay), kaufland: round2(byMarketplace.kaufland), other: round2(byMarketplace.other) },
  };
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
  const [returnsRes, ebayRes, ordersRes, productsRes, balancesRes, sevdeskRes, sendcloudRes, payoutRes, costCfgRes, ebayListingsRes] =
    await Promise.allSettled([
      queryReturnsWindow(fromIso, toIso),
      getEbayNetRevenueSummary(fromDateStr, toDateStr, { timeoutMs: 15000 }),
      firestore.collection('orders').where('tenantId', '==', tenantId).get(),
      getAllProductsV2ForTenant(tenantId),
      getCheckAccountBalances({ timeoutMs: 15000 }),
      getShippingCostsFromSevDesk(fromDateStr, toDateStr, { timeoutMs: 20000 }),
      getSendCloudShippingSummary(fromDateStr, toDateStr, { timeoutMs: 20000 }),
      getMarketplacePayoutsFromSevDesk(fromDateStr, toDateStr, { timeoutMs: 20000 }),
      getCostModelConfig(tenantId),
      firestore.collection('ebayListingsLive').get(),
    ]);

  const returns = returnsRes.status === 'fulfilled' ? returnsRes.value : (errors.push('Retouren konnten nicht geladen werden.'), { value: 0, count: 0 });
  const ebayNet = ebayRes.status === 'fulfilled' && ebayRes.value ? ebayRes.value : null;

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
    // total:null statt 0 — ein nicht abrufbarer Kontostand ist UNBEKANNT,
    // keine gemessene Null. Vorher stand gross "0,00 € — Bankstand heute" auf
    // der Kachel, obwohl SevDesk gar nicht geantwortet hatte.
    : (errors.push('Kontostand (SevDesk) nicht verfügbar.'), { accounts: [], total: null });

  // Versandkosten: die BANKABBUCHUNG ist die Zahl, nicht der SendCloud-Preis.
  //
  // Bis 2026-08-17 wurde der von SendCloud berechnete Paketpreis UND dieselbe
  // Sendung als echte Bankabbuchung addiert — gemessen 4.906,89 € angezeigt
  // gegen 3.380,57 € tatsaechlichen Abgang (+45 %). Alle drei Carrier-Vertraege
  // sind laut SendCloud-API `type:"direct"`: der Frachtfuehrer bucht selbst ab,
  // die SevDesk-Buchungen SIND diese Pakete.
  //
  // SHIPPING_SOURCE='legacy' stellt das alte Verhalten wieder her (Notausstieg).
  const sevdeskShipping = sevdeskRes.status === 'fulfilled' ? sevdeskRes.value : null;
  const sendcloudShipping = sendcloudRes.status === 'fulfilled' ? sendcloudRes.value : null;
  const shippingLegacy = String(process.env.SHIPPING_SOURCE || '').trim().toLowerCase() === 'legacy';

  let shipping;
  let shippingBank = null;
  if (shippingLegacy) {
    shipping = mergeShipping(sevdeskShipping, sendcloudShipping);
    if (!shipping) errors.push('Versandkosten nicht verfügbar (SevDesk + SendCloud).');
  } else {
    const { mergeShippingBankFirst } = require('../lib/finance-shipping-merge');
    // Stueckzahl aus der EIGENEN Sendungsliste; SendCloud nur noch als
    // Rueckfall fuer alte Zeitraeume vor der v3-Umstellung.
    const eigeneSendungen = await countShipmentsWindow(fromIso, toIso, tenantId).catch(() => null);
    const stueckQuelle = eigeneSendungen && eigeneSendungen.parcel_count > 0
      ? eigeneSendungen
      : sendcloudShipping;
    shippingBank = mergeShippingBankFirst(sevdeskShipping, stueckQuelle);
    // In die bestehende Form giessen, damit die uebrigen Stellen unveraendert
    // bleiben. `netto` bleibt null — gerechnet wird jetzt mit `brutto`.
    shipping = shippingBank.brutto != null || shippingBank.parcelCount > 0
      ? {
        netto: null,
        brutto: shippingBank.brutto,
        parcelCount: shippingBank.parcelCount,
        dhl: shippingBank.dhl,
        dpd: shippingBank.dpd,
        other: shippingBank.other,
        source: shippingBank.source,
      }
      : null;
    if (shippingBank.pending) {
      errors.push(
        `Versandkosten für diesen Zeitraum sind noch nicht abgebucht — ${shippingBank.parcelCount} Sendungen verschickt.`
      );
    } else if (!shipping) {
      errors.push('Versandkosten nicht verfügbar (SevDesk).');
    }
  }

  // Real marketplace payouts from SevDesk bank credits (cflox=Kaufland, eBay S.a.r.l.=eBay).
  // EXACT money received — preferred over any estimate.
  const sevdeskPayout = payoutRes.status === 'fulfilled' && payoutRes.value ? payoutRes.value : null;
  if (!sevdeskPayout) errors.push('Auszahlungen (SevDesk) nicht verfügbar — Schätzung genutzt.');

  // ── Cost model (pallet-based estimated COGS where no real buyPrice) ──
  // Calibrate the cost ratio against the period's avg SOLD price so that total COGS =
  // soldUnits × avgUnitCostNetto (matches the owner's "total spend ÷ total units" math).
  // The sold mix is pricier than the catalog stock average, so using the stock average
  // would overstate COGS by ~⅓.
  const costConfig = costCfgRes.status === 'fulfilled' && costCfgRes.value ? costCfgRes.value : null;
  // Einkaufspreise aus den Losen (Los-Betrag / Einheiten im Los).
  //
  // Kein einziges Produkt hat einen eigenen Einkaufspreis; gerechnet wurde mit
  // einer Paletten-Pauschale von 8,51 € brutto je Einheit aus der Zeit vor der
  // Los-Umstellung. Je Los liegt die um bis zu Faktor 24 daneben (gemessen:
  // 5,39 € bei NL-0626 gegen 129,65 € bei L-072643).
  let lotCosts = new Map();
  try {
    const { buildLotUnitCosts } = require('../lib/lot-cost');
    const loseSnap = await firestore.collection('warehouse_lots').get();
    const lose = loseSnap.docs.map((d) => ({ code: d.id, ekBrutto: num(d.data().ekBrutto) }));

    // Bezugsmenge = heutiger Bestand + bereits verkaufte Einheiten aus dem Los.
    // Ohne die verkauften stiege der Stueckpreis mit jedem Verkauf.
    const mengen = new Map();
    for (const prod of products || []) {
      const code = String((prod && prod.ops && prod.ops.sourceLot) || '').trim();
      if (!code) continue;
      const eintrag = mengen.get(code) || { bestand: 0, verkauft: 0 };
      eintrag.bestand += num(prod?.inventory?.quantity);
      mengen.set(code, eintrag);
    }
    // ACHTUNG Gross-/Kleinschreibung: lib/cogs.js normalisiert Schluessel NUR mit
    // trim(), nicht mit toLowerCase(). Wer hier kleinschreibt, findet keine
    // einzige verkaufte Einheit — die Bezugsmenge waere dann nur der Restbestand
    // und der Einkaufspreis je Einheit entsprechend zu hoch.
    const lotBySku = new Map();
    for (const prod of products || []) {
      const code = String((prod && prod.ops && prod.ops.sourceLot) || '').trim();
      const sku = String(prod?.identification?.sku || prod?.details?.identifiers?.sku || '').trim();
      if (code && sku) lotBySku.set(sku, code);
    }
    for (const o of orderDocs || []) {
      for (const it of (Array.isArray(o.items) ? o.items : [])) {
        const code = lotBySku.get(String(it?.sku || '').trim());
        if (!code) continue;
        const eintrag = mengen.get(code) || { bestand: 0, verkauft: 0 };
        eintrag.verkauft += Math.max(0, num(it?.quantity));
        mengen.set(code, eintrag);
      }
    }
    lotCosts = buildLotUnitCosts(lose, mengen);
    if (lotCosts.size > 0) {
      console.log(`[finanzbericht] Einkaufspreise aus ${lotCosts.size} Losen ermittelt`);
    }
  } catch (err) {
    console.warn(`[finanzbericht] Los-Einkaufspreise nicht verfuegbar: ${err.message}`);
  }

  const costIndex = buildProductCostIndex(products, lotCosts);

  const agg0 = aggregateOrders(orderDocs, costIndex, { fromIso, toIso, bucket }); // pass 1: no model
  const soldUnits = ['ebay', 'kaufland', 'other'].reduce((s, k) => s + agg0.byMarketplace[k].units, 0);
  const avgSoldPrice = soldUnits > 0 ? round2(agg0.totalItemRevenue / soldUnits) : 0;
  const costModel = deriveCostModel(costConfig || {}, avgSoldPrice);

  const agg = aggregateOrders(orderDocs, costIndex, { fromIso, toIso, bucket, costModel }); // pass 2: COGS
  const inventory = computeInventoryValue(products, costModel);

  // ── Ø Artikel online ──
  // Exact source = daily snapshots (marketplace_daily_snapshots) when they cover the
  // window (records eBay + Kaufland active counts going forward). Otherwise fall back
  // to the eBay interval estimate (only the active set is datable; ended listings carry
  // no offline date → historical undercount, flagged via `reliable`/coverage).
  const nowIso = new Date().toISOString();
  const ebayListingDocs = ebayListingsRes.status === 'fulfilled' ? ebayListingsRes.value.docs.map((d) => d.data()) : [];
  if (ebayListingsRes.status === 'rejected') errors.push('eBay-Listings (Online-Bestand) nicht verfügbar.');
  const interval = computeOnlineListings(ebayListingDocs, { fromIso, toIso, nowIso });

  let snapAvg = { avgOnline: 0, avgEbay: 0, avgKaufland: 0, days: 0 };
  try {
    snapAvg = snapshotAverage(await getListingSnapshotsInRange(fromIso, toIso, tenantId));
  } catch (err) {
    console.warn('[financial-report] snapshot read failed:', err && err.message);
  }
  const useSnapshots = snapAvg.days > 0;
  const listingsOnline = {
    avgOnline: useSnapshots ? snapAvg.avgOnline : interval.avgOnline,
    avgEbay: useSnapshots ? snapAvg.avgEbay : interval.avgOnline,
    avgKaufland: useSnapshots ? snapAvg.avgKaufland : null,
    currentActive: interval.currentActive, // eBay active right now (exact)
    source: useSnapshots ? 'snapshot' : 'estimate',
    snapshotDays: snapAvg.days,
    coverage: interval.coverage,
    // Reliable when snapshots cover the window, or the active set covers nearly all listings.
    reliable: useSnapshots || (interval.coverage != null && interval.coverage >= 80),
  };

  // Resolve payout: SevDesk (exact) > eBay Finances + Kaufland-factor (exact-ish) > estimate.
  const realPayout = sevdeskPayout ? num(sevdeskPayout.total) : null;
  const realPayoutSource = sevdeskPayout ? 'sevdesk' : null;

  const feeRateEbay = num((costConfig && costConfig.feeRateEbay) ?? 0.11) || 0.11;
  let feeRateKaufland = num((costConfig && costConfig.feeRateKaufland) ?? 0.1666) || 0.1666;
  let feeRateKauflandGemessen = null;
  // Kaufland liefert die Gebuehren je Position im Buchungsbericht mit
  // (fee_gross / price_gross). Gemessen August 2026 ueber 48 abgerechnete
  // Positionen: 15,47 % — der hinterlegte Satz lag bei 13 %.
  //
  // Bewusst der SATZ und nicht die Summe: der Bericht enthaelt nur Positionen,
  // deren Erloes Kaufland schon freigegeben hat (Wochen nach Lieferung). Die
  // Gebuehrensumme des laufenden Monats steht dort noch gar nicht, der Satz
  // dagegen ist sofort belastbar.
  try {
    const { measureKauflandFeeRate } = require('../lib/kaufland-fee-rate');
    const { getBookings } = require('../lib/kaufland-api');
    const bis = new Date().toISOString().slice(0, 10);
    const von = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const bericht = await getBookings({ from: von, to: bis, storefront: 'de' });
    const gemessen = measureKauflandFeeRate(bericht?.bookings || []);
    if (gemessen) {
      feeRateKauflandGemessen = gemessen;
      feeRateKaufland = gemessen.rate;
      console.log(
        `[finanzbericht] Kaufland-Gebuehrensatz gemessen: ${(gemessen.rate * 100).toFixed(2)} % `
        + `(${gemessen.feeSum} € auf ${gemessen.revenueSum} €, ${gemessen.positions} Positionen)`
      );
    }
  } catch (err) {
    console.warn(`[finanzbericht] Kaufland-Gebuehrensatz nicht messbar: ${err.message}`);
  }
  const ebayGross = Math.max(0, grossRevenue - kauflandGross);
  const retByMk = returns.byMarketplace || { ebay: 0, kaufland: 0, other: 0 };

  // ── Gebühren EINMAL auflösen: gemessen > (abgerechneter) Flow > Sätze ──
  // Dieselbe Auflösung speist die Gesamt-P&L UND die Marktplatz-Zeilen, damit die
  // Summe der Zeilen exakt der Gesamtsumme entspricht (vorher zwei getrennte
  // Residuum-Rechnungen). `windowEndIso` entscheidet, ob der Flow-Pfad zulässig ist:
  // über einem noch nicht abgerechneten Fenster misst er Settlement-Lag, keine Gebühren
  // (Incident 2026-07-28: 8.121 € „Gebühren" = 75 % vom Umsatz).
  const feeResolution = resolveFees({
    marketplaces: {
      ebay: {
        gross: agg.byMarketplace.ebay.umsatz,
        retouren: num(retByMk.ebay),
        payout: sevdeskPayout ? num(sevdeskPayout.ebay) : null,
        rate: feeRateEbay,
      },
      kaufland: {
        gross: agg.byMarketplace.kaufland.umsatz,
        retouren: num(retByMk.kaufland),
        payout: sevdeskPayout ? num(sevdeskPayout.kaufland) : null,
        rate: feeRateKaufland,
      },
      // „Sonstige" hat strukturell keine zuordenbare Auszahlung → immer Satz-Basis.
      other: { gross: agg.byMarketplace.other.umsatz, retouren: num(retByMk.other), payout: null, rate: feeRateEbay },
    },
    windowEndIso: toIso,
  });

  const pnl = buildPnl({
    grossRevenue,
    ebayGross,
    kauflandGross,
    feeRateEbay,
    feeRateKaufland,
    feeRateKauflandGemessen,
    realPayout,
    realPayoutSource,
    returnsValue: returns.value,
    // Die Luecke muss sichtbar sein: der Bediener sieht auf der Retouren-Seite
    // ALLE Vorgaenge, hier wird aber nur abgezogen, was nicht schon ueber den
    // Storno aus dem Umsatz gefallen ist. Ohne diese Zahlen steht im Dashboard
    // ein Betrag, den er nirgends wiederfindet.
    returnsCancelledCount: returns.cancelledSkipped || 0,
    returnsCancelledValue: returns.cancelledSkippedValue || 0,
    shippingNetto: shipping ? shipping.netto : null,
    shippingBrutto: shipping ? (shipping.brutto != null ? shipping.brutto : null) : null,
    cogs: agg.cogs,
    feeResolution,
    windowEndIso: toIso,
  });

  // Ehrliche Fehlerliste: eine fehlende Auszahlung wird gemeldet, nicht als Gebühr getarnt.
  if (sevdeskPayout && sevdeskPayout.tx_count === 0) {
    errors.push('Keine Marktplatz-Gutschriften im Zeitraum gefunden — Auszahlungen fehlen oder der Zahlername ist unbekannt.');
  }
  for (const w of feeResolution.warnings) errors.push(w);

  const coveragePct = agg.totalItemRevenue > 0
    ? round1((agg.matchedRevenue / agg.totalItemRevenue) * 100)
    : null;

  // ── Markt­platz-Aufschlüsselung aus DERSELBEN Gebühren-Auflösung ──
  // Kein zweites Residuum mehr. Zusätzlich pro Marktplatz die Auszahlungs-Lücke,
  // damit sichtbar wird, welcher Kanal noch nicht abgerechnet hat.
  const mkOut = {};
  for (const key of ['ebay', 'kaufland', 'other']) {
    const m = agg.byMarketplace[key];
    const f = feeResolution.byMarketplace[key];
    const realPay = sevdeskPayout && key !== 'other' ? round2(num(sevdeskPayout[key])) : null;
    const ret = num(retByMk[key]);
    const payoutErwartet = round2(m.umsatz - ret - f.fees);
    mkOut[key] = {
      orders: m.orders,
      units: m.units,
      umsatz: m.umsatz,
      fees: f.fees,
      feeSource: f.feeSource,
      feePct: f.feePct,
      payout: realPay,
      payoutSource: realPay != null ? 'sevdesk' : null,
      payoutErwartet,
      offeneAuszahlung: realPay != null ? round2(payoutErwartet - realPay) : null,
      retouren: ret,
      retourenStorno: returns.cancelledSkippedValue || 0,
      retourenStornoAnzahl: returns.cancelledSkipped || 0,
      retourenGesamt: round2(num(ret) + num(returns.cancelledSkippedValue || 0)),
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
      exactItemCount: agg.exactItemCount,
      estimatedItemCount: agg.estimatedItemCount,
      unmatchedItemCount: agg.unmatchedItemCount,
      orderCount: agg.orderCount,
    },
    marketplace: mkOut,
    inventory,
    listingsOnline,
    costModel: {
      mode: costModel.mode,
      vatMode: costModel.vatMode,
      ratio: costModel.ratio,
      avgUnitCostNetto: costModel.avgUnitCostNetto,
      avgSellPrice: costModel.avgSellPrice,
      usable: costModel.usable,
      source: costModel.source,
      palletCostBrutto: num(costConfig && costConfig.palletCostBrutto),
      unitsPerPallet: num(costConfig && costConfig.unitsPerPallet),
      manualRatio: costConfig && costConfig.manualRatio != null ? num(costConfig.manualRatio) : null,
      feeRateEbay,
      feeRateKaufland,
    },
    balances: {
      accounts: Array.isArray(balances.accounts) ? balances.accounts : [],
      // round2 laeuft ueber num(); Number(null) waere 0 und wuerde das
      // "unbekannt" wieder in eine harte Null zurueckverwandeln.
      total: balances.total == null ? null : round2(balances.total),
    },
    shipping: shipping
      ? {
        brutto: shipping.brutto != null ? shipping.brutto : (shipping.netto != null ? round2(shipping.netto * 1.19) : null),
        netto: shipping.netto,
        parcelCount: shipping.parcelCount,
        dhl: shipping.dhl,
        dpd: shipping.dpd,
        other: shipping.other,
        source: shipping.source,
        // Getrennt ausgewiesen: Fracht ist die eigentliche Versandkostenzahl,
        // Plattform sind die SendCloud-Rechnungen, Vorauszahlung die Portokasse.
        fracht: shippingBank ? shippingBank.fracht : null,
        plattform: shippingBank ? shippingBank.plattform : null,
        vorauszahlung: shippingBank ? shippingBank.vorauszahlung : null,
        pending: shippingBank ? shippingBank.pending : false,
      }
      : null,
    timeseries: agg.buckets,
    quality: {
      cogsCoveragePct: coveragePct,
      matchedItemCount: agg.matchedItemCount,
      exactItemCount: agg.exactItemCount,
      estimatedItemCount: agg.estimatedItemCount,
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
