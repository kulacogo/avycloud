'use strict';

const {
  computeOnHandFromEvents,
  computeAvailableToSell,
  buildMovementEventId,
  reconcileLedger,
} = require('../lib/stock-core');

describe('computeOnHandFromEvents (onHand = Σ warehouseEvents.delta)', () => {
  it('sums signed deltas', () => {
    expect(computeOnHandFromEvents([{ delta: 5 }, { delta: -2 }, { delta: 3 }])).toBe(6);
  });

  it('returns 0 for an empty/missing ledger', () => {
    expect(computeOnHandFromEvents([])).toBe(0);
    expect(computeOnHandFromEvents(null)).toBe(0);
    expect(computeOnHandFromEvents(undefined)).toBe(0);
  });

  it('treats non-numeric / missing delta as 0 (never NaN)', () => {
    expect(computeOnHandFromEvents([{ delta: 'x' }, { delta: 5 }, {}])).toBe(5);
    expect(Number.isNaN(computeOnHandFromEvents([{ delta: undefined }]))).toBe(false);
  });

  it('can represent a net-negative raw ledger (clamping is a write-time concern)', () => {
    expect(computeOnHandFromEvents([{ delta: -10 }])).toBe(-10);
  });
});

describe('computeAvailableToSell (never negative)', () => {
  it('subtracts allocated from onHand', () => {
    expect(computeAvailableToSell({ onHand: 10, allocated: 3 })).toBe(7);
  });

  it('clamps to 0 when allocated exceeds onHand', () => {
    expect(computeAvailableToSell({ onHand: 3, allocated: 5 })).toBe(0);
  });

  it('defaults allocated to 0', () => {
    expect(computeAvailableToSell({ onHand: 5 })).toBe(5);
  });

  it('tolerates missing/empty input', () => {
    expect(computeAvailableToSell({})).toBe(0);
    expect(computeAvailableToSell()).toBe(0);
  });
});

describe('buildMovementEventId (deterministic idempotency)', () => {
  it('is deterministic for the same tenant + idempotencyKey', () => {
    const a = buildMovementEventId({ tenantId: 'default', idempotencyKey: 'pick:order-1:prod-1' });
    const b = buildMovementEventId({ tenantId: 'default', idempotencyKey: 'pick:order-1:prod-1' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/); // sha1 hex
  });

  it('differs when the idempotencyKey differs', () => {
    const a = buildMovementEventId({ tenantId: 'default', idempotencyKey: 'pick:order-1:prod-1' });
    const b = buildMovementEventId({ tenantId: 'default', idempotencyKey: 'pick:order-2:prod-1' });
    expect(a).not.toBe(b);
  });

  it('differs when the tenant differs (no cross-tenant collision)', () => {
    const a = buildMovementEventId({ tenantId: 'default', idempotencyKey: 'k' });
    const b = buildMovementEventId({ tenantId: 'trendocean', idempotencyKey: 'k' });
    expect(a).not.toBe(b);
  });

  it('throws when idempotencyKey is missing (idempotency must be explicit)', () => {
    expect(() => buildMovementEventId({ tenantId: 'default' })).toThrow();
  });
});

describe('reconcileLedger (reports drift, never fixes)', () => {
  it('is in sync when projection equals Σ ledger', () => {
    const r = reconcileLedger({ events: [{ delta: 5 }, { delta: 1 }], projectionOnHand: 6 });
    expect(r.inSync).toBe(true);
    expect(r.diff).toBe(0);
    expect(r.ledgerOnHand).toBe(6);
    expect(r.projectionOnHand).toBe(6);
  });

  it('reports the signed drift (projection − ledger) when they disagree', () => {
    const r = reconcileLedger({ events: [{ delta: 5 }, { delta: 1 }], projectionOnHand: 8 });
    expect(r.inSync).toBe(false);
    expect(r.diff).toBe(2);
    expect(r.ledgerOnHand).toBe(6);
  });

  it('does not mutate the input events', () => {
    const events = [{ delta: 5 }];
    const copy = JSON.parse(JSON.stringify(events));
    reconcileLedger({ events, projectionOnHand: 99 });
    expect(events).toEqual(copy);
  });

  it('tolerates empty/missing input without throwing', () => {
    expect(reconcileLedger({ events: [], projectionOnHand: 0 }).inSync).toBe(true);
    expect(reconcileLedger({}).inSync).toBe(true); // ledger 0, projection 0
  });
});
