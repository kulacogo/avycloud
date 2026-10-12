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
