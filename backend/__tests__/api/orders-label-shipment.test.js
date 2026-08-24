/**
 * GET /api/orders/:orderId/label — Primaer-Label-Vorrang + shipmentId-Zweig.
 *
 * Review-Befunde 2/17/21 (2026-08-21): Ohne shipmentId nahm die Route das
 * NEUESTE shipments-Doc — nach einem Zusatz-Label ist das die Zusatz-Sendung,
 * der Haupt-Druckknopf druckte still das falsche Label. Erwartung seit Fix:
 *   1. ?shipmentId= laedt genau dieses Shipment — 404 wenn es nicht zum
 *      Auftrag gehoert (einzige Schranke gegen Fremd-Label-Abruf).
 *   2. Ohne Param gewinnt order.shipmentId (Primaer-Sendung).
 *   3. Fallback (kein/toter Verweis): neuestes NICHT-Zusatz-Shipment.
 */

const request = require('supertest');

const { mockQuery, mockDoc } = require('./_patchGcp');

// shipping-engine mocken (getLabel/downloadLabelPdf werden inline im Handler ge-required)
const getLabelMock = vi.fn();
const downloadLabelPdfMock = vi.fn();
const sePath = require.resolve('../../services/shipping-engine.js');
require.cache[sePath] = {
  id: sePath, filename: sePath, loaded: true,
  exports: { getLabel: getLabelMock, downloadLabelPdf: downloadLabelPdfMock },
  children: [], paths: [],
};

require('./_patchLocalModules');
require('./_setupMocks');
const { createTestApp } = require('./_createApp');
const { router: ordersRouter } = require('../../routes/orders');

const app = createTestApp(ordersRouter);

const shipmentDoc = (id, data) => ({ id, data: () => data, ref: {} });

describe('GET /api/orders/:orderId/label', () => {
  beforeEach(() => {
    getLabelMock.mockReset().mockResolvedValue({ labelUrl: 'http://sc-label' });
    downloadLabelPdfMock.mockReset().mockResolvedValue({ buffer: Buffer.from('%PDF-fake'), contentType: 'application/pdf' });
    mockDoc.get.mockReset();
    mockQuery.get.mockReset().mockResolvedValue({ empty: true, docs: [], size: 0, forEach: () => {} });
  });

  it('?shipmentId= eines FREMDEN Auftrags → 404 (Ownership-Guard)', async () => {
    mockDoc.get.mockResolvedValueOnce({ exists: true, data: () => ({ orderId: 'other-order', sendcloudParcelId: 7 }) });

    const res = await request(app).get('/api/orders/order-1/label?shipmentId=ship-x');

    expect(res.status).toBe(404);
    expect(getLabelMock).not.toHaveBeenCalled();
  });

  it('?shipmentId= des eigenen Auftrags liefert genau dessen Label', async () => {
    mockDoc.get.mockResolvedValueOnce({ exists: true, data: () => ({ orderId: 'order-1', sendcloudParcelId: 99 }) });

    const res = await request(app).get('/api/orders/order-1/label?shipmentId=ship-add');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(getLabelMock).toHaveBeenCalledWith(expect.objectContaining({ parcelId: 99 }));
  });

  it('ohne Param gewinnt order.shipmentId (Primaer-Sendung), nicht das neueste Doc', async () => {
    // 1. Order-Doc, 2. shipments/{order.shipmentId}
    mockDoc.get
      .mockResolvedValueOnce({ exists: true, data: () => ({ shipmentId: 'ship-primary' }) })
      .mockResolvedValueOnce({ exists: true, data: () => ({ orderId: 'order-1', sendcloudParcelId: 1 }) });

    const res = await request(app).get('/api/orders/order-1/label');

    expect(res.status).toBe(200);
    expect(getLabelMock).toHaveBeenCalledWith(expect.objectContaining({ parcelId: 1 }));
    expect(mockQuery.get).not.toHaveBeenCalled();
  });

  it('Fallback ohne order.shipmentId: neuestes NICHT-Zusatz-Shipment', async () => {
    mockDoc.get.mockResolvedValueOnce({ exists: true, data: () => ({}) });
    const docs = [
      shipmentDoc('ship-add', { orderId: 'order-1', sendcloudParcelId: 43, additionalLabel: true }),
      shipmentDoc('ship-primary', { orderId: 'order-1', sendcloudParcelId: 1 }),
    ];
    mockQuery.get.mockResolvedValue({ empty: false, docs, size: docs.length, forEach: () => {} });

    const res = await request(app).get('/api/orders/order-1/label');

    expect(res.status).toBe(200);
    expect(getLabelMock).toHaveBeenCalledWith(expect.objectContaining({ parcelId: 1 }));
  });

  it('gar kein Shipment → weiterhin 404', async () => {
    mockDoc.get.mockResolvedValueOnce({ exists: true, data: () => ({}) });
    mockQuery.get.mockResolvedValue({ empty: true, docs: [], size: 0, forEach: () => {} });

    const res = await request(app).get('/api/orders/order-1/label');

    expect(res.status).toBe(404);
  });
});
