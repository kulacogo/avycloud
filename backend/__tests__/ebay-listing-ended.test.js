'use strict';

/**
 * Adversarische Gegenlese 2026-10-08 (HIGH): der Stock-Sync erkannte ein
 * beendetes Angebot ueber einen reinen Substring-Test auf „1047" (eBay-Fehler-
 * code „Item is ended"). Seit der Breaker bis zum Reset offen bleiben kann,
 * traegt die Fail-fast-Meldung Countdowns wie „(quota cooldown 1047s)" — und
 * in genau diesen 13 Sekunden je Nacht haette ein Zero-Stock-End als
 * „already ended" (Scheinerfolg!) gegolten, der Pointer waere geloescht und
 * das Angebot mit Menge > 0 online geblieben: Oversell. Ausserdem muss ein
 * Quota-Fehler IMMER Vorrang vor der Beendet-Erkennung haben.
 */

const { isEndedListingMessage } = require('../lib/ebay-listing-ended');

describe('isEndedListingMessage', () => {
  it('erkennt echte Beendet-Antworten (deutsch, englisch, Fehlercode 1047)', () => {
    expect(isEndedListingMessage('Das Angebot wurde beendet und kann nicht geaendert werden.')).toBe(true);
    expect(isEndedListingMessage('Item is ended. Only ended items can be relisted')).toBe(true);
    expect(isEndedListingMessage('eBay error 1047: Item cannot be accessed')).toBe(true);
    expect(isEndedListingMessage('Fehler 1047 – Artikel ist beendet')).toBe(true);
  });

  it('haelt einen Countdown im Quota-Text NICHT fuer den Fehlercode 1047', () => {
    expect(isEndedListingMessage('eBay Trading skipped for EndFixedPriceItem: exceeded usage limit (quota cooldown 1047s)')).toBe(false);
    expect(isEndedListingMessage('eBay Trading skipped for GetOrders: exceeded usage limit (shared quota cooldown 10470s)')).toBe(false);
    expect(isEndedListingMessage('eBay Trading exceeded usage limit for ReviseFixedPriceItem — quota breaker opened (cooldown 1047s)')).toBe(false);
  });

  it('Quota-/Budget-Fehler haben Vorrang, auch wenn der Text „ended" enthaelt', () => {
    const err = new Error('exceeded usage limit — listing ended?');
    err.quotaCooldown = true;
    expect(isEndedListingMessage(err.message, err)).toBe(false);
    const budget = new Error('Tagesbudget reserviert');
    budget.budgetDeferred = true;
    expect(isEndedListingMessage('ended', budget)).toBe(false);
    expect(isEndedListingMessage('This user has exceeded usage limit on API call (ended)')).toBe(false);
  });

  it('leer/unbekannt → false', () => {
    expect(isEndedListingMessage('')).toBe(false);
    expect(isEndedListingMessage(null)).toBe(false);
    expect(isEndedListingMessage('Internal error to the application')).toBe(false);
  });
});
