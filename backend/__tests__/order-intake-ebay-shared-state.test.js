// globals: true in vitest.config.js
'use strict';

/**
 * Vorfall 2026-10-08 — der Auftrags-Import lief auf JEDER Web-Instanz und dem
 * Worker mit eigenem Gedaechtnis: jede neue Cloud-Run-Instanz begann mit einem
 * 6-Seiten-30-Tage-Abgleich, k Web-Instanzen fuhren k parallele 4-min-Takte, und
 * 1.127 UI-Syncs am 06.10. (Handscanner alle 30 s) kosteten je 2+ GetOrders —
 * obwohl der Worker alle 5 min ohnehin importiert.
 *
 * Vertrag:
 *   - Abgleich-Zustand (letzter Voll-Lauf, letzter Versuch) liegt GETEILT in
 *     ops/ebayOrderIntake__<tenant>; ein frischer Prozess uebernimmt ihn.
 *   - skipIfFreshMs: liegt der letzte ERFOLGREICHE Import (egal welcher
 *     Prozess) weniger als N ms zurueck, macht der Aufruf KEINEN eBay-Aufruf.
 *   - priority wird an callTradingApi durchgereicht: Intake wie uebergeben,
 *     Voll-Abgleich P2, inkrementeller Abgleich P1.
 *   - Firestore-Fehler → fail-open (lokaler Zustand, Import laeuft).
 */

function patchCjsModule(modulePath, mockExports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath, filename: resolvedPath, loaded: true, exports: mockExports, children: [], paths: [],
  };
}

const opsDocs = new Map();
let opsReadFails = false;
function MockFirestore() {
  const emptyQuery = { where: () => emptyQuery, limit: () => emptyQuery, get: async () => ({ empty: true, docs: [] }) };
  return {
    collection: (name) => ({
      where: () => emptyQuery,
      doc: (id) => {
        if (name === 'ops') {
          const key = `${name}/${id}`;
          return {
            get: async () => {
              if (opsReadFails) throw new Error('firestore unavailable');
              const data = opsDocs.get(key);
              return { exists: !!data, data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined) };
            },
            set: async (data, opts) => {
              const current = opsDocs.get(key) || {};
              const merged = opts && opts.merge ? deepMerge(current, data) : data;
              opsDocs.set(key, JSON.parse(JSON.stringify(merged)));
            },
            update: async () => {},
          };
        }
        return { set: async () => {}, get: async () => ({ exists: false }), update: async () => {} };
      },
    }),
  };
}
function deepMerge(target, patch) {
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' ? deepMerge(out[k], v) : v;
  }
  return out;
}
patchCjsModule('@google-cloud/firestore', { Firestore: MockFirestore, FieldValue: {} });

const tradingCalls = [];
let tradingImpl = async () => ({
  response: { Ack: 'Success', OrderArray: { Order: [] }, PaginationResult: { TotalNumberOfPages: '1', TotalNumberOfEntries: '0' } },
});
patchCjsModule('../lib/ebay-trading-api', {
  callTradingApi: vi.fn(async (name, xml, opts) => { tradingCalls.push({ name, xml, opts: opts || {} }); return tradingImpl(); }),
});
patchCjsModule('../services/stock-reservation', { reserveStock: vi.fn(), confirmReservation: vi.fn(), releaseReservation: vi.fn() });
patchCjsModule('../services/order-state-machine', { transitionOrder: vi.fn(async () => ({ ok: true })), processShippedOrder: vi.fn(), ORDER_STATUSES: {} });
patchCjsModule('../services/stock-sync-dispatcher', { syncStockWithRetry: vi.fn(), findProductsBySkuChunk: vi.fn(async () => []) });
patchCjsModule('../services/sync-event-bus', { emitSyncEvent: vi.fn() });
patchCjsModule('../services/number-sequence', { getNextNumber: vi.fn(async () => ({ formatted: 'AVY-1' })) });
patchCjsModule('../lib/ops-alert', { sendOpsAlert: vi.fn(async () => {}) });
patchCjsModule('../lib/product-store', { getProductWeightBySku: vi.fn(async () => null) });
let backgroundRole = true;
patchCjsModule('../lib/process-role', { shouldRunBackgroundJobs: () => backgroundRole });

const { syncEbayOrders, _resetReconcileStateForTests, INTAKE_STATE_DOC_PREFIX } = require('../services/order-intake-ebay');

const MIN = 60 * 1000;
const H = 60 * MIN;
const T0 = Date.parse('2026-10-08T08:00:00Z');
const DOC = `ops/${INTAKE_STATE_DOC_PREFIX}default`;

beforeEach(() => {
  delete process.env.EBAY_RECONCILE_MODE;
  tradingCalls.length = 0;
  opsDocs.clear();
  opsReadFails = false;
  backgroundRole = true;
  _resetReconcileStateForTests();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => { vi.useRealTimers(); });

describe('syncEbayOrders — skipIfFreshMs (geteilter Frische-Marker)', () => {
  it('frischer Import eines anderen Prozesses → KEIN eBay-Aufruf, ehrliches Ergebnis', async () => {
    opsDocs.set(DOC, { lastIntakeOkAtIso: new Date(T0 - 2 * MIN).toISOString(), lastIntakeProcess: 'worker' });
    const r = await syncEbayOrders({ lookbackDays: 7, skipIfFreshMs: 6 * MIN });
    expect(tradingCalls).toHaveLength(0);
    expect(r).toMatchObject({ synced: 0, skippedFresh: true, lastIntakeProcess: 'worker' });
  });

  it('alter Marker (> N min) → Import laeuft', async () => {
    opsDocs.set(DOC, { lastIntakeOkAtIso: new Date(T0 - 10 * MIN).toISOString(), lastIntakeProcess: 'worker' });
    await syncEbayOrders({ lookbackDays: 7, skipIfFreshMs: 6 * MIN });
    expect(tradingCalls.length).toBeGreaterThan(0);
  });

  it('ohne skipIfFreshMs (Default) wird der Marker ignoriert — Worker-Fast-Poll unveraendert', async () => {
    opsDocs.set(DOC, { lastIntakeOkAtIso: new Date(T0 - 1 * MIN).toISOString(), lastIntakeProcess: 'web' });
    await syncEbayOrders({ lookbackDays: 1 });
    expect(tradingCalls.length).toBeGreaterThan(0);
  });

  it('erfolgreicher Import schreibt den Marker mit Prozessrolle', async () => {
    backgroundRole = false;
    await syncEbayOrders({ lookbackDays: 7 });
    const doc = opsDocs.get(DOC);
    expect(doc.lastIntakeOkAtIso).toBe(new Date(T0).toISOString());
    expect(doc.lastIntakeProcess).toBe('web');
    expect(doc.lastIntakeLookbackDays).toBe(7);
    expect(doc.tenantId).toBe('default');
  });

  it('gescheiterter Import schreibt KEINEN Marker', async () => {
    tradingImpl = async () => { throw new Error('eBay Trading skipped for GetOrders: exceeded usage limit (quota cooldown 10s)'); };
    await expect(syncEbayOrders({ lookbackDays: 7 })).rejects.toThrow(/usage limit/);
    expect(opsDocs.get(DOC)?.lastIntakeOkAtIso).toBeUndefined();
    tradingImpl = async () => ({ response: { Ack: 'Success', OrderArray: { Order: [] }, PaginationResult: { TotalNumberOfPages: '1', TotalNumberOfEntries: '0' } } });
  });
});

describe('syncEbayOrders — geteilter Abgleich-Zustand', () => {
  it('frischer Prozess uebernimmt den Voll-Lauf eines anderen Prozesses → inkrementell statt 30 Tage', async () => {
    opsDocs.set(DOC, { reconcile: { lastFullStartedAtIso: new Date(T0 - 1 * H).toISOString(), lastAttemptAtIso: new Date(T0 - 5 * MIN).toISOString() } });
    await syncEbayOrders({ lookbackDays: 1 });
    expect(tradingCalls).toHaveLength(2);
    expect(tradingCalls[1].xml).toContain(`<ModTimeFrom>${new Date(T0 - 1 * H - 10 * MIN).toISOString()}</ModTimeFrom>`);
    expect(tradingCalls[1].xml).not.toContain('CreateTimeFrom');
  });

  it('Versuch eines anderen Prozesses vor < 4 min → kein Abgleich (nur Intake)', async () => {
    opsDocs.set(DOC, { reconcile: { lastFullStartedAtIso: new Date(T0 - 1 * H).toISOString(), lastAttemptAtIso: new Date(T0 - 1 * MIN).toISOString() } });
    await syncEbayOrders({ lookbackDays: 1 });
    expect(tradingCalls).toHaveLength(1);
  });

  it('eigener Voll-Lauf wird geteilt geschrieben (Versuch + Abschluss)', async () => {
    await syncEbayOrders({ lookbackDays: 1 });
    const doc = opsDocs.get(DOC);
    expect(doc.reconcile.lastFullStartedAtIso).toBe(new Date(T0).toISOString());
    expect(doc.reconcile.lastAttemptAtIso).toBe(new Date(T0).toISOString());
    expect(doc.reconcile.lastMode).toBe('full');
  });

  it('Firestore nicht lesbar → fail-open: lokaler Zustand, Import laeuft', async () => {
    opsReadFails = true;
    await syncEbayOrders({ lookbackDays: 1, skipIfFreshMs: 6 * MIN });
    expect(tradingCalls).toHaveLength(2); // Intake + Voll-Abgleich (lokal frisch)
  });
});

describe('syncEbayOrders — Gegenlese 2026-10-08', () => {
  it('wird der Voll-Abgleich (P2) vom Budget verweigert, laeuft sofort der inkrementelle (P1) ab dem letzten Voll-Lauf', async () => {
    opsDocs.set(DOC, { reconcile: { lastFullStartedAtIso: new Date(T0 - 4 * H).toISOString(), lastAttemptAtIso: new Date(T0 - 5 * MIN).toISOString() } });
    tradingImpl = async () => ({ response: { Ack: 'Success', OrderArray: { Order: [] }, PaginationResult: { TotalNumberOfPages: '1', TotalNumberOfEntries: '0' } } });
    const original = tradingImpl;
    let n = 0;
    tradingImpl = async () => {
      n += 1;
      if (n === 2) { // 1 = Intake, 2 = Voll-Abgleich (P2) → Budget lehnt ab
        const err = new Error('eBay Trading skipped for GetOrders: exceeded usage limit (Tagesbudget reserviert: Prioritaet P2, Rest 1400 ≤ Reserve 1500)');
        err.code = 'EBAY_BUDGET_DEFERRED'; err.budgetDeferred = true; err.quotaCooldown = true;
        throw err;
      }
      return original();
    };
    await syncEbayOrders({ lookbackDays: 1, priority: 'P0' });
    expect(tradingCalls.map((c) => c.opts.priority)).toEqual(['P0', 'P2', 'P1']);
    expect(tradingCalls[2].xml).toContain(`<ModTimeFrom>${new Date(T0 - 4 * H - 10 * MIN).toISOString()}</ModTimeFrom>`);
    const doc = opsDocs.get(DOC);
    expect(doc.reconcile.lastMode).toBe('incremental');
    expect(doc.reconcile.lastFullStartedAtIso).toBe(new Date(T0 - 4 * H).toISOString()); // Voll-Lauf bleibt faellig
    tradingImpl = original;
  });

  it('Web-Sicherheitsnetz eskaliert die Prioritaet mit dem Alter des Markers: < 20 min P2, < 60 min P1, danach P0 (Worker tot)', async () => {
    opsDocs.set(DOC, { lastIntakeOkAtIso: new Date(T0 - 10 * MIN).toISOString(), lastIntakeProcess: 'worker' });
    await syncEbayOrders({ lookbackDays: 7, skipIfFreshMs: 6 * MIN, priority: 'P2' });
    expect(tradingCalls[0].opts.priority).toBe('P2');
    tradingCalls.length = 0;
    opsDocs.set(DOC, { lastIntakeOkAtIso: new Date(T0 - 30 * MIN).toISOString(), lastIntakeProcess: 'worker' });
    await syncEbayOrders({ lookbackDays: 7, skipIfFreshMs: 6 * MIN, priority: 'P2' });
    expect(tradingCalls[0].opts.priority).toBe('P1');
    tradingCalls.length = 0;
    opsDocs.set(DOC, { lastIntakeOkAtIso: new Date(T0 - 2 * H).toISOString(), lastIntakeProcess: 'worker' });
    await syncEbayOrders({ lookbackDays: 7, skipIfFreshMs: 6 * MIN, priority: 'P2' });
    expect(tradingCalls[0].opts.priority).toBe('P0');
    tradingCalls.length = 0;
    opsDocs.clear(); // kein Marker: niemand hat je importiert → P0
    await syncEbayOrders({ lookbackDays: 7, skipIfFreshMs: 6 * MIN, priority: 'P2' });
    expect(tradingCalls[0].opts.priority).toBe('P0');
  });

  it('ohne skipIfFreshMs (Worker-Fast-Poll) bleibt die Prioritaet, wie uebergeben', async () => {
    opsDocs.set(DOC, { lastIntakeOkAtIso: new Date(T0 - 2 * H).toISOString(), lastIntakeProcess: 'worker' });
    await syncEbayOrders({ lookbackDays: 1, priority: 'P1' });
    expect(tradingCalls[0].opts.priority).toBe('P1');
  });
});

describe('syncEbayOrders — Prioritaeten an callTradingApi', () => {
  it('Intake traegt die uebergebene Prioritaet, Voll-Abgleich P2, inkrementeller Abgleich P1', async () => {
    await syncEbayOrders({ lookbackDays: 1, priority: 'P0' });
    expect(tradingCalls.map((c) => c.opts.priority)).toEqual(['P0', 'P2']);
    tradingCalls.length = 0;
    vi.setSystemTime(T0 + 10 * MIN);
    await syncEbayOrders({ lookbackDays: 1, priority: 'P0' });
    expect(tradingCalls.map((c) => c.opts.priority)).toEqual(['P0', 'P1']);
  });

  it('ohne Prioritaet: Intake P1', async () => {
    await syncEbayOrders({ lookbackDays: 7 });
    expect(tradingCalls[0].opts.priority).toBe('P1');
  });
});
