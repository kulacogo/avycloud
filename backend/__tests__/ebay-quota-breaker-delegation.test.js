// globals: true in vitest.config.js — describe/it/expect/vi are global
'use strict';

/**
 * WP1 Task 6: the in-process eBay quota breaker delegates to the Firestore-shared
 * breaker when EBAY_QUOTA_BREAKER_SHARED=true, so all Cloud-Run instances back off
 * together. The fast synchronous local guard stays. Flag OFF → unchanged behaviour.
 */

let sharedState = { open: false, remainingMs: 0 };
const openCalls = [];
const closeCalls = [];
let getStateImpl = async () => sharedState;

// Mock the shared breaker BEFORE ebay-trading-api lazily requires it.
require.cache[require.resolve('../lib/ebay-quota-breaker')] = {
  id: require.resolve('../lib/ebay-quota-breaker'),
  filename: require.resolve('../lib/ebay-quota-breaker'),
  loaded: true,
  exports: {
    openEbayQuotaBreaker: async (opts) => { openCalls.push(opts); },
    closeEbayQuotaBreaker: async (opts) => { closeCalls.push(opts); },
    getEbayQuotaBreakerState: async (opts) => getStateImpl(opts),
  },
  children: [],
  paths: [],
};

const ebay = require('../lib/ebay-trading-api');

const PREV = process.env.EBAY_QUOTA_BREAKER_SHARED;

beforeEach(() => {
  process.env.EBAY_QUOTA_BREAKER_SHARED = 'false';
  ebay.closeEbayQuotaBreaker(); // reset local _quotaExhaustedUntil with flag off
  openCalls.length = 0;
  closeCalls.length = 0;
  sharedState = { open: false, remainingMs: 0 };
  getStateImpl = async () => sharedState;
});

afterEach(() => {
  if (PREV === undefined) delete process.env.EBAY_QUOTA_BREAKER_SHARED;
  else process.env.EBAY_QUOTA_BREAKER_SHARED = PREV;
});

describe('eBay quota breaker — shared delegation (WP1 Task 6)', () => {
  it('flag OFF: open/close stay local, never touch the shared breaker', () => {
    process.env.EBAY_QUOTA_BREAKER_SHARED = 'false';
    ebay.openEbayQuotaBreaker();
    expect(ebay.ebayQuotaCooldownActive()).toBe(true); // local guard still works
    expect(openCalls.length).toBe(0);
    ebay.closeEbayQuotaBreaker();
    expect(closeCalls.length).toBe(0);
  });

  it('flag ON: opening broadcasts to the shared breaker (with cooldownMs)', () => {
    process.env.EBAY_QUOTA_BREAKER_SHARED = 'true';
    ebay.openEbayQuotaBreaker();
    expect(ebay.ebayQuotaCooldownActive()).toBe(true);
    expect(openCalls.length).toBe(1);
    expect(openCalls[0].cooldownMs).toBeGreaterThan(0);
  });

  it('flag ON: closing broadcasts to the shared breaker', () => {
    process.env.EBAY_QUOTA_BREAKER_SHARED = 'true';
    ebay.closeEbayQuotaBreaker();
    expect(closeCalls.length).toBe(1);
  });

  it('flag OFF: consult is a no-op — no read, no throw', async () => {
    process.env.EBAY_QUOTA_BREAKER_SHARED = 'false';
    let read = false;
    getStateImpl = async () => { read = true; return { open: true, remainingMs: 1000 }; };
    await expect(ebay._consultSharedQuotaBreaker('GetOrders')).resolves.toBeUndefined();
    expect(read).toBe(false);
  });

  it('flag ON: consult throws EBAY_QUOTA_COOLDOWN when another instance opened the shared breaker', async () => {
    process.env.EBAY_QUOTA_BREAKER_SHARED = 'true';
    getStateImpl = async () => ({ open: true, remainingMs: 120000 });
    await expect(ebay._consultSharedQuotaBreaker('GetOrders')).rejects.toMatchObject({
      code: 'EBAY_QUOTA_COOLDOWN',
      quotaCooldown: true,
    });
    // remaining cooldown mirrored into the local breaker for fast subsequent fails
    expect(ebay.ebayQuotaCooldownActive()).toBe(true);
  });

  it('flag ON: consult resolves when the shared breaker is closed', async () => {
    process.env.EBAY_QUOTA_BREAKER_SHARED = 'true';
    getStateImpl = async () => ({ open: false, remainingMs: 0 });
    await expect(ebay._consultSharedQuotaBreaker('GetOrders')).resolves.toBeUndefined();
  });

  it('flag ON: consult is fail-safe — a breaker read error never blocks the call', async () => {
    process.env.EBAY_QUOTA_BREAKER_SHARED = 'true';
    getStateImpl = async () => { throw new Error('UNAVAILABLE'); };
    await expect(ebay._consultSharedQuotaBreaker('GetOrders')).resolves.toBeUndefined();
  });
});
