'use strict';

/**
 * REGRESSION GUARD — "Bereits auf eBay gelistet"-Fehlblock nach Konto-Cutover
 * (Incident 2026-07-11).
 *
 * Nach dem eBay-Konto-Wechsel trugen Produkte noch Alt-Konto-itemIds. Der
 * Publish-Guard rief GetItem, das mit definitiven eBay-Fehlern warf (Code 17
 * "nicht der Verkäufer", 21920397 "Angebot entfernt"). resolveItemIsActive
 * behandelte JEDEN Fehler als "im Zweifel aktiv → blockieren" → der gesamte
 * Katalog ließ sich nicht neu listen, obwohl auf dem neuen Konto NICHTS gelistet
 * war. Fix: nur GENUIN transiente Fehler (Netz/Quota/5xx) blocken; eine
 * definitive eBay-Antwort heißt "nicht aktiv → relisten erlauben".
 */

const { isTransientItemProbeError } = require('../lib/ebay-direct');

describe('isTransientItemProbeError — Klassifizierung Publish-Guard', () => {
  it('definitive eBay-Fehler (Code 17 / 21920397) sind NICHT transient → Relisten erlaubt', () => {
    const err17 = Object.assign(new Error('Auf den Artikel kann nicht zugegriffen werden, da entweder das Angebot entfernt wurde oder Sie nicht der Verkäufer sind.'), {
      code: 'EBAY_TRADING_CALL_FAILED',
      details: { ack: 'Failure', errors: [{ code: '17', severity: 'Error' }] },
    });
    const errPolicy = Object.assign(new Error('Dieses Angebot wurde entfernt, weil es gegen unseren Grundsatz verstößt.'), {
      code: 'EBAY_TRADING_CALL_FAILED',
      details: { ack: 'Failure', errors: [{ code: '21920397', severity: 'Error' }] },
    });
    expect(isTransientItemProbeError(err17)).toBe(false);
    expect(isTransientItemProbeError(errPolicy)).toBe(false);
  });

  it('unbekannter eBay-Fachfehler ist ebenfalls NICHT transient (definitive Antwort)', () => {
    const err = Object.assign(new Error('irgendein Item-Fehler'), {
      code: 'EBAY_TRADING_CALL_FAILED',
      details: { ack: 'Failure', errors: [{ code: '99999', severity: 'Error' }] },
    });
    expect(isTransientItemProbeError(err)).toBe(false);
  });

  it('Rate-Limit / Quota IST transient → konservativ blocken', () => {
    expect(isTransientItemProbeError(Object.assign(new Error('exceeded usage limit'), { code: 'EBAY_TRADING_RATE_LIMIT' }))).toBe(true);
    expect(isTransientItemProbeError(Object.assign(new Error('quota'), { quotaExhausted: true }))).toBe(true);
  });

  it('Timeout / Netzwerkfehler IST transient', () => {
    expect(isTransientItemProbeError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(true);
    expect(isTransientItemProbeError(Object.assign(new Error('socket hang up')))).toBe(true);
    expect(isTransientItemProbeError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe(true);
    expect(isTransientItemProbeError(Object.assign(new Error('request timed out')))).toBe(true);
  });

  it('HTTP 5xx IST transient, 4xx nicht', () => {
    expect(isTransientItemProbeError(Object.assign(new Error('server error'), { httpStatus: 503 }))).toBe(true);
    expect(isTransientItemProbeError(Object.assign(new Error('bad request'), { httpStatus: 400 }))).toBe(false);
  });

  it('null/undefined → nicht transient (nicht blocken)', () => {
    expect(isTransientItemProbeError(null)).toBe(false);
    expect(isTransientItemProbeError(undefined)).toBe(false);
  });
});
