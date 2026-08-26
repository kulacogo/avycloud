// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// QUOTA-AWARE DRAIN (2026-08-26).
//
// Befund: Waehrend das eBay-Tageskontingent erschoepft ist ("exceeded usage
// limit", shared Quota-Breaker offen), kann KEIN Retry gelingen. Vorher
// verbrannte der Drain alle 5 Versuche (~18 min Abstand ≈ 90 min Fenster)
// innerhalb der stundenlangen Sperre und gab endgueltig auf — gemessen
// 378 abandoned Docs, darunter Zero-Stock-ENDs (Oversell-Fenster jede Nacht).
//
// Neu: Ein Versuch, der in die offene Quota-Sperre faellt, zaehlt NICHT als
// Versuch. Das Doc wird verschoben (1h → 3h → bis zum naechsten Quota-Reset),
// hart begrenzt ueber MAX_QUOTA_DEFERRALS — danach zaehlt wieder normal.

// ─── Mock Setup (require.cache patching for CJS) ──────────────────────

function makeFailureDoc({ id, tenantId = 'trendocean', status = 'pending', attempts = 0, failures = [], createdAt = new Date().toISOString(), nextRetryAt, classification, quotaDeferrals }) {
  const data = { tenantId, status, attempts, failures, createdAt };
  if (nextRetryAt !== undefined) data.nextRetryAt = nextRetryAt;
  if (classification !== undefined) data.classification = classification;
  if (quotaDeferrals !== undefined) data.quotaDeferrals = quotaDeferrals;
  const updates = [];
  return {
    id,
    ref: {
      update: vi.fn(async (patch) => { updates.push(patch); Object.assign(data, patch); }),
    },
    data: () => ({ ...data }),
    _updates: updates,
    _currentData: () => data,
  };
}

let _queryImpl = async () => ({ docs: [] });
let _productQueryImpl = async () => ({ empty: true, docs: [] });

const mockFirestore = {
  collection: vi.fn((name) => {
    if (name === 'stock_operation_failures') {
      return {
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        get: async () => _queryImpl(),
      };
    }
    if (name === 'products_v2') {
      return {
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        get: async () => _productQueryImpl(),
        doc: vi.fn(() => ({ get: async () => ({ exists: false, data: () => ({}) }) })),
      };
    }
    return { where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), get: async () => ({ docs: [] }), add: vi.fn(async () => ({ id: 'x' })) };
  }),
};

require.cache[require.resolve('../lib/firestore')] = {
  id: require.resolve('../lib/firestore'),
  filename: require.resolve('../lib/firestore'),
  loaded: true,
  exports: { firestore: mockFirestore },
  children: [],
  paths: [],
};

const syncStockWithRetryMock = vi.fn();
require.cache[require.resolve('../services/stock-sync-dispatcher')] = {
  id: require.resolve('../services/stock-sync-dispatcher'),
  filename: require.resolve('../services/stock-sync-dispatcher'),
  loaded: true,
  exports: { syncStockWithRetry: syncStockWithRetryMock },
  children: [],
  paths: [],
};

// Shared eBay-Quota-Breaker mocken — der Drain fragt ihn nach jedem
// fehlgeschlagenen eBay-Retry, ob die Tagesquota gesperrt ist.
const isBreakerOpenMock = vi.fn();
const msUntilResetMock = vi.fn();
require.cache[require.resolve('../lib/ebay-quota-breaker')] = {
  id: require.resolve('../lib/ebay-quota-breaker'),
  filename: require.resolve('../lib/ebay-quota-breaker'),
  loaded: true,
  exports: { isEbayQuotaBreakerOpen: isBreakerOpenMock, msUntilNextEbayQuotaReset: msUntilResetMock },
  children: [],
  paths: [],
};

const { drainStockFailures, MAX_ATTEMPTS, MAX_QUOTA_DEFERRALS } = require('../services/stock-failure-drain');

// ─── Helpers ──────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const JITTER_SLACK = 16 * 60 * 1000; // 15 min Jitter + Messtoleranz

function ebayFailingDoc(overrides = {}) {
  return makeFailureDoc({
    id: overrides.id || 'q1',
    failures: [{ step: 'marketplaceSync', sku: 'SKU-Q' }],
    ...overrides,
  });
}

function productFound() {
  _productQueryImpl = async () => ({
    empty: false,
    docs: [{ id: 'prod-q', data: () => ({ id: 'prod-q', identification: { sku: 'SKU-Q' }, tenantId: 'trendocean' }) }],
  });
}

beforeEach(() => {
  syncStockWithRetryMock.mockReset();
  isBreakerOpenMock.mockReset();
  msUntilResetMock.mockReset();
  isBreakerOpenMock.mockResolvedValue(false);
  msUntilResetMock.mockReturnValue(5 * HOUR);
  _queryImpl = async () => ({ docs: [] });
  _productQueryImpl = async () => ({ empty: true, docs: [] });
  delete process.env.DRAIN_QUOTA_AWARE;
});

// ─── Tests ────────────────────────────────────────────────────────────

describe('drainStockFailures — quota-aware Retries (2026-08-26)', () => {
  it('zaehlt einen Versuch NICHT, wenn der eBay-Quota-Breaker offen ist (Deferral statt Attempt)', async () => {
    const doc = ebayFailingDoc({ attempts: 0 });
    _queryImpl = async () => ({ docs: [doc] });
    productFound();
    syncStockWithRetryMock.mockResolvedValue({ results: [{ channel: 'ebay', status: 'error', error: 'eBay Trading skipped for EndFixedPriceItem: exceeded usage limit (quota cooldown 244s)' }] });
    isBreakerOpenMock.mockResolvedValue(true);

    const before = Date.now();
    const r = await drainStockFailures({ tenantId: 'trendocean' });

    expect(r.quotaDeferred).toBe(1);
    expect(r.stillFailing).toBe(0);
    expect(r.abandoned).toBe(0);
    const after = doc._currentData();
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(0); // Versuch NICHT verbraucht
    expect(after.quotaDeferrals).toBe(1);
    const nra = Date.parse(after.nextRetryAt);
    expect(nra).toBeGreaterThanOrEqual(before + 1 * HOUR); // erste Stufe: 1h
    expect(nra).toBeLessThanOrEqual(before + 1 * HOUR + JITTER_SLACK);
  });

  it('verhindert das Abandon am letzten Versuch, solange die Quota gesperrt ist', async () => {
    const doc = ebayFailingDoc({ id: 'q-last', attempts: MAX_ATTEMPTS - 1 });
    _queryImpl = async () => ({ docs: [doc] });
    productFound();
    syncStockWithRetryMock.mockResolvedValue({ results: [{ channel: 'ebay', status: 'error', error: 'exceeded usage limit' }] });
    isBreakerOpenMock.mockResolvedValue(true);

    const r = await drainStockFailures({ tenantId: 'trendocean' });

    expect(r.abandoned).toBe(0);
    expect(r.quotaDeferred).toBe(1);
    expect(doc._currentData().status).toBe('pending');
    expect(doc._currentData().attempts).toBe(MAX_ATTEMPTS - 1);
  });

  it('eskaliert: ab dem dritten Deferral wartet das Doc bis zum naechsten Quota-Reset', async () => {
    const doc = ebayFailingDoc({ id: 'q-esc', attempts: 1, quotaDeferrals: 2 });
    _queryImpl = async () => ({ docs: [doc] });
    productFound();
    syncStockWithRetryMock.mockResolvedValue({ results: [{ channel: 'ebay', status: 'error', error: 'exceeded usage limit' }] });
    isBreakerOpenMock.mockResolvedValue(true);
    msUntilResetMock.mockReturnValue(5 * HOUR);

    const before = Date.now();
    const r = await drainStockFailures({ tenantId: 'trendocean' });

    expect(r.quotaDeferred).toBe(1);
    expect(msUntilResetMock).toHaveBeenCalled();
    const after = doc._currentData();
    expect(after.quotaDeferrals).toBe(3);
    const nra = Date.parse(after.nextRetryAt);
    expect(nra).toBeGreaterThanOrEqual(before + 5 * HOUR);
    expect(nra).toBeLessThanOrEqual(before + 5 * HOUR + JITTER_SLACK);
  });

  it('Deferral-Kappe: nach MAX_QUOTA_DEFERRALS zaehlen Versuche wieder normal (kein Zombie-Doc)', async () => {
    const doc = ebayFailingDoc({ id: 'q-cap', attempts: 0, quotaDeferrals: MAX_QUOTA_DEFERRALS });
    _queryImpl = async () => ({ docs: [doc] });
    productFound();
    syncStockWithRetryMock.mockResolvedValue({ results: [{ channel: 'ebay', status: 'error', error: 'exceeded usage limit' }] });
    isBreakerOpenMock.mockResolvedValue(true);

    const r = await drainStockFailures({ tenantId: 'trendocean' });

    expect(r.quotaDeferred).toBe(0);
    expect(r.stillFailing).toBe(1);
    expect(doc._currentData().attempts).toBe(1);
  });

  it('kein Deferral, wenn nur Kaufland scheitert — Quota-Sperre betrifft nur eBay', async () => {
    const doc = ebayFailingDoc({ id: 'q-kl', attempts: 0 });
    _queryImpl = async () => ({ docs: [doc] });
    productFound();
    syncStockWithRetryMock.mockResolvedValue({ results: [{ channel: 'kaufland', status: 'error', error: 'kaufland down' }] });
    isBreakerOpenMock.mockResolvedValue(true);

    const r = await drainStockFailures({ tenantId: 'trendocean' });

    expect(r.quotaDeferred).toBe(0);
    expect(r.stillFailing).toBe(1);
    expect(doc._currentData().attempts).toBe(1);
  });

  it('geschlossener Breaker: unveraendertes Verhalten, Versuch zaehlt', async () => {
    const doc = ebayFailingDoc({ id: 'q-closed', attempts: 0 });
    _queryImpl = async () => ({ docs: [doc] });
    productFound();
    syncStockWithRetryMock.mockResolvedValue({ results: [{ channel: 'ebay', status: 'error', error: 'validation error' }] });
    isBreakerOpenMock.mockResolvedValue(false);

    const r = await drainStockFailures({ tenantId: 'trendocean' });

    expect(r.quotaDeferred).toBe(0);
    expect(r.stillFailing).toBe(1);
    expect(doc._currentData().attempts).toBe(1);
  });

  it("Notbremse DRAIN_QUOTA_AWARE='off': altes Verhalten auch bei offenem Breaker", async () => {
    process.env.DRAIN_QUOTA_AWARE = 'off';
    const doc = ebayFailingDoc({ id: 'q-off', attempts: 0 });
    _queryImpl = async () => ({ docs: [doc] });
    productFound();
    syncStockWithRetryMock.mockResolvedValue({ results: [{ channel: 'ebay', status: 'error', error: 'exceeded usage limit' }] });
    isBreakerOpenMock.mockResolvedValue(true);

    const r = await drainStockFailures({ tenantId: 'trendocean' });

    expect(r.quotaDeferred).toBe(0);
    expect(doc._currentData().attempts).toBe(1);
  });

  it('Breaker-Abfrage kaputt → faellt sicher auf normales Zaehlen zurueck', async () => {
    const doc = ebayFailingDoc({ id: 'q-err', attempts: 0 });
    _queryImpl = async () => ({ docs: [doc] });
    productFound();
    syncStockWithRetryMock.mockResolvedValue({ results: [{ channel: 'ebay', status: 'error', error: 'exceeded usage limit' }] });
    isBreakerOpenMock.mockRejectedValue(new Error('firestore down'));

    const r = await drainStockFailures({ tenantId: 'trendocean' });

    expect(r.quotaDeferred).toBe(0);
    expect(r.stillFailing).toBe(1);
    expect(doc._currentData().attempts).toBe(1);
  });

  it('erfolgreicher Retry setzt den Deferral-Zaehler nicht fort — Doc wird resolved', async () => {
    const doc = ebayFailingDoc({ id: 'q-ok', attempts: 1, quotaDeferrals: 3 });
    _queryImpl = async () => ({ docs: [doc] });
    productFound();
    syncStockWithRetryMock.mockResolvedValue({ results: [{ channel: 'ebay', status: 'success' }] });
    isBreakerOpenMock.mockResolvedValue(false);

    const r = await drainStockFailures({ tenantId: 'trendocean' });

    expect(r.resolved).toBe(1);
    expect(doc._currentData().status).toBe('resolved');
  });
});
