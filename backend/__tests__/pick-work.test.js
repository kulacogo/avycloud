'use strict';

const { createPickWorkService, preparePickBooking, validatePickTransition } = require('../services/pick-work');

const { database } = require('./helpers/_pick-transaction-db');

const actor = { uid: 'alice', email: 'alice@example.test' };
const other = { uid: 'bob', email: 'bob@example.test' };
const order = (id, quantity = 2) => ({ id, tenantId: 'default', omsStatus: 'confirmed', createdAt: id,
  items: [{ id: `${id}-1`, sku: 'SKU-1', productId: 'p1', quantity }] });
function setup(seed = { 'orders/a': order('a'), 'orders/b': order('b') }) {
  const db = database(seed);
  const service = createPickWorkService({ db, listCandidates: async () => [...db.rows.entries()]
    .filter(([key]) => key.startsWith('orders/')).map(([key, row]) => ({ ...row, id: key.split('/')[1] })) });
  return { db, service };
}
const claim = (service, who = actor, sessionId = 'scanner-a', extra = {}) => service.claim({ tenantId: 'default', actor: who, sessionId, ...extra });

describe('exclusive pick work', () => {
  it('assigns different orders to two simultaneous employees', async () => {
    const { service } = setup();
    const [a, b] = await Promise.all([claim(service), claim(service, other, 'scanner-b')]);
    expect(new Set([a.id, b.id]).size).toBe(2);
    expect(a.pickWork.ownerUid).toBe('alice');
    expect(b.pickWork.ownerUid).toBe('bob');
  });
  it('resumes the same order and fences another scanner of the same employee', async () => {
    const { service } = setup();
    const a = await claim(service);
    expect((await claim(service)).id).toBe(a.id);
    await expect(claim(service, actor, 'scanner-b')).rejects.toThrow(/Scanner/);
    const taken = await claim(service, actor, 'scanner-b', { takeover: true });
    expect(taken.id).toBe(a.id);
    expect(taken.pickWork.token).not.toBe(a.pickWork.token);
  });
  it('keeps partially picked work reserved after pause and long disconnection', async () => {
    const { db, service } = setup({ 'orders/a': order('a') });
    const a = await claim(service);
    a.pickWork.lines[0].picked = 1;
    a.pickWork.updatedAt = '2020-01-01T00:00:00Z';
    db.rows.set('orders/a', a);
    await service.pause({ tenantId: 'default', actor, orderId: a.id, token: a.pickWork.token });
    expect(await claim(service, other, 'scanner-b')).toBeNull();
    expect((await claim(service)).pickWork.lines[0].picked).toBe(1);
  });
  it('does not assign another tenant or an old pick with unknown quantities', async () => {
    const { service } = setup({ 'orders/a': { ...order('a'), tenantId: 'foreign' },
      'orders/b': { ...order('b'), stockDecrementedBy: 'pick', stockDecrementedAt: 'yesterday' } });
    expect(await claim(service)).toBeNull();
  });
});

describe('pick booking contract in the stock transaction', () => {
  let current;
  let request;
  beforeEach(async () => {
    const { service } = setup();
    current = await claim(service);
    request = { tenantId: 'default', actor, token: current.pickWork.token, itemId: 'a-1',
      requestId: 'pick-1', productId: 'p1', sku: 'SKU-1', binCode: 'XEG0107D', quantity: 1 };
  });
  it('persists partial quantity, deduplicates retry, and rejects excess', () => {
    const first = preparePickBooking(current, request);
    current.pickWork = first.work;
    expect(first.deduped).toBe(false);
    expect(first.work.lines[0].picked).toBe(1);
    expect(preparePickBooking(current, request).deduped).toBe(true);
    current.pickWork = preparePickBooking(current, { ...request, requestId: 'pick-2' }).work;
    expect(current.pickWork.lines[0].picked).toBe(2);
    expect(() => preparePickBooking(current, { ...request, requestId: 'pick-3' })).toThrow(/Menge/);
  });
  it.each([
    ['owner', { actor: other }], ['tenant', { tenantId: 'foreign' }], ['old scanner', { token: 'old' }],
    ['missing request', { requestId: '' }], ['wrong product', { productId: 'p2', sku: 'SKU-2' }],
    ['wrong item', { itemId: 'b-1' }], ['fraction', { quantity: 0.5 }],
  ])('rejects %s before changing stock', (_name, patch) => {
    expect(() => preparePickBooking(current, { ...request, ...patch })).toThrow();
  });
  it('rejects reuse of an idempotency key for different data', () => {
    current.pickWork = preparePickBooking(current, request).work;
    expect(() => preparePickBooking(current, { ...request, quantity: 2 })).toThrow(/kennung/i);
  });
  it('rejects stale submissions after cancel', () => {
    current.omsStatus = 'cancelled';
    expect(() => preparePickBooking(current, request)).toThrow();
  });
  it('never allows completion or shipping of an incomplete managed pick', () => {
    expect(validatePickTransition(current, 'picked', actor)).toMatch(/vollständig/);
    expect(validatePickTransition(current, 'shipped', actor)).toMatch(/vollständig/);
    current.pickWork.lines[0].picked = 2;
    expect(validatePickTransition(current, 'picked', other)).toMatch(/Mitarbeiter/);
    expect(validatePickTransition(current, 'picked', actor)).toBeNull();
  });
});

it('blocks completion when order contents changed after claiming', async () => {
  const { service } = setup();
  const current = await claim(service);
  current.pickWork.lines[0].picked = 2;
  for (const items of [[], [{ ...current.items[0], sku: 'SKU-CHANGED' }], [{ ...current.items[0], quantity: 3 }], [...current.items, { id: 'new', quantity: 1, sku: 'SKU-2' }]]) {
    expect(validatePickTransition({ ...current, items }, 'shipped', actor)).toMatch(/geändert|prüfen/);
  }
});
it('does not trap the employee on a cancelled order with no picked goods', async () => {
  const { db, service } = setup();
  const first = await claim(service);
  db.rows.set('orders/a', { ...first, omsStatus: 'cancelled' });
  expect((await claim(service)).id).toBe('b');
});

describe('route-aware exclusive assignment', () => {
  const routedSetup = () => {
    const db = database(Object.fromEntries(['l', 's', 'x', 's2'].map((id) => [`orders/${id}`, order(id)])));
    const bins = { l: ['LEG0101A'], s: ['SEG0401A'], x: ['XEG0101A'], s2: ['SEG0301A'] };
    const service = createPickWorkService({ db,
      listCandidates: async () => [...db.rows.entries()].filter(([k]) => k.startsWith('orders/')).map(([,v]) => v),
      loadRouteBins: async () => new Map(Object.entries(bins)),
    });
    return { db, service };
  };
  it('starts along the route rather than arbitrary order IDs / age ties', async () => {
    const { service } = routedSetup();
    expect((await claim(service)).id).toBe('x');
  });
  it('continues at a confirmed position while another employee keeps their own order', async () => {
    const { db, service } = routedSetup();
    const first = await claim(service, actor, 'scanner-a', { orderId: 's' });
    db.rows.set('orders/s', { ...first, omsStatus: 'picked', pickWork: { ...first.pickWork, lastBinCode: 'SEG0401A' } });
    const [a,b] = await Promise.all([claim(service), claim(service, other, 'scanner-b')]);
    expect(a.id).toBe('s2'); expect(b.id).toBe('x');
    expect(a.pickWork.ownerUid).toBe(actor.uid);
    expect(b.pickWork.ownerUid).toBe(other.uid);
  });
  it('preserves held work and explicit assignment even when another route looks better', async () => {
    const { service } = routedSetup();
    const first = await claim(service, actor, 'scanner-a', { orderId: 'l' });
    await service.pause({ tenantId: 'default', actor, orderId: first.id, token: first.pickWork.token });
    expect((await claim(service)).id).toBe('l');
  });
  it('records the last physical pick atomically and does not move it backwards on a duplicate retry', async () => {
    const { service } = setup(); const current = await claim(service);
    const request = { tenantId: 'default', actor, token: current.pickWork.token, itemId: 'a-1', requestId: 'r1',
      productId: 'p1', sku: 'SKU-1', binCode: 'SEG0401A', quantity: 1 };
    current.pickWork = preparePickBooking(current, request).work;
    expect(current.pickWork.lastBinCode).toBe('SEG0401A');
    current.pickWork = preparePickBooking(current, { ...request, requestId: 'r2', binCode: 'LEG0101A' }).work;
    expect(preparePickBooking(current, request).work.lastBinCode).toBe('LEG0101A');
  });
  it('does not let an unavailable location source block resuming held work, or create a partial new claim', async () => {
    const { db, service } = routedSetup();
    const first = await claim(service);
    const broken = createPickWorkService({ db, listCandidates: async () => [order('l')],
      loadRouteBins: async () => { throw new Error('lookup failed'); } });
    expect((await claim(broken)).id).toBe(first.id);
    await expect(claim(broken, other, 'scanner-b')).rejects.toMatchObject({ status: 503, code: 'PICK_ROUTE_UNAVAILABLE' });
    expect(db.rows.get('orders/l').pickWork).toBeUndefined();
  });
});
