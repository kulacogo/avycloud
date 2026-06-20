'use strict';

const { recordLedgerShadowDiff, ledgerShadowEnabled } = require('../lib/stock-ledger-shadow');

// In-memory firestore double: warehouseEvents query + stock_ledger_shadow add.
function makeDb(eventsByProduct = {}, opts = {}) {
  const shadowWrites = [];
  return {
    shadowWrites,
    collection(name) {
      if (name === 'warehouseEvents') {
        let pid = null;
        const chain = {
          where(field, _op, value) { if (field === 'productId') pid = value; return chain; },
          select() { return chain; },
          async get() {
            if (opts.throwOnRead) throw new Error('UNAVAILABLE');
            const evs = eventsByProduct[pid] || [];
            return { forEach: (cb) => evs.forEach((e) => cb({ data: () => e })) };
          },
        };
        return chain;
      }
      if (name === 'stock_ledger_shadow') {
        return { add: async (doc) => { shadowWrites.push(doc); } };
      }
      return { add: async () => {} };
    },
  };
}

describe('ledgerShadowEnabled', () => {
  const PREV = process.env.STOCK_LEDGER_SHADOW;
  afterEach(() => { if (PREV === undefined) delete process.env.STOCK_LEDGER_SHADOW; else process.env.STOCK_LEDGER_SHADOW = PREV; });

  it('is off by default and on only when explicitly true', () => {
    delete process.env.STOCK_LEDGER_SHADOW;
    expect(ledgerShadowEnabled()).toBe(false);
    process.env.STOCK_LEDGER_SHADOW = 'true';
    expect(ledgerShadowEnabled()).toBe(true);
    process.env.STOCK_LEDGER_SHADOW = 'false';
    expect(ledgerShadowEnabled()).toBe(false);
  });
});

describe('recordLedgerShadowDiff (observe only, never mutate)', () => {
  it('is in sync (no shadow write) when Σ warehouseEvents == projection', async () => {
    const db = makeDb({ p1: [{ delta: 3 }, { delta: 2 }] }); // Σ = 5
    const rec = await recordLedgerShadowDiff({ productId: 'p1', projectionAfter: 5 }, { firestore: db });
    expect(rec.inSync).toBe(true);
    expect(rec.diff).toBe(0);
    expect(db.shadowWrites.length).toBe(0); // nothing logged when clean
  });

  it('records the signed diff to stock_ledger_shadow when projection ≠ Σ ledger', async () => {
    const db = makeDb({ p2: [{ delta: 1 }] }); // ledger 1
    const rec = await recordLedgerShadowDiff({ productId: 'p2', sku: 'SKU-2', projectionAfter: 0, now: 1750000000000 }, { firestore: db });
    expect(rec.inSync).toBe(false);
    expect(rec.ledgerOnHand).toBe(1);
    expect(rec.projectionOnHand).toBe(0);
    expect(rec.diff).toBe(-1);
    expect(db.shadowWrites.length).toBe(1);
    expect(db.shadowWrites[0]).toMatchObject({ productId: 'p2', sku: 'SKU-2', diff: -1, ledgerOnHand: 1, projectionOnHand: 0 });
  });

  it('returns null and never throws when the events read fails (must not break the caller)', async () => {
    const db = makeDb({}, { throwOnRead: true });
    await expect(recordLedgerShadowDiff({ productId: 'p3', projectionAfter: 5 }, { firestore: db })).resolves.toBeNull();
  });

  it('ignores a missing productId', async () => {
    const db = makeDb({});
    expect(await recordLedgerShadowDiff({ projectionAfter: 5 }, { firestore: db })).toBeNull();
  });
});
