'use strict';

const { buildAuditRow, summarizeAudit } = require('../lib/stock-audit');

describe('buildAuditRow (read-only 3-source reconcile)', () => {
  it('is in sync when projection, ledger and bins all agree', () => {
    const row = buildAuditRow({ productId: 'p1', sku: 'SKU-1', projectionOnHand: 5, events: [{ delta: 5 }], binQuantity: 5 });
    expect(row.ledgerOnHand).toBe(5);
    expect(row.inSync).toBe(true);
    expect(row.severity).toBe('ok');
    expect(row.flags).toEqual([]);
  });

  it('flags the dangerous zeroing case (projection 0 but stock elsewhere) as MAJOR', () => {
    const row = buildAuditRow({ productId: 'p2', sku: 'SKU-2', projectionOnHand: 0, events: [{ delta: 3 }], binQuantity: 3 });
    expect(row.ledgerOnHand).toBe(3);
    expect(row.severity).toBe('major');
    expect(row.flags).toContain('projection-zero-but-stock-elsewhere');
    expect(row.inSync).toBe(false);
  });

  it('flags an empty ledger when stock exists in projection/bins (minor)', () => {
    const row = buildAuditRow({ productId: 'p3', sku: 'SKU-3', projectionOnHand: 5, events: [], binQuantity: 5 });
    expect(row.ledgerOnHand).toBe(0);
    expect(row.flags).toContain('ledger-empty');
    expect(row.flags).toContain('bin-ledger-mismatch');
    expect(row.severity).toBe('minor');
  });

  it('computes signed diffs across all three sources', () => {
    const row = buildAuditRow({ productId: 'p4', projectionOnHand: 8, events: [{ delta: 6 }], binQuantity: 7 });
    expect(row.projVsLedger).toBe(2);   // 8 - 6
    expect(row.binVsLedger).toBe(1);    // 7 - 6
    expect(row.binVsProjection).toBe(-1); // 7 - 8
    expect(row.flags).toContain('bin-ledger-mismatch');
    expect(row.flags).toContain('projection-ledger-mismatch');
  });

  it('is read-only: never throws on sparse input and defaults missing sources to 0', () => {
    const row = buildAuditRow({ productId: 'p5' });
    expect(row.ledgerOnHand).toBe(0);
    expect(row.projectionOnHand).toBe(0);
    expect(row.binQuantity).toBe(0);
    expect(row.inSync).toBe(true);
    expect(row.severity).toBe('ok');
  });
});

describe('summarizeAudit', () => {
  it('counts rows by severity and aggregates flags', () => {
    const rows = [
      buildAuditRow({ productId: 'a', projectionOnHand: 5, events: [{ delta: 5 }], binQuantity: 5 }),  // ok
      buildAuditRow({ productId: 'b', projectionOnHand: 0, events: [{ delta: 3 }], binQuantity: 3 }),  // major
      buildAuditRow({ productId: 'c', projectionOnHand: 5, events: [], binQuantity: 5 }),              // minor
      buildAuditRow({ productId: 'd', projectionOnHand: 0, events: [], binQuantity: 2 }),              // major
    ];
    const s = summarizeAudit(rows);
    expect(s.total).toBe(4);
    expect(s.ok).toBe(1);
    expect(s.major).toBe(2);
    expect(s.minor).toBe(1);
    expect(s.byFlag['projection-zero-but-stock-elsewhere']).toBe(2);
  });

  it('handles an empty audit', () => {
    const s = summarizeAudit([]);
    expect(s.total).toBe(0);
    expect(s.ok).toBe(0);
    expect(s.byFlag).toEqual({});
  });
});
