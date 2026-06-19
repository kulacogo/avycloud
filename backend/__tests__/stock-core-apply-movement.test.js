'use strict';

const { applyMovement, buildMovementEventId } = require('../lib/stock-core');

// Minimal in-memory Firestore-tx double. Docs keyed by `${collection}/${id}`.
function makeDb(initial = {}) {
  const docs = new Map(Object.entries(initial));
  const sideEffects = { sets: [], updates: [] };
  const ref = (collection, id) => ({ _path: `${collection}/${id}`, id });
  const db = {
    _docs: docs,
    _sideEffects: sideEffects,
    collection(name) {
      return { doc: (id) => ref(name, id) };
    },
    async runTransaction(fn) {
      const tx = {
        async get(r) {
          const d = docs.get(r._path);
          return { exists: d !== undefined, id: r.id, data: () => d };
        },
        set(r, data) { sideEffects.sets.push({ path: r._path, data }); docs.set(r._path, { ...data }); },
        update(r, data) { sideEffects.updates.push({ path: r._path, data }); docs.set(r._path, { ...(docs.get(r._path) || {}), ...data }); },
      };
      return fn(tx);
    },
  };
  return db;
}

const withStockLockPassthrough = async (_key, fn) => fn();

function deps(db, extra = {}) {
  return { firestore: db, withStockLock: withStockLockPassthrough, now: Date.parse('2026-06-19T12:00:00Z'), ...extra };
}

const PRODUCT = (inv) => ({ 'products_v2/p1': { tenantId: 'default', identification: { sku: 'SKU-1' }, inventory: inv } });

describe('applyMovement (single writer, dark — WP3)', () => {
  it('appends one event and advances the projection: onHand += delta', async () => {
    const db = makeDb(PRODUCT({ quantity: 5, onHand: 5, reserved: 0 }));
    const res = await applyMovement({ tenantId: 'default', productId: 'p1', delta: 3, type: 'stock_in', idempotencyKey: 'in:batch-1' }, deps(db));

    expect(res.applied).toBe(true);
    const prod = db._docs.get('products_v2/p1');
    expect(prod.inventory.onHand).toBe(8);
    expect(prod.inventory.quantity).toBe(8); // quantity is an alias of onHand
    expect(db._sideEffects.sets.length).toBe(1); // exactly one event written
  });

  it('writes the event under the deterministic idempotency id', async () => {
    const db = makeDb(PRODUCT({ quantity: 5, onHand: 5 }));
    await applyMovement({ tenantId: 'default', productId: 'p1', delta: 1, type: 'stock_in', idempotencyKey: 'k1' }, deps(db));
    const expectedId = buildMovementEventId({ tenantId: 'default', idempotencyKey: 'k1' });
    expect(db._docs.has(`warehouseEvents/${expectedId}`)).toBe(true);
  });

  it('is idempotent: the same idempotencyKey applied twice decrements only once', async () => {
    const db = makeDb(PRODUCT({ quantity: 10, onHand: 10 }));
    const mv = { tenantId: 'default', productId: 'p1', delta: -2, type: 'stock_out', idempotencyKey: 'ship:order-9:p1' };
    const first = await applyMovement(mv, deps(db));
    const second = await applyMovement(mv, deps(db));

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.reason).toBe('duplicate');
    expect(db._docs.get('products_v2/p1').inventory.onHand).toBe(8); // 10 - 2, once
    expect(db._sideEffects.sets.length).toBe(1);
  });

  it('computes availableToSell = max(0, onHand − reserved)', async () => {
    const db = makeDb(PRODUCT({ quantity: 5, onHand: 5, reserved: 4 }));
    await applyMovement({ tenantId: 'default', productId: 'p1', delta: 1, type: 'stock_in', idempotencyKey: 'k' }, deps(db));
    const inv = db._docs.get('products_v2/p1').inventory;
    expect(inv.onHand).toBe(6);
    expect(inv.availableToSell).toBe(2); // 6 - 4
  });

  it('never lets onHand go negative — rejects without writing', async () => {
    const db = makeDb(PRODUCT({ quantity: 1, onHand: 1 }));
    await expect(
      applyMovement({ tenantId: 'default', productId: 'p1', delta: -5, type: 'stock_out', idempotencyKey: 'over' }, deps(db))
    ).rejects.toThrow(/negative/i);
    // nothing written
    expect(db._sideEffects.sets.length).toBe(0);
    expect(db._docs.get('products_v2/p1').inventory.onHand).toBe(1);
  });

  it('runs under the stock lock with the product key', async () => {
    const db = makeDb(PRODUCT({ quantity: 5, onHand: 5 }));
    const seen = [];
    const lock = async (key, fn) => { seen.push(key); return fn(); };
    await applyMovement({ tenantId: 'default', productId: 'p1', delta: 1, type: 'stock_in', idempotencyKey: 'k' }, deps(db, { withStockLock: lock }));
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain('p1');
  });

  it('requires an explicit idempotencyKey', async () => {
    const db = makeDb(PRODUCT({ quantity: 5, onHand: 5 }));
    await expect(
      applyMovement({ tenantId: 'default', productId: 'p1', delta: 1, type: 'stock_in' }, deps(db))
    ).rejects.toThrow();
  });

  it('falls back to inventory.quantity when onHand is not yet present (legacy doc)', async () => {
    const db = makeDb(PRODUCT({ quantity: 7 })); // no onHand field
    await applyMovement({ tenantId: 'default', productId: 'p1', delta: 2, type: 'stock_in', idempotencyKey: 'k' }, deps(db));
    expect(db._docs.get('products_v2/p1').inventory.onHand).toBe(9);
  });
});
