/**
 * POST /api/orders/:orderId/additional-label — Zusatz-Label fuer Teil-/Ersatzsendung
 * (Betreiber-Anweisung 2026-08-21).
 *
 * Erwartung:
 *   1. Auftrag MIT Versand-Beleg (trackingNumber/shipmentId/Status shipped|delivered|completed)
 *      → shipOrder({ additionalLabel:true }), 200 mit Label-Daten.
 *   2. KEIN Status-Uebergang (shipped→shipped ist force-verboten und waere doppelt) und
 *      KEIN order:status_changed-Event — nur shipment:created.
 *   3. KEIN Marktplatz-Tracking-Push — die Original-Sendungsnummer bleibt die
 *      Wahrheit am Marktplatz.
 *   4. Auftrag OHNE Versand-Beleg → 409 (der normale Versand-Weg ist zustaendig,
 *      er setzt den Status und pusht das Tracking).
 */

const request = require('supertest');

const { mockQuery, mockDoc } = require('./_patchGcp');

// order-state-machine VOR dem Route-Require mocken (CJS require.cache patch)
const transitionOrderMock = vi.fn().mockResolvedValue({ ok: true });
const osmPath = require.resolve('../../services/order-state-machine.js');
require.cache[osmPath] = {
  id: osmPath, filename: osmPath, loaded: true,
  exports: { transitionOrder: transitionOrderMock, processLabelCancelled: vi.fn(), ORDER_STATUSES: {} },
  children: [], paths: [],
};

// shipping-engine mocken (shipOrder/cancelParcel werden inline im Handler ge-required)
const shipOrderMock = vi.fn();
const cancelParcelMock = vi.fn().mockResolvedValue({ ok: true });
const sePath = require.resolve('../../services/shipping-engine.js');
require.cache[sePath] = {
  id: sePath, filename: sePath, loaded: true,
  exports: { shipOrder: shipOrderMock, cancelParcel: cancelParcelMock },
  children: [], paths: [],
};

// marketplace-tracking mocken — Push darf NIE passieren
const pushTrackingMock = vi.fn();
const mtPath = require.resolve('../../services/marketplace-tracking.js');
require.cache[mtPath] = {
  id: mtPath, filename: mtPath, loaded: true,
  exports: { pushTrackingToMarketplace: pushTrackingMock },
  children: [], paths: [],
};

// sync-event-bus mocken, damit keine echten Debounce-Timer/Syncs anlaufen
const emitSyncEventMock = vi.fn();
const busPath = require.resolve('../../services/sync-event-bus.js');
require.cache[busPath] = {
  id: busPath, filename: busPath, loaded: true,
  exports: { emitSyncEvent: emitSyncEventMock, bus: { on: () => {} } },
  children: [], paths: [],
};

require('./_patchLocalModules');
require('./_setupMocks');
const { createTestApp } = require('./_createApp');
const { router: ordersRouter } = require('../../routes/orders');

const app = createTestApp(ordersRouter);

describe('POST /api/orders/:orderId/additional-label', () => {
  beforeEach(() => {
    transitionOrderMock.mockReset().mockResolvedValue({ ok: true });
    shipOrderMock.mockReset().mockResolvedValue({
      shipmentId: 'ship-2', trackingNumber: 'SECOND-TRACK', trackingUrl: 'http://t2',
      labelUrl: 'http://label2', carrier: 'dhl_de', additionalLabel: true,
    });
    pushTrackingMock.mockReset();
    emitSyncEventMock.mockReset();
    mockDoc.get.mockReset();
    mockQuery.get.mockReset().mockResolvedValue({ empty: true, docs: [], size: 0, forEach: () => {} });
  });

  it('erstellt fuer einen versendeten Auftrag ein Zusatz-Label ohne Status-Uebergang und ohne Marktplatz-Push', async () => {
    mockDoc.get.mockResolvedValue({ exists: true, data: () => ({ omsStatus: 'shipped', trackingNumber: 'ORIG' }) });

    const res = await request(app)
      .post('/api/orders/order-1/additional-label')
      .send({ shippingOptionCode: 'dhl_de:dhl_paket', weight: 2, labelFormat: 'a6' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.trackingNumber).toBe('SECOND-TRACK');
    expect(shipOrderMock).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order-1', shippingOptionCode: 'dhl_de:dhl_paket', additionalLabel: true,
    }));
    expect(transitionOrderMock).not.toHaveBeenCalled();
    expect(pushTrackingMock).not.toHaveBeenCalled();
    const emitted = emitSyncEventMock.mock.calls.map((c) => c[0]);
    expect(emitted).toContain('shipment:created');
    expect(emitted).not.toContain('order:status_changed');
  });

  it('funktioniert auch fuer bereits zugestellte Auftraege (delivered)', async () => {
    mockDoc.get.mockResolvedValue({ exists: true, data: () => ({ omsStatus: 'delivered' }) });

    const res = await request(app)
      .post('/api/orders/order-2/additional-label')
      .send({ shippingOptionCode: 'dpd:classic', weight: 1 });

    expect(res.status).toBe(200);
    expect(shipOrderMock).toHaveBeenCalled();
  });

  it('Auftrag ohne Versand-Beleg → 409, kein shipOrder-Aufruf', async () => {
    mockDoc.get.mockResolvedValue({ exists: true, data: () => ({ omsStatus: 'packed' }) });

    const res = await request(app)
      .post('/api/orders/order-3/additional-label')
      .send({ shippingOptionCode: 'dhl_de:dhl_paket', weight: 2 });

    expect(res.status).toBe(409);
    expect(shipOrderMock).not.toHaveBeenCalled();
  });

  it('unbekannter Auftrag → 404', async () => {
    mockDoc.get.mockResolvedValue({ exists: false, data: () => ({}) });

    const res = await request(app)
      .post('/api/orders/nope/additional-label')
      .send({ shippingOptionCode: 'dhl_de:dhl_paket' });

    expect(res.status).toBe(404);
    expect(shipOrderMock).not.toHaveBeenCalled();
  });

  it('Fehler aus shipOrder (z. B. Tracking-Pflicht) kommt als 500 mit Klartext an', async () => {
    mockDoc.get.mockResolvedValue({ exists: true, data: () => ({ omsStatus: 'shipped' }) });
    shipOrderMock.mockRejectedValue(new Error('Versand ohne Sendungsverfolgung ist ab 10 € Bestellwert nicht erlaubt'));

    const res = await request(app)
      .post('/api/orders/order-4/additional-label')
      .send({ shippingOptionCode: 'dp:maxibrief/mailbox', weight: 0.4 });

    expect(res.status).toBe(500);
    expect(res.body.error.message).toMatch(/Sendungsverfolgung/);
  });

  it('STORNIERTER Auftrag mit stehengebliebener trackingNumber → 409 (kein Label auf tote Auftraege)', async () => {
    mockDoc.get.mockResolvedValue({ exists: true, data: () => ({ omsStatus: 'cancelled', trackingNumber: 'OLD' }) });

    const res = await request(app)
      .post('/api/orders/order-5/additional-label')
      .send({ shippingOptionCode: 'dhl_de:dhl_paket', weight: 2 });

    expect(res.status).toBe(409);
    expect(shipOrderMock).not.toHaveBeenCalled();
  });

  it('RETOURNIERTER Auftrag mit trackingNumber → 200 (Ersatzsendung ist genau der Use-Case)', async () => {
    mockDoc.get.mockResolvedValue({ exists: true, data: () => ({ omsStatus: 'returned', trackingNumber: 'OLD' }) });

    const res = await request(app)
      .post('/api/orders/order-6/additional-label')
      .send({ shippingOptionCode: 'dhl_de:dhl_paket', weight: 2 });

    expect(res.status).toBe(200);
    expect(shipOrderMock).toHaveBeenCalled();
  });
});

describe('POST /api/orders/:orderId/additional-label/cancel — gezielter Zusatz-Label-Storno', () => {
  beforeEach(() => {
    transitionOrderMock.mockReset().mockResolvedValue({ ok: true });
    cancelParcelMock.mockReset().mockResolvedValue({ ok: true });
    emitSyncEventMock.mockReset();
    mockDoc.get.mockReset();
    mockDoc.set.mockReset().mockResolvedValue({});
  });

  it('storniert NUR die genannte Zusatz-Sendung — kein Status-Uebergang, Primaer-Label unberuehrt', async () => {
    const additionalShipments = [
      { shipmentId: 'ship-2', sendcloudParcelId: 43, trackingNumber: 'SECOND-TRACK' },
      { shipmentId: 'ship-3', sendcloudParcelId: 44, trackingNumber: 'THIRD-TRACK' },
    ];
    mockDoc.get
      .mockResolvedValueOnce({ exists: true, data: () => ({ omsStatus: 'shipped', trackingNumber: 'ORIG', additionalShipments }) })
      .mockResolvedValueOnce({ exists: true, data: () => ({ orderId: 'order-1', sendcloudParcelId: 43 }) });

    const res = await request(app)
      .post('/api/orders/order-1/additional-label/cancel')
      .send({ shipmentId: 'ship-2' });

    expect(res.status).toBe(200);
    expect(cancelParcelMock).toHaveBeenCalledTimes(1);
    expect(cancelParcelMock.mock.calls[0][0].parcelId).toBe(43);
    expect(transitionOrderMock).not.toHaveBeenCalled();
    // Array wird neu geschrieben: ship-2 traegt cancelledAt, ship-3 bleibt unangetastet.
    const arrayWrite = mockDoc.set.mock.calls.map((c) => c[0]).find((p) => Array.isArray(p?.additionalShipments));
    expect(arrayWrite).toBeTruthy();
    const entry2 = arrayWrite.additionalShipments.find((s) => s.shipmentId === 'ship-2');
    const entry3 = arrayWrite.additionalShipments.find((s) => s.shipmentId === 'ship-3');
    expect(entry2.cancelledAt).toBeTruthy();
    expect(entry3.cancelledAt).toBeUndefined();
  });

  it('shipmentId nicht in additionalShipments → 404, fail-closed (nie das Primaer-Label treffen)', async () => {
    mockDoc.get.mockResolvedValueOnce({
      exists: true,
      data: () => ({ omsStatus: 'shipped', shipmentId: 'ship-primary', additionalShipments: [{ shipmentId: 'ship-2', sendcloudParcelId: 43 }] }),
    });

    const res = await request(app)
      .post('/api/orders/order-1/additional-label/cancel')
      .send({ shipmentId: 'ship-primary' });

    expect(res.status).toBe(404);
    expect(cancelParcelMock).not.toHaveBeenCalled();
  });

  it('SendCloud-Fehler (schon storniert) bricht nicht ab — Firestore wird trotzdem konsistent', async () => {
    cancelParcelMock.mockRejectedValue(new Error('410 Parcel has been deleted'));
    mockDoc.get
      .mockResolvedValueOnce({ exists: true, data: () => ({ omsStatus: 'shipped', additionalShipments: [{ shipmentId: 'ship-2', sendcloudParcelId: 43 }] }) })
      .mockResolvedValueOnce({ exists: true, data: () => ({ orderId: 'order-1', sendcloudParcelId: 43 }) });

    const res = await request(app)
      .post('/api/orders/order-1/additional-label/cancel')
      .send({ shipmentId: 'ship-2' });

    expect(res.status).toBe(200);
  });
});
