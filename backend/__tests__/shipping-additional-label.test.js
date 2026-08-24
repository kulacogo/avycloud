'use strict';
// ZUSATZ-LABEL (Betreiber-Anweisung 2026-08-21): Teil-/Ersatzsendungen brauchen
// ein weiteres Label OHNE Storno des bestehenden. shipOrder({ additionalLabel:true })
// umgeht den Duplikat-Guard BEWUSST, laesst aber die Primaer-Felder des Auftrags
// (trackingNumber/shipmentId — die Marktplatz-Wahrheit) unangetastet und haengt
// die neue Sendung additiv an order.additionalShipments.
require('./api/_patchGcp');
const { mockDoc, mockQuery, mockCol } = require('./api/_patchGcp');

const authPath = require.resolve('../lib/sendcloud-auth');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports: { getSendCloudAuthHeader: vi.fn().mockResolvedValue('Basic test') },
  children: [], paths: [],
};
const sendcloudPath = require.resolve('../lib/sendcloud');
require.cache[sendcloudPath] = {
  id: sendcloudPath, filename: sendcloudPath, loaded: true,
  exports: {
    lookupCsvPrice: vi.fn().mockResolvedValue(null),
    listSenderAddresses: vi.fn().mockResolvedValue([
      { companyName: 'TrendOcean', street: 'Absenderstr 1', city: 'Berlin', postalCode: '10115', country: 'DE' },
    ]),
  },
  children: [], paths: [],
};
const secretValuesPath = require.resolve('../lib/secret-values');
require.cache[secretValuesPath] = {
  id: secretValuesPath, filename: secretValuesPath, loaded: true,
  exports: { getSecretValue: vi.fn().mockResolvedValue('mock-secret') },
  children: [], paths: [],
};

const { shipOrder, refreshShipmentFromSendCloud } = require('../services/shipping-engine');

const orderData = {
  marketplaceOrderId: 'MP1', omsStatus: 'shipped', totalAmount: 49.9,
  trackingNumber: 'ORIGINAL-TRACK', shipmentId: 'ship-original', weight: 2,
  customer: { name: 'Max Mustermann', street: 'Kundenstr 5', city: 'Hamburg', zip: '20095', country: 'DE' },
};

const activeShipmentDocs = [
  { id: 'ship-original', data: () => ({ status: 'Delivered', trackingNumber: 'ORIGINAL-TRACK', sendcloudParcelId: 1 }), ref: {} },
];

let fetchCalls;
let orderRefSet;

beforeEach(() => {
  fetchCalls = [];
  orderRefSet = vi.fn().mockResolvedValue({});
  mockDoc.get.mockReset().mockResolvedValue({
    exists: true,
    id: 'o1',
    data: () => ({ ...orderData }),
    ref: { set: orderRefSet },
  });
  mockQuery.get.mockReset().mockResolvedValue({
    empty: false, docs: activeShipmentDocs, size: activeShipmentDocs.length, forEach: () => {},
  });
  global.fetch = vi.fn(async (url, opts) => {
    const u = String(url);
    fetchCalls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
    if (u.includes('/shipments/announce')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { id: 'ship2', parcels: [{ id: 43, tracking_number: 'SECOND-TRACK', tracking_url: 'http://t2', documents: [{ type: 'label', link: 'http://label2' }] }] } }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) };
  });
});

const announceCalls = () => fetchCalls.filter((c) => c.url.includes('/shipments/announce'));

describe('shipOrder ohne additionalLabel (Regression)', () => {
  it('aktive Sendung blockt weiterhin: duplicate:true, kein Announce', async () => {
    const res = await shipOrder({ orderId: 'o1', shippingOptionCode: 'dhl_de:dhl_paket', weight: 2 });
    expect(res.duplicate).toBe(true);
    expect(res.trackingNumber).toBe('ORIGINAL-TRACK');
    expect(announceCalls()).toHaveLength(0);
  });
});

describe('shipOrder mit additionalLabel:true', () => {
  it('erstellt trotz aktiver (sogar zugestellter) Sendung ein neues Label', async () => {
    const res = await shipOrder({ orderId: 'o1', shippingOptionCode: 'dhl_de:dhl_paket', weight: 2, additionalLabel: true });
    expect(res.duplicate).toBeUndefined();
    expect(res.trackingNumber).toBe('SECOND-TRACK');
    expect(res.additionalLabel).toBe(true);
    expect(announceCalls()).toHaveLength(1);
  });

  it('laesst die Primaer-Felder des Auftrags unangetastet und haengt additiv an additionalShipments an', async () => {
    await shipOrder({ orderId: 'o1', shippingOptionCode: 'dhl_de:dhl_paket', weight: 2, additionalLabel: true });
    expect(orderRefSet).toHaveBeenCalledTimes(1);
    const payload = orderRefSet.mock.calls[0][0];
    // Primaer-Tracking (Marktplatz-Wahrheit) bleibt: NIE ueberschreiben.
    expect(payload).not.toHaveProperty('trackingNumber');
    expect(payload).not.toHaveProperty('trackingUrl');
    expect(payload).not.toHaveProperty('shipmentId');
    // Additive Ablage der Zusatz-Sendung (arrayUnion-Mock liefert die Argumente als Array):
    const entries = payload.additionalShipments;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries[0]).toMatchObject({ trackingNumber: 'SECOND-TRACK', labelUrl: 'http://label2' });
    expect(entries[0].createdAt).toBeTruthy();
  });

  it('Tracking-Pflicht gilt auch fuer Zusatz-Labels (Bestellwert 49,90 € > 10 €)', async () => {
    await expect(
      shipOrder({ orderId: 'o1', shippingOptionCode: 'dp:maxibrief/mailbox', weight: 0.4, additionalLabel: true })
    ).rejects.toThrow(/Sendungsverfolgung/);
    expect(announceCalls()).toHaveLength(0);
  });

  it('markiert das shipments-Doc bei der GEBURT als Zusatz-Label (additionalLabel:true)', async () => {
    // Ohne Marker behandeln refresh-shipment, Webhook und Label-Route die
    // Zusatz-Sendung als Primaer-Sendung — genau die Review-Befunde 1/4/8/9.
    mockCol.add.mockClear();
    await shipOrder({ orderId: 'o1', shippingOptionCode: 'dhl_de:dhl_paket', weight: 2, additionalLabel: true });
    const shipmentWrite = mockCol.add.mock.calls.map((c) => c[0]).find((d) => d && d.orderId === 'o1');
    expect(shipmentWrite).toBeTruthy();
    expect(shipmentWrite.additionalLabel).toBe(true);
    expect(shipmentWrite.trackingNumber).toBe('SECOND-TRACK');
  });

  it('normale Labels tragen KEINEN additionalLabel-Marker (Bestandsverhalten)', async () => {
    mockQuery.get.mockResolvedValue({ empty: true, docs: [], size: 0, forEach: () => {} });
    mockCol.add.mockClear();
    await shipOrder({ orderId: 'o1', shippingOptionCode: 'dhl_de:dhl_paket', weight: 2 });
    const shipmentWrite = mockCol.add.mock.calls.map((c) => c[0]).find((d) => d && d.orderId === 'o1');
    expect(shipmentWrite).toBeTruthy();
    expect(shipmentWrite.additionalLabel).toBeUndefined();
  });
});

// ── refresh-shipment darf nach einem Zusatz-Label NICHT die Zusatz-Sendung
//    reconcilen (Review-Befund 1/8: Primaer-Tracking wuerde ueberschrieben und
//    die falsche Nummer zum Marktplatz gepusht). ───────────────────────────────
describe('refreshShipmentFromSendCloud — Primaer-Sendung hat Vorrang', () => {
  it('waehlt das Shipment aus order.shipmentId, nicht das neueste (Zusatz-)Shipment', async () => {
    const shipmentDocsWithAdditional = [
      { id: 'ship-additional', ref: { set: vi.fn() }, data: () => ({
        status: 'announced', sendcloudParcelId: 43, additionalLabel: true,
        createdAt: '2026-08-21T12:00:00.000Z', trackingNumber: 'SECOND-TRACK',
      }) },
      { id: 'ship-original', ref: { set: vi.fn() }, data: () => ({
        status: 'Delivered', sendcloudParcelId: 1,
        createdAt: '2026-08-15T09:00:00.000Z', trackingNumber: 'ORIGINAL-TRACK',
      }) },
    ];
    mockQuery.get.mockResolvedValue({
      empty: false, docs: shipmentDocsWithAdditional, size: 2, forEach: () => {},
    });
    mockDoc.get.mockResolvedValue({
      exists: true,
      data: () => ({ ...orderData, shipmentId: 'ship-original' }),
      ref: { set: vi.fn() },
    });
    const parcelFetches = [];
    global.fetch = vi.fn(async (url) => {
      const u = String(url);
      const m = u.match(/\/parcels\/(\d+)/);
      if (m) {
        parcelFetches.push(Number(m[1]));
        return { ok: true, status: 200, json: async () => ({ parcel: {
          id: Number(m[1]), tracking_number: 'ORIGINAL-TRACK', tracking_url: 'http://t1',
          carrier: { code: 'dhl_de' }, status: { id: 11, message: 'Delivered' },
          documents: [{ type: 'label', link: 'http://label1' }],
        } }), text: async () => '{}' };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    });

    const result = await refreshShipmentFromSendCloud({ orderId: 'o1' });
    expect(parcelFetches[0]).toBe(1); // Primaer-Parcel, nie 43 (Zusatz)
    expect(result.shipmentId).toBe('ship-original');
  });
});
