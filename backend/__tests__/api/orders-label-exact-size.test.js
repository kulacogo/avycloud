/**
 * GET /api/orders/:orderId/label — das ausgelieferte PDF hat das physische
 * Rollenmass (Betreiber-Vorgabe 2026-08-24):
 *   DHL / DPD      -> 103 x 164 mm
 *   Deutsche Post  ->  62 x 100 mm
 *
 * Bis dahin reichte der Proxy das SendCloud-PDF unveraendert durch (~A6). Der
 * Druckertreiber skalierte dann selbst, mit Voreinstellungen die niemand
 * kontrolliert — verschobene Raender, gestauchte Barcodes.
 *
 * Geprueft wird das ECHTE Seitenmass des zurueckgegebenen PDFs, nicht nur eine
 * Kopfzeile: eine Kopfzeile kann stimmen, waehrend das Dokument falsch ist.
 */

const request = require('supertest');
const { PDFDocument } = require('pdf-lib');

const { mockQuery, mockDoc } = require('./_patchGcp');

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

const mmToPt = (mm) => (mm / 25.4) * 72;
const round = (n) => Math.round(n * 100) / 100;

/** Ein A6-PDF bauen — so liefert SendCloud das Etikett. */
async function a6Pdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([mmToPt(105), mmToPt(148)]);
  page.drawRectangle({ x: 4, y: 4, width: 30, height: 30 });
  return Buffer.from(await doc.save());
}

/** Seitenmass des ausgelieferten PDFs in Millimetern. */
async function seitenMass(body) {
  const doc = await PDFDocument.load(body);
  const { width, height } = doc.getPage(0).getSize();
  return { breiteMm: round((width / 72) * 25.4), hoeheMm: round((height / 72) * 25.4) };
}

/** Ein Shipment-Doc unter `?shipmentId=` bereitstellen. */
function gibShipment(data) {
  mockDoc.get.mockResolvedValueOnce({ exists: true, data: () => ({ orderId: 'order-1', ...data }) });
}

describe('GET /api/orders/:orderId/label — exaktes Rollenmass', () => {
  let quelle;

  beforeEach(async () => {
    quelle = await a6Pdf();
    getLabelMock.mockReset().mockResolvedValue({ labelUrl: 'http://sc-label' });
    downloadLabelPdfMock.mockReset()
      .mockResolvedValue({ buffer: quelle, contentType: 'application/pdf' });
    mockDoc.get.mockReset();
    mockQuery.get.mockReset().mockResolvedValue({ empty: true, docs: [], size: 0, forEach: () => {} });
    delete process.env.LABEL_EXACT_SIZE;
  });

  it('DHL-Sendung kommt als 103 x 164 mm heraus', async () => {
    gibShipment({ sendcloudParcelId: 1, carrier: 'dhl' });

    const res = await request(app)
      .get('/api/orders/order-1/label?shipmentId=ship-1')
      .buffer(true)
      .parse((r, cb) => {
        const teile = [];
        r.on('data', (c) => teile.push(c));
        r.on('end', () => cb(null, Buffer.concat(teile)));
      });

    expect(res.status).toBe(200);
    expect(await seitenMass(res.body)).toEqual({ breiteMm: 103, hoeheMm: 164 });
    expect(res.headers['x-label-printer-role']).toBe('parcel');
    expect(res.headers['x-label-resized']).toBe('1');
  });

  it('DPD-Sendung ebenfalls 103 x 164 mm — nicht auf die Briefrolle', async () => {
    // Der Praefix-Fehler von 2026-07-11 („dp" steckt in „dpd") wuerde hier
    // 62 x 100 liefern und den Barcode abschneiden.
    gibShipment({ sendcloudParcelId: 2, carrier: 'dpd', shippingOptionCode: 'dpd:classic' });

    const res = await request(app)
      .get('/api/orders/order-1/label?shipmentId=ship-2')
      .buffer(true)
      .parse((r, cb) => {
        const teile = [];
        r.on('data', (c) => teile.push(c));
        r.on('end', () => cb(null, Buffer.concat(teile)));
      });

    expect(await seitenMass(res.body)).toEqual({ breiteMm: 103, hoeheMm: 164 });
  });

  it('Deutsche Post kommt als 62 x 100 mm heraus', async () => {
    gibShipment({ sendcloudParcelId: 3, carrier: 'deutsche_post', shippingOptionCode: 'dp:maxibrief' });

    const res = await request(app)
      .get('/api/orders/order-1/label?shipmentId=ship-3')
      .buffer(true)
      .parse((r, cb) => {
        const teile = [];
        r.on('data', (c) => teile.push(c));
        r.on('end', () => cb(null, Buffer.concat(teile)));
      });

    expect(await seitenMass(res.body)).toEqual({ breiteMm: 62, hoeheMm: 100 });
    expect(res.headers['x-label-printer-role']).toBe('letter');
  });

  it('unbekannter Transporteur: Original unveraendert durchgereicht', async () => {
    // Fail-open. Ein Etikett im Herstellermass ist brauchbar, ein geratenes
    // Format kann unlesbar sein.
    gibShipment({ sendcloudParcelId: 4, carrier: 'ups' });

    const res = await request(app)
      .get('/api/orders/order-1/label?shipmentId=ship-4')
      .buffer(true)
      .parse((r, cb) => {
        const teile = [];
        r.on('data', (c) => teile.push(c));
        r.on('end', () => cb(null, Buffer.concat(teile)));
      });

    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body, quelle)).toBe(0);
    expect(res.headers['x-label-resized']).toBe('0');
    expect(res.headers['x-label-printer-role']).toBeUndefined();
  });

  it('LABEL_EXACT_SIZE=off reicht das Original durch (Notbremse)', async () => {
    process.env.LABEL_EXACT_SIZE = 'off';
    gibShipment({ sendcloudParcelId: 5, carrier: 'dhl' });

    const res = await request(app)
      .get('/api/orders/order-1/label?shipmentId=ship-5')
      .buffer(true)
      .parse((r, cb) => {
        const teile = [];
        r.on('data', (c) => teile.push(c));
        r.on('end', () => cb(null, Buffer.concat(teile)));
      });

    expect(Buffer.compare(res.body, quelle)).toBe(0);
    expect(res.headers['x-label-resized']).toBe('0');
  });

  it('kaputtes PDF bricht den Etikettenabruf NICHT ab', async () => {
    // Fail-open ist hier Pflicht: ohne Etikett steht der Versand.
    downloadLabelPdfMock.mockResolvedValue({
      buffer: Buffer.from('kein pdf'), contentType: 'application/pdf',
    });
    gibShipment({ sendcloudParcelId: 6, carrier: 'dhl' });

    const res = await request(app)
      .get('/api/orders/order-1/label?shipmentId=ship-6')
      .buffer(true)
      .parse((r, cb) => {
        const teile = [];
        r.on('data', (c) => teile.push(c));
        r.on('end', () => cb(null, Buffer.concat(teile)));
      });

    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('kein pdf');
    expect(res.headers['x-label-resized']).toBe('0');
  });
});
