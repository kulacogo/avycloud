'use strict';
const request = require('supertest');
require('./_patchGcp');
require('./_patchLocalModules');
require('./_setupMocks');
const { database } = require('../helpers/_pick-transaction-db');
const db = database({
  'shipments/ship-1': { tenantId: 'default', orderId: 'order-1', carrier: 'dhl', sendcloudParcelId: 1 },
  'shipments/foreign': { tenantId: 'foreign', orderId: 'order-1', carrier: 'dhl' },
});
require('../..//lib/firestore').firestore = db;
const { createTestApp } = require('./_createApp');
const app = createTestApp(require('../../routes/print'));

it('concurrent duplicate print requests persist only one job', async () => {
  const jobs = await Promise.all([1, 2].map(() => request(app).post('/api/print/jobs').send({ orderId: 'order-1', shipmentId: 'ship-1' })));
  expect(jobs.map((response) => response.status)).toEqual([200, 200]);
  expect(jobs[0].body.data.jobId).toBe(jobs[1].body.data.jobId);
  expect([...db.rows.keys()].filter((key) => key.startsWith('print_jobs/'))).toHaveLength(1);
  const foreign = await request(app).post('/api/print/jobs').send({ orderId: 'order-1', shipmentId: 'foreign' });
  expect(foreign.status).toBe(404);
});
it('dispatch cannot be stolen by another agent or replayed with an old token', async () => {
  const queued = await request(app).post('/api/print/jobs').send({ orderId: 'order-1', shipmentId: 'ship-1', reprintId: 'test-dispatch' });
  const id = queued.body.data.jobId;
  // Keep only this queued job in the fixture for deterministic claim order.
  for (const [path, value] of db.rows) if (path.startsWith('print_jobs/') && !path.endsWith(id)) value.status = 'done';
  const claimed = await request(app).post('/api/print/agent/claim').send({ agentId: 'station-a', protocolVersion: 2 });
  const token = claimed.body.data.job.claimToken;
  expect(claimed.body.data.job.jobId).toBe(id);
  const begin = await request(app).post(`/api/print/jobs/${id}/result`).send({ action: 'begin', agentId: 'station-a', claimToken: token });
  expect(begin.body.data.status).toBe('dispatching');
  const second = await request(app).post('/api/print/agent/claim').send({ agentId: 'station-b', protocolVersion: 2 });
  expect(second.body.data.job).toBeNull();
  const stale = await request(app).post(`/api/print/jobs/${id}/result`).send({ ok: true, spoolId: 'DHL-1', agentId: 'station-a', claimToken: 'old' });
  expect(stale.status).toBe(409);
  const done = await request(app).post(`/api/print/jobs/${id}/result`).send({ ok: true, spoolId: 'DHL-1', agentId: 'station-a', claimToken: token });
  expect(done.body.data.status).toBe('done');
});
it('legacy agents are stopped before claiming a new delivery', async () => {
  const result = await request(app).post('/api/print/agent/claim').send({ agentId: 'old-agent' });
  expect(result.status).toBe(426);
});
it('rejects an explicitly selected cancelled shipping label', async () => {
  db.rows.set('shipments/cancelled', { tenantId: 'default', orderId: 'order-1', carrier: 'dhl', status: 'cancelled' });
  const response = await request(app).post('/api/print/jobs').send({ orderId: 'order-1', shipmentId: 'cancelled' });
  expect(response.status).toBe(404);
});
