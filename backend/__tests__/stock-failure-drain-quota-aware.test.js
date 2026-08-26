// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// QUOTA-AWARE DRAIN (2026-08-26, nachgehaertet nach 8-Winkel-Review).
//
// Befund: Waehrend das eBay-Tageskontingent erschoepft ist ("exceeded usage
// limit"), kann KEIN Retry gelingen. Vorher verbrannte der Drain alle
// 5 Versuche (~18 min Abstand ≈ 90 min Fenster) innerhalb der stundenlangen
// Sperre und gab endgueltig auf — gemessen 378 abandoned Docs, darunter
// Zero-Stock-ENDs (naechtliches Oversell-Fenster).
//
// Vertrag (Review-gehaertet):
// - Ausloeser ist die FEHLERMELDUNG des eBay-Kanals selbst (quota-artig),
//   NICHT der shared Breaker-Zustand — der haengt an EBAY_QUOTA_BREAKER_SHARED
//   (Default aus) und hat ein Fire-and-forget-Race. Deterministisch > Zustand.
// - Deferral NUR wenn AUSSCHLIESSLICH eBay-Kanaele gescheitert sind. Ein
//   Kaufland-Leg (ONHOLD-Oversell-Guard!) oder ein Lookup-Fehler
//   (product-not-found) darf nie mitverschoben werden.
// - Nicht-quota-eBay-Fehler (Auth tot, dup_guard) zaehlen normal — sonst
//   verspaetet sich der Abandoned-Alarm um Tage.
// - Ein gezaehlter Versuch setzt den Deferral-Zaehler zurueck (Budget gilt
//   pro Sperr-Phase, nicht pro Doc-Lebenszeit).
// - nextRetryAt des Deferrals wird auch OHNE SYNC_DURABLE_DRAIN respektiert.

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

// Quota-Breaker-Lib mocken — der Drain braucht daraus NUR noch das
// Reset-Fenster (msUntilNextEbayQuotaReset), keinen Breaker-Zustand.
const msUntilResetMock = vi.fn();
require.cache[require.resolve('../lib/ebay-quota-breaker')] = {
  id: require.resolve('../lib/ebay-quota-breaker'),
  filename: require.resolve('../lib/ebay-quota-breaker'),
  loaded: true,
  exports: { msUntilNextEbayQuotaReset: msUntilResetMock },
  children: [],
  paths: [],
};

const { drainStockFailures, MAX_ATTEMPTS, MAX_QUOTA_DEFERRALS } = require('../services/stock-failure-drain');

// ─── Helpers ──────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const JITTER_SLACK = 16 * 60 * 1000; // 15 min Jitter + Messtoleranz

const QUOTA_ERROR = 'eBay Trading skipped for EndFixedPriceItem: exceeded usage limit (quota cooldown 244s)';

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

function ebayQuotaChannelResult() {
  return { results: [{ channel: 'ebay', status: 'error', error: QUOTA_ERROR }] };
}

beforeEach(() => {
  syncStockWithRetryMock.mockReset();
  msUntilResetMock.mockReset();
  msUntilResetMock.mockReturnValue(5 * HOUR);
  _queryImpl = async () => ({ docs: [] });
  _productQueryImpl = async () => ({ empty: true, docs: [] });
  delete process.env.DRAIN_QUOTA_AWARE;
  delete process.env.SYNC_DURABLE_DRAIN;
});

// ─── Tests ────────────────────────────────────────────────────────────

describe('drainStockFailures — quota-aware Retries (2026-08-26)', () => {
  it('quota-artiger eBay-Fehler: Versuch zaehlt NICHT, Doc wird verschoben (1h + Jitter)', async () => {
    const doc = ebayFailingDoc({ attempts: 0 });
    _queryImpl = async () => ({ docs: [doc] });
    productFound();
    syncStockWithRetryMock.mockResolvedValue(ebayQuotaChannelResult());

    const before = Date.now();
    const r = await drainStockFailures({ tenantId: 'trendocean' });

    expect(r.quotaDeferred).toBe(1);
    expect(r.stillFailing).toBe(0);
    expect(r.abandoned).toBe(0);
    const after = doc._currentData();
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(0); // Versuch NICHT verbraucht
    expect(after.quotaDeferrals).toBe(1);
    expect(after.classification).toBe('unknown'); // Parity zum normalen Pfad
    const nra = Date.parse(after.nextRetryAt);
    expect(nra).toBeGreaterThanOrEqual(before + 1 * HOUR);
    expect(nra).toBeLessThanOrEqual(before + 1 * HOUR + JITTER_SLACK);
  });

  it('drainResults tragen strukturierte Kanalfelder (channels + quotaBlocked) — kein String-Parsing', async () => {
    const doc = ebayFailingDoc({ id: 'q-struct', attempts: 0 });
    _queryImpl = async () => ({ docs: [doc] });
    productFound();
    syncStockWithRetryMock.mockResolvedValue(ebayQuotaChannelResult());

    await drainStockFailures({ tenantId: 'trendocean' });

    const row = doc._currentData().drainResults[0];
    expect(row.channels).toEqual(['ebay']);
    expect(row.quotaBlocked).toBe(true);
  });

  it('verhindert das Abandon am letzten Versuch, solange die Quota-Sperre der Grund ist', async () => {
    const doc = ebayFailingDoc({ id: 'q-last', attempts: MAX_ATTEMPTS - 1 });
    _queryImpl = async () => ({ docs: [doc] });
    productFound();
    syncStockWithRetryMock.mockResolvedValue(ebayQuotaChannelResult());

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
    syncStockWithRetryMock.mockResolvedValue(ebayQuotaChannelResult());
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

  it('Reset-Fenster-Helper kaputt → faellt auf die 3h-Stufe zurueck (Deferral bleibt)', async () => {
    const doc = ebayFailingDoc({ id: 'q-helper-broken', attempts: 1, quotaDeferrals: 4 });
    _queryImpl = async () => ({ docs: [doc] });
    productFound();
    syncStockWithRetryMock.mockResolvedValue(ebayQuotaChannelResult());
    msUntilResetMock.mockImplementation(() => { throw new Error('intl kaputt'); });

    const before = Date.now();
    const r = await drainStockFailures({ tenantId: 'trendocean' });

    expect(r.quotaDeferred).toBe(1);
    const nra = Date.parse(doc._currentData().nextRetryAt);
    expect(nra).toBeGreaterThanOrEqual(before + 3 * HOUR);
    expect(nra).toBeLessThanOrEqual(before + 3 * HOUR + JITTER_SLACK);
  });

  it('Deferral-Kappe: nach MAX_QUOTA_DEFERRALS zaehlen Versuche wieder normal (kein Zombie-Doc)', async () => {
    const doc = ebayFailingDoc({ id: 'q-cap', attempts: 0, quotaDeferrals: MAX_QUOTA_DEFERRALS });
    _queryImpl = async () => ({ docs: [doc] });
    productFound();
    syncStockWithRetryMock.mockResolvedValue(ebayQuotaChannelResult());

    const r = await drainStockFailures({ tenantId: 'trendocean' });

    expect(r.quotaDeferred).toBe(0);
    expect(r.stillFailing).toBe(1);
    expect(doc._currentData().attempts).toBe(1);
  });

  it('gezaehlter Versuch setzt den Deferral-Zaehler zurueck — Budget gilt pro Sperr-Phase', async () => {
    // Nicht-quota-Fehler nach frueheren Deferrals: Versuch zaehlt, Zaehler → 0,
    // damit die NAECHSTE Quota-Nacht wieder volles Deferral-Budget hat.
    const doc = ebayFailingDoc({ id: 'q-reset', attempts: 1, quotaDeferrals: 5 });
    _queryImpl = async () => ({ docs: [doc] });
    productFound();
    syncStockWithRetryMock.mockResolvedValue({ results: [{ channel: 'ebay', status: 'error', error: 'Auth token invalid' }] });

    const r = await drainStockFailures({ tenantId: 'trendocean' });

    expect(r.quotaDeferred).toBe(0);
    expect(r.stillFailing).toBe(1);
    expect(doc._currentData().attempts).toBe(2);
    expect(doc._currentData().quotaDeferrals).toBe(0);
  });

  it('kein Deferral, wenn nur Kaufland scheitert', async () => {
    const doc = ebayFailingDoc({ id: 'q-kl', attempts: 0 });
    _queryImpl = async () => ({ docs: [doc] });
    productFound();
    syncStockWithRetryMock.mockResolvedValue({ results: [{ channel: 'kaufland', status: 'error', error: 'kaufland down' }] });

    const r = await drainStockFailures({ tenantId: 'trendocean' });

    expect(r.quotaDeferred).toBe(0);
    expect(r.stillFailing).toBe(1);
    expect(doc._currentData().attempts).toBe(1);
  });

  it('kein Deferral bei gemischtem Fehler (ebay+kaufland) — das Kaufland-Leg darf nie warten', async () => {
    const doc = ebayFailingDoc({ id: 'q-mixed', attempts: 0 });
    _queryImpl = async () => ({ docs: [doc] });
    productFound();
    syncStockWithRetryMock.mockResolvedValue({
      results: [
        { channel: 'ebay', status: 'error', error: QUOTA_ERROR },
        { channel: 'kaufland', status: 'error', error: 'transient 5xx' },
      ],
    });

    const r = await drainStockFailures({ tenantId: 'trendocean' });

    expect(r.quotaDeferred).toBe(0);
    expect(r.stillFailing).toBe(1);
    expect(doc._currentData().attempts).toBe(1);
  });

  it('kein Deferral bei eBay-Fehler ohne Quota-Kennzeichen (z. B. totes Auth-Token)', async () => {
    const doc = ebayFailingDoc({ id: 'q-auth', attempts: 0 });
    _queryImpl = async () => ({ docs: [doc] });
    productFound();
    syncStockWithRetryMock.mockResolvedValue({ results: [{ channel: 'ebay', status: 'failed', error: 'dup_guard_unavailable' }] });

    const r = await drainStockFailures({ tenantId: 'trendocean' });

    expect(r.quotaDeferred).toBe(0);
    expect(r.stillFailing).toBe(1);
    expect(doc._currentData().attempts).toBe(1);
  });

  it('kein Deferral, wenn der Retry als Exception scheitert — auch wenn die Meldung "ebay" enthaelt', async () => {
    const doc = ebayFailingDoc({ id: 'q-throw', attempts: 0 });
    _queryImpl = async () => ({ docs: [doc] });
    productFound();
    syncStockWithRetryMock.mockRejectedValue(new Error("Cannot read properties of undefined (reading 'ebayItemId')"));

    const r = await drainStockFailures({ tenantId: 'trendocean' });

    expect(r.quotaDeferred).toBe(0);
    expect(r.stillFailing).toBe(1);
    expect(doc._currentData().attempts).toBe(1);
  });

  it('kein Deferral, wenn NEBEN dem Quota-Fehler ein Lookup-Fehler steht (product-not-found)', async () => {
    // Zwei SKUs im selben Doc: eine mit Quota-Fehler, eine ohne Produkt.
    // Der permanente Fehler darf nicht tagelang am Alarm vorbei deferred werden.
    const doc = makeFailureDoc({
      id: 'q-lookup',
      failures: [
        { step: 'marketplaceSync', sku: 'SKU-Q' },
        { step: 'marketplaceSync', sku: 'SKU-GONE' },
      ],
    });
    _queryImpl = async () => ({ docs: [doc] });
    // Nur SKU-Q (erste Abfrage) wird gefunden; SKU-GONE laeuft in beide
    // leeren Folge-Abfragen und endet als product-not-found.
    let call = 0;
    _productQueryImpl = async () => {
      call += 1;
      if (call === 1) {
        return { empty: false, docs: [{ id: 'prod-q', data: () => ({ id: 'prod-q', identification: { sku: 'SKU-Q' }, tenantId: 'trendocean' }) }] };
      }
      return { empty: true, docs: [] };
    };
    syncStockWithRetryMock.mockResolvedValue(ebayQuotaChannelResult());

    const r = await drainStockFailures({ tenantId: 'trendocean' });

    expect(r.quotaDeferred).toBe(0);
    expect(r.stillFailing).toBe(1);
    expect(doc._currentData().attempts).toBe(1);
  });

  it("Notbremse DRAIN_QUOTA_AWARE='off' wirkt — auch mit Leerzeichen (' off ')", async () => {
    process.env.DRAIN_QUOTA_AWARE = ' off ';
    const doc = ebayFailingDoc({ id: 'q-off', attempts: 0 });
    _queryImpl = async () => ({ docs: [doc] });
    productFound();
    syncStockWithRetryMock.mockResolvedValue(ebayQuotaChannelResult());

    const r = await drainStockFailures({ tenantId: 'trendocean' });

    expect(r.quotaDeferred).toBe(0);
    expect(doc._currentData().attempts).toBe(1);
  });

  it('erfolgreicher Retry: Doc wird resolved (Deferral-Historie egal)', async () => {
    const doc = ebayFailingDoc({ id: 'q-ok', attempts: 1, quotaDeferrals: 3 });
    _queryImpl = async () => ({ docs: [doc] });
    productFound();
    syncStockWithRetryMock.mockResolvedValue({ results: [{ channel: 'ebay', status: 'success' }] });

    const r = await drainStockFailures({ tenantId: 'trendocean' });

    expect(r.resolved).toBe(1);
    expect(doc._currentData().status).toBe('resolved');
  });
});

describe('drainStockFailures — Deferral-nextRetryAt gilt auch ohne SYNC_DURABLE_DRAIN', () => {
  it('quota-verschobenes Doc mit kuenftigem nextRetryAt wird uebersprungen, obwohl durable aus ist', async () => {
    process.env.SYNC_DURABLE_DRAIN = 'false';
    const doc = ebayFailingDoc({
      id: 'q-selfcontained',
      attempts: 0,
      quotaDeferrals: 1,
      nextRetryAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    _queryImpl = async () => ({ docs: [doc] });
    productFound();
    syncStockWithRetryMock.mockResolvedValue(ebayQuotaChannelResult());

    const r = await drainStockFailures({ tenantId: 'trendocean' });

    expect(syncStockWithRetryMock).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
    expect(r.total).toBe(0);
  });

  it('Legacy-Doc OHNE Deferral-Historie behaelt Altverhalten: nextRetryAt wird ohne durable ignoriert', async () => {
    process.env.SYNC_DURABLE_DRAIN = 'false';
    const doc = ebayFailingDoc({
      id: 'q-legacy',
      attempts: 0,
      nextRetryAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    _queryImpl = async () => ({ docs: [doc] });
    productFound();
    syncStockWithRetryMock.mockResolvedValue({ results: [{ channel: 'ebay', status: 'success' }] });

    const r = await drainStockFailures({ tenantId: 'trendocean' });

    expect(syncStockWithRetryMock).toHaveBeenCalledTimes(1);
    expect(r.resolved).toBe(1);
  });
});
