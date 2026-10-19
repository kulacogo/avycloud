'use strict';
const { createDisplaySnapshotCache } = require('../lib/display-snapshot-cache');

describe('display-only incremental snapshots', () => {
  let cache;
  afterEach(() => cache?.close());
  function fixture() {
    let next, fail;
    const stop = vi.fn();
    const query = { get: vi.fn(async () => ({ docs: ['fresh'] })), onSnapshot: vi.fn((n, e) => { next = n; fail = e; return stop; }) };
    return { query, stop, emit: v => next(v), fail: e => fail(e) };
  }
  it('shares the initial read, then consumes changes including removals without another get', async () => {
    cache = createDisplaySnapshotCache(); const f = fixture();
    const first = cache.read('tenant:a:products', f.query);
    const parallel = cache.read('tenant:a:products', f.query);
    f.emit({ docs: ['a', 'b'] });
    expect(await first).toEqual({ docs: ['a', 'b'] }); expect(await parallel).toEqual(await first);
    f.emit({ docs: ['b-edited', 'c'] });
    expect(await cache.read('tenant:a:products', f.query)).toEqual({ docs: ['b-edited', 'c'] });
    expect(f.query.onSnapshot).toHaveBeenCalledTimes(1); expect(f.query.get).not.toHaveBeenCalled();
  });
  it('isolates tenants and projection keys', async () => {
    cache = createDisplaySnapshotCache(); const a = fixture(), b = fixture();
    const pa = cache.read('a', a.query), pb = cache.read('b', b.query);
    a.emit({ docs: ['a'] }); b.emit({ docs: ['b'] });
    expect(await pa).not.toEqual(await pb);
  });
  it('never returns stale data after listener failure; falls back to a fresh query', async () => {
    cache = createDisplaySnapshotCache(); const f = fixture();
    const pending = cache.read('a', f.query); f.fail(new Error('offline'));
    expect(await pending).toEqual({ docs: ['fresh'] }); expect(f.stop).toHaveBeenCalled();
  });
  it('invalidates after process suspension and ignores callbacks from the old listener', async () => {
    let now = 100; cache = createDisplaySnapshotCache({ now: () => now, maxPauseMs: 1000 });
    const a = fixture(); const p = cache.read('a', a.query); a.emit({ docs: ['old'] }); await p;
    now += 2000; const b = fixture(); const next = cache.read('a', b.query);
    a.emit({ docs: ['stale'] }); b.emit({ docs: ['new'] });
    expect(await next).toEqual({ docs: ['new'] }); expect(a.stop).toHaveBeenCalled();
  });
  it('bounds idle listeners and falls back when startup times out', async () => {
    vi.useFakeTimers();
    try {
      cache = createDisplaySnapshotCache({ startupMs: 50, idleMs: 100 }); const f = fixture();
      const p = cache.read('a', f.query); await vi.advanceTimersByTimeAsync(51);
      expect(await p).toEqual({ docs: ['fresh'] }); expect(f.stop).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('uses ordinary reads when a query cannot be watched', async () => {
    cache = createDisplaySnapshotCache(); const query = { get: vi.fn(async () => 'fresh') };
    expect(await cache.read('a', query)).toBe('fresh');
  });
  it('drops a previously ready snapshot after listener failure', async () => {
    cache = createDisplaySnapshotCache(); const a = fixture();
    const first = cache.read('a', a.query); a.emit({ docs: ['old'] }); await first;
    a.fail(new Error('disconnected'));
    const b = fixture(); const next = cache.read('a', b.query);
    b.emit({ docs: ['fresh'] });
    expect(await next).toEqual({ docs: ['fresh'] }); expect(a.stop).toHaveBeenCalledTimes(1);
  });
  it('evicts idle and excess listeners without reusing stale snapshots', async () => {
    let now = 0; cache = createDisplaySnapshotCache({ now: () => now, idleMs: 100, maxEntries: 1 });
    const a = fixture(), b = fixture(), c = fixture();
    const pa = cache.read('a', a.query); a.emit({ docs: ['a'] }); await pa;
    const pb = cache.read('b', b.query); b.emit({ docs: ['b'] }); await pb;
    expect(a.stop).toHaveBeenCalledTimes(1);
    now = 101;
    const pc = cache.read('b', c.query); c.emit({ docs: ['new-b'] });
    expect(await pc).toEqual({ docs: ['new-b'] }); expect(b.stop).toHaveBeenCalledTimes(1);
  });

});
