'use strict';

const { sumProductLedger, stockLedgerEnabled } = require('../lib/stock-core');

function makeDb(eventsByProduct = {}, opts = {}) {
  return {
    collection(name) {
      if (name !== 'warehouseEvents') return { where: () => ({ select: () => ({ get: async () => ({ forEach: () => {} }) }) }) };
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
    },
  };
}

describe('stockLedgerEnabled', () => {
  const PREV = process.env.STOCK_LEDGER;
  afterEach(() => { if (PREV === undefined) delete process.env.STOCK_LEDGER; else process.env.STOCK_LEDGER = PREV; });
  it('is off by default, on only when explicitly true', () => {
    delete process.env.STOCK_LEDGER;
    expect(stockLedgerEnabled()).toBe(false);
    process.env.STOCK_LEDGER = 'true';
    expect(stockLedgerEnabled()).toBe(true);
    process.env.STOCK_LEDGER = 'false';
    expect(stockLedgerEnabled()).toBe(false);
  });
});

describe('sumProductLedger (Σ warehouseEvents.delta for a product)', () => {
  it('sums the signed deltas of the product events', async () => {
    const db = makeDb({ p1: [{ delta: 5 }, { delta: -2 }] });
    expect(await sumProductLedger({ productId: 'p1', firestore: db })).toBe(3);
  });

  it('returns 0 for a product with no events', async () => {
    expect(await sumProductLedger({ productId: 'pX', firestore: makeDb({}) })).toBe(0);
  });

  it('throws on read error so the caller can decide to fall back (no silent 0)', async () => {
    const db = makeDb({}, { throwOnRead: true });
    await expect(sumProductLedger({ productId: 'p1', firestore: db })).rejects.toThrow();
  });

  it('requires a productId', async () => {
    await expect(sumProductLedger({ firestore: makeDb({}) })).rejects.toThrow();
  });
});
