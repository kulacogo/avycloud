// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// REGRESSION GUARD — Incident 2026-07-19 (SKU-6656556112).
//
// Der Pick dekrementierte `inventory.quantity`, aber die Reservierung der
// Order blieb bis zum Versand-Scan `status='reserved'` — dieselbe Einheit
// zählte in `available = physisch − reserviert` DOPPELT. Beim Last-Unit-Pick
// fiel available fälschlich auf 0 und der Stock-Sync beendete das eBay-Listing
// (EndFixedPriceItem/NotAvailable), obwohl 1 Einheit verkäuflich war.
//
// Fix: consumeReservationOnPick() senkt die Reservierungs-Obligation um die
// gepickte Menge; erreicht sie 0, wird die Reservierung 'confirmed'
// (confirmedBy 'pick'). Eine Einheit zählt zu jedem Zeitpunkt GENAU EINMAL.

function makeFirestoreMock(reservationDocs) {
  const updates = [];
  const docs = reservationDocs.map((data, i) => {
    const ref = { _idx: i };
    return {
      id: `res-${i}`,
      ref,
      data: () => ({ ...data }),
    };
  });

  const chain = {
    where: vi.fn(() => chain),
    get: async () => ({ empty: docs.length === 0, docs }),
  };

  const firestore = {
    collection: vi.fn(() => chain),
    runTransaction: async (fn) => {
      const tx = {
        get: async (ref) => {
          const doc = docs[ref._idx];
          return { exists: true, data: () => ({ ...reservationDocs[ref._idx] }) };
        },
        update: (ref, payload) => {
          updates.push({ idx: ref._idx, payload });
          Object.assign(reservationDocs[ref._idx], payload);
        },
      };
      return fn(tx);
    },
  };
  return { firestore, updates };
}

function loadWithMock(firestore) {
  const fsPath = require.resolve('../lib/firestore');
  delete require.cache[require.resolve('../services/stock-reservation')];
  require.cache[fsPath] = {
    id: fsPath, filename: fsPath, loaded: true,
    exports: { firestore },
    children: [], paths: [],
  };
  return require('../services/stock-reservation');
}

describe('consumeReservationOnPick — Doppelzählungs-Fix (Incident 2026-07-19)', () => {
  afterEach(() => {
    delete require.cache[require.resolve('../services/stock-reservation')];
    delete require.cache[require.resolve('../lib/firestore')];
  });

  it('schließt die Reservierung beim Pick der vollen Menge (status → confirmed by pick)', async () => {
    const resDocs = [{ orderId: 'ebay__20-14894-78016', sku: 'SKU-6656556112', quantity: 1, status: 'reserved' }];
    const { firestore, updates } = makeFirestoreMock(resDocs);
    const { consumeReservationOnPick } = loadWithMock(firestore);

    const result = await consumeReservationOnPick({
      tenantId: 'default',
      orderId: 'ebay__20-14894-78016',
      sku: 'SKU-6656556112',
      quantity: 1,
    });

    expect(result.matched).toBe(true);
    expect(result.confirmed).toBe(true);
    expect(updates.length).toBe(1);
    expect(updates[0].payload.status).toBe('confirmed');
    expect(updates[0].payload.confirmedBy).toBe('pick');
    expect(updates[0].payload.quantity).toBe(0);
  });

  it('senkt bei Teil-Pick nur die Menge (Reservierung bleibt reserved)', async () => {
    const resDocs = [{ orderId: 'o1', sku: 'SKU-A', quantity: 3, status: 'reserved' }];
    const { firestore, updates } = makeFirestoreMock(resDocs);
    const { consumeReservationOnPick } = loadWithMock(firestore);

    const result = await consumeReservationOnPick({ orderId: 'o1', sku: 'SKU-A', quantity: 1 });

    expect(result.matched).toBe(true);
    expect(result.confirmed).toBe(false);
    expect(result.remaining).toBe(2);
    expect(updates[0].payload.quantity).toBe(2);
    expect(updates[0].payload.status).toBeUndefined();
    // Original-Menge bleibt fürs Audit erhalten
    expect(updates[0].payload.quantityOriginal).toBe(3);
  });

  it('matcht per normalisierter SKU (Case-/Präfix-tolerant)', async () => {
    const resDocs = [{ orderId: 'o1', sku: 'sku-6656556112', quantity: 1, status: 'reserved' }];
    const { firestore, updates } = makeFirestoreMock(resDocs);
    const { consumeReservationOnPick } = loadWithMock(firestore);

    const result = await consumeReservationOnPick({ orderId: 'o1', sku: 'SKU-6656556112', quantity: 1 });
    expect(result.matched).toBe(true);
    expect(updates.length).toBe(1);
  });

  it('matcht per productId wenn SKU nicht passt (Reservierung ohne SKU)', async () => {
    const resDocs = [{ orderId: 'o1', sku: null, productId: 'prod-1', quantity: 1, status: 'reserved' }];
    const { firestore, updates } = makeFirestoreMock(resDocs);
    const { consumeReservationOnPick } = loadWithMock(firestore);

    const result = await consumeReservationOnPick({ orderId: 'o1', sku: 'SKU-X', productId: 'prod-1', quantity: 1 });
    expect(result.matched).toBe(true);
    expect(updates.length).toBe(1);
  });

  it('no-op wenn keine Reservierung existiert (manueller Stock-Out ohne Order)', async () => {
    const { firestore, updates } = makeFirestoreMock([]);
    const { consumeReservationOnPick } = loadWithMock(firestore);

    const result = await consumeReservationOnPick({ orderId: 'o1', sku: 'SKU-A', quantity: 1 });
    expect(result.matched).toBe(false);
    expect(updates.length).toBe(0);
  });

  it('no-op wenn die Reservierung im Race bereits confirmed/released wurde', async () => {
    const resDocs = [{ orderId: 'o1', sku: 'SKU-A', quantity: 1, status: 'reserved' }];
    const { firestore, updates } = makeFirestoreMock(resDocs);
    // Race simulieren: zwischen Query und Tx wird der Status geändert
    resDocs[0].status = 'confirmed';
    const { consumeReservationOnPick } = loadWithMock(firestore);

    const result = await consumeReservationOnPick({ orderId: 'o1', sku: 'SKU-A', quantity: 1 });
    expect(result.matched).toBe(false);
    expect(updates.length).toBe(0);
  });

  it('fremde SKU derselben Order wird NICHT konsumiert (Multi-SKU-Order)', async () => {
    const resDocs = [
      { orderId: 'o1', sku: 'SKU-OTHER', quantity: 1, status: 'reserved' },
    ];
    const { firestore, updates } = makeFirestoreMock(resDocs);
    const { consumeReservationOnPick } = loadWithMock(firestore);

    const result = await consumeReservationOnPick({ orderId: 'o1', sku: 'SKU-A', productId: 'p-a', quantity: 1 });
    expect(result.matched).toBe(false);
    expect(updates.length).toBe(0);
  });
});
