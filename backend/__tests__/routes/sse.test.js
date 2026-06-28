'use strict';

/**
 * Tests for backend/routes/sse.js — the GET /api/events SSE endpoint.
 *
 * Covers the existing behaviour (headers, connected event, bus-mapped frames,
 * 2s same-type debounce, disconnect cleanup) AND the new ENV-gated safety rails:
 *   - SSE_MAX_CONN_PER_INSTANCE (per-instance connection ceiling → 503 + Retry-After)
 *   - SSE_MAX_LIFETIME_MS (connection-lifetime cap → reconnect frame + res.end())
 *   - sseMetrics export
 *
 * CRITICAL regression guard: with NO ENV set, behaviour must be byte-for-byte
 * today's (no shed, no lifetime end).
 *
 * Pattern: require.cache-patch lib/rbac.js so requirePermission is a pass-through
 * (no auth), then drive the router with lightweight mock req/res objects so we
 * can inspect written SSE frames + control fake timers precisely.
 */

const path = require('path');

// ─── Patch lib/rbac.js BEFORE the route loads (CJS require.cache, not vi.mock) ──
function patchLocalModule(modulePath, mockExports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: mockExports,
    children: [],
    paths: [],
  };
}
patchLocalModule('../../lib/rbac.js', {
  requirePermission: () => (req, res, next) => next(),
  resolvePermissionsForUser: () => Promise.resolve({}),
});

// Use the REAL bus so listenerCount / removeListener / emit semantics are real.
const { bus } = require('../../services/sync-event-bus');
const sseModule = require('../../routes/sse');
const { router, clients, sseMetrics } = sseModule;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Find the GET /events layer's handler stack from the express router. */
function getEventsHandler() {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === '/events' && l.route.methods.get,
  );
  // Last handler in the stack is the actual route handler (after requirePermission).
  const handlers = layer.route.stack.map((s) => s.handle);
  return handlers[handlers.length - 1];
}

/** Build a fake req/res pair that records writes and lets us fire 'close'. */
function makeConn() {
  const writes = [];
  const headers = {};
  const closeListeners = [];
  let statusCode = 200;
  let ended = false;

  const req = {
    on(event, cb) {
      if (event === 'close') closeListeners.push(cb);
    },
    fireClose() {
      for (const cb of closeListeners) cb();
    },
  };

  const res = {
    setHeader(k, v) {
      headers[k] = v;
    },
    getHeader(k) {
      return headers[k];
    },
    flushHeaders() {},
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
    status(code) {
      statusCode = code;
      return res;
    },
    json(obj) {
      this.body = obj;
      ended = true;
      return res;
    },
    end(chunk) {
      if (chunk !== undefined) writes.push(String(chunk));
      ended = true;
      return res;
    },
    get statusCode() {
      return statusCode;
    },
    get ended() {
      return ended;
    },
    _writes: writes,
    _headers: headers,
  };

  return { req, res, writes, headers };
}

/** Drive a fresh connection through the route handler. */
function connect() {
  const conn = makeConn();
  const handler = getEventsHandler();
  handler(conn.req, conn.res);
  return conn;
}

/** Join all writes for substring matching. */
function joined(conn) {
  return conn.writes.join('');
}

const BUS_EVENTS = [
  'order:created',
  'order:status_changed',
  'order:updated',
  'return:created',
  'return:status_changed',
  'shipment:created',
  'shipment:updated',
  'stock:changed',
  'listings:sync_completed',
];

/** Sum of listener counts for all bus events the route registers per conn. */
function totalListenerCount() {
  return BUS_EVENTS.reduce((sum, ev) => sum + bus.listenerCount(ev), 0);
}

// ─── Test hygiene: clean ENV + clients + timers between tests ─────────────────

const ENV_KEYS = ['SSE_MAX_CONN_PER_INSTANCE', 'SSE_MAX_LIFETIME_MS'];
let savedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  // Defensive: ensure no leftover clients from a previous test.
  for (const c of [...clients]) clients.delete(c);
  // Reset metrics counters that accumulate across tests where we assert deltas.
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  // Drain any clients still registered so we don't leak listeners/timers.
  for (const c of [...clients]) {
    if (c && c.heartbeat) clearInterval(c.heartbeat);
    if (c && c.lifetimeTimer) clearTimeout(c.lifetimeTimer);
    clients.delete(c);
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/events — SSE headers + connected event', () => {
  it('sets SSE headers and writes an initial connected event', () => {
    const conn = connect();
    expect(conn.headers['Content-Type']).toBe('text/event-stream');
    expect(conn.headers['Cache-Control']).toBe('no-cache');
    expect(conn.headers['Connection']).toBe('keep-alive');
    expect(conn.headers['X-Accel-Buffering']).toBe('no');
    expect(joined(conn)).toContain('event: connected');
    conn.req.fireClose();
  });
});

describe('GET /api/events — bus event → mapped SSE frame', () => {
  it('forwards stock:changed as a listings:synced frame', () => {
    const conn = connect();
    bus.emit('stock:changed', { entityId: 'P1', source: 'test', tenantId: 'default' });
    expect(joined(conn)).toContain('event: listings:synced');
    conn.req.fireClose();
  });

  it('forwards order:status_changed as orders:status-changed with newStatus', () => {
    const conn = connect();
    bus.emit('order:status_changed', { entityId: 'O1', toStatus: 'shipped', source: 'test' });
    const out = joined(conn);
    expect(out).toContain('event: orders:status-changed');
    expect(out).toContain('"newStatus":"shipped"');
    conn.req.fireClose();
  });
});

describe('GET /api/events — 2s same-type debounce', () => {
  it('emits only one frame for two same-type events inside the 2s window', () => {
    vi.useFakeTimers();
    try {
      const conn = connect();
      const before = joined(conn);
      bus.emit('stock:changed', { entityId: 'P1', source: 'a' });
      bus.emit('stock:changed', { entityId: 'P2', source: 'b' });
      const after = joined(conn);
      const newFrames = after.slice(before.length);
      const count = (newFrames.match(/event: listings:synced/g) || []).length;
      expect(count).toBe(1);
      conn.req.fireClose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GET /api/events — connection ceiling (SSE_MAX_CONN_PER_INSTANCE)', () => {
  it('rejects the 2nd connection with 503 + Retry-After and increments shedTotal, leaving listeners untouched', () => {
    process.env.SSE_MAX_CONN_PER_INSTANCE = '1';
    const shedBefore = sseMetrics.shedTotal;

    const c1 = connect();
    expect(clients.size).toBe(1);
    const listenersAfterFirst = totalListenerCount();

    const c2 = connect();
    // Shed connection: 503 response, NOT registered.
    expect(c2.res.statusCode).toBe(503);
    expect(c2.res.getHeader('Retry-After')).toBeDefined();
    expect(clients.size).toBe(1); // still only the first
    expect(sseMetrics.shedTotal).toBe(shedBefore + 1);
    // No leaked listeners for the shed connection.
    expect(totalListenerCount()).toBe(listenersAfterFirst);

    c1.req.fireClose();
  });
});

describe('GET /api/events — lifetime cap (SSE_MAX_LIFETIME_MS)', () => {
  it('after the lifetime elapses: writes reconnect frame, ends res, clears timers, removes listeners, clients empty', () => {
    vi.useFakeTimers();
    try {
      process.env.SSE_MAX_LIFETIME_MS = '1000';
      const listenersBaseline = totalListenerCount();
      const evictBefore = sseMetrics.lifetimeEvictions;

      const conn = connect();
      expect(clients.size).toBe(1);
      expect(totalListenerCount()).toBeGreaterThan(listenersBaseline);

      vi.advanceTimersByTime(1000);

      expect(joined(conn)).toContain('event: reconnect');
      expect(conn.res.ended).toBe(true);
      expect(clients.size).toBe(0);
      expect(totalListenerCount()).toBe(listenersBaseline);
      expect(sseMetrics.lifetimeEvictions).toBe(evictBefore + 1);

      // Advancing further must not write more or double-end (no timer leak).
      const lenAfterEvict = joined(conn).length;
      vi.advanceTimersByTime(60_000);
      expect(joined(conn).length).toBe(lenAfterEvict);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GET /api/events — disconnect cleanup', () => {
  it("on req 'close' removes all listeners, clears heartbeat, deletes client", () => {
    const listenersBaseline = totalListenerCount();
    const conn = connect();
    expect(clients.size).toBe(1);
    expect(totalListenerCount()).toBeGreaterThan(listenersBaseline);

    conn.req.fireClose();

    expect(clients.size).toBe(0);
    expect(totalListenerCount()).toBe(listenersBaseline);
  });

  it('double-close is safe (idempotent, no negative metrics, no throw)', () => {
    const conn = connect();
    const openAfterConnect = sseMetrics.open;
    conn.req.fireClose();
    const openAfterClose = sseMetrics.open;
    expect(() => conn.req.fireClose()).not.toThrow();
    // open must not decrement twice.
    expect(sseMetrics.open).toBe(openAfterClose);
    expect(openAfterClose).toBe(openAfterConnect - 1);
    expect(clients.size).toBe(0);
  });
});

describe('GET /api/events — DEFAULTS preserve behaviour (regression guard)', () => {
  it('with no ENV set: no shed (many connections allowed)', () => {
    const shedBefore = sseMetrics.shedTotal;
    const conns = [];
    for (let i = 0; i < 5; i++) conns.push(connect());
    expect(clients.size).toBe(5);
    expect(sseMetrics.shedTotal).toBe(shedBefore); // nothing shed
    for (const c of conns) c.req.fireClose();
    expect(clients.size).toBe(0);
  });

  it('with no ENV set: no lifetime eviction even after a long fake-time advance', () => {
    vi.useFakeTimers();
    try {
      const evictBefore = sseMetrics.lifetimeEvictions;
      const conn = connect();
      vi.advanceTimersByTime(60 * 60 * 1000); // 1 hour
      expect(conn.res.ended).toBe(false);
      expect(joined(conn)).not.toContain('event: reconnect');
      expect(clients.size).toBe(1);
      expect(sseMetrics.lifetimeEvictions).toBe(evictBefore);
      conn.req.fireClose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('routes/sse.js — exports sseMetrics', () => {
  it('exports a metrics object with the expected counter keys', () => {
    expect(sseModule.sseMetrics).toBeDefined();
    for (const k of ['open', 'openedTotal', 'shedTotal', 'lifetimeEvictions']) {
      expect(typeof sseModule.sseMetrics[k]).toBe('number');
    }
  });
});
