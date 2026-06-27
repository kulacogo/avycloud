// backend/__tests__/webhooks-sendcloud-returned-transition.test.js
//
// CLAUDE.md rule 11 compliance: the SendCloud webhook handler must NEVER write
// `order.omsStatus` directly via orderRef.set() for a status transition. Every
// OMS state change has to flow through transitionOrder() so that the
// `order:status_changed` event fires and post-transition side-effect hooks can run.
//
// Before this fix the 'returned' branch (SendCloud status IDs 15/32/33) did a
// hand-rolled orderRef.set({ omsStatus, ... }) plus a manual order_events doc,
// bypassing the state machine entirely. These tests pin the fixed behaviour:
//
//   1) a 'returned' webhook routes through transitionOrder({ force: true,
//      source: 'sendcloud-webhook' }) and does NOT direct-write omsStatus.
//   2) the forward-rank / idempotency guard is preserved (a backward/no-progress
//      transition neither calls transitionOrder nor writes omsStatus).
//
// globals: true in vitest.config.js — describe/it/expect/vi are global.

'use strict';

// ── Stub secret-values so the webhook auth gate is skipped in dev ───────────
const secretValuesPath = require.resolve('../lib/secret-values');
require.cache[secretValuesPath] = {
  id: secretValuesPath, filename: secretValuesPath, loaded: true,
  exports: { getSecretValue: vi.fn().mockResolvedValue(null) },
  children: [], paths: [],
};

// ── Stub the sync-event-bus (we don't want real fan-out) ────────────────────
const emitSyncEvent = vi.fn();
const syncBusPath = require.resolve('../services/sync-event-bus');
require.cache[syncBusPath] = {
  id: syncBusPath, filename: syncBusPath, loaded: true,
  exports: { emitSyncEvent },
  children: [], paths: [],
};

// ── Spy on transitionOrder, keep the REAL ORDER_STATUSES table ──────────────
// We require the real module first to grab its ORDER_STATUSES, then replace the
// cached export object so routes/webhooks.js picks up our spy.
const realStateMachine = require('../services/order-state-machine');
const transitionOrder = vi.fn().mockResolvedValue({ ok: true });
const processShippedOrder = vi.fn().mockResolvedValue({ ok: true });
const stateMachinePath = require.resolve('../services/order-state-machine');
require.cache[stateMachinePath] = {
  id: stateMachinePath, filename: stateMachinePath, loaded: true,
  exports: {
    transitionOrder,
    processShippedOrder,
    ORDER_STATUSES: realStateMachine.ORDER_STATUSES,
  },
  children: [], paths: [],
};

// ── Stub @google-cloud/firestore so we drive shipment + order docs ──────────
const shipmentDocs = new Map(); // id → { ref, data }
const orderDocs = new Map();    // id → { ref, data }
const addedEventDocs = [];      // order_events .add() payloads

function makeRef(collectionName, docId, store) {
  return {
    id: docId,
    collectionName,
    set: vi.fn(async (patch, opts) => {
      const existing = store.get(docId)?.data || {};
      const merged = opts && opts.merge ? { ...existing, ...patch } : patch;
      store.set(docId, { ref: makeRef(collectionName, docId, store), data: merged });
    }),
    get: vi.fn(async () => {
      const entry = store.get(docId);
      return {
        exists: Boolean(entry),
        id: docId,
        data: () => (entry ? entry.data : undefined),
        ref: entry && entry.ref,
      };
    }),
  };
}

function makeQuerySnap(filteredEntries) {
  return {
    empty: filteredEntries.length === 0,
    docs: filteredEntries.map((entry) => ({
      id: entry.id,
      ref: entry.ref,
      data: () => entry.data,
    })),
  };
}

const firestoreMock = {
  collection: vi.fn((name) => {
    if (name === 'order_events') {
      return {
        add: vi.fn(async (data) => {
          addedEventDocs.push(data);
          return { id: `evt-${addedEventDocs.length}` };
        }),
        doc: () => makeRef('order_events', 'noop', new Map()),
      };
    }
    const store = name === 'shipments' ? shipmentDocs : name === 'orders' ? orderDocs : null;
    if (!store) {
      return {
        doc: () => makeRef(name, 'noop', new Map()),
        where: () => ({ where: () => ({ limit: () => ({ get: async () => makeQuerySnap([]) }) }) }),
        add: vi.fn(async () => ({ id: 'noop' })),
      };
    }
    const where = (field, op, value) => {
      const filter = (entry) => {
        const v = entry.data[field];
        if (op === '==') return v === value;
        return false;
      };
      return {
        where,
        limit: () => ({ get: async () => makeQuerySnap([...store.values()].filter(filter)) }),
        get: async () => makeQuerySnap([...store.values()].filter(filter)),
      };
    };
    return {
      doc: (id) => {
        const existing = store.get(id);
        if (existing) return existing.ref;
        return makeRef(name, id, store);
      },
      where,
      add: vi.fn(async (data) => {
        const id = `${name}-${store.size + 1}`;
        const ref = makeRef(name, id, store);
        store.set(id, { ref, data });
        return { id };
      }),
    };
  }),
};

const firestoreMod = require.resolve('@google-cloud/firestore');
function FirestoreCtor() { return firestoreMock; }
require.cache[firestoreMod] = {
  id: firestoreMod, filename: firestoreMod, loaded: true,
  exports: {
    Firestore: FirestoreCtor,
    FieldValue: { serverTimestamp: () => 'ts', delete: () => '__delete__' },
  },
  children: [], paths: [],
};

// ── Load the SUT after all patches are in place ─────────────────────────────
const express = require('express');
const request = require('supertest');
const webhooksRouter = require('../routes/webhooks');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', webhooksRouter);
  return app;
}

function seedShipment(id, data) {
  const ref = makeRef('shipments', id, shipmentDocs);
  shipmentDocs.set(id, { id, ref, data });
}
function seedOrder(id, data) {
  const ref = makeRef('orders', id, orderDocs);
  orderDocs.set(id, { id, ref, data });
}

// Collect every orderRef.set() call so we can assert no direct omsStatus write.
function orderSetCalls(orderId) {
  const entry = orderDocs.get(orderId);
  if (!entry || !entry.ref || !entry.ref.set) return [];
  return entry.ref.set.mock.calls.map((c) => c[0]);
}

describe('SendCloud webhook — "returned" status must route through transitionOrder (CLAUDE.md rule 11)', () => {
  beforeEach(() => {
    shipmentDocs.clear();
    orderDocs.clear();
    addedEventDocs.length = 0;
    transitionOrder.mockClear();
    processShippedOrder.mockClear();
    emitSyncEvent.mockClear();
    transitionOrder.mockResolvedValue({ ok: true });
  });

  it('routes a "returned" (status 33) webhook through transitionOrder({ force:true, source:"sendcloud-webhook" }) and does NOT direct-write omsStatus', async () => {
    seedShipment('ship-1', {
      orderId: 'order-1',
      sendcloudParcelId: 7777,
      tenantId: 'default',
    });
    // Order is in a forward state where 'returned' (rank 9) is a forward move.
    seedOrder('order-1', { omsStatus: 'shipped', tenantId: 'default' });

    const res = await request(buildApp())
      .post('/api/webhooks/sendcloud')
      .send({
        parcel_id: 7777,
        status: { id: 33, message: 'Return delivered back to sender' },
      });

    expect(res.status).toBe(200);

    // 1) transitionOrder MUST have been called for the returned transition.
    expect(transitionOrder).toHaveBeenCalledTimes(1);
    const arg = transitionOrder.mock.calls[0][0];
    expect(arg.orderId).toBe('order-1');
    expect(arg.toStatus).toBe('returned');
    expect(arg.force).toBe(true);
    expect(arg.source).toBe('sendcloud-webhook');

    // 2) NO direct orderRef.set() that contains omsStatus (the rule-11 violation).
    const setPayloads = orderSetCalls('order-1');
    for (const payload of setPayloads) {
      expect(payload).not.toHaveProperty('omsStatus');
      expect(payload).not.toHaveProperty('omsStatusLabel');
    }

    // 3) The hand-rolled order_events 'status_change' doc must be gone —
    //    transitionOrder owns event logging now.
    const manualStatusEvents = addedEventDocs.filter((d) => d.event === 'status_change');
    expect(manualStatusEvents).toHaveLength(0);

    // 4) shipment:updated still emitted (observable behaviour preserved).
    expect(emitSyncEvent).toHaveBeenCalledWith(
      'shipment:updated',
      expect.objectContaining({ entityId: 'order-1', tenantId: 'default' }),
    );
  });

  it('preserves the forward-rank guard: a "returned" webhook on an already-cancelled order does NOT transition or write omsStatus', async () => {
    seedShipment('ship-2', {
      orderId: 'order-2',
      sendcloudParcelId: 8888,
      tenantId: 'default',
    });
    // cancelled has forward-rank 99 → 'returned' (rank 9) must NOT overwrite it.
    seedOrder('order-2', { omsStatus: 'cancelled', tenantId: 'default' });

    const res = await request(buildApp())
      .post('/api/webhooks/sendcloud')
      .send({
        parcel_id: 8888,
        status: { id: 15, message: 'Return being delivered back' },
      });

    expect(res.status).toBe(200);
    // Guard blocks the move: no state machine call, no direct omsStatus write.
    expect(transitionOrder).not.toHaveBeenCalled();
    const setPayloads = orderSetCalls('order-2');
    for (const payload of setPayloads) {
      expect(payload).not.toHaveProperty('omsStatus');
    }
  });
});
