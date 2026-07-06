/**
 * CSV-Export/Import — die Routen leben unter /api, NICHT /api/v1.
 *
 * Das Frontend rief monatelang /api/v1/products/export/csv auf und lud die
 * Express-HTML-404-Seite als .csv herunter; der Import war komplett tot.
 * Ursache: falsche /api/v1-Doc-Kommentare in products.js. Dieser Test nagelt
 * die echten Pfade fest, damit Frontend und Backend nicht wieder driften.
 */

const request = require('supertest');

require('./_patchGcp');
require('./_patchLocalModules');
require('./_setupMocks');
const { createTestApp } = require('./_createApp');
const { router: productsRouter } = require('../../routes/products');

const app = createTestApp(productsRouter);

describe('CSV-Export/Import Routen-Pfade', () => {
  it('GET /api/products/export/csv existiert (kein 404)', async () => {
    const res = await request(app).get('/api/products/export/csv');
    expect(res.status).not.toBe(404);
  });

  it('GET /api/v1/products/export/csv existiert NICHT (der alte Frontend-Irrtum)', async () => {
    const res = await request(app).get('/api/v1/products/export/csv');
    expect(res.status).toBe(404);
  });

  it('POST /api/products/import/preview existiert (kein 404)', async () => {
    const res = await request(app).post('/api/products/import/preview').send({ csv: 'sku\n' });
    expect(res.status).not.toBe(404);
  });

  it('POST /api/products/import/execute existiert (kein 404)', async () => {
    const res = await request(app).post('/api/products/import/execute').send({ rows: [] });
    expect(res.status).not.toBe(404);
  });
});
