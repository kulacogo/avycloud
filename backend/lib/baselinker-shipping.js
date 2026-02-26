'use strict';

const { callBaseLinker } = require('./baselinker');

// ─── Preistabellen (Stand: Januar 2026, Quelle: Versandkosten_Gegenueberstellung) ─
// Alle Basispreise NETTO — werden mit VAT multipliziert → Brutto
const VAT = 1.19;

// DHL Paket — Angebotsblatt LW 2000 (01/2026)
// [minKg (inkl.), maxKg (exkl.), preisNetto]
const DHL_PRICES = [
  [0,    1,    4.35],
  [1,    3,    4.90],
  [3,    5,    5.95],
  [5,    10,   8.00],
  [10,   20,   12.90],
  [20,   31.5, 15.65],
];

// DPD Classic — Preisliste G320
const DPD_PRICES = [
  [0,    3,    3.20],
  [3,    5,    3.60],
  [5,    10,   4.10],
  [10,   15,   4.60],
  [15,   20,   4.80],
  [20,   25,   5.00],
  [25,   31.5, 5.30],
];

// Reguläre Zuschläge pro Paket (netto)
// DHL: Maut/CO2 0,19 € + GoGreen Plus 0,15 € + Energiezuschlag 1,25% auf Basispreis
// DPD: Maut/CO2 0,35 € + Sicherheitsgebühr 0,15 €
const DHL_EXTRA_NETTO  = { maut: 0.19, gogreen: 0.15, energyPct: 0.0125 };
const DPD_EXTRA_NETTO  = { maut: 0.35, sicherheit: 0.15 };

// Monatspauschalen (netto)
const DHL_MONTHLY_FEE_NETTO = 69.95;   // Stufe 4
const DPD_MONTHLY_FEE_NETTO = 7.50;    // nur wenn < 100 Pakete/Monat; 0 ab 100

// ─── Carrier detection ────────────────────────────────────────────────────────

function detectCarrier(packageModule, deliveryMethod) {
  const mod  = String(packageModule  || '').toLowerCase();
  const meth = String(deliveryMethod || '').toLowerCase();
  if (mod.includes('dhl') || meth.includes('dhl')) return 'dhl';
  if (mod.includes('dpd') || meth.includes('dpd')) return 'dpd';
  return null;
}

function lookupBaseNetto(table, weightKg) {
  const w = Number(weightKg) || 0;
  for (const [min, max, price] of table) {
    if (w >= min && w < max) return price;
  }
  return table[table.length - 1][2]; // Schwerste Klasse für Überschreitung
}

/**
 * Brutto-Kosten pro DHL-Label inkl. Zuschläge (ohne Monatspauschale).
 */
function dhlLabelBrutto(weightKg) {
  const base   = lookupBaseNetto(DHL_PRICES, weightKg);
  const energy = base * DHL_EXTRA_NETTO.energyPct;
  const netto  = base + energy + DHL_EXTRA_NETTO.maut + DHL_EXTRA_NETTO.gogreen;
  return netto * VAT;
}

/**
 * Brutto-Kosten pro DPD-Label inkl. Zuschläge (ohne Monatspauschale).
 */
function dpdLabelBrutto(weightKg) {
  const base  = lookupBaseNetto(DPD_PRICES, weightKg);
  const netto = base + DPD_EXTRA_NETTO.maut + DPD_EXTRA_NETTO.sicherheit;
  return netto * VAT;
}

/**
 * Anzahl der Kalendermonates im Zeitraum [fromDate, toDate] (beide inklusive).
 */
function countCalendarMonths(fromDate, toDate) {
  const months = new Set();
  const d = new Date(fromDate + 'T00:00:00Z');
  const end = new Date(toDate + 'T00:00:00Z');
  while (d <= end) {
    months.add(`${d.getUTCFullYear()}-${d.getUTCMonth()}`);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return months.size;
}

// ─── Sum order weight from products ──────────────────────────────────────────

function computeOrderWeightKg(products) {
  if (!Array.isArray(products)) return 0;
  return products.reduce((sum, p) => {
    const w = parseFloat(String(p?.weight || '0').replace(',', '.')) || 0;
    const q = Number(p?.quantity || 1) || 1;
    return sum + w * q;
  }, 0);
}

// ─── Cache ───────────────────────────────────────────────────────────────────

const BL_SHIPPING_CACHE = new Map();
const BL_SHIPPING_TTL_MS = 15 * 60 * 1000;

// ─── Main function ──────────────────────────────────────────────────────────

/**
 * Fetches BaseLinker orders for the given date range and calculates BRUTTO
 * shipping costs based on the negotiated carrier prices (Jan 2026).
 *
 * Pricing: base netto price + per-label surcharges (Maut, GoGreen/Sicherheit,
 * DHL Energiezuschlag) × 1.19 MwSt, plus the carrier monthly flat fee
 * (69.95 € DHL / 7.50 € DPD) × number of calendar months.
 *
 * Only orders with a shipping label (delivery_package_nr set) are counted.
 * Carrier detected from delivery_package_module ("dhlde_v2", "dpd", …).
 * Weight summed from products[].weight × quantity.
 *
 * @param {string} fromDate - 'YYYY-MM-DD'
 * @param {string} toDate   - 'YYYY-MM-DD'
 */
async function getShippingCostsSummaryFromBaseLinker(fromDate, toDate, { timeoutMs = 30000, forceRefresh = false } = {}) {
  const cacheKey = `bl:${fromDate}:${toDate}`;
  const now = Date.now();
  const cached = BL_SHIPPING_CACHE.get(cacheKey);
  if (!forceRefresh && cached && now - cached.atMs < BL_SHIPPING_TTL_MS) {
    return cached.data;
  }

  const fromUnix = Math.floor(new Date(fromDate + 'T00:00:00Z').getTime() / 1000);
  const toUnix   = Math.floor(new Date(toDate   + 'T23:59:59Z').getTime() / 1000);
  const deadline = Date.now() + timeoutMs;

  let perLabelCost = 0;
  let labelCount   = 0;
  let noLabelCount = 0;
  let unknownCarrierCount = 0;
  let dhlMonths = new Set(); // calendar months with ≥1 DHL label
  let dpdMonths = new Set(); // calendar months with ≥1 DPD label
  // DPD <100/month → track per-month DPD counts for flat fee threshold
  const dpdCountPerMonth = new Map();
  let cursor = fromUnix;

  for (let page = 0; page < 200; page++) {
    if (Date.now() > deadline) {
      console.warn(`[bl-shipping] timeout after ${page} pages for ${fromDate}–${toDate}`);
      break;
    }

    let batch = [];
    try {
      const response = await callBaseLinker(
        'getOrders',
        {
          date_confirmed_from: cursor,
          get_unconfirmed_orders: false,
          include_custom_extra_fields: false,
          include_connect_data: false,
          include_commission_data: false,
        },
        { timeoutMs: Math.min(15000, deadline - Date.now()), retries: 2 }
      );
      batch = Array.isArray(response?.orders) ? response.orders : [];
    } catch (err) {
      console.error(`[bl-shipping] getOrders failed on page ${page}:`, err.message);
      break;
    }

    if (!batch.length) break;

    let lastConfirmed = 0;

    for (const o of batch) {
      const confirmedUnix = Number(o?.date_confirmed || 0) || 0;
      if (confirmedUnix > lastConfirmed) lastConfirmed = confirmedUnix;

      if (!confirmedUnix || confirmedUnix < fromUnix || confirmedUnix > toUnix) continue;

      // Skip returns and cancelled orders
      const orderSource = (o?.order_source || '').toString().trim().toLowerCase();
      if (orderSource === 'order_return') continue;
      const statusName = (o?.status_name || o?.order_status_name || '').toString().toLowerCase();
      if (statusName.includes('storniert') || statusName.includes('cancel')) continue;

      // Only count orders that have an actual shipping label
      const trackingNr = String(o?.delivery_package_nr || '').trim();
      if (!trackingNr || trackingNr === '0') {
        noLabelCount++;
        continue;
      }

      labelCount++;

      const weight  = computeOrderWeightKg(o?.products);
      const carrier = detectCarrier(o?.delivery_package_module, o?.delivery_method);

      if (!carrier || weight <= 0) {
        unknownCarrierCount++;
        continue;
      }

      // Per-label brutto cost
      if (carrier === 'dhl') {
        perLabelCost += dhlLabelBrutto(weight);
        const monthKey = new Date(confirmedUnix * 1000).toISOString().slice(0, 7);
        dhlMonths.add(monthKey);
      } else {
        perLabelCost += dpdLabelBrutto(weight);
        const monthKey = new Date(confirmedUnix * 1000).toISOString().slice(0, 7);
        dpdMonths.add(monthKey);
        dpdCountPerMonth.set(monthKey, (dpdCountPerMonth.get(monthKey) || 0) + 1);
      }
    }

    if (!lastConfirmed || lastConfirmed > toUnix) break;
    if (batch.length < 100) break;
    cursor = lastConfirmed + 1;
  }

  // Monthly flat fees (brutto)
  const dhlFlatFees = dhlMonths.size * DHL_MONTHLY_FEE_NETTO * VAT;
  let dpdFlatFees = 0;
  for (const [month, count] of dpdCountPerMonth.entries()) {
    if (count < 100) dpdFlatFees += DPD_MONTHLY_FEE_NETTO * VAT;
    // ≥ 100 DPD labels/month → flat fee waived
  }

  const totalCost = perLabelCost + dhlFlatFees + dpdFlatFees;

  console.log(
    `[bl-shipping] ${fromDate}–${toDate}: labels=${labelCount}, noLabel=${noLabelCount}, unknownCarrier=${unknownCarrierCount}, ` +
    `perLabel=${perLabelCost.toFixed(2)}€ + dhlFlat=${dhlFlatFees.toFixed(2)}€ + dpdFlat=${dpdFlatFees.toFixed(2)}€ = total=${totalCost.toFixed(2)}€ (brutto)`
  );

  const result = {
    total_cost: Math.round(totalCost * 100) / 100,
    parcel_count: labelCount,
    currency: 'EUR',
    source: 'baselinker',
  };

  BL_SHIPPING_CACHE.set(cacheKey, { atMs: now, data: result });
  return result;
}

module.exports = { getShippingCostsSummaryFromBaseLinker };
