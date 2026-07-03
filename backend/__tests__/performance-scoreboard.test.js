'use strict';

/**
 * Mitarbeiter-Leistung (2026-07-04): per-user counts of erfasst / angereichert /
 * eingelagert / kommissioniert / verpackt. The aggregation is pure and tested
 * here; the Firestore reads are thin I/O around it. System/automatic actors are
 * never counted (they would distort the team numbers).
 */

const { aggregatePerformance } = require('../services/performance-scoreboard');

describe('aggregatePerformance', () => {
  it('counts each metric per user from the right source and ignores "system"', () => {
    const result = aggregatePerformance({
      auditLogs: [
        { action: 'product.identified', userId: 'u1' },   // erfasst
        { action: 'product.updated', userId: 'u1' },       // angereichert
        { action: 'product.created', userId: 'u2' },       // angereichert
        { action: 'product.identified', userId: 'system' },// ignored
        { action: 'something.else', userId: 'u1' },        // not a tracked metric
      ],
      orderEvents: [
        { toStatus: 'picked', actor: { uid: 'u1' } },      // kommissioniert
        { toStatus: 'picked', actor: { uid: 'u2' } },      // kommissioniert
        { toStatus: 'packed', actor: { uid: 'u1' } },      // verpackt
        { toStatus: 'shipped', actor: { uid: 'u1' } },     // not a tracked metric
      ],
      warehouseEvents: [
        { type: 'stock_in', meta: { actor: { uid: 'u2' } } },  // eingelagert
        { type: 'stock_out', meta: { actor: { uid: 'u2' } } }, // not eingelagert
        { type: 'stock_in', meta: { actor: { uid: 'system' } } }, // ignored
      ],
    });

    expect(result.u1).toEqual({ erfasst: 1, angereichert: 1, eingelagert: 0, kommissioniert: 1, verpackt: 1 });
    expect(result.u2).toEqual({ erfasst: 0, angereichert: 1, eingelagert: 1, kommissioniert: 1, verpackt: 0 });
    expect(result.system).toBeUndefined();
  });

  it('returns an empty object when there is nothing', () => {
    expect(aggregatePerformance({ auditLogs: [], orderEvents: [], warehouseEvents: [] })).toEqual({});
  });

  it('tolerates missing/partial records', () => {
    const result = aggregatePerformance({
      auditLogs: [{ action: 'product.updated' }], // no userId → skipped
      orderEvents: [{ toStatus: 'picked' }],       // no actor → skipped
      warehouseEvents: [{ type: 'stock_in' }],     // no meta.actor → skipped
    });
    expect(result).toEqual({});
  });
});
