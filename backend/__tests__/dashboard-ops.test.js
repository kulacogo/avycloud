/**
 * Unit tests for the operational dashboard aggregator (counts, not euros).
 *
 * Reliability is the whole point of this feature, so the counting logic lives in
 * a PURE function that we can pin down with fixtures and a fixed `now` — no
 * Firestore, no clock flakiness. The thin Firestore wrapper around it is not
 * exercised here (it is pure I/O).
 */
const { aggregateOperationalMetrics, resolveRange } = require('../lib/dashboard-ops');

// Fixed reference clock: 2026-06-22 12:00 UTC.
const NOW = new Date('2026-06-22T12:00:00Z');
// Window = June 2026 (inclusive of today).
const RANGE_START = new Date('2026-06-01T00:00:00Z');
const RANGE_END_EXCLUSIVE = new Date('2026-06-23T00:00:00Z');

const ORDERS = [
  // o1: eBay, imported but NOT yet released (pending), created in window, 2 units.
  // Pending orders are not pickable yet, so they must NOT count as waiting_picking.
  { id: 'o1', marketplace: 'ebay', omsStatus: 'pending', createdAt: '2026-06-20T10:00:00Z', items: [{ quantity: 2 }] },
  // o2: Kaufland, picked (in progress), created in window, 4 units
  { id: 'o2', marketplace: 'kaufland', omsStatus: 'picked', createdAt: '2026-06-21T10:00:00Z', pickedAt: '2026-06-21T11:00:00Z', items: [{ quantity: 1 }, { quantity: 3 }] },
  // o3: eBay, shipped TODAY, created in window, 1 unit
  { id: 'o3', marketplace: 'ebay', omsStatus: 'shipped', createdAt: '2026-06-19T10:00:00Z', shippedAt: '2026-06-22T08:00:00Z', items: [{ quantity: 1 }] },
  // o4: eBay, shipped YESTERDAY (not today), created in window, 1 unit
  { id: 'o4', marketplace: 'ebay', omsStatus: 'shipped', createdAt: '2026-06-10T10:00:00Z', shippedAt: '2026-06-21T08:00:00Z', items: [{ quantity: 1 }] },
  // o5: Kaufland, cancelled in window — counts as storno, not as order/units
  { id: 'o5', marketplace: 'kaufland', omsStatus: 'cancelled', createdAt: '2026-06-15T10:00:00Z', items: [{ quantity: 5 }] },
  // o6: eBay, confirmed (waiting), but created BEFORE the window — live counts it, window does not
  { id: 'o6', marketplace: 'ebay', omsStatus: 'confirmed', createdAt: '2026-05-30T10:00:00Z', items: [{ quantity: 1 }] },
];

const RETURNS = [
  // ebay return inside the window
  { marketplace: 'ebay', createdAt: '2026-06-18T10:00:00Z', refundAmount: 20 },
  // kaufland return before the window — excluded
  { marketplace: 'kaufland', createdAt: '2026-05-01T10:00:00Z', refundAmount: 10 },
];

function run() {
  return aggregateOperationalMetrics({
    orders: ORDERS,
    returns: RETURNS,
    rangeStart: RANGE_START,
    rangeEndExclusive: RANGE_END_EXCLUSIVE,
    now: NOW,
  });
}

describe('aggregateOperationalMetrics — live operational counts (current state, not windowed)', () => {
  it('counts ONLY confirmed orders waiting for picking, regardless of order date', () => {
    // o6 (confirmed, BEFORE window) = 1. o1 (pending) is imported but not yet
    // released by the marketplace, so it is excluded from the pick backlog.
    expect(run().live.waiting_picking).toBe(1);
  });

  it('excludes pending/unconfirmed orders from the picking backlog', () => {
    const orders = [
      { id: 'p1', omsStatus: 'pending', createdAt: '2026-06-20T10:00:00Z', items: [{ quantity: 1 }] },
      { id: 'p2', omsStatus: 'pending', createdAt: '2025-12-10T10:00:00Z', items: [{ quantity: 1 }] },
    ];
    const r = aggregateOperationalMetrics({ orders, returns: [], rangeStart: RANGE_START, rangeEndExclusive: RANGE_END_EXCLUSIVE, now: NOW });
    expect(r.live.waiting_picking).toBe(0);
  });

  it('counts in-progress orders (picked/packed, not yet shipped)', () => {
    // o2 (picked) = 1
    expect(run().live.in_progress).toBe(1);
  });

  it('counts only orders shipped today via shippedAt', () => {
    // o3 shipped today; o4 shipped yesterday -> excluded
    expect(run().live.shipped_today).toBe(1);
  });
});

describe('aggregateOperationalMetrics — windowed marketplace breakdown', () => {
  it('counts non-cancelled orders per marketplace by createdAt in window', () => {
    const mp = run().window.marketplaces;
    // ebay: o1, o3, o4 (o6 is before window) = 3
    expect(mp.ebay.orders).toBe(3);
    // kaufland: o2 (o5 cancelled, excluded from orders) = 1
    expect(mp.kaufland.orders).toBe(1);
    expect(mp.other.orders).toBe(0);
  });

  it('sums sold units per marketplace, excluding cancelled orders', () => {
    const mp = run().window.marketplaces;
    expect(mp.ebay.units).toBe(4); // 2 + 1 + 1
    expect(mp.kaufland.units).toBe(4); // 1 + 3
  });

  it('counts cancellations per marketplace within the window', () => {
    const mp = run().window.marketplaces;
    expect(mp.kaufland.cancellations).toBe(1); // o5
    expect(mp.ebay.cancellations).toBe(0);
  });

  it('counts returns per marketplace from the returns collection within the window', () => {
    const mp = run().window.marketplaces;
    expect(mp.ebay.returns).toBe(1); // one ebay return in window
    expect(mp.kaufland.returns).toBe(0); // kaufland return is before window
  });

  it('provides a combined total across marketplaces', () => {
    const total = run().window.marketplaces.total;
    expect(total.orders).toBe(4); // o1, o2, o3, o4
    expect(total.units).toBe(8); // 4 ebay + 4 kaufland
    expect(total.cancellations).toBe(1);
    expect(total.returns).toBe(1);
  });
});

describe('resolveRange — preset → date window (UTC)', () => {
  it('today: from UTC midnight to now', () => {
    const r = resolveRange({ preset: 'today', now: NOW });
    expect(r.rangeStart.toISOString()).toBe('2026-06-22T00:00:00.000Z');
    expect(r.rangeEndExclusive.toISOString()).toBe(NOW.toISOString());
  });

  it('last7: 7 calendar days inclusive of today', () => {
    const r = resolveRange({ preset: 'last7', now: NOW });
    expect(r.rangeStart.toISOString()).toBe('2026-06-16T00:00:00.000Z');
  });

  it('month_to_date: from the 1st of the current month', () => {
    const r = resolveRange({ preset: 'month_to_date', now: NOW });
    expect(r.rangeStart.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('custom: honours from/to with exclusive end of the to-day', () => {
    const r = resolveRange({ preset: 'custom', fromDate: '2026-06-01', toDate: '2026-06-22', now: NOW });
    expect(r.rangeStart.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(r.rangeEndExclusive.toISOString()).toBe('2026-06-23T00:00:00.000Z');
  });

  it('falls back to last7 semantics for an unknown preset', () => {
    const r = resolveRange({ preset: 'nonsense', now: NOW });
    expect(r.rangeStart.toISOString()).toBe('2026-06-16T00:00:00.000Z');
  });
});

describe('aggregateOperationalMetrics — authoritative status counts (full collection, current state)', () => {
  it('counts every order by its current OMS status', () => {
    const sc = run().statusCounts;
    expect(sc.pending).toBe(1);
    expect(sc.confirmed).toBe(1);
    expect(sc.picked).toBe(1);
    expect(sc.shipped).toBe(2);
    expect(sc.cancelled).toBe(1);
    expect(sc.total).toBe(6);
  });
});
