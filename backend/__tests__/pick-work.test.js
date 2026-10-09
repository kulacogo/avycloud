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
