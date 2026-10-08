// globals: true in vitest.config.js — describe/it/expect/vi are global
'use strict';

/**
 * Vorfall 2026-10-08: der Listing-Spiegel (GetMyeBaySelling, 14 Seiten alle
 * 15 min = 1.344 Trading-Aufrufe/Tag, 27 % des Kontingents) lief unabhaengig
 * davon, wie viel Budget noch da war. Jetzt richtet sich sein Takt nach dem
 * Restbudget: voll → 15 min, knapper → 30/60 min, unter der P2-Reserve →
 * Pause bis zum Reset. Unbekannter Budget-Stand → Basis-Takt (fail-open).
 */

const lightSyncCalls = [];
let budgetState = { remaining: 4000, limit: 5000, level: 'ok', reserves: { floorP0: 25, reserveP1: 400, reserveP2: 1500 }, resetAtIso: '2026-10-09T07:00:00.000Z' };
let budgetThrows = false;

function patch(path, exports) {
  const resolved = require.resolve(path);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
}

const opsWrites = [];
const emptyChain = {
  where: () => emptyChain, orderBy: () => emptyChain, limit: () => emptyChain,
  get: async () => ({ empty: true, docs: [] }),
  doc: () => ({ get: async () => ({ exists: false }), set: async () => {}, update: async () => {} }),
  add: async () => {},
};
const opsChain = {
  ...emptyChain,
  doc: (id) => ({
    get: async () => ({ exists: false }),
    set: async (data, opts) => { opsWrites.push({ id, data, opts }); },
    update: async () => {},
  }),
};
patch('../lib/firestore', { firestore: { collection: (name) => (name === 'ops' ? opsChain : emptyChain), batch: () => ({ update: () => {}, set: () => {}, commit: async () => {} }), getAll: async () => [] } });
patch('../lib/ebay-direct', {
  syncLiveListingsLight: async (opts) => { lightSyncCalls.push(opts); return { skipped: true, reason: 'test' }; },
  healMissingListingLinks: async () => ({ skipped: true }),
});
patch('../lib/kaufland-api', { listUnits: async () => [] });
patch('../services/stock-sync-dispatcher', { syncStockWithRetry: async () => ({ results: [] }), computeAvailableQuantity: async () => ({ availableQty: 0 }) });
patch('../services/sync-event-bus', { bus: { emit: () => {} } });
patch('../lib/listing-snapshot', { recordDailyListingSnapshot: async () => {} });
patch('../lib/ebay-trading-budget', {
  getEbayTradingBudget: () => ({ getState: async () => { if (budgetThrows) throw new Error('firestore down'); return budgetState; } }),
  lightSyncIntervalMs: require('../lib/ebay-trading-budget').lightSyncIntervalMs,
});

const runner = require('../services/listing-sync-runner');

const MIN = 60 * 1000;

beforeEach(() => { lightSyncCalls.length = 0; opsWrites.length = 0; budgetThrows = false; });

describe('planEbayLightSync — reine Entscheidung', () => {
  it('volles Budget → Basis-Takt OHNE Cooldown-Override (Gegenlese: ein Override am Basis-Takt halbierte den Spiegel, sobald ein Zyklus > 60 s dauerte)', () => {
    const plan = runner.planEbayLightSync({ budgetState: { remaining: 4000, limit: 5000, reserves: { floorP0: 25, reserveP1: 400, reserveP2: 1500 } }, baseIntervalMs: 15 * MIN });
    expect(plan).toMatchObject({ run: true, intervalMs: 15 * MIN, cooldownMs: null, reason: 'budget_ok', priority: 'P2' });
  });

  it('knappes Budget → gestreckter Takt', () => {
    const plan = runner.planEbayLightSync({ budgetState: { remaining: 2000, limit: 5000, reserves: { floorP0: 25, reserveP1: 400, reserveP2: 1500 } }, baseIntervalMs: 15 * MIN });
    expect(plan).toMatchObject({ run: true, intervalMs: 60 * MIN, cooldownMs: 59 * MIN, reason: 'budget_stretched', priority: 'P2' });
  });

  it('unter der P2-Reserve → Spiegel laeuft weiter, aber als P1 im 4x-Takt (Geschwister-/Relist-Angebote duerfen nicht 13 h unsichtbar bleiben)', () => {
    const plan = runner.planEbayLightSync({ budgetState: { remaining: 1400, limit: 5000, reserves: { floorP0: 25, reserveP1: 400, reserveP2: 1500 }, resetAtIso: '2026-10-09T07:00:00.000Z' }, baseIntervalMs: 15 * MIN });
    expect(plan).toMatchObject({ run: true, intervalMs: 60 * MIN, cooldownMs: 59 * MIN, reason: 'budget_stretched_p1', priority: 'P1' });
  });

  it('P1-Reserve erreicht → Spiegel pausiert mit Grund und Reset-Zeitpunkt', () => {
    const plan = runner.planEbayLightSync({ budgetState: { remaining: 400, limit: 5000, reserves: { floorP0: 25, reserveP1: 400, reserveP2: 1500 }, resetAtIso: '2026-10-09T07:00:00.000Z' }, baseIntervalMs: 15 * MIN });
    expect(plan).toMatchObject({ run: false, reason: 'budget_reserve', resetAtIso: '2026-10-09T07:00:00.000Z' });
  });

  it("Notbremse EBAY_TRADING_BUDGET='off' (enabled:false) → Basis-Takt, nie pausieren", () => {
    const plan = runner.planEbayLightSync({ budgetState: { enabled: false, remaining: 100, limit: 5000, reserves: { floorP0: 25, reserveP1: 400, reserveP2: 1500 } }, baseIntervalMs: 15 * MIN });
    expect(plan).toMatchObject({ run: true, intervalMs: 15 * MIN, cooldownMs: null, reason: 'budget_disabled' });
  });

  it('unbekannter Stand (null/Fehler) → Basis-Takt, fail-open', () => {
    expect(runner.planEbayLightSync({ budgetState: null, baseIntervalMs: 15 * MIN })).toMatchObject({ run: true, intervalMs: 15 * MIN, reason: 'budget_unknown' });
    expect(runner.planEbayLightSync({ budgetState: { remaining: null }, baseIntervalMs: 15 * MIN })).toMatchObject({ run: true, reason: 'budget_unknown' });
  });
});

describe('runListingSyncCycle — Spiegel folgt dem Budget', () => {
  it('reicht den Budget-Cooldown und die Prioritaet an syncLiveListingsLight durch', async () => {
    budgetState = { remaining: 2500, limit: 5000, reserves: { floorP0: 25, reserveP1: 400, reserveP2: 1500 } };
    await runner.runListingSyncCycle();
    expect(lightSyncCalls).toHaveLength(1);
    expect(lightSyncCalls[0].cooldownMs).toBe(29 * MIN);
    expect(lightSyncCalls[0].priority).toBe('P2');
    expect(lightSyncCalls[0].maxPages).toBe(50);
  });

  it('unter der P2-Reserve laeuft der Spiegel als P1 im 4x-Takt', async () => {
    budgetState = { remaining: 1000, limit: 5000, reserves: { floorP0: 25, reserveP1: 400, reserveP2: 1500 }, resetAtIso: '2026-10-09T07:00:00.000Z' };
    await runner.runListingSyncCycle();
    expect(lightSyncCalls).toHaveLength(1);
    expect(lightSyncCalls[0].priority).toBe('P1');
    expect(lightSyncCalls[0].cooldownMs).toBe(59 * MIN);
    expect(opsWrites.filter((w) => w.data && w.data.lastSkip)).toHaveLength(0);
  });

  it('unter der P1-Reserve ruft er den Spiegel gar nicht erst auf — und hinterlaesst den Grund im Lock-Doc (fuers ehrliche Banner)', async () => {
    budgetState = { remaining: 300, limit: 5000, reserves: { floorP0: 25, reserveP1: 400, reserveP2: 1500 }, resetAtIso: '2026-10-09T07:00:00.000Z' };
    await runner.runListingSyncCycle();
    expect(lightSyncCalls).toHaveLength(0);
    const skip = opsWrites.find((w) => w.id === 'ebayLightSync' && w.data && w.data.lastSkip);
    expect(skip).toBeDefined();
    expect(skip.opts).toEqual({ merge: true });
    expect(skip.data.lastSkip).toMatchObject({ reason: 'budget_reserve', remaining: 300, resetAtIso: '2026-10-09T07:00:00.000Z' });
    expect(typeof skip.data.lastSkip.atIso).toBe('string');
  });

  it('volles Budget → KEIN cooldownMs-Override (ENV/Default-Cooldown bleibt)', async () => {
    budgetState = { remaining: 4000, limit: 5000, reserves: { floorP0: 25, reserveP1: 400, reserveP2: 1500 } };
    await runner.runListingSyncCycle();
    expect(lightSyncCalls).toHaveLength(1);
    expect(lightSyncCalls[0].cooldownMs).toBeUndefined();
  });

  it('laeuft der Spiegel, wird KEIN lastSkip geschrieben', async () => {
    budgetState = { remaining: 4000, limit: 5000, reserves: { floorP0: 25, reserveP1: 400, reserveP2: 1500 } };
    await runner.runListingSyncCycle();
    expect(opsWrites.filter((w) => w.data && w.data.lastSkip)).toHaveLength(0);
  });

  it('Budget nicht lesbar → Spiegel laeuft wie bisher (kein Cooldown-Override)', async () => {
    budgetThrows = true;
    await runner.runListingSyncCycle();
    expect(lightSyncCalls).toHaveLength(1);
    expect(lightSyncCalls[0].cooldownMs).toBeUndefined();
  });
});
