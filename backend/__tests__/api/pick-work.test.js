'use strict';
const request = require('supertest');
const express = require('express');
require('./_patchGcp');
require('./_patchLocalModules');
require('./_setupMocks');
const { database } = require('../helpers/_pick-transaction-db');
const db = database(Object.fromEntries(['a', 'b'].map((id) => [`orders/${id}`, {
  tenantId: 'default', omsStatus: 'picking', marketplace: 'ebay', source: 'ebay', createdAt: id,
  items: [{ id: `${id}-1`, sku: 'SKU-1', quantity: 2 }],
}])));
require('../../lib/firestore').firestore = db;
const app = express();
app.use(express.json());
// Test-only trusted authentication boundary. Body-supplied identities are not used.
app.use((req, _res, next) => { req.user = { uid: req.headers['x-test-user'], tenantId: 'default', isAdmin: true }; next(); });
app.use('/api', require('../../routes/orders').router);
it('simultaneous authenticated users receive separate orders, ignoring forged body ownership', async () => {
  const responses = await Promise.all(['alice', 'bob'].map((uid) => request(app).post('/api/orders/pick-work/claim')
    .set('x-test-user', uid).send({ sessionId: `scanner-${uid}`, actor: { uid: 'forged' }, tenantId: 'foreign' })));
  expect(responses.map((res) => res.status)).toEqual([200, 200]);
  expect(responses.map((res) => res.body.data.pickWork.ownerUid)).toEqual(['alice', 'bob']);
  expect(new Set(responses.map((res) => res.body.data.id)).size).toBe(2);
});
it('returns conflict on another scanner and persists pause with the trusted owner only', async () => {
  const current = await request(app).get('/api/orders/pick-work').set('x-test-user', 'alice');
  expect(current.headers['cache-control']).toBe('no-store');
  const order = current.body.data;
  const conflict = await request(app).post('/api/orders/pick-work/claim').set('x-test-user', 'alice').send({ sessionId: 'new-device' });
  expect(conflict.status).toBe(409);
  expect(conflict.body.error.code).toBe('PICK_OTHER_DEVICE');
  const wrong = await request(app).post('/api/orders/pick-work/pause').set('x-test-user', 'bob').send({ orderId: order.id, token: order.pickWork.token });
  expect(wrong.status).toBe(409);
  const paused = await request(app).post('/api/orders/pick-work/pause').set('x-test-user', 'alice').send({ orderId: order.id, token: order.pickWork.token });
  expect(paused.status).toBe(200);
  expect(db.rows.get(`orders/${order.id}`).pickWork.status).toBe('paused');
});
it('uses fresh scoped BIN projections for two employees instead of FIFO arrival order', async () => {
  db.rows.clear();
  for (const [id, bin] of [['a-l', 'LEG0101A'], ['b-s', 'SEG0101A'], ['c-x', 'XEG0101A']]) {
    db.rows.set(`orders/${id}`, { tenantId: 'default', omsStatus: 'picking', marketplace: 'ebay', createdAt: '2026-10-12',
      items: [{ id: `${id}-line`, sku: id, quantity: 1 }] });
    db.rows.set(`products_v2/${id}`, { tenantId: 'default', identification: { sku: id }, storageBins: [{ code: bin, quantity: 1 }] });
  }
  const responses = await Promise.all(['alice', 'bob'].map(uid => request(app).post('/api/orders/pick-work/claim')
    .set('x-test-user', uid).send({ sessionId: `scanner-${uid}` })));
  expect(responses.map(r => r.status)).toEqual([200,200]);
  expect(responses.map(r => r.body.data.id).sort()).toEqual(['b-s','c-x']);
  expect(db.rows.get('orders/a-l').pickWork).toBeUndefined();
});
it('round endpoints release remaining work only for the authenticated owner and preserve partial quantities', async () => {
  db.rows.clear();
  db.rows.set('orders/partial', { tenantId: 'default', omsStatus: 'picking', marketplace: 'ebay',
    items: [{ id: 'line', sku: 'PARTIAL', quantity: 3 }] });
  db.rows.set('products_v2/partial', { tenantId: 'default', identification: { sku: 'PARTIAL' }, storageBins: [{ code: 'XEG0202A', quantity: 8 }] });
  const start = await request(app).post('/api/orders/pick-round/next').set('x-test-user', 'alice')
    .send({ sessionId: 'a', actor: { uid: 'bob' }, tenantId: 'foreign' });
  expect(start.status).toBe(200);
  expect(start.body.data.stop).toMatchObject({ itemId: 'line', binCode: 'XEG0202A', quantity: 3 });
  const roundId = start.body.data.roundId;
  const { preparePickBooking } = require('../../services/pick-work');
  const order = db.rows.get('orders/partial');
  order.pickWork = preparePickBooking(order, { tenantId: 'default', actor: { uid: 'alice' }, token: order.pickWork.token,
    itemId: 'line', sku: 'PARTIAL', quantity: 1, binCode: 'XEG0202A', requestId: 'http-pick' }).work;
  order.stockDecrementedAt = 'today'; order.stockDecrementedBy = 'pick';
  const wrong = await request(app).post('/api/orders/pick-round/end').set('x-test-user', 'bob').send({ sessionId: 'a', roundId, actor: { uid: 'alice' } });
  expect(wrong.status).toBe(409);
  const end = await request(app).post('/api/orders/pick-round/end').set('x-test-user', 'alice').send({ sessionId: 'a', roundId });
  expect(end.status).toBe(200); expect(end.body.data.releasedOrders).toBe(1);
  const bob = await request(app).post('/api/orders/pick-round/next').set('x-test-user', 'bob').send({ sessionId: 'b' });
  expect(bob.status).toBe(200); expect(bob.body.data.order.pickWork.ownerUid).toBe('bob');
  expect(bob.body.data.order.pickWork.lines[0].picked).toBe(1);
  expect(bob.body.data.stop.quantity).toBe(2);
  expect(bob.body.data.order.stockDecrementedAt).toBe('today');
});
it.each(['end', 'next'])('finishes fully booked work through the OMS before round %s', async action => {
  db.rows.clear();
  db.rows.set('orders/done', { tenantId: 'default', omsStatus: 'picking', marketplace: 'ebay',
    items: [{ id: 'line', sku: 'DONE', quantity: 1 }] });
  const first = await request(app).post('/api/orders/pick-round/next').set('x-test-user', 'alice').send({ sessionId: 'a' });
  db.rows.get('orders/done').pickWork.lines[0].picked = 1;
  const oms = require('../../services/order-state-machine');
  const transition = vi.spyOn(oms, 'transitionOrder').mockImplementation(async ({ tenantId, orderId, toStatus, actor }) => {
    expect(tenantId).toBe('default'); expect(actor.uid).toBe('alice'); expect(toStatus).toBe('picked');
    db.rows.get(`orders/${orderId}`).omsStatus = toStatus;
    return { ok: true };
  });
  try {
    const response = await request(app).post(`/api/orders/pick-round/${action}`).set('x-test-user', 'alice')
      .send({ sessionId: 'a', roundId: first.body.data.roundId });
    expect(response.status).toBe(200);
    expect(transition).toHaveBeenCalledTimes(1);
    expect(db.rows.get('orders/done').pickWork.lines[0].picked).toBe(1);
    expect(db.rows.get('orders/done').omsStatus).toBe('picked');
    if (action === 'end') expect(response.body.data.releasedOrders).toBe(0);
    else expect(response.body.data.order).toBeNull();
  } finally { transition.mockRestore(); }
});
