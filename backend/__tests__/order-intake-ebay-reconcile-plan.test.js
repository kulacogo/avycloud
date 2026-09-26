// globals: true in vitest.config.js
'use strict';

/**
 * Vorfall 2026-09-25/26 — das eBay-Tageskontingent war fast jeden Tag ab
 * ~00:30 UTC leer (bis zum Reset 07:00 UTC). Gemessen am 26.09. ueber die
 * Developer-Analytics-API: 2.460 Trading-Aufrufe seit Reset, davon GetOrders
 * 1.760 (72 %). Ursache: syncEbayOrders machte bei JEDEM Aufruf einen 30-Tage-
 * Abgleich (4+ Seiten) — beim 5-min-Fast-Poll und bei jedem Oberflaechen-
 * Abgleich (243 Laeufe in 6 h auf dem Web-Dienst).
 *
 * Vertrag der neuen Taktung (planReconciliation):
 *   - erster Lauf im Prozess und danach alle 3 h: Voll-Abgleich (30 Tage)
 *   - dazwischen: inkrementell ueber ModTimeFrom ab Start des letzten
 *     ERFOLGREICHEN Voll-Laufs (minus 10 min Ueberlappung) — lueckenlos
 *   - weniger als 4 min seit dem letzten Versuch: kein Abgleich (nur Intake)
 *   - EBAY_RECONCILE_MODE='full' stellt das alte Verhalten her
 */

function patchCjsModule(modulePath, mockExports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath, filename: resolvedPath, loaded: true, exports: mockExports, children: [], paths: [],
  };
}

function MockFirestore() {
  const emptyQuery = { where: () => emptyQuery, limit: () => emptyQuery, get: async () => ({ empty: true, docs: [] }) };
  return {
    collection: () => ({
      where: () => emptyQuery,
      doc: () => ({ set: async () => {}, get: async () => ({ exists: false }), update: async () => {} }),
    }),
  };
}
patchCjsModule('@google-cloud/firestore', { Firestore: MockFirestore, FieldValue: {} });

const tradingXml = [];
let tradingImpl = async () => ({
  response: { Ack: 'Success', OrderArray: { Order: [] }, PaginationResult: { TotalNumberOfPages: '1', TotalNumberOfEntries: '0' } },
});
patchCjsModule('../lib/ebay-trading-api', {
  callTradingApi: vi.fn(async (_name, xml) => { tradingXml.push(xml); return tradingImpl(); }),
});
patchCjsModule('../services/stock-reservation', { reserveStock: vi.fn(), confirmReservation: vi.fn(), releaseReservation: vi.fn() });
patchCjsModule('../services/order-state-machine', { transitionOrder: vi.fn(async () => ({ ok: true })), processShippedOrder: vi.fn(), ORDER_STATUSES: {} });
patchCjsModule('../services/stock-sync-dispatcher', { syncStockWithRetry: vi.fn(), findProductsBySkuChunk: vi.fn(async () => []) });
patchCjsModule('../services/sync-event-bus', { emitSyncEvent: vi.fn() });
patchCjsModule('../services/number-sequence', { getNextNumber: vi.fn(async () => ({ formatted: 'AVY-1' })) });
patchCjsModule('../lib/ops-alert', { sendOpsAlert: vi.fn(async () => {}) });
patchCjsModule('../lib/product-store', { getProductWeightBySku: vi.fn(async () => null) });

const {
  planReconciliation,
  markReconciliationAttempt,
  markReconciliationDone,
  syncEbayOrders,
  _resetReconcileStateForTests,
} = require('../services/order-intake-ebay');

const MIN = 60 * 1000;
const H = 60 * MIN;
const T0 = Date.parse('2026-09-26T08:00:00Z');

function freshState() { return { lastFullStartedAtMs: 0, lastAttemptAtMs: 0 }; }

beforeEach(() => {
  delete process.env.EBAY_RECONCILE_MODE;
  tradingXml.length = 0;
  _resetReconcileStateForTests();
});

describe('planReconciliation — Taktung des eBay-Abgleichs', () => {
  it('erster Lauf im Prozess → Voll-Abgleich', () => {
    expect(planReconciliation(T0, freshState())).toEqual({ mode: 'full' });
  });

  it('innerhalb von 4 min nach einem Versuch → kein Abgleich', () => {
    const s = freshState();
    markReconciliationAttempt(T0, s);
    markReconciliationDone('full', T0, s);
    expect(planReconciliation(T0 + 3 * MIN, s)).toEqual({ mode: 'skip' });
  });

  it('danach bis 3 h → inkrementell ab Start des letzten Voll-Laufs minus 10 min (lueckenlos)', () => {
    const s = freshState();
    markReconciliationAttempt(T0, s);
    markReconciliationDone('full', T0, s);
    markReconciliationAttempt(T0 + 2 * H, s); // spaeterer inkrementeller Lauf
    expect(planReconciliation(T0 + 2 * H + 5 * MIN, s)).toEqual({ mode: 'incremental', modTimeFromMs: T0 - 10 * MIN });
  });

  it('nach 3 h → wieder Voll-Abgleich', () => {
    const s = freshState();
    markReconciliationAttempt(T0, s);
    markReconciliationDone('full', T0, s);
    expect(planReconciliation(T0 + 3 * H, s)).toEqual({ mode: 'full' });
  });

  it('gescheiterter Voll-Lauf: Startpunkt bleibt alt, Voll-Lauf bleibt faellig — aber nicht bei jedem Aufruf', () => {
    const s = freshState();
    markReconciliationAttempt(T0, s); // Versuch, kein Done
    expect(planReconciliation(T0 + 1 * MIN, s)).toEqual({ mode: 'skip' });
    expect(planReconciliation(T0 + 5 * MIN, s)).toEqual({ mode: 'full' });
  });

  it("Notbremse EBAY_RECONCILE_MODE='full' → immer Voll-Abgleich (altes Verhalten)", () => {
    process.env.EBAY_RECONCILE_MODE = 'full';
    const s = freshState();
    markReconciliationAttempt(T0, s);
    markReconciliationDone('full', T0, s);
    expect(planReconciliation(T0 + 1 * MIN, s)).toEqual({ mode: 'full' });
  });
});

describe('syncEbayOrders — Aufrufzahl pro Lauf', () => {
  it('erster Lauf: Intake + 30-Tage-Abgleich (CreateTime); zweiter Lauf direkt danach: NUR Intake', async () => {
    await syncEbayOrders({ lookbackDays: 1 });
    expect(tradingXml).toHaveLength(2);
    expect(tradingXml[1]).toContain('<CreateTimeFrom>');

    tradingXml.length = 0;
    await syncEbayOrders({ lookbackDays: 1 });
    expect(tradingXml).toHaveLength(1);
    expect(tradingXml[0]).toContain('<CreateTimeFrom>');
    expect(tradingXml[0]).not.toContain('ModTimeFrom');
  });

  it('inkrementeller Lauf fragt ModTimeFrom/ModTimeTo statt CreateTime ab', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      await syncEbayOrders({ lookbackDays: 1 });
      tradingXml.length = 0;

      vi.setSystemTime(T0 + 10 * MIN);
      await syncEbayOrders({ lookbackDays: 1 });

      expect(tradingXml).toHaveLength(2);
      expect(tradingXml[1]).toContain(`<ModTimeFrom>${new Date(T0 - 10 * MIN).toISOString()}</ModTimeFrom>`);
      expect(tradingXml[1]).toContain(`<ModTimeTo>${new Date(T0 + 10 * MIN).toISOString()}</ModTimeTo>`);
      expect(tradingXml[1]).not.toContain('CreateTimeFrom');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gescheiterter Abgleich bricht den Intake nicht ab und wird nicht bei jedem Aufruf wiederholt', async () => {
    let n = 0;
    tradingImpl = async () => {
      n++;
      if (n === 2) throw new Error('eBay Trading skipped for GetOrders: exceeded usage limit');
      return { response: { Ack: 'Success', OrderArray: { Order: [] }, PaginationResult: { TotalNumberOfPages: '1', TotalNumberOfEntries: '0' } } };
    };
    const r = await syncEbayOrders({ lookbackDays: 1 });
    expect(r).toMatchObject({ synced: 0 });
    tradingXml.length = 0;
    await syncEbayOrders({ lookbackDays: 1 });
    expect(tradingXml).toHaveLength(1); // nur Intake, Abgleich gesperrt (4 min)
  });
});
