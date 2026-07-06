/**
 * buildOrderQuantityMaps — ein Orders-Scan statt zwei, mit Projektion.
 *
 * Semantik-Guard: reserved zählt nur Orders des Tenants in offenen Status,
 * sold zählt (wie vorher) tenant-übergreifend alle nicht-terminalen/
 * versendeten Orders. Und: die Query MUSS .select() nutzen, damit die
 * fetten raw-Payloads nicht mehr pro Produktlisten-Request geladen werden.
 */

const request = require('supertest');

require('./_patchGcp');
require('./_patchLocalModules');
const { spies: firebaseSpies } = require('./_setupMocks');

// firestore-Mock mit kontrollierbarem orders-Scan
const selectCalls = [];
let orderDocs = [];
const firestoreLib = require('../../lib/firestore');
const realCollection = firestoreLib.firestore.collection;
firestoreLib.firestore.collection = (name) => {
  if (name === 'orders') {
    const chain = {
      select: (...fields) => { selectCalls.push(fields); return chain; },
      where: () => chain,
      get: async () => ({
        forEach: (cb) => orderDocs.forEach((d) => cb({ data: () => d })),
      }),
    };
    return chain;
  }
  return realCollection.call(firestoreLib.firestore, name);
};

const { buildOrderQuantityMaps } = require('../../routes/products');

describe('buildOrderQuantityMaps', () => {
  beforeEach(() => {
    orderDocs = [];
    selectCalls.length = 0;
  });

  it('nutzt Projektion (select) — keine raw-Payloads mehr', async () => {
    await buildOrderQuantityMaps('default');
    expect(selectCalls.length).toBe(1);
    expect(selectCalls[0]).toEqual(expect.arrayContaining(['omsStatus', 'status', 'items', 'tenantId']));
  });

  it('reserved: nur offene Orders des Tenants; sold: shipped zählt als verkauft', async () => {
    orderDocs = [
      { tenantId: 'default', omsStatus: 'confirmed', items: [{ sku: 'SKU-A', quantity: 2 }] },
      { tenantId: 'default', omsStatus: 'shipped', items: [{ sku: 'SKU-A', quantity: 1 }] },
      { tenantId: 'default', omsStatus: 'cancelled', items: [{ sku: 'SKU-A', quantity: 5 }] },
      // Legacy-Doc ohne tenantId: zählt für sold (wie vorher), nicht für reserved
      { omsStatus: 'shipped', items: [{ sku: 'SKU-A', quantity: 3 }] },
      // Fremd-Tenant offene Order: nicht reserved für 'default'
      { tenantId: 'other', omsStatus: 'confirmed', items: [{ sku: 'SKU-A', quantity: 7 }] },
    ];

    const { reservedMap, soldMap } = await buildOrderQuantityMaps('default');

    expect(reservedMap.get('a')).toBe(2);
    const sold = soldMap.get('a');
    expect(sold.sold).toBe(1 + 3);      // beide shipped-Orders
    expect(sold.open).toBe(2 + 7);      // offene Orders tenant-übergreifend (wie vorher)
  });

  it('cancelled/returned zählen weder reserved noch sold', async () => {
    orderDocs = [
      { tenantId: 'default', omsStatus: 'cancelled', items: [{ sku: 'SKU-B', quantity: 4 }] },
      { tenantId: 'default', omsStatus: 'returned', items: [{ sku: 'SKU-B', quantity: 2 }] },
    ];
    const { reservedMap, soldMap } = await buildOrderQuantityMaps('default');
    expect(reservedMap.size).toBe(0);
    expect(soldMap.size).toBe(0);
  });
});
