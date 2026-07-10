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
  exports: {
    lookupCsvPrice: vi.fn().mockResolvedValue(null),
    listSenderAddresses: vi.fn().mockResolvedValue([
      { id: 1, companyName: 'TrendOcean', street: 'Musterstr 1', city: 'Berlin', postalCode: '10115', country: 'DE' },
    ]),
  },
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
    // SendCloud v3: POST /shipping-options → then POST /shipments/announce.
    global.fetch = vi.fn(async (url, init) => {
      if (/\/shipping-options/.test(String(url))) {
        const body = { data: [{
          code: 'dpd:classic',
          carrier: { code: 'dpd', name: 'DPD' },
          product: { code: 'classic', name: 'DPD Classic' },
          weight: { min: { value: '0.01' }, max: { value: '31.5' } },
          quotes: [{ price: { total: { value: '5.49' } } }],
        }] };
        return { ok: true, text: async () => JSON.stringify(body), json: async () => body };
      }
      if (/\/shipments\/announce/.test(String(url))) {
        const body = { data: {
          id: 'shp_1',
          carrier: { code: 'dpd' },
          parcels: [{
            id: 12345,
            tracking_number: '01596813323012',
            tracking_url: 'https://tracking.example/12345',
            status: { code: 'announced', message: 'ready_to_send' },
            documents: [{ type: 'label', size: 'a6', link: 'https://panel.sendcloud.sc/api/v3/parcels/12345/label' }],
          }],
        } };
        return { ok: true, text: async () => JSON.stringify(body), json: async () => body };
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
    expect(result.labelUrl).toMatch(/\/label$/);

    // Shipment row in Firestore must reflect the same values.
    expect(lastAdded?.collection).toBe('shipments');
    expect(lastAdded?.data.trackingNumber).toBe('01596813323012');
    expect(lastAdded?.data.trackingUrl).toBe('https://tracking.example/12345');
    expect(lastAdded?.data.carrier).toBe('dpd');
    expect(lastAdded?.data.labelUrl).toMatch(/\/label$/);
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
    // The search-by-order_number fallback ALSO returns nothing useful here so
    // the function falls through to the additive-only reconciliation path.
    global.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (/\/parcels\/12345$/.test(u)) {
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
      if (/\/parcels\?order_number=/.test(u)) {
        return { ok: true, json: async () => ({ parcels: [] }) };
      }
      throw new Error(`unexpected fetch ${u}`);
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

  it('FALLBACK: searches by order_number and re-binds when the stored parcel has no tracking', async () => {
    // Reproduces the noon-2026-04-29 incident:
    //   • Firestore has shipment pointing at parcel 99999 (stale, never got tracking).
    //   • SendCloud actually issued parcel 12345 with tracking 01596813323012
    //     under the same order_number "01-14582-82032".
    //   • Refresh by stored ID returns "no changes" → user sees "Versand bereits aktuell".
    //
    // After the fix:
    //   • parcel 99999 is loaded → empty tracking + empty label
    //   • search /parcels?order_number=01-14582-82032 finds parcel 12345 (with tracking)
    //   • shipment.sendcloudParcelId is rebound to 12345
    //   • order.trackingNumber gets set
    seedShipment('ship-1', {
      orderId: 'order-1',
      sendcloudParcelId: 99999,
      trackingNumber: null,
      trackingUrl: null,
      labelUrl: null,
      carrier: 'dpd',
      status: 'ausstehend',
      createdAt: '2026-04-29T08:04:00.000Z',
    });
    seedOrder('order-1', {
      omsStatus: 'shipped',
      shipmentId: 'ship-1',
      shippingService: 'dpd',
      trackingNumber: null,
      marketplaceOrderId: '01-14582-82032',
    });

    global.fetch = vi.fn(async (url, init) => {
      const u = String(url);
      if (/\/parcels\/99999$/.test(u)) {
        // Stale parcel, no tracking, empty label — exactly the user's symptom.
        return {
          ok: true,
          json: async () => ({
            parcel: {
              id: 99999,
              tracking_number: '',
              tracking_url: '',
              carrier: { code: 'dpd' },
              status: { id: 1, message: 'Bereit zum Versand' },
              label: {},
            },
          }),
        };
      }
      if (/\/parcels\?order_number=01-14582-82032/.test(u)) {
        return {
          ok: true,
          json: async () => ({
            next: null,
            previous: null,
            parcels: [
              {
                id: 99999,
                tracking_number: '',
                date_created: '29-04-2026 09:50:00',
                status: { id: 1, message: 'Bereit zum Versand' },
                label: {},
                carrier: { code: 'dpd' },
              },
              {
                id: 12345,
                tracking_number: '01596813323012',
                tracking_url: 'https://tracking.example/12345',
                date_created: '29-04-2026 10:04:00',
                status: { id: 1, message: 'Bereit zum Versand' },
                label: { label_printer: 'https://panel.sendcloud.sc/api/v2/labels/label_printer/12345' },
                carrier: { code: 'dpd' },
              },
            ],
          }),
        };
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const result = await engine.refreshShipmentFromSendCloud({ orderId: 'order-1' });

    expect(result.searchedAlternates).toBe(true);
    expect(result.alternatesFound).toBe(2);
    expect(result.reboundParcel).toBe(true);
    expect(result.previousSendcloudParcelId).toBe(99999);
    expect(result.sendcloudParcelId).toBe(12345);
    expect(result.trackingNumber).toBe('01596813323012');
    expect(result.labelUrl).toMatch(/label_printer/);
    expect(result.updated).toEqual(expect.arrayContaining([
      'shipment.sendcloudParcelId',
      'shipment.trackingNumber',
      'order.trackingNumber',
    ]));

    // Firestore was actually patched.
    const ship = shipmentDocs.get('ship-1').data;
    expect(ship.sendcloudParcelId).toBe(12345);
    expect(ship.trackingNumber).toBe('01596813323012');

    const order = orderDocs.get('order-1').data;
    expect(order.trackingNumber).toBe('01596813323012');
  });

  it('does NOT re-bind when stored parcel already has tracking (avoid spurious changes)', async () => {
    // Same order_number can match multiple parcels (e.g. retries) — but if the
    // current binding is already valid, we must not flip-flop to another one.
    seedShipment('ship-1', {
      orderId: 'order-1',
      sendcloudParcelId: 12345,
      trackingNumber: '01596813323012',
      trackingUrl: 'https://tracking.example/12345',
      labelUrl: 'https://panel.sendcloud.sc/api/v2/labels/label_printer/12345',
      carrier: 'dpd',
      status: 'ausstehend',
      createdAt: '2026-04-29T08:04:00.000Z',
    });
    seedOrder('order-1', {
      omsStatus: 'shipped',
      shipmentId: 'ship-1',
      marketplaceOrderId: '01-14582-82032',
      trackingNumber: '01596813323012',
    });

    global.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (/\/parcels\/12345$/.test(u)) {
        return {
          ok: true,
          json: async () => ({
            parcel: {
              id: 12345,
              tracking_number: '01596813323012',
              tracking_url: 'https://tracking.example/12345',
              carrier: { code: 'dpd' },
              status: { id: 3, message: 'in_transit' },
              label: { label_printer: 'https://panel.sendcloud.sc/api/v2/labels/label_printer/12345' },
            },
          }),
        };
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const result = await engine.refreshShipmentFromSendCloud({ orderId: 'order-1' });

    expect(result.reboundParcel).toBe(false);
    expect(result.searchedAlternates).toBe(false);
    expect(result.sendcloudParcelId).toBe(12345);
    expect(result.previousSendcloudParcelId).toBeNull();
    // Status moved forward, but no parcel-id change.
    expect(result.updated).not.toEqual(expect.arrayContaining(['shipment.sendcloudParcelId']));
  });

  it('FALLBACK falls through gracefully when stored parcel fetch 404s but search finds a real one', async () => {
    seedShipment('ship-1', {
      orderId: 'order-1',
      sendcloudParcelId: 99999,
      trackingNumber: null,
      labelUrl: null,
      carrier: null,
      status: 'ausstehend',
      createdAt: '2026-04-29T08:04:00.000Z',
    });
    seedOrder('order-1', {
      marketplaceOrderId: '01-14582-82032',
      omsStatus: 'shipped',
      trackingNumber: null,
    });

    global.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (/\/parcels\/99999$/.test(u)) {
        return { ok: false, status: 404, text: async () => 'Not Found' };
      }
      if (/\/parcels\?order_number=/.test(u)) {
        return {
          ok: true,
          json: async () => ({
            parcels: [
              {
                id: 12345,
                tracking_number: '01596813323012',
                tracking_url: 'https://tracking.example/12345',
                date_created: '29-04-2026 10:04:00',
                status: { id: 1, message: 'Bereit zum Versand' },
                label: { label_printer: 'https://panel.sendcloud.sc/api/v2/labels/label_printer/12345' },
                carrier: { code: 'dpd' },
              },
            ],
          }),
        };
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const result = await engine.refreshShipmentFromSendCloud({ orderId: 'order-1' });

    expect(result.reboundParcel).toBe(true);
    expect(result.sendcloudParcelId).toBe(12345);
    expect(result.previousSendcloudParcelId).toBe(99999);
    expect(result.trackingNumber).toBe('01596813323012');
    expect(shipmentDocs.get('ship-1').data.sendcloudParcelId).toBe(12345);
  });
});
