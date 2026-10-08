// globals: true in vitest.config.js — describe/it/expect/vi are global
'use strict';

/**
 * Tagesbudget-Haken in callTradingApi (2026-10-08): jeder Trading-Aufruf traegt
 * eine Prioritaet; der instanzuebergreifende Budget-Store entscheidet VOR dem
 * Aufruf, ob diese Prioritaet das Restkontingent noch benutzen darf. Abgelehnte
 * Aufrufe werfen wie ein Breaker-Skip (Marker "exceeded usage limit"), damit
 * JEDER bestehende Aufrufer sie als Quota-Klasse behandelt: verschieben, nie
 * destruktiv (Regel 14), nie als harter Fehler.
 */

const decisions = [];
const decideCalls = [];
const records = [];
let decideImpl = async (args) => { decideCalls.push(args); return decisions.shift() || { allow: true, reason: 'ok', priority: args.priority }; };
let budgetState = null; // null = unbekannt

require.cache[require.resolve('../lib/ebay-trading-budget')] = {
  id: require.resolve('../lib/ebay-trading-budget'),
  filename: require.resolve('../lib/ebay-trading-budget'),
  loaded: true,
  exports: {
    getEbayTradingBudget: () => ({
      decide: (args) => decideImpl(args),
      record: (args) => { records.push(args); },
      getState: async () => { if (budgetState instanceof Error) throw budgetState; return budgetState; },
    }),
    normalizePriority: (p) => { const s = String(p || '').toUpperCase(); return s === 'P0' || s === 'P2' ? s : 'P1'; },
  },
  children: [],
  paths: [],
};
// Geteilter Breaker steuerbar (Produktion: EBAY_QUOTA_BREAKER_SHARED=true).
let sharedBreakerState = { open: false, remainingMs: 0 };
const sharedCloseCalls = [];
require.cache[require.resolve('../lib/ebay-quota-breaker')] = {
  id: require.resolve('../lib/ebay-quota-breaker'),
  filename: require.resolve('../lib/ebay-quota-breaker'),
  loaded: true,
  exports: {
    openEbayQuotaBreaker: async () => {},
    closeEbayQuotaBreaker: async () => { sharedCloseCalls.push(1); },
    getEbayQuotaBreakerState: async () => sharedBreakerState,
  },
  children: [],
  paths: [],
};
require.cache[require.resolve('../lib/ebay-oauth')] = {
  id: require.resolve('../lib/ebay-oauth'),
  filename: require.resolve('../lib/ebay-oauth'),
  loaded: true,
  exports: { getValidEbayAccessToken: async () => ({ accessToken: 'oauth-token' }) },
  children: [],
  paths: [],
};

process.env.EBAY_TRADING_APP_ID = 'app';
process.env.EBAY_TRADING_DEV_ID = 'dev';
process.env.EBAY_TRADING_CERT_ID = 'cert';
process.env.EBAY_TRADING_USER_TOKEN = 'user';
process.env.EBAY_TRADING_ENV = 'production';
delete process.env.EBAY_QUOTA_BREAKER_SHARED;

// Der Fetch-Stub MUSS vor dem require stehen: lib/ebay-trading-api.js bindet
// `global.fetch` beim Laden (`const fetchImpl = global.fetch || …`). Ein spaeter
// gesetzter Stub wuerde ignoriert — und die Tests riefen die ECHTE eBay-API.
const fetchCalls = [];
let fetchImpl = async (url, init) => {
  fetchCalls.push({ url, init });
  const callName = init.headers['X-EBAY-API-CALL-NAME'];
  return {
    ok: true,
    status: 200,
    text: async () => `<?xml version="1.0" encoding="UTF-8"?><${callName}Response xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><Timestamp>2026-10-08T07:00:00.000Z</Timestamp></${callName}Response>`,
  };
};
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => fetchImpl(...args);

const ebay = require('../lib/ebay-trading-api');

afterAll(() => { globalThis.fetch = realFetch; });

beforeEach(() => {
  decisions.length = 0;
  decideCalls.length = 0;
  records.length = 0;
  fetchCalls.length = 0;
  budgetState = null;
  delete process.env.EBAY_QUOTA_BREAKER_UNTIL_RESET;
  ebay.closeEbayQuotaBreaker();
  decideImpl = async (args) => { decideCalls.push(args); return decisions.shift() || { allow: true, reason: 'ok', priority: args.priority }; };
  fetchImpl = async (url, init) => {
    fetchCalls.push({ url, init });
    const callName = init.headers['X-EBAY-API-CALL-NAME'];
    return {
      ok: true,
      status: 200,
      text: async () => `<?xml version="1.0" encoding="UTF-8"?><${callName}Response xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack></${callName}Response>`,
    };
  };
});

const rejectingFetch = async () => ({ ok: false, status: 500, text: async () => 'This user has exceeded usage limit on API call' });

describe('Breaker-Dauer bei echter eBay-Ablehnung — bis zum Reset, wenn das Budget die Erschoepfung bestaetigt', () => {
  it('Budget bestaetigt (level exhausted/critical) → Breaker bis zum Reset (+30 s), nicht nur 300 s', async () => {
    const resetAtIso = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
    budgetState = { remaining: 3, level: 'exhausted', resetAtIso };
    fetchImpl = rejectingFetch;
    await ebay.callTradingApi('GetOrders', '<x/>').catch(() => {});
    const remainingMs = ebay.ebayQuotaCooldownRemainingMs();
    expect(remainingMs).toBeGreaterThan(4.9 * 60 * 60 * 1000);
    expect(remainingMs).toBeLessThanOrEqual(5 * 60 * 60 * 1000 + 31 * 1000);
  });

  it('Budget unbekannt oder noch Rest vorhanden → wie bisher 300 s (Probe bleibt moeglich)', async () => {
    budgetState = null;
    fetchImpl = rejectingFetch;
    await ebay.callTradingApi('GetOrders', '<x/>').catch(() => {});
    expect(ebay.ebayQuotaCooldownRemainingMs()).toBeLessThanOrEqual(300 * 1000);
    ebay.closeEbayQuotaBreaker();
    budgetState = { remaining: 2000, level: 'ok', resetAtIso: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString() };
    await ebay.callTradingApi('GetOrders', '<x/>').catch(() => {});
    expect(ebay.ebayQuotaCooldownRemainingMs()).toBeLessThanOrEqual(300 * 1000);
  });

  it("Notbremse EBAY_QUOTA_BREAKER_UNTIL_RESET='off' → immer 300 s", async () => {
    process.env.EBAY_QUOTA_BREAKER_UNTIL_RESET = 'off';
    budgetState = { remaining: 0, level: 'exhausted', resetAtIso: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString() };
    fetchImpl = rejectingFetch;
    await ebay.callTradingApi('GetOrders', '<x/>').catch(() => {});
    expect(ebay.ebayQuotaCooldownRemainingMs()).toBeLessThanOrEqual(300 * 1000);
  });

  it("Notbremse EBAY_TRADING_BUDGET='off' (state.enabled:false) → 300 s, auch wenn der Zaehler 'exhausted' meldet", async () => {
    budgetState = { enabled: false, remaining: 0, level: 'exhausted', resetAtIso: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString() };
    fetchImpl = rejectingFetch;
    await ebay.callTradingApi('GetOrders', '<x/>').catch(() => {});
    expect(ebay.ebayQuotaCooldownRemainingMs()).toBeLessThanOrEqual(300 * 1000);
  });

  it('lokal gespiegelter Langzeit-Breaker prueft den geteilten Zustand erneut: ist er dort geschlossen (z. B. Limit angehoben, Messung hat ihn geschlossen), laeuft der Aufruf', async () => {
    process.env.EBAY_QUOTA_BREAKER_SHARED = 'true';
    try {
      ebay.openEbayQuotaBreaker(60 * 60 * 1000); // lokal 1 h zu
      sharedBreakerState = { open: false, remainingMs: 0 };
      const out = await ebay.callTradingApi('GetOrders', '<x/>');
      expect(out.ack).toBe('Success');
      expect(ebay.ebayQuotaCooldownActive()).toBe(false);
      // geteilt noch offen → weiterhin fail-fast
      ebay.openEbayQuotaBreaker(60 * 60 * 1000);
      sharedBreakerState = { open: true, remainingMs: 3600 * 1000 };
      await expect(ebay.callTradingApi('GetOrders', '<x/>')).rejects.toMatchObject({ code: 'EBAY_QUOTA_COOLDOWN' });
    } finally {
      delete process.env.EBAY_QUOTA_BREAKER_SHARED;
      sharedBreakerState = { open: false, remainingMs: 0 };
      ebay.closeEbayQuotaBreaker();
    }
  });

  it('zaehlt NICHT, wenn der Aufruf eBay nie erreicht hat (Netzfehler/Timeout vor einer Antwort)', async () => {
    fetchImpl = async () => { throw Object.assign(new Error('fetch failed: ECONNRESET'), { code: 'ECONNRESET' }); };
    await ebay.callTradingApi('GetOrders', '<x/>', { priority: 'P0' }).catch(() => {});
    expect(records).toEqual([]);
  });

  it('Deckel: nie laenger als 25 h, nie kuerzer als 60 s, Fehler im Budget → 300 s', async () => {
    budgetState = new Error('firestore down');
    fetchImpl = rejectingFetch;
    await ebay.callTradingApi('GetOrders', '<x/>').catch(() => {});
    expect(ebay.ebayQuotaCooldownRemainingMs()).toBeLessThanOrEqual(300 * 1000);
    ebay.closeEbayQuotaBreaker();
    budgetState = { remaining: 0, level: 'exhausted', resetAtIso: new Date(Date.now() + 40 * 60 * 60 * 1000).toISOString() };
    await ebay.callTradingApi('GetOrders', '<x/>').catch(() => {});
    expect(ebay.ebayQuotaCooldownRemainingMs()).toBeLessThanOrEqual(25 * 60 * 60 * 1000);
  });
});

describe('callTradingApi — Tagesbudget mit Prioritaeten', () => {
  it('fragt das Budget VOR dem Aufruf mit der uebergebenen Prioritaet', async () => {
    const out = await ebay.callTradingApi('GetMyeBaySelling', '<x/>', { priority: 'P2' });
    expect(out.ack).toBe('Success');
    expect(decideCalls).toEqual([{ callName: 'GetMyeBaySelling', priority: 'P2' }]);
    expect(fetchCalls.length).toBe(1);
  });

  it('zaehlt jeden echten Aufruf im Budget (CallName + Prioritaet)', async () => {
    await ebay.callTradingApi('GetOrders', '<x/>', { priority: 'P0' });
    expect(records).toEqual([{ callName: 'GetOrders', priority: 'P0' }]);
  });

  it('lehnt ab, ohne eBay zu beruehren, und wirft wie ein Breaker-Skip (Quota-Marker, nie destruktiv)', async () => {
    decisions.push({ allow: false, reason: 'reserve_reached', priority: 'P2', remaining: 1400, reserve: 1500, resetAtIso: '2026-10-09T07:00:00.000Z' });
    let caught;
    try { await ebay.callTradingApi('GetMyeBaySelling', '<x/>', { priority: 'P2' }); } catch (err) { caught = err; }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('EBAY_BUDGET_DEFERRED');
    expect(caught.budgetDeferred).toBe(true);
    expect(caught.quotaCooldown).toBe(true);
    expect(caught.message).toContain('exceeded usage limit');
    expect(caught.message).toContain('Tagesbudget');
    expect(caught.message).toContain('P2');
    expect(fetchCalls.length).toBe(0);
    expect(records.length).toBe(0);
    // Ein Budget-Skip ist KEINE eBay-Ablehnung → der Breaker bleibt zu.
    expect(ebay.ebayQuotaCooldownActive()).toBe(false);
  });

  it('Voreinstellung je CallName: Spiegel/Profile P2, Versand/End P0, Rest P1', async () => {
    await ebay.callTradingApi('GetMyeBaySelling', '<x/>');
    await ebay.callTradingApi('GetSellerProfiles', '<x/>');
    await ebay.callTradingApi('CompleteSale', '<x/>');
    await ebay.callTradingApi('EndFixedPriceItem', '<x/>');
    await ebay.callTradingApi('GetOrders', '<x/>');
    await ebay.callTradingApi('ReviseFixedPriceItem', '<x/>');
    expect(decideCalls.map((d) => `${d.callName}=${d.priority}`)).toEqual([
      'GetMyeBaySelling=P2', 'GetSellerProfiles=P2', 'CompleteSale=P0', 'EndFixedPriceItem=P0', 'GetOrders=P1', 'ReviseFixedPriceItem=P1',
    ]);
  });

  it('explizite Prioritaet schlaegt die Voreinstellung', async () => {
    await ebay.callTradingApi('GetOrders', '<x/>', { priority: 'P0' });
    await ebay.callTradingApi('ReviseFixedPriceItem', '<x/>', { priority: 'p0' });
    expect(decideCalls.map((d) => d.priority)).toEqual(['P0', 'P0']);
  });

  it('ist FAIL-OPEN: wirft der Budget-Store, laeuft der Aufruf trotzdem', async () => {
    decideImpl = async () => { throw new Error('firestore down'); };
    const out = await ebay.callTradingApi('GetOrders', '<x/>');
    expect(out.ack).toBe('Success');
    expect(fetchCalls.length).toBe(1);
  });

  it('eine echte eBay-Ablehnung ("exceeded usage limit") wird gezaehlt UND oeffnet den Breaker', async () => {
    fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'This user has exceeded usage limit on API call' });
    let caught;
    try { await ebay.callTradingApi('GetOrders', '<x/>', { priority: 'P0' }); } catch (err) { caught = err; }
    expect(caught.code).toBe('EBAY_TRADING_RATE_LIMIT');
    expect(records).toEqual([{ callName: 'GetOrders', priority: 'P0' }]);
    expect(ebay.ebayQuotaCooldownActive()).toBe(true);
  });

  it('Breaker-Skip geht dem Budget vor: bei offenem Breaker wird das Budget gar nicht gefragt', async () => {
    ebay.openEbayQuotaBreaker();
    let caught;
    try { await ebay.callTradingApi('GetOrders', '<x/>'); } catch (err) { caught = err; }
    expect(caught.code).toBe('EBAY_QUOTA_COOLDOWN');
    expect(decideCalls.length).toBe(0);
  });
});
