// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// REGRESSION GUARDS — eBay-Intake (2 Bugs, gefunden 2026-07-06):
//
// 1. on_hold blockierte die Status-Reconciliation: unbezahlte Orders starten
//    als on_hold (sortOrder 11 = reine UI-Position ans Listenende). Der
//    Rank-Vergleich sah confirmed (1) / shipped (6) < 11 → bezahlte Orders
//    blieben für immer 'Pausiert', Ship-Decrement lief nie (Oversell-Fenster
//    nach Ablauf der 72h-Reservierung). Fix: on_hold zählt als Rank 0,
//    identisch zur Kaufland-Intake-OMS_RANK-Map.
//
// 2. reserveStock lief für JEDE neu gespeicherte Order — auch für Orders, die
//    bereits storniert/versendet ankamen (Backfill, Storno vor Erst-Intake).
//    Born-cancelled Orders bekamen eine Phantom-Reservierung ohne Release-Pfad
//    (_onOrderCancelled läuft nur bei Transition NACH cancelled). Fix:
//    Reservierung nur für Status aus RESERVED_ORDER_STATUSES.

function patchCjsModule(modulePath, mockExports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath, filename: resolvedPath, loaded: true,
    exports: mockExports, children: [], paths: [],
  };
}

// ─── Stateful Orders-Mock: gespeicherte Docs tauchen in Folge-Queries auf ───
const savedDocs = new Map();
const updateSpy = vi.fn(async () => {});

function makeOrdersQuery(filters) {
  return {
    where: (field, _op, value) => makeOrdersQuery([...filters, { field, value }]),
    limit: () => makeOrdersQuery(filters),
    get: async () => {
      const keyFilter = filters.find((f) => f.field === 'marketplaceKey');
      if (keyFilter && savedDocs.has(keyFilter.value)) {
        const data = savedDocs.get(keyFilter.value);
        return {
          empty: false,
          docs: [{ id: keyFilter.value, data: () => data, ref: { update: updateSpy } }],
        };
      }
      return { empty: true, docs: [] };
    },
  };
}

function MockFirestore() {
  return {
    collection: (name) => ({
      where: (field, op, value) => makeOrdersQuery([{ field, value }]),
      doc: (id) => ({
        set: async (data) => { savedDocs.set(id, data); },
        get: async () => ({ exists: savedDocs.has(id), data: () => savedDocs.get(id) }),
        update: updateSpy,
      }),
      add: async () => ({ id: 'mock' }),
    }),
  };
}
MockFirestore.FieldValue = { serverTimestamp: () => null, increment: (n) => n };

patchCjsModule('@google-cloud/firestore', {
  Firestore: MockFirestore,
  FieldValue: MockFirestore.FieldValue,
});

// ─── Externe Deps stubben ────────────────────────────────────────────────────
let tradingApiResponse = null;
patchCjsModule('../lib/ebay-trading-api', {
  callTradingApi: vi.fn(async () => ({ response: tradingApiResponse })),
});

const reserveStockSpy = vi.fn(async () => ({}));
patchCjsModule('../services/stock-reservation', {
  reserveStock: reserveStockSpy,
  confirmReservation: vi.fn(),
  releaseReservation: vi.fn(),
});

const transitionOrderSpy = vi.fn(async () => ({ ok: true, fromStatus: 'on_hold', toStatus: 'confirmed' }));
patchCjsModule('../services/order-state-machine', {
  transitionOrder: transitionOrderSpy,
  processShippedOrder: vi.fn(async () => ({})),
  ORDER_STATUSES: {},
});

patchCjsModule('../services/stock-sync-dispatcher', {
  syncStockWithRetry: vi.fn(async () => ({})),
  findProductsBySkuChunk: vi.fn(async () => []),
});
patchCjsModule('../services/sync-event-bus', { emitSyncEvent: vi.fn() });
patchCjsModule('../services/number-sequence', {
  getNextNumber: vi.fn(async () => ({ formatted: 'AVY-2026-0001', number: 1 })),
});
patchCjsModule('../lib/ops-alert', { sendOpsAlert: vi.fn(async () => {}) });
patchCjsModule('../lib/product-store', { getProductWeightBySku: vi.fn(async () => null) });

const { syncEbayOrders, saveOrderIfNew, mapEbayOrder } = require('../services/order-intake-ebay');

function rawEbayOrder({ orderId, status, checkoutComplete, shipped }) {
  return {
    OrderID: orderId,
    OrderStatus: status,
    ...(shipped ? { ShippedTime: '2026-07-01T10:00:00Z' } : {}),
    CheckoutStatus: { Status: checkoutComplete ? 'Complete' : 'Incomplete' },
    CreatedTime: '2026-07-01T09:00:00Z',
    Total: { '#text': '19.99', '@_currencyID': 'EUR' },
    ShippingAddress: { Name: 'Max Mustermann', Street1: 'Teststr. 1', CityName: 'Berlin', PostalCode: '10115', Country: 'DE' },
    TransactionArray: {
      Transaction: { Item: { SKU: `SKU-${orderId}` }, QuantityPurchased: 1, TransactionPrice: { '#text': '19.99' } },
    },
  };
}

beforeEach(() => {
  savedDocs.clear();
  reserveStockSpy.mockClear();
  transitionOrderSpy.mockClear();
  updateSpy.mockClear();
});

describe('eBay-Intake: keine Reservierung für born-cancelled/shipped Orders', () => {
  it('reserviert nur für offene Orders, nicht für born-cancelled', async () => {
    tradingApiResponse = {
      Ack: 'Success',
      OrderArray: {
        Order: [
          rawEbayOrder({ orderId: 'C-1', status: 'Cancelled' }),
          rawEbayOrder({ orderId: 'K-2', status: 'Completed', checkoutComplete: true }),
        ],
      },
      PaginationResult: { TotalNumberOfPages: '1', TotalNumberOfEntries: '2' },
    };

    const result = await syncEbayOrders({ tenantId: 'default' });

    expect(result.synced).toBe(2); // beide Orders werden gespeichert …
    expect(reserveStockSpy).toHaveBeenCalledTimes(1); // … aber nur eine reserviert
    expect(reserveStockSpy.mock.calls[0][0].orderId).toBe('ebay__K-2');
  });
});

describe('eBay-Intake: unbezahlte Orders werden NICHT angelegt (Incident 2026-07-10)', () => {
  // Angenommener Preisvorschlag → eBay meldet Order mit itemId-transactionId-ID
  // und CheckoutStatus Incomplete. Die ID ÄNDERT sich bei Zahlung → früh
  // angelegte Docs bleiben als "Pausiert"-Zombies + Doppel-Reservierung stehen.
  it('legt keine neue Order an, solange unbezahlt (Active/Incomplete)', async () => {
    const order = mapEbayOrder(rawEbayOrder({ orderId: '800314901891-10082833345304', status: 'Active', checkoutComplete: false }));
    expect(order.ebayStatus).toBe('on_hold');

    const saved = await saveOrderIfNew({ tenantId: 'default', order });

    expect(saved).toBe(false);
    expect(savedDocs.has('ebay__800314901891-10082833345304')).toBe(false);
  });

  it('legt die Order an, sobald eBay sie als bezahlt meldet (finale OrderID)', async () => {
    const order = mapEbayOrder(rawEbayOrder({ orderId: '27-14851-26147', status: 'Completed', checkoutComplete: true }));
    expect(order.ebayStatus).toBe('confirmed');

    const saved = await saveOrderIfNew({ tenantId: 'default', order });

    expect(saved).toBe(true);
    expect(savedDocs.has('ebay__27-14851-26147')).toBe(true);
  });

  it('bestehende unbezahlte Docs werden weiter aktualisiert, nicht neu angelegt', async () => {
    savedDocs.set('ebay__H-9', { omsStatus: 'on_hold', orderId: 'AVY-2026-0012' });
    const order = mapEbayOrder(rawEbayOrder({ orderId: 'H-9', status: 'Active', checkoutComplete: false }));

    const saved = await saveOrderIfNew({ tenantId: 'default', order });

    expect(saved).toBe(false); // existiert → kein Neuanlegen, kein Crash
    expect(savedDocs.has('ebay__H-9')).toBe(true);
  });
});

describe('eBay-Intake: on_hold blockiert die Status-Reconciliation nicht mehr', () => {
  it('on_hold → confirmed läuft über transitionOrder, sobald eBay bezahlt meldet', async () => {
    savedDocs.set('ebay__H-1', { omsStatus: 'on_hold', orderId: 'AVY-2026-0009' });

    const order = mapEbayOrder(rawEbayOrder({ orderId: 'H-1', status: 'Completed', checkoutComplete: true }));
    expect(order.ebayStatus).toBe('confirmed');

    const saved = await saveOrderIfNew({ tenantId: 'default', order });

    expect(saved).toBe(false); // Order existiert schon
    expect(transitionOrderSpy).toHaveBeenCalledTimes(1);
    expect(transitionOrderSpy.mock.calls[0][0]).toMatchObject({ toStatus: 'confirmed', force: true });
  });

  it('on_hold → shipped triggert den State-Machine-Pfad (Ship-Decrement)', async () => {
    savedDocs.set('ebay__H-2', { omsStatus: 'on_hold', orderId: 'AVY-2026-0010' });

    const order = mapEbayOrder(rawEbayOrder({ orderId: 'H-2', status: 'Completed', checkoutComplete: true, shipped: true }));
    expect(order.ebayStatus).toBe('shipped');

    await saveOrderIfNew({ tenantId: 'default', order });

    expect(transitionOrderSpy).toHaveBeenCalledTimes(1);
    expect(transitionOrderSpy.mock.calls[0][0]).toMatchObject({ toStatus: 'shipped', force: true });
  });

  it('echter Fortschritt wird weiterhin nicht rückwärts überschrieben (shipped bleibt bei confirmed-Meldung)', async () => {
    savedDocs.set('ebay__H-3', { omsStatus: 'shipped', orderId: 'AVY-2026-0011' });

    const order = mapEbayOrder(rawEbayOrder({ orderId: 'H-3', status: 'Completed', checkoutComplete: true }));
    expect(order.ebayStatus).toBe('confirmed');

    await saveOrderIfNew({ tenantId: 'default', order });

    expect(transitionOrderSpy).not.toHaveBeenCalled();
  });
});
