/**
 * POST /api/print/jobs — Versandetikett in die Druckwarteschlange legen.
 *
 * Der Auftrag traegt die DRUCKERROLLE, nicht den Druckernamen: welches Geraet
 * das ist, weiss nur der Agent im Buero. Die Rolle entscheidet AvyCloud, damit
 * es genau eine Wahrheit gibt (lib/label-format.js).
 */

const request = require('supertest');
const { mockDoc, mockCol } = require('./_patchGcp');

require('./_patchLocalModules');
require('./_setupMocks');
const { createTestApp } = require('./_createApp');
const printRouter = require('../../routes/print');

const app = createTestApp(printRouter);

/** Shipment-Doc unter `shipmentId` bereitstellen. */
function gibShipment(data) {
  mockDoc.get.mockResolvedValueOnce({ exists: true, data: () => ({ orderId: 'order-1', ...data }) });
}

describe('POST /api/print/jobs', () => {
  beforeEach(() => {
    mockDoc.get.mockReset();
    mockCol.add.mockReset().mockResolvedValue({ id: 'job-1' });
    delete process.env.PRINT_QUEUE;
  });

  it('DHL-Sendung ergibt einen Auftrag fuer die Paketrolle', async () => {
    gibShipment({ sendcloudParcelId: 1, carrier: 'dhl' });

    const res = await request(app)
      .post('/api/print/jobs')
      .send({ orderId: 'order-1', shipmentId: 'ship-1' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      jobId: 'job-1',
      printerRole: 'parcel',
      widthMm: 103,
      heightMm: 164,
      status: 'queued',
    });
  });

  it('Deutsche Post ergibt einen Auftrag fuer die Briefrolle', async () => {
    gibShipment({ sendcloudParcelId: 2, carrier: 'deutsche_post', shippingOptionCode: 'dp:maxibrief' });

    const res = await request(app)
      .post('/api/print/jobs')
      .send({ orderId: 'order-1', shipmentId: 'ship-2' });

    expect(res.body.data).toMatchObject({ printerRole: 'letter', widthMm: 62, heightMm: 100 });
  });

  it('DPD landet NICHT auf der Briefrolle', async () => {
    // Praefix-Falle von 2026-07-11: „dp" steckt in „dpd".
    gibShipment({ sendcloudParcelId: 3, carrier: 'dpd', shippingOptionCode: 'dpd:classic' });

    const res = await request(app)
      .post('/api/print/jobs')
      .send({ orderId: 'order-1', shipmentId: 'ship-3' });

    expect(res.body.data.printerRole).toBe('parcel');
  });

  it('unbekannter Transporteur: 422 statt geratenem Drucker', async () => {
    // Raten hiesse: 103-mm-Etikett womoeglich auf der 62-mm-Rolle. Der Barcode
    // waere abgeschnitten und das Paket bliebe liegen. Lieber ehrlich ablehnen
    // und den Bediener von Hand drucken lassen.
    gibShipment({ sendcloudParcelId: 4, carrier: 'ups' });

    const res = await request(app)
      .post('/api/print/jobs')
      .send({ orderId: 'order-1', shipmentId: 'ship-4' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('UNKNOWN_LABEL_FORMAT');
    expect(mockCol.add).not.toHaveBeenCalled();
  });

  it('fremdes Shipment wird nicht gedruckt', async () => {
    mockDoc.get.mockResolvedValueOnce({ exists: true, data: () => ({ orderId: 'anderer-auftrag' }) });

    const res = await request(app)
      .post('/api/print/jobs')
      .send({ orderId: 'order-1', shipmentId: 'ship-fremd' });

    expect(res.status).toBe(404);
    expect(mockCol.add).not.toHaveBeenCalled();
  });

  it('ohne orderId: 400', async () => {
    const res = await request(app).post('/api/print/jobs').send({});
    expect(res.status).toBe(400);
  });

  it('PRINT_QUEUE=off: 503, nichts wird eingereiht', async () => {
    process.env.PRINT_QUEUE = 'off';
    const res = await request(app)
      .post('/api/print/jobs')
      .send({ orderId: 'order-1', shipmentId: 'ship-1' });

    expect(res.status).toBe(503);
    expect(mockCol.add).not.toHaveBeenCalled();
  });
});

describe('GET /api/print/status', () => {
  beforeEach(() => {
    delete process.env.PRINT_QUEUE;
  });

  it('meldet online:false wenn die Warteschlange abgeschaltet ist', async () => {
    process.env.PRINT_QUEUE = 'off';
    const res = await request(app).get('/api/print/status');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ enabled: false, online: false });
  });
});
