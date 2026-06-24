
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

  // Fetch bank account transactions (Kontoauszug-Buchungen) — this matches what the user
  // sees in SevDesk under "Bezahldatum". The /Voucher endpoint (Eingangsrechnungen) uses
  // voucher dates which can differ from actual payment dates and may be incomplete.
  const params = new URLSearchParams({
    startDate: String(startTs),
    endDate:   String(endTs),
    limit:     '500',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let transactions = [];
  try {
    const response = await fetch(`${SEVDESK_BASE_URL}/CheckAccountTransaction?${params}`, {
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`SevDesk CheckAccountTransaction API ${response.status}: ${body.slice(0, 200)}`);
    }
    const data = await response.json();
    transactions = Array.isArray(data?.objects) ? data.objects : [];
  } finally {
    clearTimeout(timer);
  }

  // Filter to outgoing shipping carrier payments.
  // Correct SevDesk field: "payeePayerName" (= "Name" column in Kontoauszug view).
  // Only negative amounts (Ausgaben) are counted — positive = incoming/refunds.
  // Categorise: "sendcloud" vs "direct" (DHL/DPD/GLS paid without SendCloud)
  const categorizeShipping = (t) => {
    const payee = (t?.payeePayerName || '').toLowerCase();
    // Only check payeePayerName (sender/recipient), NOT paymtPurpose (description)
    // to avoid false matches from customer notes mentioning "sendcloud"
    if (payee.includes('sendcloud')) return 'sendcloud';
    if (SHIPPING_SUPPLIER_KEYWORDS.some(kw => payee.includes(kw))) return 'direct';
    return null;
  };

  let totalCost = 0;
  let directCost = 0;   // DHL/DPD direct (pre-SendCloud era), brutto
  let sendcloudCost = 0; // SendCloud payments, brutto
  let txCount = 0;
  const matched = [];

  for (const t of transactions) {
    const raw = parseFloat(String(t?.amount || '0').replace(',', '.')) || 0;
    if (raw >= 0) continue; // skip incoming payments and zero entries
    const category = categorizeShipping(t);
    if (!category) continue;
    const amount = Math.abs(raw);
    totalCost += amount;
    if (category === 'sendcloud') sendcloudCost += amount;
    else directCost += amount;
    txCount++;
    matched.push({ payee: t?.payeePayerName || '?', amount, date: t?.valueDate || '', category });
  }

  if (matched.length > 0) {
    console.log(`[sevdesk-shipping] ${fromDate}–${toDate}: ${txCount} Zahlungen, ${totalCost.toFixed(2)}€ (direct: ${directCost.toFixed(2)}€, sendcloud: ${sendcloudCost.toFixed(2)}€)`);
    matched.forEach(m => console.log(`  ${m.date}: [${m.category}] ${m.payee} → ${m.amount.toFixed(2)}€`));
  } else {
    console.log(`[sevdesk-shipping] ${fromDate}–${toDate}: keine Versandlieferanten-Buchungen (${transactions.length} Buchungen total)`);
  }

  const result = {
    total_cost: Math.round(totalCost * 100) / 100,
    direct_shipping_cost: Math.round(directCost * 100) / 100,   // brutto, DHL/DPD direct
    sendcloud_cost: Math.round(sendcloudCost * 100) / 100,      // brutto, via SendCloud
    voucher_count: txCount,
    currency: 'EUR',
    source: 'sevdesk',
  };

  SHIPPING_VOUCHER_CACHE.set(cacheKey, { atMs: now, data: result });
  return result;
}

// Payer-name fragments identifying actual marketplace payouts on the bank statement.
// Source: real SevDesk Kontoauszug (cflox GmbH = Kaufland payout; eBay S.a.r.l.,
// Boulevard Royal = eBay payout). Add more fragments here if a payer name changes.
const MARKETPLACE_PAYOUT_PAYERS = {
  kaufland: ['cflox'],
  ebay: ['ebay', 'boulevard royal'],
};
const PAYOUT_CACHE = new Map();
const PAYOUT_TTL_MS = 15 * 60 * 1000;

/**
 * Real marketplace payouts (incoming bank credits) booked in SevDesk for the range.
 * This is the EXACT money eBay/Kaufland transferred (net of all marketplace fees) —
 * no estimation. Filtered by payer name + positive amount (credits only).
 *
 * NOTE: amounts are by bank settlement date, which lags order date (eBay/Kaufland pay
 * out on a cycle). Over a month/year this reflects "cash actually received".
 *
 * @returns {Promise<{ebay:number, kaufland:number, total:number, tx_count:number, currency:string, source:string}>}
 */
async function getMarketplacePayoutsFromSevDesk(fromDate, toDate, { forceRefresh = false, timeoutMs = 15000 } = {}) {
  const cacheKey = `payout:${fromDate}:${toDate}`;
  const now = Date.now();
  const cached = PAYOUT_CACHE.get(cacheKey);
  if (!forceRefresh && cached && now - cached.atMs < PAYOUT_TTL_MS) return cached.data;

  const apiKey = await getSevDeskApiKey();
  if (!apiKey) throw new Error('SEVDESK_API_TOKEN not configured');

  const startTs = Math.floor(new Date(fromDate + 'T00:00:00Z').getTime() / 1000);
  const endTs = Math.floor(new Date(toDate + 'T23:59:59Z').getTime() / 1000);
  const params = new URLSearchParams({ startDate: String(startTs), endDate: String(endTs), limit: '500' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let transactions = [];
  try {
    const response = await fetch(`${SEVDESK_BASE_URL}/CheckAccountTransaction?${params}`, {
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`SevDesk CheckAccountTransaction API ${response.status}: ${body.slice(0, 200)}`);
    }
    const data = await response.json();
    transactions = Array.isArray(data?.objects) ? data.objects : [];
  } finally {
    clearTimeout(timer);
  }

  const classify = (payee) => {
    const p = (payee || '').toLowerCase();
    if (MARKETPLACE_PAYOUT_PAYERS.kaufland.some((kw) => p.includes(kw))) return 'kaufland';
    if (MARKETPLACE_PAYOUT_PAYERS.ebay.some((kw) => p.includes(kw))) return 'ebay';
    return null;
  };

  let ebay = 0;
  let kaufland = 0;
  let txCount = 0;
  const matched = [];
  for (const t of transactions) {
    const raw = parseFloat(String(t?.amount || '0').replace(',', '.')) || 0;
    if (raw <= 0) continue; // payouts are incoming credits
    const mk = classify(t?.payeePayerName);
    if (!mk) continue;
    if (mk === 'kaufland') kaufland += raw; else ebay += raw;
    txCount++;
    matched.push({ payee: t?.payeePayerName || '?', amount: raw, date: t?.valueDate || '', mk });
  }

  if (matched.length > 0) {
    console.log(`[sevdesk-payout] ${fromDate}–${toDate}: ${txCount} Gutschriften, eBay ${ebay.toFixed(2)}€ + Kaufland ${kaufland.toFixed(2)}€`);
  } else {
    console.log(`[sevdesk-payout] ${fromDate}–${toDate}: keine Marktplatz-Auszahlungen (${transactions.length} Buchungen total)`);
  }

  const result = {
    ebay: Math.round(ebay * 100) / 100,
    kaufland: Math.round(kaufland * 100) / 100,
    total: Math.round((ebay + kaufland) * 100) / 100,
    tx_count: txCount,
    currency: 'EUR',
    source: 'sevdesk',
  };
  PAYOUT_CACHE.set(cacheKey, { atMs: now, data: result });
  return result;
}

// ─── Settings API ──────────────────────────────────────────────────────────

/**
 * Fetch all tax rates from SevDesk.
 * @returns {Promise<Array<{ id: string, taxRate: number, name: string }>>}
 */
async function listTaxRates({ timeoutMs = 15000 } = {}) {
  const apiKey = await getSevDeskApiKey();
  if (!apiKey) throw new Error('SEVDESK_API_TOKEN not configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${SEVDESK_BASE_URL}/TaxSet?limit=100`, {
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`SevDesk API returned ${response.status}: ${body.slice(0, 200)}`);
    }
    const data = await response.json();
    const items = Array.isArray(data?.objects) ? data.objects : [];
    return items.map((ts) => ({
      id: String(ts.id),
      taxRate: Number(ts.taxRate) || 0,
      name: ts.text || `${ts.taxRate}%`,
    }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch all check accounts (bank accounts) from SevDesk — full list without filtering.
 * @returns {Promise<Array<{ id: string, name: string, iban: string, currency: string }>>}
 */
async function listCheckAccounts({ timeoutMs = 15000 } = {}) {
  const apiKey = await getSevDeskApiKey();
  if (!apiKey) throw new Error('SEVDESK_API_TOKEN not configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${SEVDESK_BASE_URL}/CheckAccount?limit=100`, {
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`SevDesk API returned ${response.status}: ${body.slice(0, 200)}`);
    }
    const data = await response.json();
    const items = Array.isArray(data?.objects) ? data.objects : [];
    return items.map((acc) => ({
      id: String(acc.id),
      name: acc.name || '',
      iban: acc.iban || '',
      currency: acc.currency || 'EUR',
    }));
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { getCheckAccountBalances, getShippingCostsFromSevDesk, getMarketplacePayoutsFromSevDesk, listTaxRates, listCheckAccounts };
