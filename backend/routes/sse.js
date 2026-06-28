'use strict';

/**
 * SSE (Server-Sent Events) endpoint — pushes real-time sync events to the frontend.
 *
 * Single connection per client at GET /api/events.
 * Listens to sync-event-bus and forwards relevant events so the frontend
 * can invalidate its React Query cache instantly.
 *
 * Auth: uses the existing ?token=<jwt> → Authorization header middleware
 * from index.js, so EventSource (which can't set headers) works out of the box.
 */

const router = require('express').Router();
const { requirePermission } = require('../lib/rbac');
const { bus } = require('../services/sync-event-bus');

// Track connected clients for graceful cleanup
const clients = new Set();

// ─── Self-limiting safety rails (ENV-gated, default = today's behaviour) ──────
//
// Background: at Cloud-Run containerConcurrency=1, a single long-lived SSE
// connection pins a whole instance for its entire lifetime. These two knobs
// let an operator cap/shed connections without redeploying code. With NEITHER
// ENV set the behaviour is byte-for-byte identical to before (no shed, no cap).
//
//   SSE_MAX_CONN_PER_INSTANCE — per-instance connection ceiling. 0 = unlimited
//                               (DEFAULT). When >0, the (ceiling+1)-th concurrent
//                               connection is rejected with 503 + Retry-After and
//                               is NOT registered (no heartbeat / bus listeners).
//   SSE_MAX_LIFETIME_MS       — max connection lifetime in ms. 0 = no cap
//                               (DEFAULT). When >0, the server proactively sends
//                               an `event: reconnect` frame and ends the response
//                               so the browser EventSource auto-reconnects (which
//                               lets Cloud-Run rebalance the connection to a
//                               fresh/less-loaded instance).
//
// Read PER-REQUEST (not at module load) so the safety rails reflect the current
// environment without re-requiring the module — keeps the default path a single
// integer parse with no behaviour change.
function intEnv(name, fallback) {
  const n = parseInt(process.env[name] || String(fallback), 10);
  return Number.isFinite(n) ? n : fallback;
}

// Lightweight in-process metrics so a health route can read SSE saturation.
// Exported (not wired to a new route here) — additive, read-only telemetry.
const sseMetrics = {
  open: 0,              // currently-open connections on this instance
  openedTotal: 0,       // total connections ever accepted (monotonic)
  shedTotal: 0,         // total connections rejected by the ceiling (monotonic)
  lifetimeEvictions: 0, // total connections ended by the lifetime cap (monotonic)
};

/**
 * Map internal sync-event-bus events to frontend SSE event types.
 * Only events the frontend cares about for cache invalidation.
 */
const EVENT_MAP = {
  'order:created':        'orders:synced',
  'order:status_changed': 'orders:status-changed',
  'order:updated':        'orders:synced',
  'return:created':       'orders:synced',
  'return:status_changed': 'orders:synced',
  'shipment:created':     'orders:synced',
  'shipment:updated':     'orders:synced',
  'stock:changed':        'listings:synced',
};

// Listing sync events are emitted by listing-sync-runner; forward them too.
const LISTING_SYNC_EVENT = 'listings:sync_completed';

router.get('/events', requirePermission('dashboard', 'read'), (req, res) => {
  const maxConn = intEnv('SSE_MAX_CONN_PER_INSTANCE', 0);
  const maxLifetimeMs = intEnv('SSE_MAX_LIFETIME_MS', 0);

  // ─── Connection ceiling (ENV-gated; 0 = unlimited = TODAY'S DEFAULT) ──────
  // Reject BEFORE writing SSE headers or registering any heartbeat/bus
  // listeners, so a shed connection leaks nothing.
  if (maxConn > 0 && clients.size >= maxConn) {
    sseMetrics.shedTotal += 1;
    res.setHeader('Retry-After', String(intEnv('SSE_SHED_RETRY_AFTER_S', 5)));
    res.status(503).json({
      ok: false,
      error: { code: 'SSE_CAPACITY', message: 'SSE connection limit reached, retry shortly' },
    });
    return;
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);

  // Heartbeat every 30s to keep connection alive through proxies/load balancers
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 30_000);

  // Track this client
  const client = { res, heartbeat, lifetimeTimer: null };
  clients.add(client);
  sseMetrics.open += 1;
  sseMetrics.openedTotal += 1;

  // Debounce per event type — don't flood the client
  const lastSent = new Map();
  const SSE_DEBOUNCE_MS = 2000;

  function sendEvent(eventType, payload) {
    const now = Date.now();
    const last = lastSent.get(eventType) || 0;
    if (now - last < SSE_DEBOUNCE_MS) return;
    lastSent.set(eventType, now);

    try {
      res.write(`event: ${eventType}\ndata: ${JSON.stringify({ ...payload, ts: now })}\n\n`);
    } catch {
      // Client disconnected — cleanup will handle it
    }
  }

  // Listen to sync-event-bus events
  function onBusEvent(busEvent) {
    return (payload) => {
      const sseEvent = EVENT_MAP[busEvent];
      if (sseEvent) {
        sendEvent(sseEvent, {
          entityId: payload.entityId,
          source: payload.source,
          ...(payload.toStatus ? { newStatus: payload.toStatus } : {}),
        });
      }
    };
  }

  const listeners = {};
  for (const busEvent of Object.keys(EVENT_MAP)) {
    const handler = onBusEvent(busEvent);
    listeners[busEvent] = handler;
    bus.on(busEvent, handler);
  }

  // Also listen for listing sync completion
  const onListingSync = (payload) => {
    sendEvent('listings:synced', {
      active: payload?.active,
      inactive: payload?.inactive,
      source: payload?.source || 'listing-sync',
    });
  };
  bus.on(LISTING_SYNC_EVENT, onListingSync);

  // Single, idempotent teardown — removes ALL timers + ALL bus listeners and
  // always deletes the client. Guarded so a double-close (e.g. lifetime cap
  // firing then req 'close') can't double-decrement metrics or double-remove.
  let closed = false;
  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    if (client.lifetimeTimer) {
      clearTimeout(client.lifetimeTimer);
      client.lifetimeTimer = null;
    }
    for (const [event, handler] of Object.entries(listeners)) {
      bus.removeListener(event, handler);
    }
    bus.removeListener(LISTING_SYNC_EVENT, onListingSync);
    clients.delete(client);
    sseMetrics.open = Math.max(0, sseMetrics.open - 1);
  }

  // ─── Lifetime cap (ENV-gated; 0 = no cap = TODAY'S DEFAULT) ───────────────
  // Proactively recycle the connection so the EventSource reconnects and
  // Cloud-Run can rebalance it off a pinned instance. We send a `reconnect`
  // frame, end the response, then tear everything down via cleanup().
  if (maxLifetimeMs > 0) {
    client.lifetimeTimer = setTimeout(() => {
      try {
        res.write(`event: reconnect\ndata: ${JSON.stringify({ ts: Date.now(), reason: 'lifetime' })}\n\n`);
      } catch {
        // Client already gone — cleanup below still runs.
      }
      sseMetrics.lifetimeEvictions += 1;
      cleanup();
      try {
        res.end();
      } catch {
        // Response already ended.
      }
    }, maxLifetimeMs);
  }

  // Cleanup on disconnect
  req.on('close', cleanup);
});

module.exports = { router, clients, sseMetrics };
