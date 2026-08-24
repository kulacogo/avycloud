// backend/__tests__/webhooks-sendcloud-additional-shipment.test.js
//
// Review-Befunde 4/9 (2026-08-21): Ein Zusatz-Label (Teil-/Ersatzsendung) legt ein
// regulaeres shipments-Doc an — der SendCloud-Webhook behandelte JEDES Paket des
// Auftrags als autoritativ. Wird das ZUSATZ-Paket zugestellt, bevor das
// Primaer-Paket ankommt, transitionierte der Auftrag faelschlich auf 'delivered'
// und der Tracking-Backfill ueberschrieb order.trackingNumber mit der
// Zusatz-Sendungsnummer (die dann via refresh/catchup zum Marktplatz ginge).
//
// Erwartung seit Fix: shipments-Docs mit additionalLabel:true aktualisieren NUR
// ihr eigenes Doc (+ den Eintrag in order.additionalShipments), loesen aber
// KEINEN Status-Uebergang und KEINEN Tracking-Backfill der Primaer-Felder aus.

'use strict';

const secretValuesPath = require.resolve('../lib/secret-values');
require.cache[secretValuesPath] = {
  id: secretValuesPath, filename: secretValuesPath, loaded: true,
  exports: { getSecretValue: vi.fn().mockResolvedValue(null) },
  children: [], paths: [],
};

const emitSyncEvent = vi.fn();
const syncBusPath = require.resolve('../services/sync-event-bus');
require.cache[syncBusPath] = {
  id: syncBusPath, filename: syncBusPath, loaded: true,
  exports: { emitSyncEvent },
  children: [], paths: [],
};

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

// ── Firestore-Mock (Muster aus webhooks-sendcloud-returned-transition.test.js) ──
const shipmentDocs = new Map();
const orderDocs = new Map();

function makeRef(collectionName, docId, store) {
  return {
    id: docId,
    collectionName,
    set: vi.fn(async (patch, opts) => {
      const existing = store.get(docId)?.data || {};
      const prevRef = store.get(docId)?.ref;
      const merged = opts && opts.merge ? { ...existing, ...patch } : patch;
      store.set(docId, { id: docId, ref: prevRef || makeRef(collectionName, docId, store), data: merged });
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
    const store = name === 'shipments' ? shipmentDocs : name === 'orders' ? orderDocs : null;
    if (!store) {
      return {
        doc: () => makeRef(name, 'noop', new Map()),
        where: () => ({ where: () => ({ limit: () => ({ get: async () => makeQuerySnap([]) }) }) }),
        add: vi.fn(async () => ({ id: 'noop' })),
      };
    }
    const where = (field, op, value) => ({
      where,
      limit: () => ({ get: async () => makeQuerySnap([...store.values()].filter((e) => e.data[field] === value)) }),
      get: async () => makeQuerySnap([...store.values()].filter((e) => e.data[field] === value)),
    });
    return {
      doc: (id) => {
        const existing = store.get(id);
        if (existing) return existing.ref;
        return makeRef(name, id, store);
      },
      where,
      add: vi.fn(async (data) => ({ id: 'auto' })),
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

const express = require('express');
const request = require('supertest');
const webhooksRouter = require('../routes/webhooks');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', webhooksRouter);
  return app;
}

function seed(store, id, data) {
  const ref = makeRef(store === shipmentDocs ? 'shipments' : 'orders', id, store);
  store.set(id, { id, ref, data });
}

describe('SendCloud-Webhook — Zusatz-Sendungen sind nicht autoritativ fuer den Auftrag', () => {
  beforeEach(() => {
    shipmentDocs.clear();
    orderDocs.clear();
    transitionOrder.mockClear();
    processShippedOrder.mockClear();
    emitSyncEvent.mockClear();
  });

  it('Zustellung des ZUSATZ-Pakets: kein transitionOrder, kein Primaer-Tracking-Backfill', async () => {
    seed(shipmentDocs, 'ship-add', {
      orderId: 'order-1', sendcloudParcelId: 4343, tenantId: 'default',
      additionalLabel: true, trackingNumber: 'SECOND-TRACK',
    });
    seed(orderDocs, 'order-1', {
      omsStatus: 'shipped', trackingNumber: 'ORIGINAL-TRACK',
      additionalShipments: [{ shipmentId: 'ship-add', sendcloudParcelId: 4343, trackingNumber: null }],
    });

    const res = await request(buildApp())
      .post('/api/webhooks/sendcloud')
      .send({ parcel_id: 4343, tracking_number: 'SECOND-TRACK', status: { id: 11, message: 'Delivered' } });

    expect(res.status).toBe(200);
    expect(transitionOrder).not.toHaveBeenCalled();
    expect(processShippedOrder).not.toHaveBeenCalled();
    // Primaer-Tracking unangetastet:
    expect(orderDocs.get('order-1').data.trackingNumber).toBe('ORIGINAL-TRACK');
    // Das shipments-Doc der Zusatz-Sendung wurde aktualisiert:
    expect(shipmentDocs.get('ship-add').data.status).toBe('Delivered');
  });

  it('traegt die Zusatz-Sendungsnummer in order.additionalShipments nach (DPD: Tracking kommt asynchron)', async () => {
    seed(shipmentDocs, 'ship-add', {
      orderId: 'order-1', sendcloudParcelId: 4343, tenantId: 'default', additionalLabel: true,
    });
    seed(orderDocs, 'order-1', {
      omsStatus: 'shipped', trackingNumber: 'ORIGINAL-TRACK',
      additionalShipments: [{ shipmentId: 'ship-add', sendcloudParcelId: 4343, trackingNumber: null }],
    });

    await request(buildApp())
      .post('/api/webhooks/sendcloud')
      .send({ parcel_id: 4343, tracking_number: 'LATE-TRACK', tracking_url: 'http://late', status: { id: 5, message: 'Sorted' } });

    const entry = orderDocs.get('order-1').data.additionalShipments.find((s) => s.shipmentId === 'ship-add');
    expect(entry.trackingNumber).toBe('LATE-TRACK');
    expect(orderDocs.get('order-1').data.trackingNumber).toBe('ORIGINAL-TRACK');
  });

  it('PRIMAER-Paket verhaelt sich unveraendert: Zustellung transitioniert den Auftrag', async () => {
    seed(shipmentDocs, 'ship-prim', {
      orderId: 'order-1', sendcloudParcelId: 1111, tenantId: 'default', trackingNumber: 'ORIGINAL-TRACK',
    });
    seed(orderDocs, 'order-1', { omsStatus: 'shipped', trackingNumber: 'ORIGINAL-TRACK' });

    const res = await request(buildApp())
      .post('/api/webhooks/sendcloud')
      .send({ parcel_id: 1111, tracking_number: 'ORIGINAL-TRACK', status: { id: 11, message: 'Delivered' } });

    expect(res.status).toBe(200);
    expect(transitionOrder).toHaveBeenCalledTimes(1);
    expect(transitionOrder.mock.calls[0][0]).toMatchObject({ orderId: 'order-1', toStatus: 'delivered' });
  });
});
