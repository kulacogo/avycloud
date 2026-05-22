/**
 * order-status-helpers — pure-function tests for the HARDEN-Wave-7 consolidation.
 */

'use strict';

const {
  EXCLUDED_ORDER_STATUSES,
  SHIPPED_ORDER_STATUSES,
  RESERVED_ORDER_STATUSES,
  normalizeSkuKey,
  getOmsSortOrder,
  getOmsForwardRank,
  FORWARD_RANK_MAP,
} = require('../../lib/order-status-helpers');

describe('order-status-helpers: status sets', () => {
  it('EXCLUDED_ORDER_STATUSES contains cancelled and returned', () => {
    expect(EXCLUDED_ORDER_STATUSES.has('cancelled')).toBe(true);
    expect(EXCLUDED_ORDER_STATUSES.has('returned')).toBe(true);
    expect(EXCLUDED_ORDER_STATUSES.has('shipped')).toBe(false);
  });

  it('SHIPPED_ORDER_STATUSES contains shipped/delivered/completed', () => {
    expect(SHIPPED_ORDER_STATUSES.has('shipped')).toBe(true);
    expect(SHIPPED_ORDER_STATUSES.has('delivered')).toBe(true);
    expect(SHIPPED_ORDER_STATUSES.has('completed')).toBe(true);
    expect(SHIPPED_ORDER_STATUSES.has('cancelled')).toBe(false);
  });

  it('RESERVED_ORDER_STATUSES covers pre-shipment lifecycle', () => {
    for (const s of ['new', 'pending', 'confirmed', 'picking', 'picked', 'packing', 'packed', 'on_hold']) {
      expect(RESERVED_ORDER_STATUSES.has(s)).toBe(true);
    }
    expect(RESERVED_ORDER_STATUSES.has('shipped')).toBe(false);
  });
});

describe('order-status-helpers: normalizeSkuKey', () => {
  it('strips SKU prefix variants', () => {
    expect(normalizeSkuKey('SKU-1234')).toBe('1234');
    expect(normalizeSkuKey('sku_1234')).toBe('1234');
    expect(normalizeSkuKey('Sku 1234')).toBe('1234');
  });

  it('handles whitespace + lowercases', () => {
    expect(normalizeSkuKey('  AbC 9 9 9  ')).toBe('abc999');
  });

  it('returns empty string for null/undefined/empty', () => {
    expect(normalizeSkuKey(null)).toBe('');
    expect(normalizeSkuKey(undefined)).toBe('');
    expect(normalizeSkuKey('')).toBe('');
  });
});

describe('order-status-helpers: getOmsSortOrder', () => {
  it('returns monotonically increasing values for the pipeline', () => {
    const pending = getOmsSortOrder('pending');
    const picking = getOmsSortOrder('picking');
    const shipped = getOmsSortOrder('shipped');
    const delivered = getOmsSortOrder('delivered');
    expect(pending).toBeGreaterThanOrEqual(0);
    expect(picking).toBeGreaterThan(pending);
    expect(shipped).toBeGreaterThan(picking);
    expect(delivered).toBeGreaterThan(shipped);
  });

  it('returns -1 for unknown status', () => {
    expect(getOmsSortOrder('not-a-real-status')).toBe(-1);
  });
});

describe('order-status-helpers: getOmsForwardRank', () => {
  it('matches the inline statusOrder from the old webhooks.js (regression)', () => {
    // This MUST exactly match the inline map removed from routes/webhooks.js
    // — if anyone changes the helper, the webhook progression logic changes.
    expect(FORWARD_RANK_MAP).toEqual({
      pending: 0, confirmed: 1, picking: 2, picked: 3,
      packing: 4, packed: 5, shipped: 6, delivered: 7,
      completed: 8, returned: 9,
      on_hold: 98, cancelled: 99,
    });
  });

  it('terminal statuses (cancelled, on_hold) get high rank to block late webhook updates', () => {
    expect(getOmsForwardRank('cancelled')).toBeGreaterThan(getOmsForwardRank('delivered'));
    expect(getOmsForwardRank('on_hold')).toBeGreaterThan(getOmsForwardRank('delivered'));
  });

  it('returns -1 for unknown status (no fallback to 0)', () => {
    expect(getOmsForwardRank('foo')).toBe(-1);
  });
});
