
'use strict';

const { getSecretValue } = require('./secret-values');

const SEVDESK_BASE_URL = 'https://my.sevdesk.de/api/v1';

// In-memory cache: { atMs, data }
const BALANCE_CACHE = { atMs: 0, data: null };
const BALANCE_TTL_MS = 5 * 60 * 1000; // 5 min

let _cachedApiKey = null;

async function getSevDeskApiKey() {
  if (_cachedApiKey) return _cachedApiKey;
  _cachedApiKey = await getSecretValue('SEVDESK_API_TOKEN');
  return _cachedApiKey;
}

/**
 * Returns balances for relevant bank accounts (Sichteinlagen + Business Card).
 * Excludes "Basiskonto" and any account whose name doesn't match the filter.
 *
 * @returns {Promise<{ accounts: Array<{id:string,name:string,balance:number,currency:string}>, total: number }>}
 */
async function getCheckAccountBalances({ forceRefresh = false, timeoutMs = 15000 } = {}) {
  const now = Date.now();
  if (!forceRefresh && BALANCE_CACHE.data && now - BALANCE_CACHE.atMs < BALANCE_TTL_MS) {
    return BALANCE_CACHE.data;
  }

  const apiKey = await getSevDeskApiKey();
  if (!apiKey) {
    throw new Error('SEVDESK_API_TOKEN not configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let allAccounts = [];
  try {
    // SevDesk API v1: token goes in Authorization header (raw token, no Bearer prefix)
    const url = `${SEVDESK_BASE_URL}/CheckAccount?limit=100&embed=all`;
    const response = await fetch(url, {
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`SevDesk API returned ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    allAccounts = Array.isArray(data?.objects) ? data.objects : [];
  } finally {
    clearTimeout(timer);
  }

  // Filter: keep only "Sichteinlagen" and "BusinessCard" (with or without space); exclude "Basiskonto"
  const ALLOWED_KEYWORDS = ['sichteinlagen', 'businesscard', 'business card'];
  const EXCLUDE_KEYWORDS = ['basiskonto', 'stamm'];

  const relevant = allAccounts.filter((acc) => {
    const nameLower = (acc.name || '').toLowerCase();
    const isExcluded = EXCLUDE_KEYWORDS.some((kw) => nameLower.includes(kw));
    if (isExcluded) return false;
    return ALLOWED_KEYWORDS.some((kw) => nameLower.includes(kw));
  });

  const accounts = relevant.map((acc) => ({
    id: String(acc.id || ''),
    name: String(acc.name || ''),
    balance: Number(acc.balance ?? 0),
    currency: String(acc.currency || 'EUR').toUpperCase(),
  }));

  const total = accounts.reduce((s, a) => s + a.balance, 0);
  const result = { accounts, total };

  BALANCE_CACHE.atMs = now;
  BALANCE_CACHE.data = result;
  return result;
}

// ─── Shipping cost vouchers ──────────────────────────────────────────────────

const SHIPPING_VOUCHER_CACHE = new Map();
const SHIPPING_VOUCHER_TTL_MS = 15 * 60 * 1000;

// Supplier name fragments that indicate a shipping carrier invoice
const SHIPPING_SUPPLIER_KEYWORDS = ['dhl', 'dpd', 'sendcloud', 'deutsche post', 'gls'];

/**
 * Returns the total BRUTTO amount of shipping invoices (Eingangsrechnungen)
 * booked in SevDesk for the given date range.
 *
 * Matches vouchers whose contact name or description contains one of:
 * "dhl", "dpd", "sendcloud", "deutsche post", "gls".
 *
 * @param {string} fromDate - 'YYYY-MM-DD'
 * @param {string} toDate   - 'YYYY-MM-DD'
 * @returns {Promise<{total_cost: number, voucher_count: number, currency: string, source: string}>}
 */
async function getShippingCostsFromSevDesk(fromDate, toDate, { forceRefresh = false, timeoutMs = 15000 } = {}) {
  const cacheKey = `sv:${fromDate}:${toDate}`;
  const now = Date.now();
  const cached = SHIPPING_VOUCHER_CACHE.get(cacheKey);
  if (!forceRefresh && cached && now - cached.atMs < SHIPPING_VOUCHER_TTL_MS) {
    return cached.data;
  }

  const apiKey = await getSevDeskApiKey();
  if (!apiKey) throw new Error('SEVDESK_API_TOKEN not configured');

  const startTs = Math.floor(new Date(fromDate + 'T00:00:00Z').getTime() / 1000);
  const endTs   = Math.floor(new Date(toDate   + 'T23:59:59Z').getTime() / 1000);

  // Fetch incoming vouchers (Eingangsrechnungen) in date range.
  // status=1000 (Bezahlt) + 1200 (Teilbezahlt); voucherType=VOU = Eingangsbeleg
  const params = new URLSearchParams({
    startDate:   String(startTs),
    endDate:     String(endTs),
    voucherType: 'VOU',
    embed:       'contact',
    limit:       '500',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let vouchers = [];
  try {
    const response = await fetch(`${SEVDESK_BASE_URL}/Voucher?${params}`, {
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`SevDesk Voucher API ${response.status}: ${body.slice(0, 200)}`);
    }
    const data = await response.json();
    vouchers = Array.isArray(data?.objects) ? data.objects : [];
  } finally {
    clearTimeout(timer);
  }

  // Filter to shipping carrier invoices by contact name or description
  const isShipping = (v) => {
    const name = (v?.contact?.name || v?.supplierName || '').toLowerCase();
    const desc = (v?.description || '').toLowerCase();
    return SHIPPING_SUPPLIER_KEYWORDS.some(kw => name.includes(kw) || desc.includes(kw));
  };

  let totalCost = 0;
  let voucherCount = 0;
  const matched = [];

  for (const v of vouchers) {
    if (!isShipping(v)) continue;
    // sumGross is the brutto total of the voucher
    const gross = parseFloat(String(v?.sumGross ?? v?.sumTotal ?? 0).replace(',', '.')) || 0;
    totalCost += gross;
    voucherCount++;
    matched.push({ contact: v?.contact?.name || '?', gross, date: v?.voucherDate });
  }

  if (matched.length > 0) {
    console.log(`[sevdesk-shipping] ${fromDate}–${toDate}: ${voucherCount} Rechnungen, ${totalCost.toFixed(2)}€ brutto`);
    matched.forEach(m => console.log(`  ${m.date}: ${m.contact} → ${m.gross.toFixed(2)}€`));
  } else {
    console.log(`[sevdesk-shipping] ${fromDate}–${toDate}: keine Versandlieferanten-Rechnungen gefunden (${vouchers.length} Belege total)`);
  }

  const result = {
    total_cost: Math.round(totalCost * 100) / 100,
    voucher_count: voucherCount,
    currency: 'EUR',
    source: 'sevdesk',
  };

  SHIPPING_VOUCHER_CACHE.set(cacheKey, { atMs: now, data: result });
  return result;
}

module.exports = { getCheckAccountBalances, getShippingCostsFromSevDesk };
