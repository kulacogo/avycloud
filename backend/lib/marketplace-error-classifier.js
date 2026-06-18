/**
 * marketplace-error-classifier.js — WP1 / Teil E, Task 1.
 *
 * Klassifiziert Marketplace-Sync-/Revise-Fehler in eine GESCHLOSSENE Menge von
 * 5 Klassen. INVARIANTE (CLAUDE.md Punkt 14, Incident 2026-06-16 „66 getötete
 * eBay-Angebote"): KEINE Klasse ist destruktiv. Es gibt keinen Ausgang, der zu
 * `EndFixedPriceItem`/Löschen führt — „Listing beenden als Fehlerreaktion" ist
 * damit strukturell unmöglich. Fehler → klassifizieren → durable Queue → Retry.
 *
 * Klassen:
 *   - rate_limited   Quota/Usage-Limit (429, „exceeded usage limit", call limit). retryable nach Backoff/Quota.
 *   - transient      Netzwerk/5xx/Timeout. retryable mit Backoff.
 *   - listing_config Listing-/Daten-Konfig (Best-Offer-Auto-Decline, Aspect, Kategorie, Preis). NICHT auto-retrybar.
 *   - auth           Token/Permission (401/403, IAF-Token, invalid_grant). NICHT auto-retrybar.
 *   - unknown        Default — defensiv retrybar (eher transient behandeln) statt destruktiv.
 */

'use strict';

const MARKETPLACE_ERROR_CLASSES = Object.freeze([
  'rate_limited',
  'transient',
  'listing_config',
  'auth',
  'unknown',
]);

// retryable je Klasse. listing_config/auth heilen nicht durch stures Retry —
// sie brauchen Config-/Token-Fix; bleiben in der Queue, aber nicht auto-retry.
const RETRYABLE = Object.freeze({
  rate_limited: true,
  transient: true,
  listing_config: false,
  auth: false,
  unknown: true,
});

// Reihenfolge ist Priorität: auth VOR listing_config (sonst fängt „invalid…"
// fälschlich Token-Fehler), rate_limited zuerst (eindeutigste Signatur).
const PATTERNS = [
  ['rate_limited', /exceeded usage limit|usage limit|call limit|rate.?limit|too many requests|\bquota\b|\b429\b/i],
  ['auth', /\biaf token\b|\btoken\b|unauthorized|invalid_grant|\bauth\b|access denied|\b401\b|\b403\b|forbidden|expired token|hard expired/i],
  ['listing_config', /best.?offer|auto.?decline|buy it now price|\baspect\b|item specific|missing required|required item|\bcategory\b|invalid category|invalid value|\bcondition\b|policy.*violat|disallowed/i],
  ['transient', /timeout|etimedout|econnreset|socket hang up|temporar|unavailable|network|\b5\d\d\b|service unavailable|gateway/i],
];

function extractMessage(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'object') {
    return String(input.message || input.error || input.msg || input.reason || '');
  }
  return String(input);
}

function extractStatus(input) {
  if (input && typeof input === 'object') {
    const s = input.httpStatus ?? input.status ?? input.statusCode ?? input.code;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function classFromStatus(status) {
  if (status == null) return null;
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500 && status <= 599) return 'transient';
  return null;
}

/**
 * @param {string|Object|null} input - Fehler-String oder {message/error, httpStatus/status/code}.
 * @returns {{class:string, retryable:boolean, destructive:false}}
 */
function classifyMarketplaceError(input) {
  const message = extractMessage(input);
  const status = extractStatus(input);

  let cls = null;
  if (message) {
    for (const [name, re] of PATTERNS) {
      if (re.test(message)) { cls = name; break; }
    }
  }
  if (!cls) cls = classFromStatus(status);
  if (!cls) cls = 'unknown';

  return {
    class: cls,
    retryable: RETRYABLE[cls],
    destructive: false, // invariant — never an end/delete action
  };
}

module.exports = { classifyMarketplaceError, MARKETPLACE_ERROR_CLASSES };
