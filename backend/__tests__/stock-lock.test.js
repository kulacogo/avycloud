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

  it('timeout breaks lock after specified time (no deadlock)', async () => {
    // Acquire lock and never release it
    const release = await acquireStockLock('STUCK', 100);
    const start = Date.now();
    // Second acquisition should timeout
    const release2 = await acquireStockLock('STUCK', 100);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(500);
    release2();
    release();
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
