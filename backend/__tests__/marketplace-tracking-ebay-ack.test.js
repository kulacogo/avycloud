// globals: true in vitest.config.js
'use strict';

/**
 * Regression (inverse of the 2026-06-12 retry-storm): a SILENT tracking-push loss.
 *
 * eBay's Trading API can answer HTTP 200 with an envelope `Ack='Failure'` (or
 * 'Warning') in the BODY. pushTrackingToEbay treated ANY non-throwing response
 * from callTradingApi as success — so a body-level Ack='Failure' was recorded as
 * 'success' and the tracking number was NEVER retried. The marketplace silently
 * never got the tracking.
 *
 * Contract:
 *   - Ack='Failure'  → pushTrackingToEbay returns { ok:false, error:<ebay msg> }
 *                      so deriveMarketplacePushStatus counts the attempt and the
 *                      existing cap/retry/abandon logic kicks in (NOT 'success').
 *   - Ack='Warning'  → still treated as success (eBay accepted it) but logged.
 *   - Ack='Success'  → success (unchanged).
 *
 * The retry cap (MAX_PUSH_ATTEMPTS) + success/abandoned-never-reschedule rule
 * are NOT touched by this fix — only the ack detection.
 */

// ─── Harness: stub error-collector + ebay-trading-api before loading service ──
function patch(path, exports) {
  require.cache[require.resolve(path)] = {
    id: require.resolve(path), filename: require.resolve(path), loaded: true, exports, children: [], paths: [],
  };
}

patch('../lib/error-collector', { collectError: () => {} });

// Controllable callTradingApi: each test sets what the eBay envelope resolves to.
let tradingApiImpl = async () => ({ ack: 'Success', errors: [] });

patch('../lib/ebay-trading-api', {
  getEbayTradingConfig: async () => ({ userToken: 'tok', compatibilityLevel: '1.0.0' }),
  buildRequestRoot: () => '<xml/>',
  callTradingApi: async (callName, xml) => tradingApiImpl(callName, xml),
});

const { pushTrackingToEbay, deriveMarketplacePushStatus } = require('../services/marketplace-tracking');

const baseOrder = () => ({ marketplaceOrderId: '123-456-789' });

beforeEach(() => {
  tradingApiImpl = async () => ({ ack: 'Success', errors: [] });
});

describe('pushTrackingToEbay — body-level Ack detection (silent-failure guard)', () => {
  it("Ack='Failure' → ok:false with the eBay error message (attempt is counted, NOT marked success)", async () => {
    tradingApiImpl = async () => ({
      ack: 'Failure',
      errors: [{ code: '12345', longMessage: 'Order has already been acknowledged', shortMessage: 'Already acked' }],
    });

    const res = await pushTrackingToEbay({ order: baseOrder(), trackingNumber: 'TRK1', carrier: 'dhl' });

    expect(res.ok).toBe(false);
    expect(res.marketplace).toBe('ebay');
    expect(res.error).toMatch(/already been acknowledged/i);

    // And the cap/retry logic must therefore NOT see this as success.
    const derived = deriveMarketplacePushStatus({ ok: res.ok, error: res.error, prevAttempts: 0 });
    expect(derived.status).not.toBe('success');
    expect(derived.attempts).toBe(1);
  });

  it("Ack='Failure' with no error array → ok:false with a generic Ack=Failure message", async () => {
    tradingApiImpl = async () => ({ ack: 'Failure', errors: [] });

    const res = await pushTrackingToEbay({ order: baseOrder(), trackingNumber: 'TRK1', carrier: 'dhl' });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/failure/i);
  });

  it("Ack='Warning' → still treated as success (eBay accepted it)", async () => {
    tradingApiImpl = async () => ({
      ack: 'Warning',
      errors: [{ code: '999', longMessage: 'Tracking carrier guessed', severity: 'Warning' }],
    });

    const res = await pushTrackingToEbay({ order: baseOrder(), trackingNumber: 'TRK1', carrier: 'dhl' });

    expect(res.ok).toBe(true);
    expect(res.marketplace).toBe('ebay');
  });

  it("Ack='Success' → success (unchanged baseline behaviour)", async () => {
    tradingApiImpl = async () => ({ ack: 'Success', errors: [] });

    const res = await pushTrackingToEbay({ order: baseOrder(), trackingNumber: 'TRK1', carrier: 'dhl' });

    expect(res.ok).toBe(true);
    expect(res.marketplace).toBe('ebay');
  });

  it('callTradingApi throwing (e.g. quota/parse error) → ok:false (existing catch path preserved)', async () => {
    tradingApiImpl = async () => { throw new Error('eBay Trading exceeded usage limit'); };

    const res = await pushTrackingToEbay({ order: baseOrder(), trackingNumber: 'TRK1', carrier: 'dhl' });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/exceeded usage limit/i);
  });
});
