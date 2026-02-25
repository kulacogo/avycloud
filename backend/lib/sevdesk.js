
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

  // Filter: keep only "Sichteinlagen" and "Business Card"; exclude "Basiskonto"
  const ALLOWED_KEYWORDS = ['sichteinlagen', 'business card'];
  const EXCLUDE_KEYWORDS = ['basiskonto'];

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

module.exports = { getCheckAccountBalances };
