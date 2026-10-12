'use strict';
const { createPickRoundService } = require('../services/pick-round');
const { preparePickBooking } = require('../services/pick-work');
const { database } = require('./helpers/_pick-transaction-db');
const actor = { uid: 'alice', email: 'alice@example.test' };
const other = { uid: 'bob', email: 'bob@example.test' };
const item = (id, bin) => ({ id, sku: id, quantity: 2, bin });
function setup() {
  const db = database({
    'orders/a': { tenantId: 'default', omsStatus: 'picking', items: [item('a1', 'XEG0309A'), item('a2', 'LEG0101A')] },
    'orders/b': { tenantId: 'default', omsStatus: 'picking', items: [item('b1', 'XEG0308A')] },
  });
  const service = createPickRoundService({ db,
    listCandidates: async () => [...db.rows].filter(([p]) => p.startsWith('orders/')).map(([p, x]) => ({ ...x, id: p.split('/')[1] })),
    loadStops: async ({ orders }) => new Map(orders.map(o => [o.id, o.items.filter(i => (o.pickWork?.lines.find(l => l.itemId === i.id)?.picked || 0) < i.quantity)
      .map(i => ({ itemId: i.id, binCode: i.bin, quantity: 2 }))])),
  });
  return { db, service };
}
const next = (s, who = actor, extra = {}) => s.next({ tenantId: 'default', actor: who, sessionId: `scanner-${who.uid}`, ...extra });
function book(db, result, quantity = 2) {
  const o = db.rows.get(`orders/${result.order.id}`);
  const work = preparePickBooking(o, { tenantId: 'default', actor, token: o.pickWork.token, itemId: result.stop.itemId,
    requestId: `receipt-${result.stop.itemId}-${quantity}`, quantity, sku: result.stop.itemId, binCode: result.stop.binCode }).work;
  db.rows.set(`orders/${result.order.id}`, { ...o, pickWork: work, stockDecrementedAt: 'today', stockDecrementedBy: 'pick' });
}
it('walks to the neighbouring BIN in another order before a distant remaining line', async () => {
  const { db, service } = setup();
  const first = await next(service);
  expect(first.order.id).toBe('a');
  book(db, first);
  const second = await next(service, actor, { roundId: first.roundId });
  expect(second.order.id).toBe('b');
  expect(second.stop.binCode).toBe('XEG0308A');
  expect(db.rows.get('orders/a').pickWork.ownerUid).toBe('alice');
});
it('assigns different orders to two simultaneous pickers', async () => {
  const { service } = setup();
  const results = await Promise.all([next(service), next(service, other)]);
  expect(new Set(results.map(r => r.order.id)).size).toBe(2);
});
it('ends a round and releases only the remainder with receipts and quantities intact', async () => {
  const { db, service } = setup();
  const first = await next(service); book(db, first, 1);
  const before = structuredClone(db.rows.get('orders/a'));
  const ended = await service.end({ tenantId: 'default', actor, sessionId: 'scanner-alice', roundId: first.roundId });
  expect(ended.releasedOrders).toBe(1);
  const released = db.rows.get('orders/a');
  expect(released.pickWork.status).toBe('released');
  expect(released.pickWork.lines).toEqual(before.pickWork.lines);
  expect(released.pickWork.receipts).toEqual(before.pickWork.receipts);
  expect(released.stockDecrementedAt).toBe('today');
  expect(released.omsStatus).toBe('picking');
  await expect(next(service, actor, { roundId: first.roundId })).rejects.toMatchObject({ code: 'PICK_ROUND_ENDED' });
  const received = await next(service, other);
  expect(received.order.id).toBe('a');
  expect(received.order.pickWork.lines[0].picked).toBe(1);
  expect(received.order.pickWork.token).not.toBe(before.pickWork.token);
  expect(() => preparePickBooking(received.order, { tenantId: 'default', actor, token: before.pickWork.token })).toThrow(/Mitarbeiter/);
});
it('releases all unfinished orders held in the round, not just the current pointer', async () => {
  const { db, service } = setup(); const first = await next(service); book(db, first);
  const second = await next(service, actor, { roundId: first.roundId });
  const ended = await service.end({ tenantId: 'default', actor, sessionId: 'scanner-alice', roundId: second.roundId });
  expect(ended.releasedOrders).toBe(2);
  expect(['a', 'b'].map(id => db.rows.get(`orders/${id}`).pickWork.status)).toEqual(['released', 'released']);
});
it('requires the current scanner and round to end, and makes repeated end harmless', async () => {
  const { db, service } = setup(); const first = await next(service);
  await expect(service.end({ tenantId: 'default', actor, sessionId: 'wrong', roundId: first.roundId })).rejects.toMatchObject({ code: 'PICK_OTHER_DEVICE' });
  await expect(service.end({ tenantId: 'foreign', actor, sessionId: 'scanner-alice', roundId: first.roundId })).rejects.toThrow();
  expect(db.rows.get('orders/a').pickWork.status).toBe('active');
  const request = { tenantId: 'default', actor, sessionId: 'scanner-alice', roundId: first.roundId };
  const ended = await service.end(request);
  expect(await service.end(request)).toEqual(ended);
});
it('fences every unfinished order when the owner takes over on another scanner', async () => {
  const { db, service } = setup(); const first = await next(service); book(db, first);
  await next(service, actor, { roundId: first.roundId });
  const oldTokens = ['a', 'b'].map(id => db.rows.get(`orders/${id}`).pickWork.token);
  await expect(next(service, actor, { sessionId: 'replacement' })).rejects.toMatchObject({ code: 'PICK_OTHER_DEVICE' });
  await next(service, actor, { sessionId: 'replacement', takeover: true });
  for (const [i, id] of ['a', 'b'].entries()) {
    expect(db.rows.get(`orders/${id}`).pickWork.token).not.toBe(oldTokens[i]);
    expect(db.rows.get(`orders/${id}`).pickWork.sessionId).toBe('replacement');
  }
});
it('adopts and explicitly releases a legacy paused assignment instead of stranding it', async () => {
  const { db, service } = setup();
  const { createPickWorkService } = require('../services/pick-work');
  const legacy = createPickWorkService({ db, listCandidates: async () => [{ ...db.rows.get('orders/a'), id: 'a' }] });
  const o = await legacy.claim({ tenantId: 'default', actor, sessionId: 'scanner-alice' });
  await legacy.pause({ tenantId: 'default', actor, orderId: o.id, token: o.pickWork.token });
  const started = await next(service);
  await service.end({ tenantId: 'default', actor, sessionId: 'scanner-alice', roundId: started.roundId });
  expect(db.rows.get('orders/a').pickWork.status).toBe('released');
});
it('never releases a changed receipt or quantity by resetting progress', async () => {
  const { db, service } = setup(); const first = await next(service); book(db, first, 1);
  db.rows.get('orders/a').items[0].quantity = 3;
  await expect(service.end({ tenantId: 'default', actor, sessionId: 'scanner-alice', roundId: first.roundId })).rejects.toMatchObject({ code: 'PICK_REVIEW' });
  expect(db.rows.get('orders/a').pickWork.lines[0].picked).toBe(1);
  expect(db.rows.get('orders/a').pickWork.status).toBe('active');
});
it('skips a problem order for this round, then releases it when the user ends', async () => {
  const { db, service } = setup(); const first = await next(service);
  db.rows.get('orders/a').pickWork.status = 'paused';
  const later = await next(service, actor, { roundId: first.roundId });
  expect(later.order.id).toBe('b');
  await service.end({ tenantId: 'default', actor, sessionId: 'scanner-alice', roundId: later.roundId });
  expect(db.rows.get('orders/a').pickWork.status).toBe('released');
});
it('rejects late requests from an ended round after another round starts', async () => {
  const { service } = setup(); const first = await next(service);
  const old = { tenantId: 'default', actor, sessionId: 'scanner-alice', roundId: first.roundId };
  await service.end(old); const second = await next(service);
  expect(second.roundId).not.toBe(first.roundId);
  await expect(service.end(old)).rejects.toMatchObject({ code: 'PICK_ROUND_ENDED' });
  await expect(next(service, actor, { roundId: first.roundId })).rejects.toMatchObject({ code: 'PICK_ROUND_ENDED' });
});
it('does not offer foreign-tenant or ship-decremented work', async () => {
  const { db, service } = setup();
  db.rows.get('orders/a').tenantId = 'foreign';
  Object.assign(db.rows.get('orders/b'), { stockDecrementedAt: 'today', stockDecrementedBy: 'ship' });
  const first = await next(service);
  expect(first.order).toBeNull();
  expect(db.rows.get('orders/a').pickWork).toBeUndefined();
});
it('preserves a booking racing with end, or fences it before it can write', async () => {
  const { db, service } = setup(); const first = await next(service);
  const stock = db.runTransaction(async tx => {
    const ref = db.collection('orders').doc('a'); const snap = await tx.get(ref);
    const prepared = preparePickBooking(snap.data(), { tenantId: 'default', actor, token: first.order.pickWork.token,
      itemId: 'a1', sku: 'a1', binCode: first.stop.binCode, requestId: 'race', quantity: 1 });
    tx.update(ref, { pickWork: prepared.work });
  });
  const outcomes = await Promise.allSettled([stock, service.end({ tenantId: 'default', actor, sessionId: 'scanner-alice', roundId: first.roundId })]);
  const work = db.rows.get('orders/a').pickWork;
  expect(work.status).toBe('released');
  expect(outcomes[1].status).toBe('fulfilled');
  expect(work.lines[0].picked).toBe(outcomes[0].status === 'fulfilled' ? 1 : 0);
});
it('forces OMS completion before ending a fully booked order, without silently releasing it', async () => {
  const { db, service } = setup(); const first = await next(service);
  db.rows.get('orders/a').pickWork.lines.forEach(l => { l.picked = l.required; });
  await expect(service.end({ tenantId: 'default', actor, sessionId: 'scanner-alice', roundId: first.roundId }))
    .rejects.toMatchObject({ code: 'PICK_COMPLETE_REQUIRED', orderId: 'a' });
  expect(db.rows.get('orders/a').pickWork.status).toBe('active');
});
it('retains held orders when OMS puts them on hold, then fences and releases them at round end', async () => {
  const { db, service } = setup(); const first = await next(service); book(db, first, 1);
  db.rows.get('orders/a').omsStatus = 'on_hold';
  const second = await next(service, actor, { roundId: first.roundId });
  expect(second.order.id).toBe('b');
  // Production listCandidates no longer includes an on-hold order.
  const filtered = createPickRoundService({ db,
    listCandidates: async () => [{ ...db.rows.get('orders/b'), id: 'b' }],
    loadStops: async () => new Map(),
  });
  await next(filtered, actor, { sessionId: 'replacement', takeover: true });
  expect(db.rows.get('orders/a').pickWork.sessionId).toBe('replacement');
  const ended = await filtered.end({ tenantId: 'default', actor, sessionId: 'replacement', roundId: first.roundId });
  expect(ended.releasedOrders).toBe(2);
  expect(db.rows.get('orders/a')).toMatchObject({ omsStatus: 'on_hold', pickWork: { status: 'released', lines: [{ picked: 1 }, { picked: 0 }] } });
});
it('allows a legacy client to claim released partial work without booking the old quantity again', async () => {
  const { db, service } = setup(); const first = await next(service); book(db, first, 1);
  await service.end({ tenantId: 'default', actor, sessionId: 'scanner-alice', roundId: first.roundId });
  const { createPickWorkService } = require('../services/pick-work');
  const legacy = createPickWorkService({ db, listCandidates: async () => [{ ...db.rows.get('orders/a'), id: 'a' }] });
  const picked = await legacy.claim({ tenantId: 'default', actor: other, sessionId: 'old-browser' });
  expect(picked.pickWork.ownerUid).toBe('bob');
  expect(picked.pickWork.lines[0].picked).toBe(1);
  expect(Object.keys(picked.pickWork.receipts)).toHaveLength(1);
  expect(picked.stockDecrementedBy).toBe('pick');
});
