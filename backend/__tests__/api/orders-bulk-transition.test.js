/**
 * POST /api/orders/bulk-transition — abgelehnte Transitionen dürfen nicht als
 * Erfolg gemeldet werden.
 *
 * transitionOrder() wirft bei abgelehnten Übergängen NICHT, sondern liefert
 * {ok:false, error}. Der Bulk-Endpoint muss result.ok durchreichen, sonst
 * sieht der Operator success:N obwohl Orders nie umgestellt wurden.
 */

const request = require('supertest');

require('./_patchGcp');

// order-state-machine VOR dem Route-Require mocken (CJS require.cache patch)
const transitionOrderMock = vi.fn();
const osmPath = require.resolve('../../services/order-state-machine.js');
require.cache[osmPath] = {
  id: osmPath,
  filename: osmPath,
  loaded: true,
  exports: { transitionOrder: transitionOrderMock, ORDER_STATUSES: {} },
  children: [],
  paths: [],
};

require('./_patchLocalModules');
require('./_setupMocks');
const { createTestApp } = require('./_createApp');
const { router: ordersRouter } = require('../../routes/orders');

const app = createTestApp(ordersRouter);

describe('POST /api/orders/bulk-transition', () => {
  beforeEach(() => {
    transitionOrderMock.mockReset();
  });

  it('meldet ok:false für Orders, deren Transition abgelehnt wurde', async () => {
    transitionOrderMock.mockImplementation(async ({ orderId }) => {
      if (orderId === 'order-b') {
        return { ok: false, error: 'Transition confirmed → picking nicht erlaubt' };
      }
      return { ok: true, fromStatus: 'pending', toStatus: 'confirmed' };
    });

    const res = await request(app)
      .post('/api/orders/bulk-transition')
      .send({ orderIds: ['order-a', 'order-b'], toStatus: 'confirmed' });

    expect(res.status).toBe(200);
    expect(res.body.data.success).toBe(1);

    const byId = Object.fromEntries(res.body.data.results.map((r) => [r.orderId, r]));
    expect(byId['order-a'].ok).toBe(true);
    expect(byId['order-b'].ok).toBe(false);
    expect(byId['order-b'].error).toContain('nicht erlaubt');
  });

  it('meldet ok:false mit Default-Fehler, wenn transitionOrder ok:false ohne error liefert', async () => {
    transitionOrderMock.mockResolvedValue({ ok: false });

    const res = await request(app)
      .post('/api/orders/bulk-transition')
      .send({ orderIds: ['order-x'], toStatus: 'confirmed' });

    expect(res.status).toBe(200);
    expect(res.body.data.success).toBe(0);
    expect(res.body.data.results[0].ok).toBe(false);
    expect(res.body.data.results[0].error).toBeTruthy();
  });

  it('zählt nur echte Erfolge in success', async () => {
    transitionOrderMock.mockResolvedValue({ ok: true, fromStatus: 'pending', toStatus: 'confirmed' });

    const res = await request(app)
      .post('/api/orders/bulk-transition')
      .send({ orderIds: ['o1', 'o2', 'o3'], toStatus: 'confirmed' });

    expect(res.status).toBe(200);
    expect(res.body.data.success).toBe(3);
    expect(res.body.data.results.every((r) => r.ok)).toBe(true);
  });
});
