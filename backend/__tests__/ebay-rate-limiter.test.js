const { acquireSlot, getUsage, _reset } = require('../lib/ebay-rate-limiter');

beforeEach(() => {
  _reset();
});

describe('ebay-rate-limiter', () => {
  it('acquireSlot() resolves immediately when under limit', async () => {
    const start = Date.now();
    await acquireSlot();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('allows multiple calls under per-second limit', async () => {
    // Default is 4 calls/second — first 4 should be instant
    for (let i = 0; i < 4; i++) {
      await acquireSlot();
    }
    const usage = getUsage();
    expect(usage.lastSecond).toBe(4);
    expect(usage.lastDay).toBe(4);
  });

  it('getUsage() returns correct structure', () => {
    const usage = getUsage();
    expect(usage).toHaveProperty('lastSecond');
    expect(usage).toHaveProperty('lastHour');
    expect(usage).toHaveProperty('lastDay');
    expect(usage).toHaveProperty('limits');
    expect(usage).toHaveProperty('queueLength');
    expect(usage.limits).toHaveProperty('perSecond');
    expect(usage.limits).toHaveProperty('perHour');
    expect(usage.limits).toHaveProperty('perDay');
  });

  it('getUsage() tracks calls correctly', async () => {
    expect(getUsage().lastDay).toBe(0);
    await acquireSlot();
    expect(getUsage().lastDay).toBe(1);
    await acquireSlot();
    expect(getUsage().lastDay).toBe(2);
  });

  it('_reset() clears all state', async () => {
    await acquireSlot();
    await acquireSlot();
    expect(getUsage().lastDay).toBe(2);
    _reset();
    expect(getUsage().lastDay).toBe(0);
  });
});
