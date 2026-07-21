/**
 * POST /api/orders/:orderId/cancel-label — Sackgassen-Ausweg + Multi-Parcel.
 *
 * Incident 2026-07-21 (Order 20-14894-78016): Label wurde extern im
 * SendCloud-Panel storniert, avycloud blieb auf "shipped ohne Tracking".
 * Der alte Endpoint stornierte nur das NEUESTE Shipment (limit 1) und brach
 * mit 400 ab, wenn dessen Parcel-ID fehlte — der Auftrag war unrettbar
 * feststeckt. Erwartung seit Fix:
 *   1. ALLE aktiven (nicht-cancelled) Shipments werden storniert.
 *   2. Kein aktives Shipment + Order ist "shipped" → trotzdem 200:
 *      Tracking leeren + Transition zurück auf packed (Ausweg).
 *   3. Kein Shipment + Order NICHT "shipped" → weiterhin 404.
 */

const request = require('supertest');

const { mockQuery, mockDoc } = require('./_patchGcp');

// order-state-machine VOR dem Route-Require mocken (CJS require.cache patch)
const transitionOrderMock = vi.fn();
const processLabelCancelledMock = vi.fn().mockResolvedValue({});
const osmPath = require.resolve('../../services/order-state-machine.js');
require.cache[osmPath] = {
  id: osmPath,
  filename: osmPath,
  loaded: true,
  exports: {
    transitionOrder: transitionOrderMock,
    processLabelCancelled: processLabelCancelledMock,
    ORDER_STATUSES: {},
  },
  children: [],
  paths: [],
};

// shipping-engine mocken (cancelParcel wird inline im Handler ge-required)
const cancelParcelMock = vi.fn().mockResolvedValue({ ok: true });
const sePath = require.resolve('../../services/shipping-engine.js');
require.cache[sePath] = {
  id: sePath,
  filename: sePath,
  loaded: true,
  exports: { cancelParcel: cancelParcelMock },
  children: [], paths: [],
};

require('./_patchLocalModules');
require('./_setupMocks');
const { createTestApp } = require('./_createApp');
const { router: ordersRouter } = require('../../routes/orders');

const app = createTestApp(ordersRouter);

const shipmentDoc = (id, data) => ({ id, data: () => data, ref: {} });

describe('POST /api/orders/:orderId/cancel-label', () => {
  beforeEach(() => {
    transitionOrderMock.mockReset().mockResolvedValue({ ok: true, fromStatus: 'shipped', toStatus: 'packed' });
    cancelParcelMock.mockReset().mockResolvedValue({ ok: true });
    mockQuery.get.mockReset();
    mockDoc.get.mockReset();
    mockDoc.set.mockReset().mockResolvedValue({});
  });

  it('storniert ALLE aktiven Shipments (nicht nur das neueste), bereits stornierte werden übersprungen', async () => {
    const docs = [
      shipmentDoc('s-new', { sendcloudParcelId: 222, status: 'problem' }),
      shipmentDoc('s-old', { sendcloudParcelId: 111, status: 'announced' }),
      shipmentDoc('s-done', { sendcloudParcelId: 999, status: 'cancelled' }),
    ];
    mockQuery.get.mockResolvedValue({ empty: false, docs, size: docs.length, forEach: () => {} });

    const res = await request(app).post('/api/orders/order-multi/cancel-label').send({});

    expect(res.status).toBe(200);
    const cancelledIds = cancelParcelMock.mock.calls.map((c) => c[0].parcelId);
    expect(cancelledIds).toEqual([222, 111]); // 999 war schon cancelled → kein API-Call
    expect(transitionOrderMock).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order-multi', toStatus: 'packed', force: true,
    }));
  });

  it('Sackgassen-Ausweg: kein Shipment vorhanden, Order shipped → 200 + Transition auf packed', async () => {
    mockQuery.get.mockResolvedValue({ empty: true, docs: [], size: 0, forEach: () => {} });
    mockDoc.get.mockResolvedValue({ exists: true, data: () => ({ omsStatus: 'shipped', trackingNumber: null }) });

    const res = await request(app).post('/api/orders/order-stuck/cancel-label').send({});

    expect(res.status).toBe(200);
    expect(cancelParcelMock).not.toHaveBeenCalled();
    expect(transitionOrderMock).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order-stuck', toStatus: 'packed', force: true,
    }));
  });

  it('kein Shipment + Order nicht shipped → weiterhin 404, keine Transition', async () => {
    mockQuery.get.mockResolvedValue({ empty: true, docs: [], size: 0, forEach: () => {} });
    mockDoc.get.mockResolvedValue({ exists: true, data: () => ({ omsStatus: 'confirmed' }) });

    const res = await request(app).post('/api/orders/order-fresh/cancel-label').send({});

    expect(res.status).toBe(404);
    expect(transitionOrderMock).not.toHaveBeenCalled();
  });

  it('Shipment ohne Parcel-ID blockt den Reset nicht mehr (früher 400)', async () => {
    const docs = [shipmentDoc('s-noid', { status: 'problem' })];
    mockQuery.get.mockResolvedValue({ empty: false, docs, size: 1, forEach: () => {} });

    const res = await request(app).post('/api/orders/order-noid/cancel-label').send({});

    expect(res.status).toBe(200);
    expect(cancelParcelMock).not.toHaveBeenCalled(); // nichts zu stornieren
    expect(transitionOrderMock).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order-noid', toStatus: 'packed', force: true,
    }));
  });

  it('SendCloud-Storno-Fehler (schon extern storniert) bricht den Reset nicht ab', async () => {
    cancelParcelMock.mockRejectedValue(new Error('410 Parcel has been deleted'));
    const docs = [shipmentDoc('s-gone', { sendcloudParcelId: 333, status: 'announced' })];
    mockQuery.get.mockResolvedValue({ empty: false, docs, size: 1, forEach: () => {} });

    const res = await request(app).post('/api/orders/order-gone/cancel-label').send({});

    expect(res.status).toBe(200);
    expect(transitionOrderMock).toHaveBeenCalled();
  });
});
