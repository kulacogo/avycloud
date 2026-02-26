
'use strict';

const path = require('path');
const fs = require('fs');
const { getSecretValue } = require('./secret-values');

const SENDCLOUD_BASE_URL = 'https://panel.sendcloud.sc/api/v2';

// ─── CSV Price Table ────────────────────────────────────────────────────────
// Load both carrier price tables at module startup for fast shipping cost
// estimation when the SendCloud API returns price=0 (not configured for API).

/** @type {Array<{method_id:number, min_weight:number, max_weight:number, price:number}>} */
let _priceTable = null;

function loadPriceTable() {
  if (_priceTable) return _priceTable;
  _priceTable = [];

  // Deduplicated candidate paths: try backend/data/ first (Docker), then repo root (local dev).
  const candidates = [
    path.join(__dirname, '..', 'data', 'sendcloud_upload_DHL.csv'),
    path.join(__dirname, '..', 'data', 'sendcloud_upload_DPD.csv'),
    path.join(__dirname, '..', '..', 'sendcloud_upload_DHL.csv'),
    path.join(__dirname, '..', '..', 'sendcloud_upload_DPD.csv'),
  ];
  // De-duplicate by resolved path so we don't double-count if both resolve the same file.
  const seen = new Set();
  const files = candidates.filter(f => {
    const resolved = path.resolve(f);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });

  for (const file of files) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      // Skip header line
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',');
        if (parts.length < 7) continue;
        const [methodIdStr, , , , minWStr, maxWStr, priceStr] = parts;
        const methodId = parseInt(methodIdStr.trim(), 10);
        const minWeight = parseFloat(minWStr.trim());
        const maxWeight = parseFloat(maxWStr.trim());
        const price = parseFloat(priceStr.trim());
        if (!isNaN(methodId) && !isNaN(price) && !isNaN(minWeight)) {
          _priceTable.push({ method_id: methodId, min_weight: minWeight, max_weight: maxWeight, price });
        }
      }
    } catch (err) {
      console.warn(`[sendcloud] Could not load price table ${file}:`, err.message);
    }
  }

  console.log(`[sendcloud] Loaded ${_priceTable.length} price table entries`);
  return _priceTable;
}

/**
 * Look up shipping cost from CSV price tables using method_id + weight.
 * Returns 0 if no match found.
 */
function lookupCsvPrice(methodId, weightKg) {
  const table = loadPriceTable();
  const mid = Number(methodId);
  const w = Number(weightKg) || 0;

  // Find exact method_id + weight range match
  for (const row of table) {
    if (row.method_id === mid && w >= row.min_weight && w < row.max_weight) {
      return row.price;
    }
  }

  // Fallback: any entry for this method_id with closest weight range
  const methodEntries = table.filter(r => r.method_id === mid).sort((a, b) => a.min_weight - b.min_weight);
  if (methodEntries.length) {
    // If weight exceeds all ranges, return last entry
    const last = methodEntries[methodEntries.length - 1];
    if (w >= last.max_weight) return last.price;
    // If weight is below all ranges, return first
    return methodEntries[0].price;
  }

  return 0;
}

// ─── Auth ───────────────────────────────────────────────────────────────────

const SHIPPING_CACHE = new Map();
const SHIPPING_TTL_MS = 15 * 60 * 1000;

let _cachedAuth = null;

async function getSendCloudAuthHeader() {
  if (_cachedAuth) return _cachedAuth;
  const [pub, sec] = await Promise.all([
    getSecretValue('SENDCLOUD_PUBLIC_KEY'),
    getSecretValue('SENDCLOUD_SECRET_KEY'),
  ]);
  if (!pub || !sec) throw new Error('SENDCLOUD credentials not configured');
  _cachedAuth = 'Basic ' + Buffer.from(`${pub}:${sec}`).toString('base64');
  return _cachedAuth;
}

// ─── Main function ──────────────────────────────────────────────────────────

/**
 * Returns total shipping costs for the given date range.
 * Uses parcel's own `price` field when available; falls back to CSV lookup
 * when the API returns price="0" (common when pricing is not API-visible).
 *
 * @param {string} fromDate - 'YYYY-MM-DD'
 * @param {string} toDate   - 'YYYY-MM-DD'
 */
async function getShippingCostsSummary(fromDate, toDate, { timeoutMs = 30000, forceRefresh = false } = {}) {
  const cacheKey = `${fromDate}:${toDate}`;
  const now = Date.now();
  const cached = SHIPPING_CACHE.get(cacheKey);
  if (!forceRefresh && cached && now - cached.atMs < SHIPPING_TTL_MS) {
    return cached.data;
  }

  // Warm up price table in background (fast, sync FS read)
  loadPriceTable();

  const authHeader = await getSendCloudAuthHeader();
  const deadline = Date.now() + timeoutMs;

  let totalCost = 0;
  let csvFallbackCount = 0;
  let parcelCount = 0;
  let page = 1;
  const limit = 100;

  // Client-side date boundaries for validation.
  // SendCloud's server-side date filter can return all-time data if the
  // API key has unrestricted access — we double-check each parcel's date.
  const fromMs = new Date(fromDate + 'T00:00:00Z').getTime();
  const toMs = new Date(toDate + 'T23:59:59Z').getTime();

  while (true) {
    if (Date.now() > deadline) break;

    const params = new URLSearchParams({
      from_date: fromDate,
      to_date: toDate,
      limit: String(limit),
      page: String(page),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(15000, deadline - Date.now()));

    let parcels = [];
    try {
      const response = await fetch(`${SENDCLOUD_BASE_URL}/parcels?${params}`, {
        headers: { Authorization: authHeader },
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`SendCloud API ${response.status}: ${body.slice(0, 200)}`);
      }

      const data = await response.json();
      parcels = Array.isArray(data?.parcels) ? data.parcels : [];
    } finally {
      clearTimeout(timer);
    }

    for (const parcel of parcels) {
      // Client-side date guard — skip parcels outside the requested window
      const createdRaw = parcel.date_created || parcel.created_at || null;
      if (createdRaw) {
        const createdMs = new Date(createdRaw).getTime();
        if (!isNaN(createdMs) && (createdMs < fromMs || createdMs > toMs)) {
          continue; // outside range — skip this parcel
        }
      }

      // Try the API-provided price first
      const apiPriceRaw =
        parcel.price ??
        parcel.shipment_cost?.price ??
        parcel.shipment_cost?.amount ??
        null;
      const apiPrice = apiPriceRaw !== null
        ? parseFloat(String(apiPriceRaw).replace(',', '.')) || 0
        : 0;

      let cost = apiPrice;

      // If API price is 0, fall back to CSV lookup
      if (cost === 0) {
        const methodId = parcel.shipment?.id ?? parcel.shipment_product?.id ?? 0;
        const weightKg = parseFloat(String(parcel.weight || '0').replace(',', '.')) || 0;
        if (methodId && weightKg > 0) {
          cost = lookupCsvPrice(methodId, weightKg);
          if (cost > 0) csvFallbackCount++;
        }
      }

      totalCost += cost;
      parcelCount++;
    }

    if (parcels.length < limit) break;
    if (parcelCount > 5000) {
      console.warn(`[sendcloud] Safety limit: ${parcelCount} parcels counted for ${fromDate}–${toDate}, stopping.`);
      break;
    }
    page++;
  }

  if (csvFallbackCount > 0) {
    console.log(`[sendcloud] ${csvFallbackCount}/${parcelCount} parcels priced via CSV table`);
  }

  const result = {
    total_cost: Math.round(totalCost * 100) / 100,
    parcel_count: parcelCount,
    currency: 'EUR',
    csv_fallback_count: csvFallbackCount,
  };

  SHIPPING_CACHE.set(cacheKey, { atMs: now, data: result });
  return result;
}

module.exports = { getShippingCostsSummary };
