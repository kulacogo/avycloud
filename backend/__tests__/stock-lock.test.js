// globals: true in vitest.config.js — describe/it/expect/vi are global

const { acquireStockLock, withStockLock } = require('../lib/stock-lock');

describe('stock-lock', () => {
  it('serializes parallel calls for the same key', async () => {
    const order = [];
    const p1 = withStockLock('SKU-A', async () => {
      order.push('p1-start');
      await new Promise((r) => setTimeout(r, 50));
      order.push('p1-end');
    });
    // Small delay so p1 acquires lock first
    await new Promise((r) => setTimeout(r, 5));
    const p2 = withStockLock('SKU-A', async () => {
      order.push('p2-start');
      order.push('p2-end');
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual(['p1-start', 'p1-end', 'p2-start', 'p2-end']);
  });

  it('allows parallel calls for different keys', async () => {
    const order = [];
    const p1 = withStockLock('SKU-A', async () => {
      order.push('A-start');
      await new Promise((r) => setTimeout(r, 50));
      order.push('A-end');
    });
    const p2 = withStockLock('SKU-B', async () => {
      order.push('B-start');
      await new Promise((r) => setTimeout(r, 50));
      order.push('B-end');
    });
    await Promise.all([p1, p2]);
    // Both should start before either ends (parallel)
    expect(order.indexOf('A-start')).toBeLessThan(order.indexOf('A-end'));
    expect(order.indexOf('B-start')).toBeLessThan(order.indexOf('B-end'));
    // At least one B operation should happen before A-end (proves parallelism)
    expect(order.indexOf('B-start')).toBeLessThan(order.indexOf('A-end'));
  });

  it('throws timeout when lock cannot be acquired in time', async () => {
    const release = await acquireStockLock('STUCK', 100);
    const start = Date.now();
    await expect(acquireStockLock('STUCK', 100)).rejects.toThrow(/timeout/i);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(800);
    await release();
  });

  it('releases lock even when callback throws', async () => {
    try {
      await withStockLock('ERR-SKU', async () => {
        throw new Error('boom');
      });
    } catch (e) {
      expect(e.message).toBe('boom');
    }

    // Lock should be released — second call should resolve immediately
    const start = Date.now();
    await withStockLock('ERR-SKU', async () => {});
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('returns the callback return value', async () => {
    const result = await withStockLock('RET-SKU', async () => 42);
    expect(result).toBe(42);
  });
});

// Regression guard for the oversell hole: when the firestore lock backend is
// active and the acquire path errors transiently, withStockLock MUST fail closed
// (surface the error) instead of silently degrading to the per-instance in-memory
// Map lock. In Cloud Run NODE_ENV is UNSET (not 'test'/'development'), so the
// fail-closed guard must treat any non-test/non-dev env as production.
// CLAUDE.md rule #12: kein In-Memory-Stock-Lock in Production.
describe('stock-lock fail-closed (no silent memory fallback in prod)', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  const ORIGINAL_BACKEND = process.env.STOCK_LOCK_BACKEND;
  let firestore;
  let originalRunTransaction;

  beforeEach(() => {
    // Force the firestore backend regardless of NODE_ENV.
    process.env.STOCK_LOCK_BACKEND = 'firestore';
    // Patch the shared firestore module export so acquire fails transiently.
    ({ firestore } = require('../lib/firestore'));
    originalRunTransaction = firestore.runTransaction;
    firestore.runTransaction = async () => {
      throw new Error('simulated firestore outage (DEADLINE_EXCEEDED)');
    };
  });

  afterEach(() => {
    firestore.runTransaction = originalRunTransaction;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_BACKEND === undefined) delete process.env.STOCK_LOCK_BACKEND;
    else process.env.STOCK_LOCK_BACKEND = ORIGINAL_BACKEND;
  });

  it('fails closed when NODE_ENV is unset (Cloud Run) and firestore acquire errors', async () => {
    // Cloud Run reality: NODE_ENV is not set at all.
    delete process.env.NODE_ENV;
    await expect(acquireStockLock('OVERSELL-SKU', 200)).rejects.toThrow(/stock-lock unavailable/i);
  });

  it('fails closed when NODE_ENV=production and firestore acquire errors', async () => {
    process.env.NODE_ENV = 'production';
    await expect(acquireStockLock('OVERSELL-SKU', 200)).rejects.toThrow(/stock-lock unavailable/i);
  });

  it('still degrades to memory in development when firestore acquire errors', async () => {
    process.env.NODE_ENV = 'development';
    // Dev convenience: degrade to in-memory lock so devs can keep working.
    const release = await acquireStockLock('DEV-SKU', 200);
    expect(typeof release).toBe('function');
    await release();
  });
});
