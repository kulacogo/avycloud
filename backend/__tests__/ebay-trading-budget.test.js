// globals: true in vitest.config.js — describe/it/expect/vi are global
'use strict';

/**
 * eBay-Trading-Tagesbudget (seit 2026-10-08, Vorfall „Angebots-Abgleich gestoert").
 *
 * Das Trading-Kontingent (5.000 Aufrufe/Tag fuer ALLE Calls zusammen, Reset
 * Mitternacht US-Pazifik) wurde seit 05.10. jeden Tag leer gefahren. Die
 * Budget-Verwaltung ist ein instanzuebergreifender Zaehler mit Prioritaeten:
 * P2 (Spiegel/Komfort) wird gedrosselt, BEVOR P0 (Oversell-Schutz, Auftrags-
 * Import, Versandmeldung) verhungert.
 */

const {
  computeWindow,
  decideBudget,
  budgetLevel,
  resolveReserves,
  lightSyncIntervalMs,
  createBudgetStore,
  normalizePriority,
  DEFAULT_DAILY_LIMIT,
} = require('../lib/ebay-trading-budget');

// ── Fake Firestore (nur was der Store braucht) ─────────────────────────────
function createFakeDb({ failReads = false, failWrites = false } = {}) {
  const docs = new Map();
  const writes = [];
  function applyMerge(target, patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, '__inc')) {
        target[k] = (Number(target[k]) || 0) + v.__inc;
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (!target[k] || typeof target[k] !== 'object') target[k] = {};
        applyMerge(target[k], v);
      } else {
        target[k] = v;
      }
    }
  }
  return {
    docs,
    writes,
    doc(path) {
      return {
        path,
        async get() {
          if (failReads) throw new Error('firestore unavailable (read)');
          const data = docs.get(path);
          return { exists: !!data, data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined) };
        },
        async set(data, opts) {
          if (failWrites) throw new Error('firestore unavailable (write)');
          writes.push({ path, data: JSON.parse(JSON.stringify(data)), opts });
          const current = docs.get(path) || {};
          if (opts && opts.merge) applyMerge(current, data);
          else { for (const k of Object.keys(current)) delete current[k]; applyMerge(current, data); }
          docs.set(path, current);
        },
      };
    },
  };
}
const inc = (n) => ({ __inc: n });

const T_0659Z = Date.parse('2026-10-08T06:59:00Z'); // 23:59 PDT am 07.10.
const T_0701Z = Date.parse('2026-10-08T07:01:00Z'); // 00:01 PDT am 08.10.

describe('computeWindow — Reset-Fenster = Mitternacht US-Pazifik', () => {
  it('ordnet 06:59 UTC dem Vortag zu und setzt den Reset auf 07:00 UTC (Sommerzeit)', () => {
    const w = computeWindow({ nowMs: T_0659Z });
    expect(w.windowKey).toBe('2026-10-07');
    expect(new Date(w.resetAtMs).toISOString()).toBe('2026-10-08T07:00:00.000Z');
    expect(new Date(w.windowStartMs).toISOString()).toBe('2026-10-07T07:00:00.000Z');
  });

  it('beginnt um 07:01 UTC ein neues Fenster', () => {
    const w = computeWindow({ nowMs: T_0701Z });
    expect(w.windowKey).toBe('2026-10-08');
    expect(new Date(w.resetAtMs).toISOString()).toBe('2026-10-09T07:00:00.000Z');
  });

  it('kennt die Winterzeit: im November liegt der Reset bei 08:00 UTC', () => {
    const w = computeWindow({ nowMs: Date.parse('2026-11-05T07:30:00Z') });
    expect(w.windowKey).toBe('2026-11-04');
    expect(new Date(w.resetAtMs).toISOString()).toBe('2026-11-05T08:00:00.000Z');
  });

  it('bevorzugt den von eBay gemeldeten Reset-Zeitpunkt, wenn er plausibel ist', () => {
    const w = computeWindow({ nowMs: T_0659Z, analyticsResetAtIso: '2026-10-08T07:00:00.000Z' });
    expect(new Date(w.resetAtMs).toISOString()).toBe('2026-10-08T07:00:00.000Z');
    expect(w.windowKey).toBe('2026-10-07');
  });

  it('ignoriert einen unplausiblen gemeldeten Reset (Vergangenheit oder > 25 h)', () => {
    const past = computeWindow({ nowMs: T_0701Z, analyticsResetAtIso: '2026-10-08T07:00:00.000Z' });
    expect(new Date(past.resetAtMs).toISOString()).toBe('2026-10-09T07:00:00.000Z');
    const far = computeWindow({ nowMs: T_0701Z, analyticsResetAtIso: '2026-10-12T07:00:00.000Z' });
    expect(new Date(far.resetAtMs).toISOString()).toBe('2026-10-09T07:00:00.000Z');
  });
});

describe('resolveReserves / normalizePriority', () => {
  it('liefert die Voreinstellungen P0-Boden 10, P1-Reserve 400, P2-Reserve 1500', () => {
    // Boden 10 statt 25 (Gegenlese): P0 ist die unterste Stufe, niemand nutzt
    // die letzten Aufrufe sonst — der Boden deckt nur ungeflushte Zaehler
    // anderer Instanzen (≤ 5 s), die eBay-Ablehnung selbst oeffnet den Breaker.
    expect(resolveReserves({})).toEqual({ floorP0: 10, reserveP1: 400, reserveP2: 1500 });
  });

  it('liest ENV-Werte und verwirft Muell (negativ, Text, Reihenfolge verletzt)', () => {
    expect(resolveReserves({ EBAY_BUDGET_FLOOR_P0: '10', EBAY_BUDGET_RESERVE_P1: '300', EBAY_BUDGET_RESERVE_P2: '2000' }))
      .toEqual({ floorP0: 10, reserveP1: 300, reserveP2: 2000 });
    expect(resolveReserves({ EBAY_BUDGET_FLOOR_P0: 'abc', EBAY_BUDGET_RESERVE_P1: '-5' }))
      .toEqual({ floorP0: 10, reserveP1: 400, reserveP2: 1500 });
    // P2-Reserve unter P1-Reserve waere widersinnig → Voreinstellungen
    expect(resolveReserves({ EBAY_BUDGET_RESERVE_P1: '900', EBAY_BUDGET_RESERVE_P2: '500' }))
      .toEqual({ floorP0: 10, reserveP1: 400, reserveP2: 1500 });
  });

  it('normalisiert Prioritaeten: unbekannt → P1', () => {
    expect(normalizePriority('P0')).toBe('P0');
    expect(normalizePriority('p2')).toBe('P2');
    expect(normalizePriority(undefined)).toBe('P1');
    expect(normalizePriority('urgent')).toBe('P1');
  });
});

describe('decideBudget — Reserven schuetzen die kritischen Aufrufe', () => {
  const reserves = { floorP0: 25, reserveP1: 400, reserveP2: 1500 };

  it('P2 wird ab der P2-Reserve abgelehnt, P1 und P0 laufen weiter', () => {
    expect(decideBudget({ priority: 'P2', remaining: 1500, reserves }).allow).toBe(false);
    expect(decideBudget({ priority: 'P2', remaining: 1501, reserves }).allow).toBe(true);
    expect(decideBudget({ priority: 'P1', remaining: 1500, reserves }).allow).toBe(true);
    expect(decideBudget({ priority: 'P0', remaining: 1500, reserves }).allow).toBe(true);
  });

  it('P1 wird ab der P1-Reserve abgelehnt, P0 bis zum Boden erlaubt', () => {
    expect(decideBudget({ priority: 'P1', remaining: 400, reserves }).allow).toBe(false);
    expect(decideBudget({ priority: 'P0', remaining: 400, reserves }).allow).toBe(true);
    expect(decideBudget({ priority: 'P0', remaining: 26, reserves }).allow).toBe(true);
    expect(decideBudget({ priority: 'P0', remaining: 25, reserves }).allow).toBe(false);
  });

  it('nennt im Ablehnungsfall die Reserve und den Grund', () => {
    const d = decideBudget({ priority: 'P2', remaining: 900, reserves });
    expect(d).toMatchObject({ allow: false, reserve: 1500, remaining: 900, reason: 'reserve_reached' });
  });

  it('P0 laeuft mit den Voreinstellungen bis Rest 10 (Boden), nicht 25', () => {
    expect(decideBudget({ priority: 'P0', remaining: 11 }).allow).toBe(true);
    expect(decideBudget({ priority: 'P0', remaining: 10 }).allow).toBe(false);
  });

  it('ist FAIL-OPEN bei unbekanntem Stand (kein Firestore, keine Messung)', () => {
    const d = decideBudget({ priority: 'P2', remaining: null, reserves });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('unknown_state');
  });
});

describe('budgetLevel — Stufen fuer Anzeige und Alarm', () => {
  const reserves = { floorP0: 25, reserveP1: 400, reserveP2: 1500 };
  it('ok > tight > critical > exhausted', () => {
    expect(budgetLevel({ remaining: 3000, reserves })).toBe('ok');
    expect(budgetLevel({ remaining: 1500, reserves })).toBe('tight');
    expect(budgetLevel({ remaining: 400, reserves })).toBe('critical');
    expect(budgetLevel({ remaining: 25, reserves })).toBe('exhausted');
    expect(budgetLevel({ remaining: -3, reserves })).toBe('exhausted');
    expect(budgetLevel({ remaining: null, reserves })).toBe('unknown');
  });
});

describe('lightSyncIntervalMs — Spiegel-Takt nach Restbudget', () => {
  const reserves = { floorP0: 25, reserveP1: 400, reserveP2: 1500 };
  const base = 15 * 60 * 1000;
  it('ueber 60 % Rest: Basis-Takt; 45-60 %: doppelt; darunter: vierfach', () => {
    expect(lightSyncIntervalMs({ remaining: 4000, limit: 5000, reserves, baseIntervalMs: base })).toBe(base);
    expect(lightSyncIntervalMs({ remaining: 3000, limit: 5000, reserves, baseIntervalMs: base })).toBe(base);
    expect(lightSyncIntervalMs({ remaining: 2500, limit: 5000, reserves, baseIntervalMs: base })).toBe(2 * base);
    expect(lightSyncIntervalMs({ remaining: 2000, limit: 5000, reserves, baseIntervalMs: base })).toBe(4 * base);
  });
  it('unter der P2-Reserve: 4x-Takt (als P1 weiterfuehren); erst unter der P1-Reserve pausiert der Spiegel (null)', () => {
    // Gegenlese: ein bis zum Reset eingefrorener Spiegel kennt fremd angelegte
    // Geschwister-/Relist-Angebote nicht — Zero-Stock-End koennte sie nicht beenden.
    expect(lightSyncIntervalMs({ remaining: 1500, limit: 5000, reserves, baseIntervalMs: base })).toBe(4 * base);
    expect(lightSyncIntervalMs({ remaining: 401, limit: 5000, reserves, baseIntervalMs: base })).toBe(4 * base);
    expect(lightSyncIntervalMs({ remaining: 400, limit: 5000, reserves, baseIntervalMs: base })).toBe(null);
  });
  it('unbekannter Stand → Basis-Takt (fail-open)', () => {
    expect(lightSyncIntervalMs({ remaining: null, limit: 5000, reserves, baseIntervalMs: base })).toBe(base);
  });
});

describe('createBudgetStore — instanzuebergreifender Zaehler in Firestore', () => {
  function makeStore(db, extra = {}) {
    return createBudgetStore({
      db,
      incrementValue: inc,
      now: () => extra.nowMs ?? T_0659Z,
      limit: 5000,
      reserves: { floorP0: 25, reserveP1: 400, reserveP2: 1500 },
      cacheTtlMs: 0,
      ...extra,
    });
  }

  it('zaehlt Aufrufe je CallName und Prioritaet im Fenster-Dokument (Increment, gebuendelt)', async () => {
    const db = createFakeDb();
    const store = makeStore(db);
    store.record({ callName: 'GetOrders', priority: 'P0' });
    store.record({ callName: 'GetOrders', priority: 'P0' });
    store.record({ callName: 'GetMyeBaySelling', priority: 'P2' });
    await store.flush();
    const doc = db.docs.get('system/ebay_trading_budget/windows/2026-10-07');
    expect(doc.used).toBe(3);
    expect(doc.usedByCall.GetOrders).toBe(2);
    expect(doc.usedByCall.GetMyeBaySelling).toBe(1);
    expect(doc.usedByPriority.P0).toBe(2);
    expect(doc.usedByPriority.P2).toBe(1);
    expect(doc.windowKey).toBe('2026-10-07');
    expect(db.writes.length).toBe(1); // EIN Write fuer drei Aufrufe
  });

  it('rechnet den Rest aus Limit minus Verbrauch und beruecksichtigt ungeflushte Aufrufe', async () => {
    const db = createFakeDb();
    db.docs.set('system/ebay_trading_budget/windows/2026-10-07', { used: 4000, windowKey: '2026-10-07' });
    const store = makeStore(db);
    store.record({ callName: 'GetOrders', priority: 'P0' });
    const state = await store.getState();
    expect(state.used).toBe(4001);
    expect(state.remaining).toBe(999);
    expect(state.level).toBe('tight');
    expect(state.windowKey).toBe('2026-10-07');
    expect(state.resetAtIso).toBe('2026-10-08T07:00:00.000Z');
  });

  it('vertraut einer frischen eBay-Messung mehr als dem eigenen Zaehler', async () => {
    const db = createFakeDb();
    db.docs.set('system/ebay_trading_budget/windows/2026-10-07', {
      used: 1000,
      probe: { remaining: 2600, limit: 5000, atIso: '2026-10-08T06:50:00.000Z', usedAtProbe: 900 },
    });
    const store = makeStore(db);
    const state = await store.getState();
    // seit der Messung 100 weitere Aufrufe gezaehlt → 2600 − 100
    expect(state.remaining).toBe(2500);
    expect(state.source).toBe('probe');
  });

  it('eine alte Messung (> 30 min) bleibt eine OBERE SCHRANKE: der Rest springt nie ueber den Messwert hinaus (Gegenlese: sonst Sprung nach oben genau im Stoerfall)', async () => {
    const db = createFakeDb();
    db.docs.set('system/ebay_trading_budget/windows/2026-10-07', {
      used: 1000,
      probe: { remaining: 2600, limit: 5000, atIso: '2026-10-08T05:00:00.000Z', usedAtProbe: 900 },
    });
    const store = makeStore(db);
    const state = await store.getState();
    // Zaehler sagt 4000, alte Messung minus seither gezaehlte 100 sagt 2500 → das Minimum
    expect(state.remaining).toBe(2500);
    expect(state.source).toBe('probe_stale');
  });

  it('frische Messung und Zaehler: auch hier gilt das Minimum (Zaehler kann strenger sein als eine aeltere Messung)', async () => {
    const db = createFakeDb();
    db.docs.set('system/ebay_trading_budget/windows/2026-10-07', {
      used: 4900,
      probe: { remaining: 2600, limit: 5000, atIso: '2026-10-08T06:50:00.000Z', usedAtProbe: 100 },
    });
    const store = makeStore(db);
    const state = await store.getState();
    // min(Zaehler 5000−4900 = 100, Messung 2600 − seither 4800 = −2200) → beide sind
    // obere Schranken des echten Rests, die strengere gilt (konservativ).
    expect(state.remaining).toBe(-2200);
    expect(state.level).toBe('exhausted');
  });

  it('verwirft eine Messung aus dem VORHERIGEN Fenster (ueber Mitternacht LA gemessen, danach geschrieben)', async () => {
    const db = createFakeDb();
    const store = createBudgetStore({ db, incrementValue: inc, now: () => T_0701Z, limit: 5000, cacheTtlMs: 0 });
    const out = await store.applyProbe({ remaining: 10, limit: 5000, resetAtIso: '2026-10-08T07:00:00.000Z', atIso: '2026-10-08T06:59:59.000Z' });
    expect(out).toBeNull();
    expect(db.docs.has('system/ebay_trading_budget/windows/2026-10-08')).toBe(false);
    expect((await store.getState()).remaining).toBe(5000);
  });

  it('EBAY_TRADING_DAILY_LIMIT darf das Limit nur nach UNTEN korrigieren (Puffer), eine Messung mit hoeherem Limit hebt es nicht auf', async () => {
    const db = createFakeDb();
    db.docs.set('system/ebay_trading_budget/windows/2026-10-07', {
      used: 1000,
      probe: { remaining: 4000, limit: 5000, atIso: '2026-10-08T06:50:00.000Z', usedAtProbe: 1000 },
    });
    const store = createBudgetStore({ db, incrementValue: inc, now: () => T_0659Z, env: { EBAY_TRADING_DAILY_LIMIT: '4500' }, cacheTtlMs: 0 });
    const state = await store.getState();
    expect(state.limit).toBe(4500);
    expect(state.remaining).toBe(3500); // min(4500−1000, 4000−0)
  });

  it('Lesefehler werden 10 s negativ gecacht — kein Firestore-Read je Trading-Aufruf waehrend einer Stoerung', async () => {
    let reads = 0;
    const failing = { doc: () => ({ get: async () => { reads += 1; throw new Error('DEADLINE_EXCEEDED'); }, set: async () => {} }) };
    let nowMs = T_0659Z;
    const store = createBudgetStore({ db: failing, incrementValue: inc, now: () => nowMs, limit: 5000, cacheTtlMs: 20000 });
    expect((await store.decide({ callName: 'GetOrders', priority: 'P0' })).allow).toBe(true);
    nowMs += 2000;
    expect((await store.decide({ callName: 'GetOrders', priority: 'P0' })).allow).toBe(true);
    expect(reads).toBe(1);
    nowMs += 11000;
    await store.decide({ callName: 'GetOrders', priority: 'P0' });
    expect(reads).toBe(2);
  });

  it('flush(): ein waehrend eines laufenden Flushs eingegangener Aufruf wird NICHT vergessen (naechster Flush wird eingeplant)', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const sets = [];
    const slowDb = { doc: () => ({ get: async () => ({ exists: false }), set: async (data) => { sets.push(data); await gate; } }) };
    const store = createBudgetStore({ db: slowDb, incrementValue: inc, now: () => T_0659Z, limit: 5000, cacheTtlMs: 0, flushDelayMs: 5 });
    store.record({ callName: 'GetOrders', priority: 'P0' });
    const first = store.flush();
    store.record({ callName: 'GetItem', priority: 'P1' });
    const second = store.flush(); // laeuft gerade → muss einen Folge-Flush einplanen
    release();
    await first; await second;
    await new Promise((r) => setTimeout(r, 30));
    expect(sets.length).toBe(2);
    expect(store.pendingCount()).toBe(0);
  });

  it('decide() lehnt P2 ab, wenn die Reserve erreicht ist, und zaehlt die Ablehnung', async () => {
    const db = createFakeDb();
    db.docs.set('system/ebay_trading_budget/windows/2026-10-07', { used: 3600 });
    const store = makeStore(db);
    const d = await store.decide({ callName: 'GetMyeBaySelling', priority: 'P2' });
    expect(d.allow).toBe(false);
    expect(d.remaining).toBe(1400);
    const p0 = await store.decide({ callName: 'EndFixedPriceItem', priority: 'P0' });
    expect(p0.allow).toBe(true);
    await store.flush();
    const doc = db.docs.get('system/ebay_trading_budget/windows/2026-10-07');
    expect(doc.deferredByPriority.P2).toBe(1);
  });

  it('ist FAIL-OPEN, wenn Firestore nicht lesbar ist', async () => {
    const db = createFakeDb({ failReads: true });
    const store = makeStore(db);
    const d = await store.decide({ callName: 'GetMyeBaySelling', priority: 'P2' });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('unknown_state');
  });

  it('verliert ungeflushte Aufrufe bei einem Schreibfehler nicht (naechster Flush traegt sie nach)', async () => {
    const db = createFakeDb({ failWrites: true });
    const store = makeStore(db);
    store.record({ callName: 'GetOrders', priority: 'P0' });
    await store.flush();
    expect(db.docs.has('system/ebay_trading_budget/windows/2026-10-07')).toBe(false);
    db.failWrites = false;
    // Fake-DB-Flag lebt im Closure → neue Referenz mit gleicher Map
    const db2 = createFakeDb();
    db2.docs.set('x', {});
    const store2 = createBudgetStore({ db: db2, incrementValue: inc, now: () => T_0659Z, limit: 5000, cacheTtlMs: 0 });
    store2.record({ callName: 'GetOrders', priority: 'P0' });
    const failing = { doc: () => ({ get: async () => ({ exists: false }), set: async () => { throw new Error('down'); } }) };
    const store3 = createBudgetStore({ db: failing, incrementValue: inc, now: () => T_0659Z, limit: 5000, cacheTtlMs: 0 });
    store3.record({ callName: 'GetOrders', priority: 'P0' });
    await store3.flush();
    expect(store3.pendingCount()).toBe(1);
  });

  it('applyProbe() speichert die eBay-Messung samt Zaehlerstand und Reset-Zeitpunkt', async () => {
    const db = createFakeDb();
    db.docs.set('system/ebay_trading_budget/windows/2026-10-07', { used: 1200 });
    const store = makeStore(db);
    await store.applyProbe({ remaining: 3100, limit: 5000, resetAtIso: '2026-10-08T07:00:00.000Z', atIso: '2026-10-08T06:58:00.000Z' });
    const doc = db.docs.get('system/ebay_trading_budget/windows/2026-10-07');
    expect(doc.probe).toMatchObject({ remaining: 3100, limit: 5000, usedAtProbe: 1200, atIso: '2026-10-08T06:58:00.000Z' });
    expect(doc.resetAtIso).toBe('2026-10-08T07:00:00.000Z');
    const state = await store.getState({ force: true });
    expect(state.remaining).toBe(3100);
  });

  it('wechselt um 07:00 UTC automatisch in ein neues Fenster-Dokument', async () => {
    const db = createFakeDb();
    db.docs.set('system/ebay_trading_budget/windows/2026-10-07', { used: 4990 });
    let nowMs = T_0659Z;
    const store = createBudgetStore({ db, incrementValue: inc, now: () => nowMs, limit: 5000, cacheTtlMs: 0 });
    expect((await store.getState()).remaining).toBe(10);
    nowMs = T_0701Z;
    const fresh = await store.getState();
    expect(fresh.windowKey).toBe('2026-10-08');
    expect(fresh.remaining).toBe(5000);
  });

  it('EBAY_TRADING_BUDGET=off → decide() erlaubt alles, zaehlt aber weiter', async () => {
    const db = createFakeDb();
    db.docs.set('system/ebay_trading_budget/windows/2026-10-07', { used: 4990 });
    const store = makeStore(db, { env: { EBAY_TRADING_BUDGET: 'off' } });
    const d = await store.decide({ callName: 'GetMyeBaySelling', priority: 'P2' });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('disabled');
  });

  it("EBAY_TRADING_BUDGET_STORE='off' (Tests): der Prozess-Store ist inert — kein Firestore-Read, kein Write, alles erlaubt", async () => {
    const { getEbayTradingBudget, _resetForTests } = require('../lib/ebay-trading-budget');
    const prev = process.env.EBAY_TRADING_BUDGET_STORE;
    process.env.EBAY_TRADING_BUDGET_STORE = 'off';
    _resetForTests();
    try {
      const store = getEbayTradingBudget();
      expect(await store.decide({ callName: 'GetOrders', priority: 'P2' })).toMatchObject({ allow: true, reason: 'store_off' });
      expect(await store.getState()).toMatchObject({ unknown: true, remaining: null, level: 'unknown' });
      store.record({ callName: 'GetOrders', priority: 'P0' });
      expect(store.pendingCount()).toBe(0);
      await expect(store.flush()).resolves.toBeUndefined();
      await expect(store.applyProbe({ remaining: 1, limit: 5000 })).resolves.toBeNull();
    } finally {
      if (prev === undefined) delete process.env.EBAY_TRADING_BUDGET_STORE; else process.env.EBAY_TRADING_BUDGET_STORE = prev;
      _resetForTests();
    }
  });

  it('exportiert ein sinnvolles Tageslimit als Voreinstellung', () => {
    expect(DEFAULT_DAILY_LIMIT).toBe(5000);
  });
});
