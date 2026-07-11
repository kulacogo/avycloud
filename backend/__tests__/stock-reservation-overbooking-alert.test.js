// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// REGRESSION GUARD — Oversell-Incident 2026-07-11 (SKU-2510094553):
//
// Zwei Kaufland-Bestellungen (je 1 Stück) trafen auf physisch 1 Stück Lager.
// Beide Reservierungen wurden STUMM angelegt (2 reserviert > 1 physisch) —
// kein Alarm, der Konflikt wäre erst beim Picken aufgefallen. Bezahlte
// Marktplatz-Orders MÜSSEN reserviert werden (ablehnen geht nicht), aber die
// Überbuchung muss sofort einen kritischen Ops-Alert auslösen.

function patchCjsModule(modulePath, mockExports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath, filename: resolvedPath, loaded: true,
    exports: mockExports, children: [], paths: [],
  };
}

// ─── Collection-bewusster Firestore-Mock ────────────────────────────────────
// stock_reservations: create()-Semantik + query nach sku/status
// products_v2: query nach identification.sku
const reservationDocs = new Map(); // docId → data
let productQueryResult = { empty: true, docs: [] };

function reservationQueryResult(filters) {
  const docs = [...reservationDocs.values()]
    .filter((d) => Object.entries(filters).every(([field, value]) => d[field] === value))
    .map((d) => ({ data: () => d }));
  return { empty: docs.length === 0, docs };
}

const mockFirestore = {
  collection: vi.fn((name) => {
    if (name === 'products_v2') {
      const chain = {
        where: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        get: async () => productQueryResult,
        doc: vi.fn(() => ({ get: async () => ({ exists: false }) })),
      };
      return chain;
    }
    // stock_reservations
    const filters = {};
    const chain = {
      where: vi.fn((field, _op, value) => { filters[field] = value; return chain; }),
      limit: vi.fn(() => chain),
      get: async () => reservationQueryResult(filters),
      doc: vi.fn((id) => ({ id })),
    };
    return chain;
  }),
  batch: vi.fn(() => {
    const pending = [];
    return {
      create: vi.fn((ref, data) => { pending.push({ ref, data }); }),
      commit: vi.fn(async () => {
        for (const { ref, data } of pending) reservationDocs.set(ref.id, data);
      }),
    };
  }),
};

const opsAlerts = [];
patchCjsModule('../lib/firestore', { firestore: mockFirestore });
patchCjsModule('../lib/ops-alert', { emitOpsAlert: vi.fn((a) => { opsAlerts.push(a); }) });

const { reserveStock } = require('../services/stock-reservation');

function productWithStock(quantity) {
  return {
    empty: false,
    docs: [{ id: 'prod-ob-1', data: () => ({ inventory: { quantity }, identification: { sku: 'SKU-OB-1' } }) }],
  };
}

describe('reserveStock — Überbuchungs-Alarm', () => {
  beforeEach(() => {
    reservationDocs.clear();
    opsAlerts.length = 0;
    productQueryResult = { empty: true, docs: [] };
  });

  it('zweite Reservierung über den physischen Bestand → overbooked:true + kritischer Ops-Alert', async () => {
    productQueryResult = productWithStock(1);

    const r1 = await reserveStock({ tenantId: 'default', orderId: 'kaufland__A1', items: [{ sku: 'SKU-OB-1', quantity: 1 }] });
    expect(r1.reserved).toBe(true);
    expect(r1.overbooked).toBe(false);
    expect(opsAlerts.length).toBe(0);

    const r2 = await reserveStock({ tenantId: 'default', orderId: 'kaufland__A2', items: [{ sku: 'SKU-OB-1', quantity: 1 }] });
    expect(r2.reserved).toBe(true);
    expect(r2.overbooked).toBe(true);
    expect(opsAlerts.length).toBe(1);
    expect(opsAlerts[0].severity).toBe('critical');
    expect(opsAlerts[0].message).toContain('ÜBERBUCHUNG');
    expect(opsAlerts[0].message).toContain('SKU-OB-1');
    expect(opsAlerts[0].context).toMatchObject({ sku: 'SKU-OB-1', physicalQty: 1, reservedQty: 2 });
  });

  it('ausreichender Bestand → kein Alarm', async () => {
    productQueryResult = productWithStock(5);
    const r = await reserveStock({ tenantId: 'default', orderId: 'kaufland__B1', items: [{ sku: 'SKU-OB-1', quantity: 2 }] });
    expect(r.reserved).toBe(true);
    expect(r.overbooked).toBe(false);
    expect(opsAlerts.length).toBe(0);
  });

  it('Produkt nicht auffindbar → keine Aussage möglich, kein Alarm, kein Crash', async () => {
    productQueryResult = { empty: true, docs: [] };
    const r = await reserveStock({ tenantId: 'default', orderId: 'kaufland__C1', items: [{ sku: 'SKU-UNBEKANNT', quantity: 3 }] });
    expect(r.reserved).toBe(true);
    expect(r.overbooked).toBe(false);
    expect(opsAlerts.length).toBe(0);
  });
});
