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
  const client = { res, heartbeat };
  clients.add(client);

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

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    for (const [event, handler] of Object.entries(listeners)) {
      bus.removeListener(event, handler);
    }
    bus.removeListener(LISTING_SYNC_EVENT, onListingSync);
    clients.delete(client);
  });
});

module.exports = { router, clients };
