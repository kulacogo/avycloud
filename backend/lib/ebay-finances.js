'use strict';

/**
 * eBay Finances API integration.
 *
 * Fetches net revenue data from the eBay Sell Finances API:
 *   GET https://apiz.ebay.com/sell/finances/v1/transaction
 *
 * Requires scope: https://api.ebay.com/oauth/api_scope/sell.finances
 * If the scope is not authorized, calls return 403 and the module returns null
 * so the caller can fall back to estimated gross revenue.
 *
 * Reference: https://developer.ebay.com/api-docs/sell/finances/resources/transaction/methods/getTransactions
 */

const { getValidEbayAccessToken } = require('./ebay-oauth');

// eBay Finances API uses a different subdomain than the rest of the eBay API
const FINANCES_BASE_URL = 'https://apiz.ebay.com';

// Cache: { cacheKey → { atMs, data } }
const FINANCES_CACHE = new Map();
const FINANCES_TTL_MS = 15 * 60 * 1000; // 15 min

async function financesFetch(path, query = {}, { timeoutMs = 20000 } = {}) {
  const { accessToken } = await getValidEbayAccessToken();
  const url = new URL(path, FINANCES_BASE_URL);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && String(v).trim()) {
      url.searchParams.set(k, String(v));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_DE',
      },
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns net eBay revenue for the given date range.
 *
 * "Net" means after all eBay marketplace fees (Verkaufsprovision, Angebotsgebühren,
 * Werbegebühren, etc.) — as reported in the "Betrag abzügl. Kosten" column of the
 * eBay transaction export. This is what actually lands in the eBay payment account.
 *
 * Only SALE transactions with bookingEntry=CREDIT are summed (i.e. actual order revenue).
 * REFUND, DISPUTE, and fee transactions are excluded — they appear as separate deductions
 * in the eBay payment account but are not counted in this revenue figure (gross order
 * revenue before refunds/disputes).
 *
 * Returns null if the sell.finances scope is not authorized (caller should fall back).
 *
 * @param {string} fromDate - 'YYYY-MM-DD'
 * @param {string} toDate   - 'YYYY-MM-DD'
 * @returns {Promise<{net_revenue: number, order_count: number, currency: string, source: string} | null>}
 */
async function getEbayNetRevenueSummary(fromDate, toDate, { forceRefresh = false, timeoutMs = 30000 } = {}) {
  const cacheKey = `ebfin:${fromDate}:${toDate}`;
  const now = Date.now();
  const cached = FINANCES_CACHE.get(cacheKey);
  if (!forceRefresh && cached && now - cached.atMs < FINANCES_TTL_MS) {
    return cached.data;
  }

  // ISO date range filter for eBay Finances API
  const fromIso = `${fromDate}T00:00:00.000Z`;
  const toIso   = `${toDate}T23:59:59.999Z`;
  const filter  = `transactionDate:[${fromIso}..${toIso}],transactionType:{SALE},bookingEntry:{CREDIT}`;

  let netRevenue = 0;
  let orderCount = 0;
  let currency = 'EUR';
  let offset = 0;
  const limit = 200;
  const deadline = Date.now() + timeoutMs;

  for (let page = 0; page < 50; page++) {
    if (Date.now() > deadline) {
      console.warn(`[ebay-finances] timeout after ${page} pages for ${fromDate}–${toDate}`);
      break;
    }

    let res;
    try {
      res = await financesFetch(
        '/sell/finances/v1/transaction',
        { filter, limit: String(limit), offset: String(offset) },
        { timeoutMs: Math.min(15000, deadline - Date.now()) }
      );
    } catch (err) {
      console.error(`[ebay-finances] fetch error on page ${page}:`, err.message);
      return null;
    }

    if (res.status === 403 || res.status === 401) {
      // Scope not authorized — caller should fall back to estimated revenue
      console.log(`[ebay-finances] ${res.status} – sell.finances scope not authorized, using fallback`);
      return null;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[ebay-finances] API ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    let data;
    try {
      data = await res.json();
    } catch {
      console.error('[ebay-finances] invalid JSON response');
      return null;
    }

    const transactions = Array.isArray(data?.transactions) ? data.transactions : [];
    if (!transactions.length) break;

    for (const tx of transactions) {
      const amount = parseFloat(tx?.amount?.value || '0') || 0;
      const cur = (tx?.amount?.currency || 'EUR').toString().toUpperCase();
      if (cur === 'EUR') {
        netRevenue += amount;
        orderCount++;
        currency = cur;
      }
    }

    const total = Number(data?.total || 0);
    offset += transactions.length;
    if (offset >= total || transactions.length < limit) break;
  }

  const result = {
    net_revenue: Math.round(netRevenue * 100) / 100,
    order_count: orderCount,
    currency,
    source: 'ebay_finances',
  };

  console.log(
    `[ebay-finances] ${fromDate}–${toDate}: ${orderCount} SALE transactions, net=${netRevenue.toFixed(2)}€`
  );

  FINANCES_CACHE.set(cacheKey, { atMs: now, data: result });
  return result;
}

/**
 * Returns net eBay revenue broken down by day for time-series charts.
 * Each entry: { date: 'YYYY-MM-DD', net_revenue: number, order_count: number }
 *
 * Returns null if the sell.finances scope is not authorized.
 *
 * @param {string} fromDate - 'YYYY-MM-DD'
 * @param {string} toDate   - 'YYYY-MM-DD'
 */
async function getEbayNetRevenueSeries(fromDate, toDate, { forceRefresh = false, timeoutMs = 30000 } = {}) {
  const cacheKey = `ebfin-series:${fromDate}:${toDate}`;
  const now = Date.now();
  const cached = FINANCES_CACHE.get(cacheKey);
  if (!forceRefresh && cached && now - cached.atMs < FINANCES_TTL_MS) {
    return cached.data;
  }

  const fromIso = `${fromDate}T00:00:00.000Z`;
  const toIso   = `${toDate}T23:59:59.999Z`;
  const filter  = `transactionDate:[${fromIso}..${toIso}],transactionType:{SALE},bookingEntry:{CREDIT}`;

  const byDay = new Map(); // 'YYYY-MM-DD' → { net_revenue, order_count }
  let offset = 0;
  const limit = 200;
  const deadline = Date.now() + timeoutMs;

  for (let page = 0; page < 50; page++) {
    if (Date.now() > deadline) break;

    let res;
    try {
      res = await financesFetch(
        '/sell/finances/v1/transaction',
        { filter, limit: String(limit), offset: String(offset) },
        { timeoutMs: Math.min(15000, deadline - Date.now()) }
      );
    } catch {
      return null;
    }

    if (res.status === 403 || res.status === 401) return null;
    if (!res.ok) return null;

    let data;
    try { data = await res.json(); } catch { return null; }

    const transactions = Array.isArray(data?.transactions) ? data.transactions : [];
    if (!transactions.length) break;

    for (const tx of transactions) {
      const amount = parseFloat(tx?.amount?.value || '0') || 0;
      const cur = (tx?.amount?.currency || 'EUR').toString().toUpperCase();
      if (cur !== 'EUR') continue;
      const dateStr = (tx?.transactionDate || '').slice(0, 10);
      if (!dateStr) continue;
      const entry = byDay.get(dateStr) || { net_revenue: 0, order_count: 0 };
      entry.net_revenue += amount;
      entry.order_count++;
      byDay.set(dateStr, entry);
    }

    const total = Number(data?.total || 0);
    offset += transactions.length;
    if (offset >= total || transactions.length < limit) break;
  }

  const series = Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({
      date,
      net_revenue: Math.round(v.net_revenue * 100) / 100,
      order_count: v.order_count,
    }));

  FINANCES_CACHE.set(cacheKey, { atMs: now, data: series });
  return series;
}

module.exports = { getEbayNetRevenueSummary, getEbayNetRevenueSeries };
