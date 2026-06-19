'use strict';

const { planLedgerCorrection, planCorrections } = require('../lib/stock-ledger-correction');

describe('planLedgerCorrection (adjust ledger → physical truth)', () => {
  it('proposes nothing when the ledger already matches the truth source (bins)', () => {
    const p = planLedgerCorrection({ productId: 'p1', ledgerOnHand: 5, binQuantity: 5, projectionOnHand: 5 });
    expect(p.needed).toBe(false);
  });

  it('proposes a negative adjust for ledger over-count (phantom sold stock)', () => {
    // ledger says 1, bins (physical) say 0 → book -1 to bring the ledger to truth.
    const p = planLedgerCorrection({ productId: 'p2', sku: 'SKU-2', ledgerOnHand: 1, binQuantity: 0, projectionOnHand: 0 });
    expect(p.needed).toBe(true);
    expect(p.target).toBe(0);
    expect(p.adjustDelta).toBe(-1);
    expect(p.type).toBe('adjust');
    expect(p.idempotencyKey).toBe('adjust:opening:p2');
  });

  it('proposes a positive adjust for bin-orphaned stock (real stock missing from ledger)', () => {
    const p = planLedgerCorrection({ productId: 'p3', ledgerOnHand: 0, binQuantity: 2, projectionOnHand: 0 });
    expect(p.needed).toBe(true);
    expect(p.target).toBe(2);
    expect(p.adjustDelta).toBe(2);
  });

  it('honours an explicit truthSource of projection', () => {
    const p = planLedgerCorrection({ productId: 'p4', ledgerOnHand: 6, binQuantity: 7, projectionOnHand: 8 }, { truthSource: 'projection' });
    expect(p.target).toBe(8);
    expect(p.adjustDelta).toBe(2); // 8 - 6
  });

  it('uses a deterministic idempotency key per product (safe to re-run)', () => {
    const a = planLedgerCorrection({ productId: 'pX', ledgerOnHand: 1, binQuantity: 0 });
    const b = planLedgerCorrection({ productId: 'pX', ledgerOnHand: 1, binQuantity: 0 });
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
  });
});

describe('planCorrections (batch plan + summary)', () => {
  it('plans only the rows that need correction and summarises the net delta', () => {
    const rows = [
      { productId: 'a', ledgerOnHand: 5, binQuantity: 5 },   // ok → skip
      { productId: 'b', ledgerOnHand: 1, binQuantity: 0 },   // -1
      { productId: 'c', ledgerOnHand: 0, binQuantity: 2 },   // +2
    ];
    const plan = planCorrections(rows);
    expect(plan.corrections).toHaveLength(2);
    expect(plan.summary.count).toBe(2);
    expect(plan.summary.totalNegativeAdjust).toBe(-1);
    expect(plan.summary.totalPositiveAdjust).toBe(2);
  });

  it('returns an empty plan for an all-in-sync set', () => {
    const plan = planCorrections([{ productId: 'a', ledgerOnHand: 3, binQuantity: 3 }]);
    expect(plan.corrections).toEqual([]);
    expect(plan.summary.count).toBe(0);
  });
});
