// backend/__tests__/shipping-refresh.test.js
//
// Covers two interlocking concerns from incident 2026-04-29 ("label created
// in SendCloud but order shows no tracking + no print button"):
//
//   A) The polling-race fix in `createParcel` — after pollForLabel reassigns
//      `parcel`, the persisted shipment + return value MUST take their
//      tracking_number / tracking_url / carrier code from the polled body,
//      not from the initial POST response.
//
//   B) The recovery helper `refreshShipmentFromSendCloud` — fetches the
//      latest parcel state from SendCloud and reconciles both `shipments`
//      and `orders` Firestore docs additively (never nulls a field it
//      doesn't have a non-empty value for).

require('./api/_patchGcp');

// ── Stub SendCloud auth + CSV price helpers (loaded by shipping-engine) ─────
const secretValuesPath = require.resolve('../lib/secret-values');
require.cache[secretValuesPath] = {
  id: secretValuesPath, filename: secretValuesPath, loaded: true,
  exports: { getSecretValue: vi.fn().mockResolvedValue('mock-secret') },
  children: [], paths: [],
};
const sendcloudPath = require.resolve('../lib/sendcloud');
require.cache[sendcloudPath] = {
  id: sendcloudPath, filename: sendcloudPath, loaded: true,
  exports: { lookupCsvPrice: vi.fn().mockResolvedValue(null) },
  children: [], paths: [],
};

// ── Stub Firestore so we can drive collection().doc().get()/set() ───────────
const shipmentDocs = new Map(); // id → { ref, data }
const orderDocs = new Map();    // id → { ref, data }
let lastAdded = null;

function makeRef(collectionName, docId, store) {
  return {
    id: docId,
    collectionName,
    set: vi.fn(async (patch, opts) => {
      const existing = store.get(docId)?.data || {};
      const merged = opts?.merge ? { ...existing, ...patch } : patch;
      store.set(docId, { ref: makeRef(collectionName, docId, store), data: merged });
    }),
    get: vi.fn(async () => {
      const entry = store.get(docId);
      return {
        exists: Boolean(entry),
        id: docId,
        data: () => (entry ? entry.data : undefined),
        ref: entry?.ref,
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
      // Permissive default for any collection the SUT touches that we don't care about.
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
        const ref = makeRef(name, id, store);
        return ref;
      },
      where,
      add: vi.fn(async (data) => {
        const id = `${name}-${store.size + 1}`;
        const ref = makeRef(name, id, store);
        store.set(id, { ref, data });
        lastAdded = { collection: name, id, data };
        return { id, get: async () => ({ exists: true, id, data: () => data }) };
      }),
    };
  }),
};

const firestoreMod = require.resolve('@google-cloud/firestore');
// shipping-engine does `new Firestore()` — provide a class-shaped constructor
// that returns the shared mock store on every instantiation.
function FirestoreCtor() { return firestoreMock; }
require.cache[firestoreMod] = {
  id: firestoreMod, filename: firestoreMod, loaded: true,
  exports: {
    Firestore: FirestoreCtor,
    FieldValue: { serverTimestamp: () => 'ts' },
  },
  children: [], paths: [],
};

// ── Now load the SUT (shipping-engine reads Firestore + SendCloud lazily) ───
const engine = require('../services/shipping-engine');

// ── Test helpers ────────────────────────────────────────────────────────────
function seedShipment(id, data) {
  const ref = makeRef('shipments', id, shipmentDocs);
  shipmentDocs.set(id, { id, ref, data });
}
function seedOrder(id, data) {
  const ref = makeRef('orders', id, orderDocs);
  orderDocs.set(id, { id, ref, data });
}
function resetStores() {
  shipmentDocs.clear();
  orderDocs.clear();
  lastAdded = null;
}

// ── A) createParcel persistence is end-state-driven ─────────────────────────
describe('createParcel — shipment doc reflects the final parcel state', () => {
  beforeEach(() => {
    resetStores();
  });

  it('persists tracking_number, tracking_url and carrier from the parcel response', async () => {
    // Smoke-test the (refactored) downstream pipeline: the persisted shipment
    // and the return value MUST be derived from the same `parcel` object —
    // never from a stale local snapshot. The polling branch is defensive
    // for async carriers; this test is the regression guard for the
    // post-refactor synchronous (DPD/DHL) happy path.
    global.fetch = vi.fn(async (url, init) => {
      if (init && init.method === 'POST' && /\/parcels\?errors=/.test(String(url))) {
        return {
          ok: true,
          json: async () => ({
            parcel: {
              id: 12345,
              status: { id: 1, message: 'ready_to_send' },
              tracking_number: '01596813323012',
              tracking_url: 'https://tracking.example/12345',
              carrier: { code: 'dpd' },
              shipment: { id: 113 },
              label: { label_printer: 'https://panel.sendcloud.sc/api/v2/labels/label_printer/12345' },
            },
          }),
        };
      }
      throw new Error(`unexpected fetch ${init?.method || 'GET'} ${url}`);
    });

    const result = await engine.createParcel({
      order: {
        id: 'order-1',
        marketplaceOrderId: '01-14582-82032',
        weight: 13,
        customer: { name: 'Horst König', street: 'Bürgermeister-Herb-Str. 19', city: 'Gengenbach', zip: '77723', country: 'DE' },
      },
      shippingMethodId: 113,
      weight: 13,
      tenantId: 'default',
      requestLabel: true,
      labelFormat: 'a6',
    });

    expect(result.trackingNumber).toBe('01596813323012');
    expect(result.trackingUrl).toBe('https://tracking.example/12345');
    expect(result.carrier).toBe('dpd');
    expect(result.labelUrl).toMatch(/label_printer/);

    // Shipment row in Firestore must reflect the same values.
    expect(lastAdded?.collection).toBe('shipments');
    expect(lastAdded?.data.trackingNumber).toBe('01596813323012');
    expect(lastAdded?.data.trackingUrl).toBe('https://tracking.example/12345');
    expect(lastAdded?.data.carrier).toBe('dpd');
    expect(lastAdded?.data.labelUrl).toMatch(/label_printer/);
  });
});

// ── B) refreshShipmentFromSendCloud ─────────────────────────────────────────
describe('refreshShipmentFromSendCloud — recovery for incident 2026-04-29', () => {
  beforeEach(() => {
    resetStores();
  });

  it('fills in missing tracking on both shipment + order from a fresh parcel fetch', async () => {
    seedShipment('ship-1', {
      orderId: 'order-1',
      sendcloudParcelId: 12345,
      trackingNumber: null,
      trackingUrl: null,
      labelUrl: null,
      carrier: 'dpd',
      status: 'ausstehend',
      statusId: 1,
      createdAt: '2026-04-29T08:04:00.000Z',
    });
    seedOrder('order-1', {
      omsStatus: 'shipped',
      shipmentId: 'ship-1',
      shippingService: 'dpd',
      trackingNumber: null,
    });

    global.fetch = vi.fn(async (url) => {
      if (/\/parcels\/12345$/.test(String(url))) {
        return {
          ok: true,
          json: async () => ({
            parcel: {
              id: 12345,
              tracking_number: '01596813323012',
              tracking_url: 'https://tracking.example/12345',
              carrier: { code: 'dpd' },
              status: { id: 1, message: 'ready_to_send' },
              label: { label_printer: 'https://panel.sendcloud.sc/api/v2/labels/label_printer/12345' },
            },
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await engine.refreshShipmentFromSendCloud({ orderId: 'order-1' });

    expect(result.trackingNumber).toBe('01596813323012');
    expect(result.labelUrl).toMatch(/label_printer/);
    expect(result.updated).toEqual(expect.arrayContaining([
      'shipment.trackingNumber',
      'shipment.trackingUrl',
      'shipment.labelUrl',
      'order.trackingNumber',
      'order.trackingUrl',
    ]));

    // Shipment doc was patched with a merge.
    const ship = shipmentDocs.get('ship-1').data;
    expect(ship.trackingNumber).toBe('01596813323012');
    expect(ship.trackingUrl).toBe('https://tracking.example/12345');
    expect(ship.labelUrl).toMatch(/label_printer/);

    // Order doc mirrors the new tracking.
    const order = orderDocs.get('order-1').data;
    expect(order.trackingNumber).toBe('01596813323012');
    expect(order.trackingUrl).toBe('https://tracking.example/12345');
  });

  it('never overwrites an existing field with null on a transient empty response', async () => {
    seedShipment('ship-1', {
      orderId: 'order-1',
      sendcloudParcelId: 12345,
      trackingNumber: '01596813323012',
      trackingUrl: 'https://tracking.example/12345',
      labelUrl: 'https://panel.sendcloud.sc/api/v2/labels/label_printer/12345',
      carrier: 'dpd',
      status: 'in_zustellung',
      createdAt: '2026-04-29T08:04:00.000Z',
    });
    seedOrder('order-1', { trackingNumber: '01596813323012' });

    // SendCloud returns a body with empty optional fields (rare, e.g. test mode).
    global.fetch = vi.fn(async (url) => {
      if (/\/parcels\/12345$/.test(String(url))) {
        return {
          ok: true,
          json: async () => ({
            parcel: {
              id: 12345,
              tracking_number: null,
              tracking_url: null,
              carrier: { code: null },
              status: { id: 3, message: 'in_transit' },
              label: {},
            },
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await engine.refreshShipmentFromSendCloud({ orderId: 'order-1' });

    // Existing values are preserved; only the status moved forward.
    expect(result.trackingNumber).toBe('01596813323012');
    expect(result.labelUrl).toMatch(/label_printer/);
    expect(shipmentDocs.get('ship-1').data.trackingNumber).toBe('01596813323012');
    expect(shipmentDocs.get('ship-1').data.labelUrl).toMatch(/label_printer/);
    expect(orderDocs.get('order-1').data.trackingNumber).toBe('01596813323012');
    // None of the additive shipment fields were touched (still null in SendCloud body).
    expect(result.updated).not.toEqual(expect.arrayContaining(['shipment.trackingNumber']));
    expect(result.updated).not.toEqual(expect.arrayContaining(['shipment.trackingUrl']));
    expect(result.updated).not.toEqual(expect.arrayContaining(['shipment.labelUrl']));
  });

  it('throws when no shipment exists for the order', async () => {
    seedOrder('order-1', { omsStatus: 'pending' });
    global.fetch = vi.fn();
    await expect(engine.refreshShipmentFromSendCloud({ orderId: 'order-1' }))
      .rejects.toThrow(/Kein Versanddatensatz/);
  });

  it('throws when the shipment has no SendCloud parcel id', async () => {
    seedShipment('ship-1', {
      orderId: 'order-1',
      sendcloudParcelId: null,
      createdAt: '2026-04-29T08:04:00.000Z',
    });
    global.fetch = vi.fn();
    await expect(engine.refreshShipmentFromSendCloud({ orderId: 'order-1' }))
      .rejects.toThrow(/SendCloud-Parcel-ID/);
  });
});
