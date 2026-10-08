'use strict';

/**
 * ebay-trading-budget.js — instanzuebergreifendes Tagesbudget fuer die eBay-Trading-API.
 *
 * HINTERGRUND (Vorfall 2026-10-08, „Angebots-Abgleich mit eBay gestoert"):
 * Die Trading-API hat EIN App-Tageskontingent von 5.000 Aufrufen fuer ALLE
 * Calls zusammen (Reset Mitternacht US-Pazifik = 07:00 UTC im Sommer, 08:00 UTC
 * im Winter). Seit dem 05.10. war es jeden Tag Stunden vor dem Reset leer —
 * und waehrend der Sperre faellt ALLES aus: Auftrags-Import, Zero-Stock-Ends
 * (Oversell-Fenster), Versandmeldungen, der Listing-Spiegel. Das Kontingent
 * wurde von Komfort-Aufrufen (UI-Abgleiche, 15-min-Spiegel) aufgebraucht,
 * bevor die kritischen Aufrufe an die Reihe kamen.
 *
 * LOESUNG: Jeder Trading-Aufruf traegt eine Prioritaet, und ein in Firestore
 * geteilter Zaehler (alle Cloud-Run-Instanzen, Web UND Worker) entscheidet VOR
 * dem Aufruf, ob die Prioritaet das Restbudget noch benutzen darf:
 *
 *   P0  Oversell-Schutz (End/Revise auf die verfuegbare Menge), Auftrags-Import
 *       des Workers, Versandmeldung (CompleteSale) — laeuft bis zum Boden (25).
 *   P1  Alles Wichtige, aber Nachholbare (inkrementeller Auftrags-Abgleich,
 *       Publish aus der Oberflaeche, GetItem-Pruefungen) — bis Reserve 400.
 *   P2  Spiegel und Komfort (GetMyeBaySelling-Light-Sync, 30-Tage-Voll-
 *       Abgleich, UI-ausgeloeste Syncs, Kategorien/Profile) — bis Reserve 1.500.
 *
 * Rest = Limit − gezaehlte Aufrufe; liegt eine frische Messung der Developer-
 * Analytics-API vor (eigenes Kontingent, kein Trading-Call), gewinnt sie —
 * sie sieht auch Aufrufe, die NICHT durch diesen Prozess gingen (Scripts).
 *
 * FAIL-OPEN: Firestore-Fehler, fehlende Messung, unbekannter Stand → erlauben.
 * Lieber ein Aufruf zu viel als ein blockiertes System. Notbremse
 * EBAY_TRADING_BUDGET='off' (nur exakt dieser Wert) schaltet die Entscheidung
 * ab; gezaehlt wird dann trotzdem weiter (Sichtbarkeit).
 *
 * Schreiblast: Aufrufe werden im Prozess gesammelt und gebuendelt als
 * FieldValue.increment() geschrieben — kein Firestore-Write je Trading-Call.
 */

const DOC_ROOT = 'system/ebay_trading_budget';
const WINDOW_TZ = 'America/Los_Angeles';
const DEFAULT_DAILY_LIMIT = 5000;
// P0-Boden 10 (nicht 25, Gegenlese): P0 ist die unterste Stufe — niemand nutzt
// die letzten Aufrufe sonst; der Boden deckt nur ungeflushte Zaehler anderer
// Instanzen (≤ 5 s). Die eBay-Ablehnung selbst oeffnet den Breaker.
const DEFAULT_RESERVES = Object.freeze({ floorP0: 10, reserveP1: 400, reserveP2: 1500 });
const PROBE_MAX_AGE_MS = 30 * 60 * 1000;
const DEFAULT_CACHE_TTL_MS = 20 * 1000;
const READ_ERROR_CACHE_TTL_MS = 10 * 1000;
const DEFAULT_FLUSH_DELAY_MS = 5 * 1000;
const MAX_PLAUSIBLE_RESET_AHEAD_MS = 25 * 60 * 60 * 1000;
const PENDING_CAP = 50000;
const PRIORITIES = ['P0', 'P1', 'P2'];

function budgetEnabled(env = process.env) {
  return String((env && env.EBAY_TRADING_BUDGET) || '').trim().toLowerCase() !== 'off';
}

function normalizePriority(priority) {
  const p = String(priority || '').trim().toUpperCase();
  return p === 'P0' || p === 'P2' ? p : 'P1';
}

function parseNonNegativeInt(value) {
  const n = Number.parseInt(String(value == null ? '' : value).trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Reserven aus ENV, Voreinstellungen bei Muell oder verletzter Reihenfolge. */
function resolveReserves(env = process.env) {
  const e = env || {};
  const out = {
    floorP0: parseNonNegativeInt(e.EBAY_BUDGET_FLOOR_P0) ?? DEFAULT_RESERVES.floorP0,
    reserveP1: parseNonNegativeInt(e.EBAY_BUDGET_RESERVE_P1) ?? DEFAULT_RESERVES.reserveP1,
    reserveP2: parseNonNegativeInt(e.EBAY_BUDGET_RESERVE_P2) ?? DEFAULT_RESERVES.reserveP2,
  };
  if (!(out.floorP0 <= out.reserveP1 && out.reserveP1 <= out.reserveP2)) return { ...DEFAULT_RESERVES };
  return out;
}

function resolveDailyLimit(env = process.env) {
  const n = parseNonNegativeInt(env && env.EBAY_TRADING_DAILY_LIMIT);
  return n && n > 0 ? n : DEFAULT_DAILY_LIMIT;
}

/** Explizit gesetztes ENV-Limit? Dann darf es eine Messung nur nach UNTEN korrigieren (Puffer). */
function explicitDailyLimit(env = process.env) {
  const n = parseNonNegativeInt(env && env.EBAY_TRADING_DAILY_LIMIT);
  return n && n > 0 ? n : null;
}

// ── Reset-Fenster (Mitternacht US-Pazifik) ──────────────────────────────────

const _laFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: WINDOW_TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

function laParts(ms) {
  const parts = {};
  for (const p of _laFormatter.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return parts; // { year, month, day, hour, minute }
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** UTC-Zeitpunkt von Mitternacht (LA) des gegebenen LA-Kalendertags. */
function laMidnightUtcMs(year, month, day) {
  for (const offsetHours of [8, 7]) { // PST = UTC-8, PDT = UTC-7
    const candidate = Date.UTC(year, month - 1, day, offsetHours, 0, 0, 0);
    const p = laParts(candidate);
    if (p.year === year && p.month === month && p.day === day && p.hour === 0 && p.minute === 0) return candidate;
  }
  return Date.UTC(year, month - 1, day, 8, 0, 0, 0);
}

/**
 * Fenster, in dem `nowMs` liegt: Schluessel (LA-Datum), Beginn, naechster Reset.
 * Ein von eBay gemeldeter Reset (Developer-Analytics `reset`) gewinnt, wenn er
 * in der Zukunft und hoechstens 25 h entfernt liegt.
 */
function computeWindow({ nowMs = Date.now(), analyticsResetAtIso = null } = {}) {
  const p = laParts(nowMs);
  const windowStartMs = laMidnightUtcMs(p.year, p.month, p.day);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  let resetAtMs = laMidnightUtcMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  const reported = analyticsResetAtIso ? Date.parse(analyticsResetAtIso) : NaN;
  if (Number.isFinite(reported) && reported > nowMs && reported - nowMs <= MAX_PLAUSIBLE_RESET_AHEAD_MS) {
    resetAtMs = reported;
  }
  return {
    windowKey: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`,
    windowStartMs,
    resetAtMs,
  };
}

// ── Reine Entscheidungen ────────────────────────────────────────────────────

function reserveFor(priority, reserves) {
  const r = reserves || DEFAULT_RESERVES;
  if (priority === 'P0') return r.floorP0;
  if (priority === 'P2') return r.reserveP2;
  return r.reserveP1;
}

function decideBudget({ priority, remaining, reserves = DEFAULT_RESERVES } = {}) {
  const p = normalizePriority(priority);
  if (!Number.isFinite(remaining)) {
    return { allow: true, reason: 'unknown_state', priority: p, remaining: null, reserve: null };
  }
  const reserve = reserveFor(p, reserves);
  const allow = remaining > reserve;
  return { allow, reason: allow ? 'ok' : 'reserve_reached', priority: p, remaining, reserve };
}

function budgetLevel({ remaining, reserves = DEFAULT_RESERVES } = {}) {
  if (!Number.isFinite(remaining)) return 'unknown';
  const r = reserves || DEFAULT_RESERVES;
  if (remaining <= r.floorP0) return 'exhausted';
  if (remaining <= r.reserveP1) return 'critical';
  if (remaining <= r.reserveP2) return 'tight';
  return 'ok';
}

/**
 * Takt des Listing-Spiegels nach Restbudget. Zwischen P2- und P1-Reserve
 * laeuft er im 4x-Takt weiter (der Aufrufer stuft ihn dort als P1 ein — ein
 * eingefrorener Spiegel kennt fremd angelegte Geschwister-/Relist-Angebote
 * nicht). null = Spiegel pausiert (P1-Reserve erreicht). Unbekannter Stand →
 * Basis-Takt (fail-open).
 */
function lightSyncIntervalMs({ remaining, limit = DEFAULT_DAILY_LIMIT, reserves = DEFAULT_RESERVES, baseIntervalMs } = {}) {
  const base = Number(baseIntervalMs) > 0 ? Number(baseIntervalMs) : 15 * 60 * 1000;
  if (!Number.isFinite(remaining)) return base;
  const r = reserves || DEFAULT_RESERVES;
  if (remaining <= r.reserveP1) return null;
  if (remaining <= r.reserveP2) return 4 * base;
  const fraction = limit > 0 ? remaining / limit : 1;
  if (fraction >= 0.6) return base;
  if (fraction >= 0.45) return 2 * base;
  return 4 * base;
}

// ── Firestore-Store ─────────────────────────────────────────────────────────

function emptyPending() {
  return { used: 0, byCall: {}, byPriority: {}, deferred: {} };
}

function addCounts(target, source) {
  for (const [k, v] of Object.entries(source || {})) target[k] = (target[k] || 0) + v;
}

function defaultIncrementValue() {
  const { FieldValue } = require('@google-cloud/firestore');
  return (n) => FieldValue.increment(n);
}

function createBudgetStore({
  db = null,
  incrementValue = null,
  now = () => Date.now(),
  limit = null,
  reserves = null,
  env = process.env,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  flushDelayMs = DEFAULT_FLUSH_DELAY_MS,
  logger = console,
} = {}) {
  const getDb = () => db || require('./firestore').firestore;
  const inc = incrementValue || defaultIncrementValue();
  const effectiveReserves = reserves || resolveReserves(env);
  const configuredLimit = limit || resolveDailyLimit(env);

  let pending = emptyPending();
  let cache = { windowKey: null, data: null, fetchedAt: 0 };
  let flushTimer = null;
  let flushing = null;

  const docPath = (windowKey) => `${DOC_ROOT}/windows/${windowKey}`;

  function scheduleFlush() {
    if (flushTimer || !(flushDelayMs > 0)) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush().catch(() => {});
    }, flushDelayMs);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  }

  function record({ callName, priority, count = 1 } = {}) {
    const n = Number(count) > 0 ? Number(count) : 1;
    if (pending.used >= PENDING_CAP) return;
    const call = String(callName || 'unknown').replace(/[.~/*\[\]]/g, '_') || 'unknown';
    const p = normalizePriority(priority);
    pending.used += n;
    pending.byCall[call] = (pending.byCall[call] || 0) + n;
    pending.byPriority[p] = (pending.byPriority[p] || 0) + n;
    scheduleFlush();
  }

  function recordDeferral(priority) {
    const p = normalizePriority(priority);
    pending.deferred[p] = (pending.deferred[p] || 0) + 1;
    scheduleFlush();
  }

  async function flush() {
    // Laeuft gerade ein Flush, den naechsten einplanen (Gegenlese: sonst blieb
    // eine zweite Charge ohne Timer liegen, bis der naechste record() kam).
    if (flushing) { scheduleFlush(); return flushing; }
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    const snapshot = pending;
    const hasCalls = snapshot.used > 0;
    const hasDeferrals = Object.keys(snapshot.deferred).length > 0;
    if (!hasCalls && !hasDeferrals) return;
    pending = emptyPending();
    const nowMs = now();
    const window = computeWindow({ nowMs });
    const payload = {
      windowKey: window.windowKey,
      windowStartIso: new Date(window.windowStartMs).toISOString(),
      limit: configuredLimit,
      updatedAt: new Date(nowMs).toISOString(),
    };
    if (hasCalls) {
      payload.used = inc(snapshot.used);
      payload.usedByCall = Object.fromEntries(Object.entries(snapshot.byCall).map(([k, v]) => [k, inc(v)]));
      payload.usedByPriority = Object.fromEntries(Object.entries(snapshot.byPriority).map(([k, v]) => [k, inc(v)]));
    }
    if (hasDeferrals) {
      payload.deferredByPriority = Object.fromEntries(Object.entries(snapshot.deferred).map(([k, v]) => [k, inc(v)]));
    }
    flushing = (async () => {
      try {
        await getDb().doc(docPath(window.windowKey)).set(payload, { merge: true });
        cache.fetchedAt = 0; // naechster Lesezugriff holt den frischen Stand
      } catch (err) {
        // Nichts verlieren: zurueck in den Topf, naechster Flush traegt nach.
        const merged = emptyPending();
        addCounts(merged.byCall, snapshot.byCall); addCounts(merged.byCall, pending.byCall);
        addCounts(merged.byPriority, snapshot.byPriority); addCounts(merged.byPriority, pending.byPriority);
        addCounts(merged.deferred, snapshot.deferred); addCounts(merged.deferred, pending.deferred);
        merged.used = snapshot.used + pending.used;
        pending = merged;
        // Uneindeutiger Ausgang (DEADLINE_EXCEEDED/UNAVAILABLE nach Commit) kann
        // die Charge doppelt zaehlen — konservativ (Rest zu klein), die naechste
        // Messung korrigiert es. Bewusst so belassen, aber sichtbar geloggt.
        if (logger && typeof logger.warn === 'function') logger.warn(`[ebay-budget] flush failed (kept ${pending.used} pending, code=${err && err.code}): ${err && err.message}`);
      } finally {
        flushing = null;
        if (pending.used > 0 || Object.keys(pending.deferred).length > 0) scheduleFlush();
      }
    })();
    return flushing;
  }

  async function readWindowDoc(windowKey, { force = false } = {}) {
    const nowMs = now();
    if (!force && cache.windowKey === windowKey && cache.fetchedAt > 0 && nowMs - cache.fetchedAt < cacheTtlMs) {
      if (cache.error) throw cache.error;
      return cache.data;
    }
    try {
      const snap = await getDb().doc(docPath(windowKey)).get();
      const data = snap && snap.exists ? (snap.data() || {}) : {};
      cache = { windowKey, data, fetchedAt: nowMs };
      return data;
    } catch (err) {
      // Negativ-Cache (Gegenlese): waehrend einer Firestore-Stoerung soll nicht
      // JEDER Trading-Aufruf einen vollen Read samt Timeout bezahlen.
      cache = { windowKey, data: null, fetchedAt: nowMs - Math.max(0, cacheTtlMs - READ_ERROR_CACHE_TTL_MS), error: err };
      throw err;
    }
  }

  function probeIsFresh(probe, nowMs) {
    if (!probe || !Number.isFinite(Number(probe.remaining))) return false;
    const at = Date.parse(probe.atIso || '');
    return Number.isFinite(at) && nowMs - at >= 0 && nowMs - at <= PROBE_MAX_AGE_MS;
  }

  async function getState({ force = false } = {}) {
    const nowMs = now();
    const baseWindow = computeWindow({ nowMs });
    let data;
    try {
      data = await readWindowDoc(baseWindow.windowKey, { force });
    } catch (err) {
      return {
        unknown: true,
        enabled: budgetEnabled(env),
        windowKey: baseWindow.windowKey,
        windowStartIso: new Date(baseWindow.windowStartMs).toISOString(),
        resetAtIso: new Date(baseWindow.resetAtMs).toISOString(),
        limit: configuredLimit,
        used: null,
        remaining: null,
        level: 'unknown',
        source: 'unknown',
        reserves: { ...effectiveReserves },
        error: err && err.message ? err.message : String(err),
      };
    }
    const probe = data.probe && typeof data.probe === 'object' ? data.probe : null;
    const window = computeWindow({ nowMs, analyticsResetAtIso: data.resetAtIso || (probe && probe.resetAtIso) || null });
    const used = (Number(data.used) || 0) + pending.used;
    const probeLimit = probe && Number.isFinite(Number(probe.limit)) && Number(probe.limit) > 0 ? Number(probe.limit) : null;
    // Ein explizit gesetztes ENV-Limit darf eine Messung nur nach UNTEN
    // korrigieren (Puffer gegen Zaehlfehler); ohne ENV gewinnt die Messung
    // (nach einem Growth Check automatisch hoeher).
    const envLimit = explicitDailyLimit(env);
    const effectiveLimit = envLimit ? Math.min(envLimit, probeLimit || envLimit) : (probeLimit || configuredLimit);
    // Rest = das MINIMUM aus Zaehler und (Messung − seither gezaehlte Aufrufe):
    // beide sind obere Schranken des echten Rests; eine Messung bleibt auch
    // alt eine gueltige Schranke (eBays Rest kann im Fenster nur sinken) —
    // vorher sprang der Rest nach 30 min ohne Messung nach OBEN, genau im
    // Stoerfall (Gegenlese).
    const counterRemaining = effectiveLimit - used;
    let remaining = counterRemaining;
    let source = 'counter';
    if (probe && Number.isFinite(Number(probe.remaining))) {
      const sinceProbe = Math.max(0, used - (Number(probe.usedAtProbe) || 0));
      const probeRemaining = Number(probe.remaining) - sinceProbe;
      remaining = Math.min(counterRemaining, probeRemaining);
      source = probeIsFresh(probe, nowMs) ? 'probe' : 'probe_stale';
    }
    const usedByCall = { ...(data.usedByCall || {}) };
    addCounts(usedByCall, pending.byCall);
    const usedByPriority = { ...(data.usedByPriority || {}) };
    addCounts(usedByPriority, pending.byPriority);
    const deferredByPriority = { ...(data.deferredByPriority || {}) };
    addCounts(deferredByPriority, pending.deferred);
    return {
      unknown: false,
      enabled: budgetEnabled(env),
      windowKey: window.windowKey,
      windowStartIso: new Date(window.windowStartMs).toISOString(),
      resetAtIso: new Date(window.resetAtMs).toISOString(),
      limit: effectiveLimit,
      used,
      usedByCall,
      usedByPriority,
      deferredByPriority,
      remaining,
      level: budgetLevel({ remaining, reserves: effectiveReserves }),
      source,
      probe: probe ? { ...probe } : null,
      reserves: { ...effectiveReserves },
    };
  }

  async function decide({ callName, priority } = {}) {
    const p = normalizePriority(priority);
    if (!budgetEnabled(env)) return { allow: true, reason: 'disabled', priority: p, remaining: null, reserve: null };
    const state = await getState();
    const verdict = decideBudget({ priority: p, remaining: state.remaining, reserves: effectiveReserves });
    if (!verdict.allow) recordDeferral(p);
    return { ...verdict, callName: callName || null, level: state.level, resetAtIso: state.resetAtIso, windowKey: state.windowKey, source: state.source };
  }

  async function applyProbe({ remaining, limit: probeLimit, resetAtIso, atIso } = {}) {
    const nowMs = now();
    const window = computeWindow({ nowMs, analyticsResetAtIso: resetAtIso || null });
    // Fenster aus dem MESSzeitpunkt (Gegenlese): eine kurz vor Mitternacht LA
    // gemessene „Rest 10"-Zahl darf nicht ins frische Fenster geschrieben
    // werden — sie haette P0 fuer bis zu 15 min nach dem Reset gesperrt.
    const measuredAtMs = Date.parse(atIso || '');
    if (Number.isFinite(measuredAtMs)) {
      const measuredWindow = computeWindow({ nowMs: measuredAtMs });
      if (measuredWindow.windowKey !== window.windowKey) {
        if (logger && typeof logger.warn === 'function') logger.warn(`[ebay-budget] Messung aus altem Fenster (${measuredWindow.windowKey}) verworfen — aktuelles Fenster ${window.windowKey}`);
        return null;
      }
    }
    let current = {};
    try { current = await readWindowDoc(window.windowKey, { force: true }); } catch (_) { current = {}; }
    const payload = {
      windowKey: window.windowKey,
      windowStartIso: new Date(window.windowStartMs).toISOString(),
      probe: {
        remaining: Number(remaining),
        limit: Number.isFinite(Number(probeLimit)) ? Number(probeLimit) : configuredLimit,
        resetAtIso: resetAtIso || null,
        atIso: atIso || new Date(nowMs).toISOString(),
        usedAtProbe: (Number(current.used) || 0) + pending.used,
      },
      updatedAt: new Date(nowMs).toISOString(),
    };
    if (resetAtIso) payload.resetAtIso = resetAtIso;
    await getDb().doc(docPath(window.windowKey)).set(payload, { merge: true });
    cache.fetchedAt = 0;
    return payload.probe;
  }

  function pendingCount() { return pending.used; }

  return { record, flush, getState, decide, applyProbe, pendingCount, reserves: { ...effectiveReserves }, limit: configuredLimit };
}

// ── Prozessweiter Store (Produktion) ────────────────────────────────────────

// EBAY_TRADING_BUDGET_STORE='off' (vitest.setup.js): kein Firestore-Zugriff
// ueberhaupt. Ohne den Schalter lasen Tests, die callTradingApi durchlaufen,
// die PRODUKTIONS-Datenbank (lib/firestore.js faellt auf Projekt avycloud
// zurueck) und hingen auf dem GitHub-Runner ohne Anmeldedaten 10 s.
function createInertStore() {
  const unknown = () => ({
    unknown: true, enabled: false, windowKey: null, windowStartIso: null, resetAtIso: null,
    limit: DEFAULT_DAILY_LIMIT, used: null, remaining: null, level: 'unknown', source: 'unknown',
    reserves: { ...DEFAULT_RESERVES },
  });
  return {
    record() {},
    async flush() {},
    async getState() { return unknown(); },
    async decide({ priority } = {}) { return { allow: true, reason: 'store_off', priority: normalizePriority(priority), remaining: null, reserve: null }; },
    async applyProbe() { return null; },
    pendingCount() { return 0; },
    reserves: { ...DEFAULT_RESERVES },
    limit: DEFAULT_DAILY_LIMIT,
  };
}

let _store = null;
function getEbayTradingBudget() {
  if (!_store) {
    _store = String(process.env.EBAY_TRADING_BUDGET_STORE || '').trim().toLowerCase() === 'off'
      ? createInertStore()
      : createBudgetStore({});
  }
  return _store;
}
function _resetForTests() { _store = null; }

module.exports = {
  DOC_ROOT,
  DEFAULT_DAILY_LIMIT,
  DEFAULT_RESERVES,
  PROBE_MAX_AGE_MS,
  PRIORITIES,
  budgetEnabled,
  normalizePriority,
  resolveReserves,
  resolveDailyLimit,
  explicitDailyLimit,
  computeWindow,
  decideBudget,
  budgetLevel,
  lightSyncIntervalMs,
  createBudgetStore,
  getEbayTradingBudget,
  _resetForTests,
};
