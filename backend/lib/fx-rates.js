'use strict';

/**
 * fx-rates.js — EZB-Referenzkurse fuer Marktplatz-Bestellungen in Fremdwaehrung.
 *
 * ANLASS (2026-10-05): Kaufland.cz-Bestellung M53KUW5 ueber 534,14 CZK wurde als
 * 534,14 EUR gespeichert — die Kaufland-API liefert je Position `currency` (EUR|CZK|PLN)
 * und `storefront`, aber keinen Wechselkurs; Kaufland rechnet erst bei der Auszahlung
 * in Euro um und nennt den Kurs ueber die API nicht.
 *
 * QUELLE: die EZB-Referenzkurse (ohne Anmeldung, keine Abhaengigkeit):
 *   - eurofxref-hist-90d.xml  — die letzten ~90 Tage, taeglich ~16:00 MEZ, CZK + PLN enthalten
 *   - eurofxref-hist.xml      — volle Historie (nur fuer Reparaturlaeufe alter Auftraege)
 * Gemessen 05.10.2026: letzter Eintrag 2026-10-02 (Freitag), CZK 24,470 / PLN 4,3775.
 *
 * REGELN:
 *   - Fuer ein Datum gilt der LETZTE veroeffentlichte Kurs <= Datum (Wochenende → Freitag).
 *     Ein Datum VOR dem ersten bekannten Kurs bekommt nie den aeltesten Kurs geraten.
 *   - Die Tabelle liegt im Prozess und als Kopie in Firestore (`system/fx-rates-ecb`,
 *     dieselbe Stelle wie `system/kaufland-sync-state`; Referenzdaten, kein Mandantendatum),
 *     auf 400 Tage begrenzt. Netzaufruf nur, wenn das Datum juenger ist als der letzte
 *     bekannte Kurs — und dann hoechstens alle 6 Stunden. Gleichzeitige Aufrufer teilen
 *     sich EINEN Aufruf.
 *   - Faellt die EZB aus, gilt ein datierter NOTKURS (`FALLBACK_RATES`) und das Ergebnis
 *     ist `pending: true` — die Groessenordnung stimmt, der echte Kurs kommt beim naechsten
 *     Abgleich (lib/order-currency.js needsCurrencyHeal). Der Intake wird NIE blockiert:
 *     eine fehlende Bestellung ist keine Reservierung und damit ein Oversell-Risiko.
 *   - Ein kaputter Speicher (Firestore) bremst nicht: Laden und Schreiben sind best-effort.
 */

const ECB_HIST_90D_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml';
const ECB_HIST_FULL_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml';

/** Notkurs — NUR wenn die EZB nicht erreichbar ist. Stand 05.10.2026 (EZB vom 02.10.2026). */
const FALLBACK_RATES = Object.freeze({
  asOf: '2026-10-05',
  rates: Object.freeze({ CZK: 24.5, PLN: 4.35 }),
});

const MAX_HISTORY_DAYS = 400;
const REFRESH_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const FX_COLLECTION = 'system';
const FX_DOC = 'fx-rates-ecb';

function toDateKey(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : s;
  }
  const d = value instanceof Date ? value : new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function readAttr(attrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*['"]([^'"]*)['"]`, 'i').exec(attrs || '');
  return m ? m[1] : null;
}

/**
 * Liest die EZB-XML-Datei in eine Tabelle { 'YYYY-MM-DD': { CZK: 24.47, … } }.
 * Wirft nie — Muell ergibt eine leere Tabelle.
 */
function parseEcbXml(xml) {
  const table = {};
  const text = typeof xml === 'string' ? xml : '';
  if (!text) return table;

  const dayRe = /<Cube\s+time\s*=\s*['"](\d{4}-\d{2}-\d{2})['"][^>]*>([\s\S]*?)<\/Cube>/g;
  let day;
  while ((day = dayRe.exec(text))) {
    const rates = {};
    const cubeRe = /<Cube\b([^>]*)\/?>/g;
    let cube;
    while ((cube = cubeRe.exec(day[2]))) {
      const currency = readAttr(cube[1], 'currency');
      const rate = Number(readAttr(cube[1], 'rate'));
      if (currency && /^[A-Za-z]{3}$/.test(currency) && Number.isFinite(rate) && rate > 0) {
        rates[currency.toUpperCase()] = rate;
      }
    }
    table[day[1]] = rates;
  }
  return table;
}

function latestDate(table) {
  let best = null;
  for (const d of Object.keys(table || {})) if (best == null || d > best) best = d;
  return best;
}

function earliestDate(table) {
  let best = null;
  for (const d of Object.keys(table || {})) if (best == null || d < best) best = d;
  return best;
}

/**
 * Letzter veroeffentlichter Kurs <= Datum. Null, wenn die Waehrung fehlt, das Datum
 * ungueltig ist oder vor dem ersten bekannten Kurs liegt.
 */
function pickRateForDate(table, currency, date) {
  const ccy = String(currency || '').trim().toUpperCase();
  const key = toDateKey(date);
  if (!ccy || !key || !table || typeof table !== 'object') return null;
  let best = null;
  for (const d of Object.keys(table)) {
    if (d > key) continue;
    const v = table[d] && table[d][ccy];
    if (!(Number.isFinite(v) && v > 0)) continue;
    if (best == null || d > best) best = d;
  }
  return best ? { rate: table[best][ccy], rateDate: best } : null;
}

/** Fremdwaehrungsbetrag → Euro, cent-genau. `rate` = Fremdwaehrung je 1 EUR (EZB-Quotierung). */
function convertToEur(amount, rate) {
  const a = Number(amount);
  const r = Number(rate);
  if (!Number.isFinite(a) || !Number.isFinite(r) || r <= 0) return null;
  return Math.round((a / r) * 100) / 100;
}

/** Nur die juengsten `maxDays` Tage behalten — die Firestore-Kopie darf nicht ins Unendliche wachsen. */
function pruneTable(table, maxDays = MAX_HISTORY_DAYS) {
  const keys = Object.keys(table || {}).sort();
  const keep = keys.slice(Math.max(0, keys.length - Math.max(1, maxDays)));
  const out = {};
  for (const k of keep) out[k] = table[k];
  return out;
}

function defaultFetch(...args) {
  // Lazy: in Tests wird fetchImpl injiziert, node-fetch muss dort nicht geladen werden.
  const fetch = require('node-fetch');
  return fetch(...args);
}

/**
 * Baut einen Kurs-Aufloeser. Alles injizierbar (Netz, Speicher, Uhr) — der Kern ist testbar
 * ohne Firestore und ohne Internet.
 *
 * @param {{ fetchImpl?: Function, store?: { load: Function, save: Function }|null, now?: Function,
 *           fallback?: { asOf: string, rates: object }, timeoutMs?: number }} opts
 */
function createFxRateResolver({
  fetchImpl = defaultFetch,
  store = null,
  now = () => new Date(),
  fallback = FALLBACK_RATES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const state = {
    table: {},
    fullTable: null,
    storeLoaded: false,
    storeLoading: null,
    nextFetchAllowedAt: 0,
    inflight90d: null,
    inflightFull: null,
  };

  async function fetchXml(url) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs)) : null;
    try {
      const res = await fetchImpl(url, controller ? { signal: controller.signal } : {});
      if (!res || !res.ok) throw new Error(`EZB antwortete mit HTTP ${res ? res.status : '?'}`);
      return await res.text();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function loadStore() {
    if (state.storeLoaded || !store) return;
    if (!state.storeLoading) {
      state.storeLoading = (async () => {
        try {
          const loaded = await store.load();
          if (loaded && typeof loaded === 'object') state.table = { ...loaded, ...state.table };
        } catch (err) {
          console.warn(`[fx-rates] Kurs-Speicher nicht lesbar (weiter ohne): ${err?.message || err}`);
        } finally {
          state.storeLoaded = true;
          state.storeLoading = null;
        }
      })();
    }
    await state.storeLoading;
  }

  async function refresh90d() {
    if (state.inflight90d) return state.inflight90d;
    state.inflight90d = (async () => {
      const startedAt = now().getTime();
      try {
        const parsed = parseEcbXml(await fetchXml(ECB_HIST_90D_URL));
        if (!Object.keys(parsed).length) throw new Error('EZB-Datei enthaelt keine Kurse');
        state.table = pruneTable({ ...state.table, ...parsed }, MAX_HISTORY_DAYS);
        state.nextFetchAllowedAt = startedAt + REFRESH_MIN_INTERVAL_MS;
        if (store) {
          try {
            await store.save(state.table);
          } catch (err) {
            console.warn(`[fx-rates] Kurs-Speicher nicht schreibbar (weiter ohne): ${err?.message || err}`);
          }
        }
        return true;
      } catch (err) {
        state.nextFetchAllowedAt = startedAt + RETRY_AFTER_FAILURE_MS;
        console.warn(`[fx-rates] EZB-Kurse nicht abrufbar: ${err?.message || err}`);
        return false;
      } finally {
        state.inflight90d = null;
      }
    })();
    return state.inflight90d;
  }

  async function loadFullHistory() {
    if (state.fullTable) return state.fullTable;
    if (state.inflightFull) return state.inflightFull;
    state.inflightFull = (async () => {
      try {
        const parsed = parseEcbXml(await fetchXml(ECB_HIST_FULL_URL));
        if (Object.keys(parsed).length) state.fullTable = parsed; // bewusst NICHT in den Speicher (Dokumentgroesse)
      } catch (err) {
        console.warn(`[fx-rates] volle EZB-Historie nicht abrufbar: ${err?.message || err}`);
      } finally {
        state.inflightFull = null;
      }
      return state.fullTable;
    })();
    return state.inflightFull;
  }

  function finish(ccy, hit) {
    if (hit) return { currency: ccy, rate: hit.rate, rateDate: hit.rateDate, source: 'ecb', pending: false };
    const fb = fallback && fallback.rates ? fallback.rates[ccy] : null;
    if (Number.isFinite(fb) && fb > 0) {
      return { currency: ccy, rate: fb, rateDate: fallback.asOf || null, source: 'static_fallback', pending: true };
    }
    return { currency: ccy, rate: null, rateDate: null, source: 'none', pending: true };
  }

  /**
   * @param {{ currency: string, date?: string|Date }} opts
   * @returns {Promise<{currency: string, rate: number|null, rateDate: string|null, source: 'identity'|'ecb'|'static_fallback'|'none', pending: boolean}>}
   */
  async function getEurRate({ currency, date } = {}) {
    const ccy = String(currency || '').trim().toUpperCase();
    if (!ccy || ccy === 'EUR') return { currency: 'EUR', rate: 1, rateDate: null, source: 'identity', pending: false };
    const key = toDateKey(date) || toDateKey(now());

    await loadStore();

    let hit = pickRateForDate(state.table, ccy, key);
    const latest = latestDate(state.table);
    const needsFresh = !hit || (latest != null && key > latest);
    if (needsFresh && now().getTime() >= state.nextFetchAllowedAt) {
      await refresh90d();
      hit = pickRateForDate(state.table, ccy, key);
    }

    // Aelter als die 90-Tage-Datei (nur Reparaturlaeufe): volle Historie, nur im Prozess.
    if (!hit) {
      const earliest = earliestDate(state.table);
      if (earliest != null && key < earliest) {
        const full = await loadFullHistory();
        if (full) hit = pickRateForDate(full, ccy, key);
      }
    }

    return finish(ccy, hit);
  }

  return { getEurRate, _state: state };
}

/** Firestore-Kopie der Kurstabelle: `system/fx-rates-ecb` (Referenzdaten, kein Mandantendatum). */
function createFirestoreFxStore({ db = null } = {}) {
  let _db = db;
  function getDb() {
    if (!_db) {
      const { Firestore } = require('@google-cloud/firestore');
      _db = new Firestore();
    }
    return _db;
  }
  return {
    async load() {
      const snap = await getDb().collection(FX_COLLECTION).doc(FX_DOC).get();
      if (!snap.exists) return null;
      const data = snap.data() || {};
      return data.rates && typeof data.rates === 'object' ? data.rates : null;
    },
    async save(table) {
      const pruned = pruneTable(table, MAX_HISTORY_DAYS);
      await getDb().collection(FX_COLLECTION).doc(FX_DOC).set({
        source: 'ecb',
        rates: pruned,
        latest: latestDate(pruned),
        days: Object.keys(pruned).length,
        updatedAt: new Date().toISOString(),
      });
    },
  };
}

let _defaultResolver = null;

/** Prozessweiter Aufloeser mit Firestore-Kopie — wird vom Intake benutzt. */
function getDefaultFxResolver() {
  if (!_defaultResolver) _defaultResolver = createFxRateResolver({ store: createFirestoreFxStore() });
  return _defaultResolver;
}

/** Test-/Betriebs-Haken: eigenen Aufloeser einsetzen (null = zuruecksetzen). */
function setDefaultFxResolver(resolver) {
  _defaultResolver = resolver || null;
}

module.exports = {
  ECB_HIST_90D_URL,
  ECB_HIST_FULL_URL,
  FALLBACK_RATES,
  MAX_HISTORY_DAYS,
  parseEcbXml,
  pickRateForDate,
  convertToEur,
  pruneTable,
  toDateKey,
  createFxRateResolver,
  createFirestoreFxStore,
  getDefaultFxResolver,
  setDefaultFxResolver,
};
