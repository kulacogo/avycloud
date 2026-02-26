'use strict';

const { callBaseLinker } = require('./baselinker');
const { loadPriceTable, lookupCsvPrice } = require('./sendcloud');

// ─── Carrier detection ────────────────────────────────────────────────────────

// Map carrier keyword → method_id that covers the full weight range (0–31.5kg)
// DHL Paket (89): 0.01–31.5kg
// DPD Classic 0-31.5kg Incoterm DDP (26561): 0.001–31.5kg
const CARRIER_METHOD_ID = {
  dhl: 89,
  dpd: 26561,
};

function detectCarrier(deliveryMethod) {
  const m = String(deliveryMethod || '').toLowerCase();
  if (m.includes('dhl')) return 'dhl';
  if (m.includes('dpd')) return 'dpd';
  return null;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

const BL_SHIPPING_CACHE = new Map();
const BL_SHIPPING_TTL_MS = 15 * 60 * 1000;

// ─── Main function ──────────────────────────────────────────────────────────

/**
 * Fetches BaseLinker orders for the given date range and estimates shipping
 * costs using the carrier CSV price tables.
 *
 * Counts all non-cancelled, non-return orders that were confirmed in the
 * range; for each one it detects the carrier from delivery_method and looks
 * up the cost by weight from the CSV.
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

  // Warm up price table (fast, sync FS read, cached after first call)
  loadPriceTable();

  const fromUnix = Math.floor(new Date(fromDate + 'T00:00:00Z').getTime() / 1000);
  const toUnix = Math.floor(new Date(toDate + 'T23:59:59Z').getTime() / 1000);
  const deadline = Date.now() + timeoutMs;

  let totalCost = 0;
  let labelCount = 0;
  let unknownCarrierCount = 0;
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

      // Skip orders outside the requested window
      if (!confirmedUnix || confirmedUnix < fromUnix || confirmedUnix > toUnix) continue;

      // Skip return orders
      const orderSource = (o?.order_source || '').toString().trim().toLowerCase();
      if (orderSource === 'order_return') continue;

      // Skip cancelled orders (by status name if available)
      const statusName = (o?.status_name || o?.order_status_name || '').toString().toLowerCase();
      if (statusName.includes('storniert') || statusName.includes('cancel')) continue;

      labelCount++;

      const weight = parseFloat(String(o?.weight || '0').replace(',', '.')) || 0;
      const carrier = detectCarrier(o?.delivery_method);

      if (!carrier || weight <= 0) {
        unknownCarrierCount++;
        // No price can be looked up without carrier+weight; cost stays at 0 for this order
        continue;
      }

      const methodId = CARRIER_METHOD_ID[carrier];
      const price = lookupCsvPrice(methodId, weight);
      totalCost += price;
    }

    // Stop if we've seen orders past the end of the requested range
    if (!lastConfirmed || lastConfirmed > toUnix) break;
    if (batch.length < 100) break; // last page

    cursor = lastConfirmed + 1;
  }

  console.log(`[bl-shipping] ${fromDate}–${toDate}: ${labelCount} labels, unknownCarrier=${unknownCarrierCount}, total=${totalCost.toFixed(2)}€`);

  const result = {
    total_cost: Math.round(totalCost * 100) / 100,
    parcel_count: labelCount,
    currency: 'EUR',
    source: 'baselinker',
    unknown_carrier_count: unknownCarrierCount,
  };

  BL_SHIPPING_CACHE.set(cacheKey, { atMs: now, data: result });
  return result;
}

module.exports = { getShippingCostsSummaryFromBaseLinker };
