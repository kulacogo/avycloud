'use strict';

/**
 * ebay-rate-limit-probe.js — misst den Rest des eBay-Trading-Tageskontingents.
 *
 * Quelle: Developer-Analytics-API `GET /developer/analytics/v1_beta/rate_limit/
 * ?api_context=tradingapi` mit App-Token (client_credentials). Eigenes
 * Kontingent — die Messung kostet KEINEN Trading-Aufruf. Gemessen 08.10.2026:
 * jede Trading-Ressource meldet denselben Pool (limit 5000, remaining
 * identisch, reset = Mitternacht US-Pazifik); eine Aufschluesselung je Call
 * liefert eBay NICHT — die kommt aus unserem eigenen Zaehler
 * (lib/ebay-trading-budget.js).
 *
 * Die Messung sieht auch Aufrufe, die NICHT durch diesen Prozess gingen
 * (Scripts vom Rechner des Betreibers) — deshalb gewinnt sie im Budget-Store
 * gegen den lokalen Zaehler, solange sie frisch ist.
 */

const ANALYTICS_URL = 'https://api.ebay.com/developer/analytics/v1_beta/rate_limit/';
const DAY_WINDOW_SECONDS = 86400;

function probeEnabled(env = process.env) {
  return String((env && env.EBAY_BUDGET_PROBE) || '').trim().toLowerCase() !== 'off';
}

/**
 * Pool-Werte aus der Analytics-Antwort. Gemessen 08.10.2026: 82 von 84
 * Trading-Ressourcen melden denselben Pool (limit 5000, identischer Rest),
 * zwei (AddItem 100.000, RelistItem 50.000) haben eigene Limits. Der Pool ist
 * die Gruppe mit den MEISTEN Ressourcen; darin zaehlen der kleinste Rest und
 * der frueheste Reset.
 * @returns {{limit:number, remaining:number, resetAtIso:string|null, resources:number}|null}
 */
function parseTradingRateLimit(json) {
  const rateLimits = json && Array.isArray(json.rateLimits) ? json.rateLimits : [];
  const byLimit = new Map(); // limit → { resources, remaining, resetMs }
  for (const rl of rateLimits) {
    for (const resource of (rl && Array.isArray(rl.resources) ? rl.resources : [])) {
      for (const rate of (resource && Array.isArray(resource.rates) ? resource.rates : [])) {
        if (Number(rate && rate.timeWindow) !== DAY_WINDOW_SECONDS) continue;
        const l = Number(rate.limit);
        const r = Number(rate.remaining);
        if (!Number.isFinite(l) || !Number.isFinite(r)) continue;
        const group = byLimit.get(l) || { resources: 0, remaining: null, resetMs: null };
        group.resources += 1;
        group.remaining = group.remaining == null ? r : Math.min(group.remaining, r);
        const reset = Date.parse(rate.reset || '');
        if (Number.isFinite(reset) && (group.resetMs == null || reset < group.resetMs)) group.resetMs = reset;
        byLimit.set(l, group);
      }
    }
  }
  if (!byLimit.size) return null;
  let limit = null;
  let pool = null;
  for (const [l, group] of byLimit.entries()) {
    if (!pool || group.resources > pool.resources || (group.resources === pool.resources && l < limit)) {
      limit = l;
      pool = group;
    }
  }
  return {
    limit,
    remaining: pool.remaining,
    resetAtIso: pool.resetMs != null ? new Date(pool.resetMs).toISOString() : null,
    resources: pool.resources,
  };
}

function defaultGetToken() {
  const { getAppToken } = require('./ebay-browse-title-insights');
  return getAppToken({});
}

async function fetchTradingRateLimit({ fetchImpl = globalThis.fetch, getToken = defaultGetToken, nowMs = Date.now(), timeoutMs = 20000 } = {}) {
  const token = await getToken();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(`${ANALYTICS_URL}?api_context=tradingapi`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller ? controller.signal : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`eBay Analytics rate_limit HTTP ${res.status}: ${String(text || '').slice(0, 200)}`);
      err.code = 'EBAY_ANALYTICS_HTTP_ERROR';
      err.statusCode = res.status;
      throw err;
    }
    const parsed = parseTradingRateLimit(JSON.parse(text));
    if (!parsed) {
      const err = new Error('eBay Analytics rate_limit: keine Tagesfenster-Werte in der Antwort');
      err.code = 'EBAY_ANALYTICS_EMPTY';
      throw err;
    }
    return { ...parsed, atIso: new Date(nowMs).toISOString() };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function defaultAlert(payload) {
  const { sendOpsAlert } = require('./ops-alert');
  return sendOpsAlert(payload);
}

// Zweiter Beleg in GEGENRICHTUNG (Gegenlese, HIGH): der Breaker kann bis zum
// Reset offen sein; die Messung ist die einzige Stelle, die ein angehobenes
// Limit (Growth Check) oder einen falschen Zaehlerstand SIEHT — zeigt sie
// wieder Rest, schliesst sie den lokalen (Worker) und den geteilten Breaker.
async function defaultCloseBreaker() {
  try { require('./ebay-trading-api').closeEbayQuotaBreaker(); } catch (_) { /* best effort */ }
  try { await require('./ebay-quota-breaker').closeEbayQuotaBreaker({}); } catch (_) { /* best effort */ }
}

let _probeInFlight = false;

// Ein Alarm je Reset-Fenster, sobald das Budget kritisch (P1-Reserve erreicht)
// oder leer ist. Vorher gab es KEINEN Quota-Alarm — der einzige, der je jemanden
// erreichte, war der ABANDONED-Drain-Alarm, also NACH dem Oversell-Fenster.
const _defaultAlertState = {};

/**
 * Cron-Einstieg (Worker): Messung holen und in den Budget-Store schreiben.
 * Wirft nie — ein Messfehler darf keinen Runner umwerfen (fail-open: der
 * Store rechnet dann mit dem eigenen Zaehler weiter).
 */
async function runEbayBudgetProbe({ store = null, fetchImpl, getToken, nowMs = Date.now(), env = process.env, logger = console, alert = defaultAlert, closeBreaker = defaultCloseBreaker, _alertState = _defaultAlertState } = {}) {
  if (!probeEnabled(env)) return { ok: false, skipped: true, reason: 'disabled' };
  // Nie doppelt (Gegenlese): ein Muell-Intervall oder ein langsamer Aufruf darf
  // keine parallelen Messungen (Analytics-GET + OAuth + Firestore) stapeln.
  if (_probeInFlight) return { ok: false, skipped: true, reason: 'in_flight' };
  _probeInFlight = true;
  try {
    const budget = store || require('./ebay-trading-budget').getEbayTradingBudget();
    const probe = await fetchTradingRateLimit({ fetchImpl, getToken, nowMs });
    const applied = await budget.applyProbe({ remaining: probe.remaining, limit: probe.limit, resetAtIso: probe.resetAtIso, atIso: probe.atIso });
    if (logger && typeof logger.log === 'function') {
      logger.log(`[ebay-budget] Messung: Rest ${probe.remaining}/${probe.limit}, Reset ${probe.resetAtIso}${applied ? '' : ' (nicht uebernommen: altes Fenster)'}`);
    }
    try {
      const state = typeof budget.getState === 'function' ? await budget.getState({ force: true }) : null;
      const critical = state && (state.level === 'critical' || state.level === 'exhausted');
      if (applied && state && state.source === 'probe' && (state.level === 'ok' || state.level === 'tight')) {
        // Messung zeigt wieder Rest → ein evtl. bis zum Reset offener Breaker darf nicht weiterblockieren.
        await closeBreaker();
      }
      if (critical && _alertState.windowKey !== state.windowKey) {
        _alertState.windowKey = state.windowKey;
        await alert({
          source: 'ebay-budget',
          severity: state.level === 'exhausted' ? 'critical' : 'warning',
          tenantId: 'default',
          message: `eBay-Trading-Tagesbudget ${state.level === 'exhausted' ? 'ERSCHOEPFT' : 'kritisch'}: Rest ${state.remaining} von ${state.limit} Aufrufen, Reset ${state.resetAtIso}. Spiegel und Komfort-Syncs pausieren; Oversell-Schutz, Auftrags-Import und Versandmeldung laufen bis zum Boden weiter.`,
          context: { remaining: state.remaining, limit: state.limit, level: state.level, resetAtIso: state.resetAtIso, usedByCall: state.usedByCall || null },
        });
      }
    } catch (alertErr) {
      if (logger && typeof logger.warn === 'function') logger.warn(`[ebay-budget] Alarm fehlgeschlagen (ignoriert): ${alertErr && alertErr.message}`);
    }
    return { ok: true, ...probe };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (logger && typeof logger.warn === 'function') logger.warn(`[ebay-budget] Messung fehlgeschlagen (fail-open, Zaehler bleibt massgeblich): ${message}`);
    return { ok: false, error: message };
  } finally {
    _probeInFlight = false;
  }
}

module.exports = { ANALYTICS_URL, probeEnabled, parseTradingRateLimit, fetchTradingRateLimit, runEbayBudgetProbe };
