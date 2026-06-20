'use strict';

const { applyLedgerCorrection } = require('../lib/stock-ledger-correction');
const { buildMovementEventId } = require('../lib/stock-core');

// In-memory Firestore-tx double (docs keyed by `${collection}/${id}`).
function makeDb(initial = {}) {
  const docs = new Map(Object.entries(initial));
  const sets = [];
  const updates = [];
  const ref = (c, id) => ({ _path: `${c}/${id}`, id });
  return {
    _docs: docs, _sets: sets, _updates: updates,
    collection: (name) => ({ doc: (id) => ref(name, id) }),
    runTransaction: async (fn) => fn({
      get: async (r) => ({ exists: docs.has(r._path), id: r.id, data: () => docs.get(r._path) }),
      set: (r, data) => { sets.push({ path: r._path, data }); docs.set(r._path, { ...data }); },
      update: (r, data) => { updates.push({ path: r._path, data }); docs.set(r._path, { ...(docs.get(r._path) || {}), ...data }); },
    }),
  };
}

const deps = (db) => ({ firestore: db, now: Date.parse('2026-06-20T21:00:00Z') });

describe('applyLedgerCorrection (ledger-only adjust, idempotent)', () => {
  it('appends an adjust event with the given delta and does NOT touch the projection', async () => {
    const db = makeDb({ 'products_v2/p1': { inventory: { quantity: 0 } } });
    const r = await applyLedgerCorrection({ tenantId: 'default', productId: 'p1', adjustDelta: -1, target: 0, idempotencyKey: 'adjust:opening:p1' }, deps(db));

    expect(r.applied).toBe(true);
    expect(db._sets.length).toBe(1);
    const ev = db._sets[0].data;
    expect(ev.type).toBe('adjust');
    expect(ev.delta).toBe(-1);
    expect(ev.productId).toBe('p1');
    // projection untouched — no update to products_v2
    expect(db._updates.length).toBe(0);
    expect(db._docs.get('products_v2/p1').inventory.quantity).toBe(0);
  });

  it('writes the event under the deterministic adjust:opening key', async () => {
    const db = makeDb({});
    await applyLedgerCorrection({ tenantId: 'default', productId: 'p2', adjustDelta: 1, target: 1, idempotencyKey: 'adjust:opening:p2' }, deps(db));
    const id = buildMovementEventId({ tenantId: 'default', idempotencyKey: 'adjust:opening:p2' });
    expect(db._docs.has(`warehouseEvents/${id}`)).toBe(true);
  });

  it('is idempotent: applying the same correction twice writes only one event', async () => {
    const db = makeDb({});
    const mv = { tenantId: 'default', productId: 'p3', adjustDelta: -2, target: 0, idempotencyKey: 'adjust:opening:p3' };
    const a = await applyLedgerCorrection(mv, deps(db));
    const b = await applyLedgerCorrection(mv, deps(db));
    expect(a.applied).toBe(true);
    expect(b.applied).toBe(false);
    expect(b.reason).toBe('duplicate');
    expect(db._sets.length).toBe(1);
  });

  it('is a no-op when adjustDelta is 0 (nothing to correct)', async () => {
    const db = makeDb({});
    const r = await applyLedgerCorrection({ tenantId: 'default', productId: 'p4', adjustDelta: 0, target: 1, idempotencyKey: 'adjust:opening:p4' }, deps(db));
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('noop');
    expect(db._sets.length).toBe(0);
  });

  it('refuses a correction whose target would be negative (safety)', async () => {
    const db = makeDb({});
    await expect(
      applyLedgerCorrection({ tenantId: 'default', productId: 'p5', adjustDelta: -5, target: -3, idempotencyKey: 'k' }, deps(db))
    ).rejects.toThrow(/negative/i);
    expect(db._sets.length).toBe(0);
  });

  it('requires productId and idempotencyKey', async () => {
    const db = makeDb({});
    await expect(applyLedgerCorrection({ tenantId: 'default', adjustDelta: 1, idempotencyKey: 'k' }, deps(db))).rejects.toThrow();
    await expect(applyLedgerCorrection({ tenantId: 'default', productId: 'p', adjustDelta: 1 }, deps(db))).rejects.toThrow();
  });
});
