// globals: true in vitest.config.js
'use strict';

/**
 * Vorfall 2026-10-08: das rote Banner „Angebots-Abgleich mit eBay gestoert"
 * bot bei einem LEEREN TAGESKONTINGENT den Knopf „eBay neu verbinden" an —
 * ein Klick dort haette nichts geheilt. Der Fehlertyp muss unterschieden
 * werden: Kontingent (warten bis Reset) vs. Anmeldung (neu verbinden) vs.
 * Sonstiges.
 */

const { classifyEbaySyncError } = require('../lib/ebay-sync-error-kind');

describe('classifyEbaySyncError', () => {
  it('erkennt Kontingent-Fehler (eBay-Ablehnung, Breaker-Skip, Budget-Reservierung)', () => {
    expect(classifyEbaySyncError('eBay Trading skipped for GetMyeBaySelling: exceeded usage limit (shared quota cooldown 152s)')).toBe('quota');
    expect(classifyEbaySyncError('eBay Trading exceeded usage limit for GetOrders — quota breaker opened (cooldown 300s)')).toBe('quota');
    expect(classifyEbaySyncError('eBay Trading skipped for GetMyeBaySelling: exceeded usage limit (Tagesbudget reserviert: Prioritaet P2, Rest 1400 ≤ Reserve 1500)')).toBe('quota');
    expect(classifyEbaySyncError('This user has exceeded usage limit on API call')).toBe('quota');
  });

  it('erkennt Anmelde-/Token-Fehler', () => {
    expect(classifyEbaySyncError('Invalid IAF token. IAF token supplied is invalid.')).toBe('auth');
    expect(classifyEbaySyncError('eBay OAuth token refresh failed (400): invalid_grant')).toBe('auth');
    expect(classifyEbaySyncError('Auth token is hard expired')).toBe('auth');
    expect(classifyEbaySyncError('eBay Trading config missing: EBAY_TRADING_USER_TOKEN')).toBe('auth');
    // eBay antwortet auf Site 77 DEUTSCH (Fixture aus ebay-listing-sync-health.test.js)
    expect(classifyEbaySyncError('Die Validierung des Authentifizierungs-Tokens in der API-Anfrage ist fehlgeschlagen.')).toBe('auth');
    expect(classifyEbaySyncError('eBay nicht verbunden (EBAY_NOT_CONNECTED)')).toBe('auth');
  });

  it('alles andere ist "other", leer ist null', () => {
    expect(classifyEbaySyncError('Invalid GetMyeBaySelling response payload.')).toBe('other');
    expect(classifyEbaySyncError('fetch failed: ETIMEDOUT')).toBe('other');
    expect(classifyEbaySyncError('')).toBe(null);
    expect(classifyEbaySyncError(null)).toBe(null);
  });
});
