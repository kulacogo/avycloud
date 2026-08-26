'use strict';

/**
 * msUntilNextEbayQuotaReset — eBay setzt die Trading-API-Tageskontingente um
 * Mitternacht US-Pazifik zurueck. Der Drain nutzt das Fenster, um Retries
 * waehrend einer erschoepften Quota NICHT sinnlos zu verbrennen (2026-08-26:
 * 378 abandoned Docs, weil 5 Versuche × ~18 min immer komplett in die
 * stundenlange Sperre fielen).
 *
 * Die Erwartungswerte sind fixe Zeitpunkte (Sommer-/Winterzeit), damit der
 * Test deterministisch bleibt.
 */

const { msUntilNextEbayQuotaReset } = require('../lib/ebay-quota-breaker');

describe('msUntilNextEbayQuotaReset — naechster eBay-Quota-Reset (Mitternacht US-Pazifik)', () => {
  it('Sommer (PDT, UTC-7): 00:20 UTC → 6h40m bis Mitternacht Los Angeles', () => {
    const now = Date.parse('2026-08-26T00:20:00Z'); // LA: 25.08. 17:20:00
    expect(msUntilNextEbayQuotaReset(now)).toBe(24000 * 1000);
  });

  it('Winter (PST, UTC-8): 00:20 UTC → 7h40m bis Mitternacht Los Angeles', () => {
    const now = Date.parse('2026-01-15T00:20:00Z'); // LA: 14.01. 16:20:00
    expect(msUntilNextEbayQuotaReset(now)).toBe(27600 * 1000);
  });

  it('kurz vor Mitternacht LA: klemmt auf mindestens 60s, nie 0 oder negativ', () => {
    const now = Date.parse('2026-08-26T06:59:30Z'); // LA: 23:59:30
    expect(msUntilNextEbayQuotaReset(now)).toBe(60 * 1000);
  });

  it('ohne Argument: liefert einen plausiblen Wert (0 < ms <= ~25h)', () => {
    const ms = msUntilNextEbayQuotaReset();
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(25 * 60 * 60 * 1000);
  });
});
