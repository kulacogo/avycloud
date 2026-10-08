// globals: true in vitest.config.js — describe/it/expect/vi are global
'use strict';

/**
 * Messung des eBay-Trading-Kontingents ueber die Developer-Analytics-API
 * (GET /developer/analytics/v1_beta/rate_limit/?api_context=tradingapi).
 * Eigenes Kontingent, KEIN Trading-Aufruf. Gemessen 08.10.2026: alle
 * Trading-Ressourcen melden denselben Pool (limit 5000, remaining identisch),
 * d. h. die Antwort liefert den Rest des GEMEINSAMEN Tageskontingents.
 */

const { parseTradingRateLimit, fetchTradingRateLimit, runEbayBudgetProbe, ANALYTICS_URL } = require('../lib/ebay-rate-limit-probe');

function payload({ remaining = 2960, limit = 5000, reset = '2026-10-09T07:00:00.000Z', extraResource = null } = {}) {
  const resources = [
    { name: 'GetOrders', rates: [{ limit, remaining, reset, timeWindow: 86400 }] },
    { name: 'GetMyeBaySelling', rates: [{ limit, remaining, reset, timeWindow: 86400 }] },
  ];
  if (extraResource) resources.push(extraResource);
  return { rateLimits: [{ apiContext: 'tradingapi', apiName: 'tradingapi', apiVersion: 'v1', resources }] };
}

describe('parseTradingRateLimit', () => {
  it('liest Limit, Rest und Reset des gemeinsamen Pools aus der Antwort', () => {
    const out = parseTradingRateLimit(payload());
    expect(out).toEqual({ limit: 5000, remaining: 2960, resetAtIso: '2026-10-09T07:00:00.000Z', resources: 2 });
  });

  it('ist konservativ: der kleinste Rest und das groesste Limit zaehlen', () => {
    const out = parseTradingRateLimit(payload({ extraResource: { name: 'GetItem', rates: [{ limit: 5000, remaining: 12, reset: '2026-10-09T07:00:00.000Z', timeWindow: 86400 }] } }));
    expect(out.remaining).toBe(12);
    expect(out.limit).toBe(5000);
  });

  it('nimmt den GEMEINSAMEN Pool (haeufigstes Limit), nicht einzelne Ressourcen mit eigenem, hoeherem Limit', () => {
    // Gemessen 08.10.2026: einzelne Trading-Ressourcen melden limit=100000 mit
    // eigenem Rest — das ist NICHT der 5.000er-Pool, in dem GetOrders & Co. leben.
    const out = parseTradingRateLimit(payload({ extraResource: { name: 'GetSellerEvents', rates: [{ limit: 100000, remaining: 99900, reset: '2026-10-09T07:00:00.000Z', timeWindow: 86400 }] } }));
    expect(out.limit).toBe(5000);
    expect(out.remaining).toBe(2960);
    expect(out.resources).toBe(2);
  });

  it('ignoriert Fenster, die kein Tagesfenster sind (5-s-Burst-Limits)', () => {
    const out = parseTradingRateLimit(payload({ extraResource: { name: 'Burst', rates: [{ limit: 20, remaining: 1, reset: '2026-10-08T07:00:05.000Z', timeWindow: 5 }] } }));
    expect(out.remaining).toBe(2960);
  });

  it('liefert null bei leerer oder unbrauchbarer Antwort', () => {
    expect(parseTradingRateLimit({})).toBe(null);
    expect(parseTradingRateLimit({ rateLimits: [] })).toBe(null);
    expect(parseTradingRateLimit(null)).toBe(null);
  });
});

describe('fetchTradingRateLimit', () => {
  it('ruft die Analytics-API mit App-Token auf und stempelt den Messzeitpunkt', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify(payload()) };
    };
    const out = await fetchTradingRateLimit({ fetchImpl, getToken: async () => 'app-token', nowMs: Date.parse('2026-10-08T07:30:00Z') });
    expect(calls[0].url).toBe(`${ANALYTICS_URL}?api_context=tradingapi`);
    expect(calls[0].init.headers.Authorization).toBe('Bearer app-token');
    expect(out).toMatchObject({ limit: 5000, remaining: 2960, resetAtIso: '2026-10-09T07:00:00.000Z', atIso: '2026-10-08T07:30:00.000Z' });
  });

  it('wirft bei HTTP-Fehler mit Status und Textauszug', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, text: async () => '{"errors":[{"message":"Invalid access token"}]}' });
    await expect(fetchTradingRateLimit({ fetchImpl, getToken: async () => 'x' })).rejects.toThrow(/401/);
  });
});

describe('runEbayBudgetProbe — Cron auf dem Worker', () => {
  it('schreibt die Messung in den Budget-Store', async () => {
    const applied = [];
    const store = { applyProbe: async (p) => { applied.push(p); return p; } };
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload({ remaining: 4100 })) });
    const out = await runEbayBudgetProbe({ store, fetchImpl, getToken: async () => 't', nowMs: Date.parse('2026-10-08T07:30:00Z') });
    expect(out.ok).toBe(true);
    expect(applied[0]).toMatchObject({ remaining: 4100, limit: 5000, resetAtIso: '2026-10-09T07:00:00.000Z' });
  });

  it('wirft NIE — ein Messfehler wird gemeldet, nicht geworfen (fail-open)', async () => {
    const store = { applyProbe: async () => { throw new Error('should not be called'); } };
    const out = await runEbayBudgetProbe({ store, fetchImpl: async () => { throw new Error('network down'); }, getToken: async () => 't' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/network down/);
  });

  it('alarmiert EINMAL je Fenster, wenn das Budget kritisch wird (vorher gab es keinen Quota-Alarm)', async () => {
    const alerts = [];
    const state = { windowKey: '2026-10-08', level: 'critical', remaining: 300, limit: 5000, resetAtIso: '2026-10-09T07:00:00.000Z' };
    const store = { applyProbe: async (p) => p, getState: async () => state };
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload({ remaining: 300 })) });
    const alert = async (a) => { alerts.push(a); };
    await runEbayBudgetProbe({ store, fetchImpl, getToken: async () => 't', alert, _alertState: {} });
    const alertState = {};
    await runEbayBudgetProbe({ store, fetchImpl, getToken: async () => 't', alert, _alertState: alertState });
    await runEbayBudgetProbe({ store, fetchImpl, getToken: async () => 't', alert, _alertState: alertState });
    expect(alerts.length).toBe(2); // erster Lauf (eigener Zustand) + einmal fuer alertState
    expect(alerts[0].severity).toBe('warning');
    expect(alerts[0].message).toMatch(/kritisch|critical/i);
    state.windowKey = '2026-10-09';
    await runEbayBudgetProbe({ store, fetchImpl, getToken: async () => 't', alert, _alertState: alertState });
    expect(alerts.length).toBe(3); // neues Fenster → wieder ein Alarm
  });

  it('kein Alarm bei Stufe ok/tight; ein Alarmfehler bricht die Messung nicht', async () => {
    const store = { applyProbe: async (p) => p, getState: async () => ({ windowKey: '2026-10-08', level: 'tight', remaining: 1400, limit: 5000 }) };
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload({ remaining: 1400 })) });
    const alerts = [];
    const out = await runEbayBudgetProbe({ store, fetchImpl, getToken: async () => 't', alert: async (a) => { alerts.push(a); }, _alertState: {} });
    expect(out.ok).toBe(true);
    expect(alerts.length).toBe(0);
    const store2 = { applyProbe: async (p) => p, getState: async () => ({ windowKey: '2026-10-08', level: 'exhausted', remaining: 0, limit: 5000 }) };
    const out2 = await runEbayBudgetProbe({ store: store2, fetchImpl, getToken: async () => 't', alert: async () => { throw new Error('slack down'); }, _alertState: {} });
    expect(out2.ok).toBe(true);
  });

  it('schliesst einen offenen Langzeit-Breaker, wenn die Messung wieder Rest zeigt (einziger Weg, ein angehobenes Limit zu sehen)', async () => {
    const closes = [];
    const closeBreaker = async () => { closes.push(1); };
    const okStore = { applyProbe: async (p) => p, getState: async () => ({ windowKey: '2026-10-08', level: 'ok', remaining: 4800, limit: 5000, source: 'probe' }) };
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload({ remaining: 4800 })) });
    await runEbayBudgetProbe({ store: okStore, fetchImpl, getToken: async () => 't', closeBreaker, _alertState: {} });
    expect(closes.length).toBe(1);
    const badStore = { applyProbe: async (p) => p, getState: async () => ({ windowKey: '2026-10-08', level: 'exhausted', remaining: 0, limit: 5000, source: 'probe' }) };
    await runEbayBudgetProbe({ store: badStore, fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload({ remaining: 0 })) }), getToken: async () => 't', closeBreaker, _alertState: {} });
    expect(closes.length).toBe(1);
  });

  it('laeuft nie doppelt: eine zweite Messung waehrend einer laufenden wird uebersprungen', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const store = { applyProbe: async (p) => { await gate; return p; }, getState: async () => ({ windowKey: '2026-10-08', level: 'ok', remaining: 4000, limit: 5000 }) };
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload({ remaining: 4000 })) });
    const first = runEbayBudgetProbe({ store, fetchImpl, getToken: async () => 't', _alertState: {}, closeBreaker: async () => {} });
    const second = await runEbayBudgetProbe({ store, fetchImpl, getToken: async () => 't', _alertState: {}, closeBreaker: async () => {} });
    expect(second).toMatchObject({ ok: false, skipped: true, reason: 'in_flight' });
    release();
    expect((await first).ok).toBe(true);
  });

  it('laesst sich mit EBAY_BUDGET_PROBE=off abschalten', async () => {
    const store = { applyProbe: async () => { throw new Error('should not be called'); } };
    const out = await runEbayBudgetProbe({ store, fetchImpl: async () => { throw new Error('should not fetch'); }, getToken: async () => 't', env: { EBAY_BUDGET_PROBE: 'off' } });
    expect(out).toMatchObject({ ok: false, skipped: true, reason: 'disabled' });
  });
});
