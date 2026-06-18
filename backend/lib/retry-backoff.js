/**
 * retry-backoff.js — WP1 / Teil E, Task 2.
 *
 * Reine Backoff-Berechnung für den durable Stock-Failure-Drain. Exponentiell
 * 60/120/240… s, gedeckelt bei 30 min. Für `rate_limited` darf der nächste
 * Versuch NIE vor dem Quota-Cooldown-Ende (`quotaUntil`) liegen — sonst
 * verbrennt der Retry erneut einen quota-blockierten Call (Incident 2026-06-12).
 *
 * Dependency-frei, deterministisch (now wird hereingereicht).
 */

'use strict';

const BASE_BACKOFF_MS = 60 * 1000;      // 60 s erster Versuch
const MAX_BACKOFF_MS = 30 * 60 * 1000;  // Cap 30 min

/**
 * Backoff-Dauer für den (attempts)-ten Versuch: 60·2^(attempts-1) ms, capped.
 * @param {number} attempts - bereits gemachte Versuche (>=1). <=0 → wie 1.
 * @returns {number} ms
 */
function computeBackoffMs(attempts) {
  const n = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 1;
  const raw = BASE_BACKOFF_MS * Math.pow(2, n - 1);
  return Math.min(raw, MAX_BACKOFF_MS);
}

function toMs(value) {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Nächster Retry-Zeitpunkt als ISO-String.
 * @param {Object} params
 * @param {number} [params.attempts=1]
 * @param {number} [params.now=Date.now()]
 * @param {string} [params.classification]
 * @param {number|string} [params.quotaUntil] - nur für rate_limited relevant.
 * @returns {string} ISO-Zeitstempel
 */
function computeNextRetryAt({ attempts = 1, now = Date.now(), classification, quotaUntil } = {}) {
  const backoffTarget = now + computeBackoffMs(attempts);

  let target = backoffTarget;
  if (classification === 'rate_limited') {
    const quotaMs = toMs(quotaUntil);
    if (quotaMs != null) target = Math.max(backoffTarget, quotaMs);
  }

  return new Date(target).toISOString();
}

module.exports = { computeNextRetryAt, computeBackoffMs, BASE_BACKOFF_MS, MAX_BACKOFF_MS };
