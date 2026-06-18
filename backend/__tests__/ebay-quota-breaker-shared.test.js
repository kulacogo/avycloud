'use strict';

const breaker = require('../lib/ebay-quota-breaker');

const NOW = Date.parse('2026-06-18T12:00:00.000Z');
const DOC_PATH = 'system/ebay_quota_breaker';

// Minimal in-memory Firestore double supporting doc(path).get()/.set().
function makeFakeFirestore(initial) {
  const store = new Map();
  if (initial) store.set(DOC_PATH, initial);
  let getCount = 0;
  let setCount = 0;
  return {
    getCount: () => getCount,
    setCount: () => setCount,
    store,
    doc(path) {
      return {
        async get() {
          getCount += 1;
          const d = store.get(path);
          return { exists: d != null, data: () => d };
        },
        async set(data, opts) {
          setCount += 1;
          const prev = opts && opts.merge ? store.get(path) || {} : {};
          store.set(path, { ...prev, ...data });
        },
      };
    },
  };
}

beforeEach(() => breaker._resetCache());

describe('ebay-quota-breaker (Firestore-shared)', () => {
  it('starts closed when no breaker doc exists', async () => {
    const firestore = makeFakeFirestore();
    expect(await breaker.isEbayQuotaBreakerOpen({ firestore, now: NOW })).toBe(false);
  });

  it('opens by writing openUntil = now + cooldown to Firestore', async () => {
    const firestore = makeFakeFirestore();
    await breaker.openEbayQuotaBreaker({ firestore, cooldownMs: 15 * 60 * 1000, reason: 'usage limit', now: NOW });

    const persisted = firestore.store.get(DOC_PATH);
    expect(Date.parse(persisted.openUntil)).toBe(NOW + 15 * 60 * 1000);

    const state = await breaker.getEbayQuotaBreakerState({ firestore, now: NOW });
    expect(state.open).toBe(true);
    expect(state.remainingMs).toBe(15 * 60 * 1000);
  });

  it('reports closed once openUntil is in the past', async () => {
    const firestore = makeFakeFirestore({ openUntil: new Date(NOW - 1000).toISOString() });
    expect(await breaker.isEbayQuotaBreakerOpen({ firestore, now: NOW })).toBe(false);
  });

  it('caches reads in-process for 10s (no Firestore read on repeat)', async () => {
    const firestore = makeFakeFirestore();
    // First read populates the cache (1 get).
    await breaker.isEbayQuotaBreakerOpen({ firestore, now: NOW });
    expect(firestore.getCount()).toBe(1);
    // Within 10s → served from cache, no extra get.
    await breaker.isEbayQuotaBreakerOpen({ firestore, now: NOW + 5000 });
    expect(firestore.getCount()).toBe(1);
    // After 10s → cache expired, re-reads.
    await breaker.isEbayQuotaBreakerOpen({ firestore, now: NOW + 11000 });
    expect(firestore.getCount()).toBe(2);
  });

  it('open() primes the cache so an immediate isOpen() needs no read', async () => {
    const firestore = makeFakeFirestore();
    await breaker.openEbayQuotaBreaker({ firestore, cooldownMs: 60000, now: NOW });
    const before = firestore.getCount();
    expect(await breaker.isEbayQuotaBreakerOpen({ firestore, now: NOW + 1000 })).toBe(true);
    expect(firestore.getCount()).toBe(before); // served from primed cache
  });

  it('is cross-instance: a breaker opened via Firestore is seen by a fresh reader', async () => {
    const shared = makeFakeFirestore();
    await breaker.openEbayQuotaBreaker({ firestore: shared, cooldownMs: 60000, now: NOW });
    // Simulate a different instance: its in-process cache is empty.
    breaker._resetCache();
    expect(await breaker.isEbayQuotaBreakerOpen({ firestore: shared, now: NOW + 1000 })).toBe(true);
  });

  it('closes the breaker', async () => {
    const firestore = makeFakeFirestore();
    await breaker.openEbayQuotaBreaker({ firestore, cooldownMs: 60000, now: NOW });
    await breaker.closeEbayQuotaBreaker({ firestore, now: NOW });
    expect(await breaker.isEbayQuotaBreakerOpen({ firestore, now: NOW + 1000 })).toBe(false);
  });

  it('fails safe (treats as closed) when Firestore read throws', async () => {
    const firestore = {
      doc: () => ({ get: async () => { throw new Error('UNAVAILABLE'); }, set: async () => {} }),
    };
    await expect(breaker.isEbayQuotaBreakerOpen({ firestore, now: NOW })).resolves.toBe(false);
  });
});
