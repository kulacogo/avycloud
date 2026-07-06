// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// REGRESSION GUARD — reserveStock muss idempotent BY CONSTRUCTION sein.
//
// Vorher: Query-then-Batch-Write. Zwei ueberlappende Order-Syncs (jede
// Web-Instanz triggert backgroundSyncOrders, dazu Worker-Cron + Event-Bus)
// sahen beide "keine Reservierung" → Duplikat-Reservierungen → availableQty
// faelschlich 0 → Zero-Stock-Push bis zum eBay-Listing-End.
// Seit Fix: deterministische Doc-IDs (tenant__order__sku) + batch.create();
// der zweite Schreiber verliert mit ALREADY_EXISTS und meldet skip.

function patchCjsModule(modulePath, mockExports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath, filename: resolvedPath, loaded: true,
    exports: mockExports, children: [], paths: [],
  };
}

const docsById = new Map(); // docId → data
const createCalls = [];
let queryResult = { empty: true, docs: [] };

const mockFirestore = {
  collection: vi.fn(() => ({
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    get: vi.fn(async () => queryResult),
    doc: vi.fn((id) => ({ id })),
  })),
  batch: vi.fn(() => {
    const pending = [];
    return {
      create: vi.fn((ref, data) => { pending.push({ ref, data }); }),
      set: vi.fn(),
      update: vi.fn(),
      commit: vi.fn(async () => {
        // Firestore-Semantik: create() wirft ALREADY_EXISTS wenn Doc existiert.
        for (const { ref } of pending) {
          if (docsById.has(ref.id)) {
            const err = new Error(`6 ALREADY_EXISTS: Document already exists: ${ref.id}`);
            err.code = 6;
            throw err;
          }
        }
        for (const { ref, data } of pending) {
          docsById.set(ref.id, data);
          createCalls.push({ id: ref.id, data });
        }
      }),
    };
  }),
};

patchCjsModule('../lib/firestore', { firestore: mockFirestore });

const { reserveStock } = require('../services/stock-reservation');

beforeEach(() => {
  docsById.clear();
  createCalls.length = 0;
  queryResult = { empty: true, docs: [] };
});

describe('reserveStock: idempotent by construction', () => {
  it('schreibt deterministische Doc-IDs pro (tenant, order, sku)', async () => {
    const result = await reserveStock({
      tenantId: 'default',
      orderId: 'ebay__123',
      items: [{ sku: 'SKU-A', quantity: 1 }, { sku: 'SKU-B', quantity: 2 }],
    });

    expect(result.reserved).toBe(true);
    expect(result.count).toBe(2);
    const ids = createCalls.map((c) => c.id).sort();
    expect(ids).toEqual(['default__ebay__123__sku_SKU-A', 'default__ebay__123__sku_SKU-B']);
  });

  it('aggregiert mehrere Positionen derselben SKU zu einem Doc', async () => {
    await reserveStock({
      tenantId: 'default',
      orderId: 'ebay__124',
      items: [{ sku: 'SKU-A', quantity: 1 }, { sku: 'SKU-A', quantity: 2 }],
    });

    expect(createCalls.length).toBe(1);
    expect(createCalls[0].data.quantity).toBe(3);
  });

  it('zweiter konkurrierender Aufruf erzeugt KEINE Duplikate (ALREADY_EXISTS → skip)', async () => {
    // Simuliert das Race: beide Aufrufer haben den leeren Query-Check schon
    // passiert (queryResult bleibt empty), der zweite kollidiert beim create.
    const first = await reserveStock({
      tenantId: 'default', orderId: 'ebay__125', items: [{ sku: 'SKU-A', quantity: 1 }],
    });
    const second = await reserveStock({
      tenantId: 'default', orderId: 'ebay__125', items: [{ sku: 'SKU-A', quantity: 1 }],
    });

    expect(first.reserved).toBe(true);
    expect(second.reserved).toBe(false);
    expect(second.skipped).toBe(true);
    expect(second.reason).toContain('already reserved');
    // Nur EIN Reservierungs-Doc existiert:
    expect(docsById.size).toBe(1);
  });

  it('sanitisiert Sonderzeichen in SKUs für die Doc-ID', async () => {
    await reserveStock({
      tenantId: 'default', orderId: 'ebay__126', items: [{ sku: 'SKU A/B#1', quantity: 1 }],
    });
    expect(createCalls[0].id).not.toMatch(/[\/#?%\s]/);
  });

  it('Fast-path: existierende Reservierung → skip ohne Write', async () => {
    queryResult = { empty: false, docs: [{ id: 'x' }] };
    const result = await reserveStock({
      tenantId: 'default', orderId: 'ebay__127', items: [{ sku: 'SKU-A', quantity: 1 }],
    });
    expect(result.skipped).toBe(true);
    expect(createCalls.length).toBe(0);
  });

  it('andere Commit-Fehler werden weitergeworfen (kein silent-skip)', async () => {
    mockFirestore.batch.mockImplementationOnce(() => ({
      create: vi.fn(),
      commit: vi.fn(async () => { throw new Error('DEADLINE_EXCEEDED'); }),
    }));
    await expect(reserveStock({
      tenantId: 'default', orderId: 'ebay__128', items: [{ sku: 'SKU-A', quantity: 1 }],
    })).rejects.toThrow('DEADLINE_EXCEEDED');
  });
});
