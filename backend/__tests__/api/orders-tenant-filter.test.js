// globals: true in vitest.config.js — describe/it/expect are global
//
// Unit test for the tenant-scoping filter behind GET /api/orders.
// Guards against the cross-tenant order/PII leak: listOrders must only return
// rows belonging to the caller's tenant, treating legacy (missing tenantId)
// rows as 'default'.

require('./_patchGcp'); // mock GCP so lib/firestore can load without credentials
const { filterOrdersByTenant } = require('../../lib/firestore');

const rows = [
  { id: 'a', tenantId: 'default', orderId: 'AVY-1' },
  { id: 'b', tenantId: 'trendocean', orderId: 'TO-1' },
  { id: 'c', orderId: 'LEGACY-1' }, // no tenantId → treated as 'default'
  { id: 'd', tenantId: 'default', orderId: 'AVY-2' },
  { id: 'e', tenantId: 'trendocean', orderId: 'TO-2' },
];

describe('filterOrdersByTenant', () => {
  it('returns only the caller tenant\'s rows', () => {
    const out = filterOrdersByTenant(rows, 'default', 50);
    expect(out.map((r) => r.id)).toEqual(['a', 'c', 'd']); // incl. legacy 'c'
  });

  it('does not leak other tenants', () => {
    const out = filterOrdersByTenant(rows, 'trendocean', 50);
    expect(out.map((r) => r.id)).toEqual(['b', 'e']);
    expect(out.some((r) => r.id === 'c')).toBe(false); // legacy never leaks to non-default
  });

  it('treats missing tenantId as default', () => {
    const out = filterOrdersByTenant([{ id: 'x', orderId: 'L' }], 'default', 50);
    expect(out).toHaveLength(1);
  });

  it('respects the requested count (preserving input order)', () => {
    const out = filterOrdersByTenant(rows, 'default', 2);
    expect(out.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('is defensive against non-array / empty input', () => {
    expect(filterOrdersByTenant(null, 'default', 10)).toEqual([]);
    expect(filterOrdersByTenant([], 'default', 10)).toEqual([]);
  });
});
