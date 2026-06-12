'use strict';

/**
 * Regression: eBay daily-quota circuit breaker (incident 2026-06-12).
 *
 * When the shared Trading-API daily quota is exhausted, callTradingApi must fail
 * fast WITHOUT hitting eBay so the quota can recover — otherwise a zero-stock
 * EndFixedPriceItem loop keeps it pinned at zero and starves GetOrders (order
 * intake) + CompleteSale (tracking). The skip error must keep the
 * "exceeded usage limit" marker so downstream rate-limit detection still defers.
 */

const ebay = require('../lib/ebay-trading-api');

describe('eBay quota circuit breaker', () => {
  afterEach(() => ebay.closeEbayQuotaBreaker());

  it('starts closed', () => {
    expect(ebay.ebayQuotaCooldownActive()).toBe(false);
  });

  it('opens and closes', () => {
    ebay.openEbayQuotaBreaker();
    expect(ebay.ebayQuotaCooldownActive()).toBe(true);
    expect(ebay.ebayQuotaCooldownRemainingMs()).toBeGreaterThan(0);
    ebay.closeEbayQuotaBreaker();
    expect(ebay.ebayQuotaCooldownActive()).toBe(false);
    expect(ebay.ebayQuotaCooldownRemainingMs()).toBe(0);
  });

  it('callTradingApi fails fast during cooldown without hitting eBay, keeping the rate-limit marker', async () => {
    ebay.openEbayQuotaBreaker();
    let caught;
    try {
      await ebay.callTradingApi('GetOrders', '<x/>');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('EBAY_QUOTA_COOLDOWN');
    expect(caught.quotaCooldown).toBe(true);
    // Downstream isRateLimited()/isRateLimitedError() match on this substring:
    expect(String(caught.message).toLowerCase()).toContain('exceeded usage limit');
  });
});
