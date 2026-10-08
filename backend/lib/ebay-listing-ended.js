'use strict';

/**
 * ebay-listing-ended.js — erkennt „dieses Angebot ist beendet" in eBay-Antworten.
 *
 * Gegenlese 2026-10-08 (HIGH): der Stock-Sync pruefte per Substring auf
 * „1047" (eBay-Fehlercode „Item is ended"). Seit der Quota-Breaker bis zum
 * Reset offen bleiben kann, tragen die Fail-fast-Meldungen Countdowns wie
 * „(quota cooldown 1047s)" — in diesen Sekunden haette ein Zero-Stock-End als
 * „already ended" (SCHEINERFOLG) gegolten, der ItemID-Zeiger waere geloescht
 * und das Angebot mit Menge > 0 online geblieben: Oversell.
 *
 * Regeln: (1) Quota-/Budget-Fehler sind NIE „beendet" — sie haben Vorrang.
 * (2) Der Fehlercode zaehlt nur als eigenstaendiges Wort („1047", „1047:",
 * „Fehler 1047"), nie als Teil einer Zahl wie „1047s" oder „10470".
 */

const QUOTA_LIKE = /exceeded usage limit|usage limit|quota|tagesbudget|call limit|rate.?limit/i;
const ENDED_WORDS = /beendet|\bended\b/i;
const ENDED_CODE = /(?<![\d])1047(?![\d]|s\b)/;

function isQuotaLikeError(message, err) {
  if (err && (err.quotaCooldown || err.budgetDeferred || err.quotaExhausted || err.code === 'EBAY_TRADING_RATE_LIMIT' || err.code === 'EBAY_QUOTA_COOLDOWN' || err.code === 'EBAY_BUDGET_DEFERRED')) return true;
  return QUOTA_LIKE.test(String(message || ''));
}

function isEndedListingMessage(message, err = null) {
  const text = String(message || '');
  if (!text) return false;
  if (isQuotaLikeError(text, err)) return false;
  return ENDED_WORDS.test(text) || ENDED_CODE.test(text);
}

module.exports = { isEndedListingMessage, isQuotaLikeError };
