/**
 * ebay-quota-breaker.js — WP1 / Teil E, Task 3.
 *
 * Firestore-SHARED Circuit-Breaker für die eBay-Trading-API-Tagesquota. Zustand
 * liegt in EINEM Doc (`system/ebay_quota_breaker`), damit ALLE Cloud-Run-Instanzen
 * dieselbe Quota-Sicht haben (der bisherige In-Process-Breaker in
 * `ebay-trading-api.js` schützt nur eine Instanz — Incident 2026-06-12).
 *
 * 10s In-Process-Cache verhindert ein Firestore-Read pro API-Call. `firestore`
 * ist injizierbar (Default: lib/firestore) → unit-testbar mit In-Memory-Fake.
 *
 * Fail-safe: jeder Firestore-Fehler wird als „Breaker geschlossen" behandelt —
 * lieber einen Call zu viel als das System fälschlich komplett zu blockieren.
 */

'use strict';

const DOC_PATH = 'system/ebay_quota_breaker';
const CACHE_TTL_MS = 10 * 1000;
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

// In-Process-Cache. `fetchedAt > 0` markiert „Cache befüllt" — ein leeres
// Breaker-Doc (value=null) ist ein gültiger gecachter „geschlossen"-Zustand.
let _cache = { value: null, fetchedAt: 0 };

function getFirestore(injected) {
  if (injected) return injected;
  return require('./firestore').firestore;
}

function deriveState(data, now) {
  const openUntilMs = data && data.openUntil ? Date.parse(data.openUntil) : null;
  const open = openUntilMs != null && Number.isFinite(openUntilMs) && openUntilMs > now;
  return {
    open,
    openUntil: open ? data.openUntil : null,
    remainingMs: open ? openUntilMs - now : 0,
  };
}

/**
 * Öffnet den Breaker für `cooldownMs` und persistiert das in Firestore.
 * Primt den lokalen Cache, damit ein direkt folgender isOpen() kein Read braucht.
 * @returns {Promise<string>} openUntil als ISO-String
 */
async function openEbayQuotaBreaker({ firestore, cooldownMs = DEFAULT_COOLDOWN_MS, reason = '', now = Date.now() } = {}) {
  const db = getFirestore(firestore);
  const openUntil = new Date(now + cooldownMs).toISOString();
  const payload = { openUntil, reason: String(reason || ''), updatedAt: new Date(now).toISOString() };
  await db.doc(DOC_PATH).set(payload, { merge: true });
  _cache = { value: payload, fetchedAt: now };
  return openUntil;
}

/**
 * Liest den Breaker-Zustand (cache-first, 10s TTL).
 * @param {Object} [params]
 * @param {boolean} [params.force=false] - Cache umgehen, frisch lesen.
 */
async function getEbayQuotaBreakerState({ firestore, now = Date.now(), force = false } = {}) {
  if (!force && _cache.fetchedAt > 0 && now - _cache.fetchedAt < CACHE_TTL_MS) {
    return deriveState(_cache.value, now);
  }
  const db = getFirestore(firestore);
  let data = _cache.value;
  try {
    const snap = await db.doc(DOC_PATH).get();
    data = snap && snap.exists ? snap.data() : null;
  } catch (err) {
    // Fail-safe: bei Read-Fehler letzten bekannten Wert behalten (default null=closed),
    // und kurz cachen, um Firestore bei Outage nicht zu hämmern.
    console.warn(`[ebay-quota-breaker] read failed, treating as last-known: ${err.message}`);
  }
  _cache = { value: data, fetchedAt: now };
  return deriveState(data, now);
}

async function isEbayQuotaBreakerOpen(opts = {}) {
  return (await getEbayQuotaBreakerState(opts)).open;
}

async function closeEbayQuotaBreaker({ firestore, now = Date.now() } = {}) {
  const db = getFirestore(firestore);
  await db.doc(DOC_PATH)
    .set({ openUntil: null, updatedAt: new Date(now).toISOString() }, { merge: true })
    .catch((err) => console.warn(`[ebay-quota-breaker] close failed: ${err.message}`));
  _cache = { value: null, fetchedAt: 0 };
}

// eBay setzt die Trading-API-Tageskontingente um Mitternacht US-Pazifik
// zurueck. Der Drain (stock-failure-drain) nutzt dieses Fenster, um Retries
// waehrend einer erschoepften Tagesquota nicht sinnlos zu verbrennen —
// 2026-08-26: 378 abandoned Failure-Docs, weil alle 5 Versuche (~90 min)
// komplett in die stundenlange Sperre fielen. DST-korrekt ueber Intl;
// min. 60s, damit ein Aufrufer direkt vor Mitternacht nie 0/negativ plant.
const EBAY_QUOTA_TZ = 'America/Los_Angeles';

function msUntilNextEbayQuotaReset(now = Date.now()) {
  let secondsIntoDay;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: EBAY_QUOTA_TZ,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(now));
    const get = (type) => Number((parts.find((p) => p.type === type) || {}).value || 0);
    secondsIntoDay = (get('hour') % 24) * 3600 + get('minute') * 60 + get('second');
  } catch (_) {
    // Fallback ohne TZ-Daten: 07:00 UTC (= PDT-Mitternacht) als Naeherung.
    const secUtc = Math.floor((now % 86400000) / 1000);
    secondsIntoDay = (secUtc - 7 * 3600 + 86400) % 86400;
  }
  return Math.max(60 * 1000, (86400 - secondsIntoDay) * 1000);
}

// Test-Helper: lokalen Cache leeren (simuliert frische Instanz).
function _resetCache() {
  _cache = { value: null, fetchedAt: 0 };
}

module.exports = {
  openEbayQuotaBreaker,
  closeEbayQuotaBreaker,
  isEbayQuotaBreakerOpen,
  getEbayQuotaBreakerState,
  msUntilNextEbayQuotaReset,
  _resetCache,
  DOC_PATH,
  CACHE_TTL_MS,
  DEFAULT_COOLDOWN_MS,
};
