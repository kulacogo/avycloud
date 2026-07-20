// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// Review-Finding 8 (Gegen-Pfad zum Pick-Consume): wird eine gepickte Einheit
// wieder eingelagert (Fehl-Pick → Stow-back mit Order-Kontext), muss die beim
// Pick konsumierte Reservierung wieder aufleben — sonst zählt available die
// Einheit als frei verkäuflich, obwohl die offene Order sie braucht.
//
// SICHERHEITS-GATE: der WP4-Cancel-/Return-Recredit ruft bookStockIn ebenfalls
// mit meta.orderId auf — dessen Orders sind cancelled/returned und dürfen die
// erloschene Obligation NIEMALS wieder öffnen (Order-Status-Gate).

let orderDocs = {}; // orderId → { omsStatus }

function makeFirestoreMock(reservationDocs) {
  const updates = [];
  const docs = reservationDocs.map((data, i) => ({
    id: `res-${i}`,
    ref: { _idx: i },
    data: () => ({ ...reservationDocs[i] }),
  }));

  const resChain = {
    where: vi.fn(() => resChain),
    get: async () => ({ empty: docs.length === 0, docs }),
  };

  const firestore = {
    collection: vi.fn((name) => {
      if (name === 'orders') {
        return {
          doc: vi.fn((id) => ({
            get: async () => ({
              exists: Boolean(orderDocs[id]),
              data: () => ({ ...(orderDocs[id] || {}) }),
            }),
          })),
        };
      }
      return resChain;
    }),
    runTransaction: async (fn) => {
      const tx = {
        get: async (ref) => ({ exists: true, data: () => ({ ...reservationDocs[ref._idx] }) }),
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

describe('restoreReservationOnStowBack — Gegen-Pfad zum Pick-Consume', () => {
  beforeEach(() => { orderDocs = {}; });
  afterEach(() => {
    delete require.cache[require.resolve('../services/stock-reservation')];
    delete require.cache[require.resolve('../lib/firestore')];
  });

  it('öffnet eine pick-konsumierte Reservierung wieder (Fehl-Pick, Order noch offen)', async () => {
    orderDocs['o1'] = { omsStatus: 'picking' };
    const resDocs = [{
      orderId: 'o1', sku: 'SKU-A', quantity: 0, quantityOriginal: 1,
      status: 'confirmed', confirmedBy: 'pick',
    }];
    const { firestore, updates } = makeFirestoreMock(resDocs);
    const { restoreReservationOnStowBack } = loadWithMock(firestore);

    const result = await restoreReservationOnStowBack({ orderId: 'o1', sku: 'SKU-A', quantity: 1 });

    expect(result.matched).toBe(true);
    expect(result.restored).toBe(1);
    expect(updates[0].payload.status).toBe('reserved');
    expect(updates[0].payload.quantity).toBe(1);
  });

  it('restauriert NIE über quantityOriginal hinaus (Cap)', async () => {
    orderDocs['o1'] = { omsStatus: 'picking' };
    const resDocs = [{
      orderId: 'o1', sku: 'SKU-A', quantity: 0, quantityOriginal: 1,
      status: 'confirmed', confirmedBy: 'pick',
    }];
    const { firestore, updates } = makeFirestoreMock(resDocs);
    const { restoreReservationOnStowBack } = loadWithMock(firestore);

    const result = await restoreReservationOnStowBack({ orderId: 'o1', sku: 'SKU-A', quantity: 5 });
    expect(result.restored).toBe(1);
    expect(updates[0].payload.quantity).toBe(1);
  });

  it('GATE: stornierte Order darf NICHT wieder reservieren (WP4-Cancel-Recredit)', async () => {
    orderDocs['o1'] = { omsStatus: 'cancelled' };
    const resDocs = [{
      orderId: 'o1', sku: 'SKU-A', quantity: 0, quantityOriginal: 1,
      status: 'confirmed', confirmedBy: 'pick',
    }];
    const { firestore, updates } = makeFirestoreMock(resDocs);
    const { restoreReservationOnStowBack } = loadWithMock(firestore);

    const result = await restoreReservationOnStowBack({ orderId: 'o1', sku: 'SKU-A', quantity: 1 });
    expect(result.matched).toBe(false);
    expect(result.reason).toBe('order_status_cancelled');
    expect(updates.length).toBe(0);
  });

  it('GATE: versendete Order restauriert nicht (Ship-Confirm ist final)', async () => {
    orderDocs['o1'] = { omsStatus: 'shipped' };
    const resDocs = [{
      orderId: 'o1', sku: 'SKU-A', quantity: 0, quantityOriginal: 1,
      status: 'confirmed', confirmedBy: 'pick',
    }];
    const { firestore, updates } = makeFirestoreMock(resDocs);
    const { restoreReservationOnStowBack } = loadWithMock(firestore);

    const result = await restoreReservationOnStowBack({ orderId: 'o1', sku: 'SKU-A', quantity: 1 });
    expect(result.matched).toBe(false);
    expect(updates.length).toBe(0);
  });

  it('ship-bestätigte Reservierung (confirmedBy != pick) wird nicht angefasst', async () => {
    orderDocs['o1'] = { omsStatus: 'picking' };
    const resDocs = [{
      orderId: 'o1', sku: 'SKU-A', quantity: 0, quantityOriginal: 1,
      status: 'confirmed', confirmedBy: null, confirmedAt: '2026-07-19T00:00:00Z',
    }];
    const { firestore, updates } = makeFirestoreMock(resDocs);
    const { restoreReservationOnStowBack } = loadWithMock(firestore);

    const result = await restoreReservationOnStowBack({ orderId: 'o1', sku: 'SKU-A', quantity: 1 });
    expect(result.matched).toBe(false);
    expect(updates.length).toBe(0);
  });

  it('Teil-Konsum: reserved-Reservierung wird bis zum Original aufgefüllt', async () => {
    orderDocs['o1'] = { omsStatus: 'picking' };
    const resDocs = [{
      orderId: 'o1', sku: 'SKU-A', quantity: 2, quantityOriginal: 3,
      status: 'reserved',
    }];
    const { firestore, updates } = makeFirestoreMock(resDocs);
    const { restoreReservationOnStowBack } = loadWithMock(firestore);

    const result = await restoreReservationOnStowBack({ orderId: 'o1', sku: 'SKU-A', quantity: 1 });
    expect(result.restored).toBe(1);
    expect(updates[0].payload.quantity).toBe(3);
    expect(updates[0].payload.status).toBeUndefined(); // war schon reserved
  });
});
