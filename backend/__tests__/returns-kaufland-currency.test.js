'use strict';
// globals: true in vitest.config.js — describe/it/expect/vi sind global
//
// Kaufland-Retouren in Fremdwaehrung: `refundAmount` kommt aus `order_unit.price`
// (Positionswaehrung, bei kaufland.cz CZK). Der Finanzbericht summiert refundAmount
// blind als Euro — eine CZK-Retoure ueber 534,14 wuerde 534,14 € vom Umsatz
// abziehen. Deshalb wird die Retoure wie der Auftrag in Euro gefuehrt, das
// Original bleibt additiv daneben (Vorfall M53KUW5, 2026-10-05).

function patchCjsModule(modulePath, mockExports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath, filename: resolvedPath, loaded: true,
    exports: mockExports, children: [], paths: [],
  };
}

// ─── Firestore-Fake: returns (stateful) + orders (verknuepfbar) ──────────────
const savedReturns = new Map();   // docId → data (set mit merge)
const existingReturns = new Map(); // marketplaceReturnId → data (vorab eingespielt)
const linkedOrders = new Map();    // orders docId → data (vorab eingespielt)
const updateSpy = vi.fn(async () => {});

function returnsQuery(filters) {
  return {
    where: (field, _op, value) => returnsQuery([...filters, { field, value }]),
    limit: () => returnsQuery(filters),
    get: async () => {
      const f = filters.find((x) => x.field === 'marketplaceReturnId');
      if (f && existingReturns.has(f.value)) {
        const data = existingReturns.get(f.value);
        return { empty: false, docs: [{ id: `kaufland__${f.value}`, data: () => data, ref: { update: updateSpy } }] };
      }
      return { empty: true, docs: [] };
    },
  };
}
function ordersQuery(filters) {
  return {
    where: (field, _op, value) => ordersQuery([...filters, { field, value }]),
    limit: () => ordersQuery(filters),
    get: async () => {
      const f = filters.find((x) => x.field === 'marketplaceOrderId');
      const hit = f ? [...linkedOrders.entries()].find(([, d]) => d.marketplaceOrderId === f.value) : null;
      if (hit) return { empty: false, docs: [{ id: hit[0], data: () => hit[1] }] };
      return { empty: true, docs: [] };
    },
  };
}
const fakeDb = {
  collection: (name) => ({
    where: (field, op, value) => (name === 'returns' ? returnsQuery([{ field, value }]) : ordersQuery([{ field, value }])),
    doc: (id) => ({
      set: async (data) => { savedReturns.set(id, { ...(savedReturns.get(id) || {}), ...data }); },
      get: async () => ({ exists: linkedOrders.has(id), id, data: () => linkedOrders.get(id) }),
      update: updateSpy,
    }),
    add: async () => ({ id: 'mock' }),
  }),
};
patchCjsModule('@google-cloud/firestore', { Firestore: function () { return fakeDb; }, FieldValue: { serverTimestamp: () => null, arrayUnion: (...a) => a } });
patchCjsModule('../lib/firestore', { firestore: fakeDb });

// ─── Kaufland-API-Stub ───────────────────────────────────────────────────────
let kauflandResponses = {};
const kauflandRequest = vi.fn(async (method, path) => {
  if (!(path in kauflandResponses)) throw new Error(`unerwarteter Kaufland-Aufruf ${method} ${path}`);
  return { status: 200, data: kauflandResponses[path] };
});
const getBookings = vi.fn(async () => { throw new Error('Buchungsbericht in diesem Test nicht verfuegbar'); });
patchCjsModule('../lib/kaufland-api', { kauflandRequest, getBookings });

const { createFxRateResolver, setDefaultFxResolver } = require('../lib/fx-rates');
const { assertNoUndefined } = require('../lib/order-currency');
const { syncKauflandReturns } = require('../services/returns-engine');

const ECB_XML = `<Cube><Cube time='2026-10-02'><Cube currency='CZK' rate='24.470'/><Cube currency='PLN' rate='4.3775'/></Cube></Cube>`;
function fxOnline() {
  return createFxRateResolver({
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => ECB_XML }),
    store: null,
    now: () => new Date('2026-10-05T10:00:00Z'),
  });
}

/** Retoure zur echten cz-Bestellposition 314568017759588 (Betraege aus dem Live-Payload). */
function czReturnResponses() {
  return {
    '/returns': { data: [{ id_return: 9001, ts_created_iso: '2026-10-04T09:00:00Z', ts_updated_iso: '2026-10-04T09:00:00Z', storefront: 'cz', status: 'label_generated', tracking_provider: null, tracking_code: null, fulfillment_type: 'fulfilled_by_merchant' }] },
    '/returns/9001': { data: { id_return: 9001, ts_created_iso: '2026-10-04T09:00:00Z', ts_updated_iso: '2026-10-04T09:00:00Z', status: 'label_generated', return_units: [{ id_return_unit: 77001, id_order_unit: 314568017759588, reason: 'dislike', status: 'label_generated', note: '' }] } },
    '/order-units/314568017759588': { data: { id_order_unit: 314568017759588, id_order: 'M53KUW5', id_offer: 'SKU-7350795017', price: 53414, revenue_gross: 45151, revenue_net: 37200, vat: 21, currency: 'CZK', storefront: 'cz', product: { title: 'Primewire Antennenkabel', eans: ['4061474124438'] }, buyer: { email: 'kaeufer@kaufland-marktplatz.de' }, shipping_address: { first_name: 'Martin', last_name: 'Medek', country: 'CZ' } } },
  };
}

function deReturnResponses() {
  const r = czReturnResponses();
  r['/order-units/314568017759588'].data.currency = 'EUR';
  r['/order-units/314568017759588'].data.storefront = 'de';
  r['/order-units/314568017759588'].data.price = 1999;
  return r;
}

/** Der (bereits umgerechnete) Auftrag zur Retoure — Kurs vom 01.10. (24,41), bewusst ≠ EZB-Tabelle (24,47). */
function linkedCzOrder(overrides = {}) {
  return {
    tenantId: 'default', marketplace: 'kaufland', marketplaceOrderId: 'M53KUW5', omsStatus: 'shipped',
    totalAmount: 21.88, currency: 'EUR', originalCurrency: 'CZK', originalTotalAmount: 534.14,
    exchangeRate: 24.41, exchangeRateDate: '2026-10-01', exchangeRateSource: 'ecb', exchangeRatePending: false,
    ...overrides,
  };
}

beforeEach(() => {
  savedReturns.clear();
  existingReturns.clear();
  linkedOrders.clear();
  updateSpy.mockClear();
  kauflandRequest.mockClear();
  kauflandResponses = {};
  delete process.env.ORDER_CURRENCY_CONVERSION;
  setDefaultFxResolver(fxOnline());
});
afterEach(() => setDefaultFxResolver(null));

describe('syncKauflandReturns — Retoure in Fremdwaehrung', () => {
  it('fuehrt eine CZK-Retoure in Euro und behaelt das Original', async () => {
    kauflandResponses = czReturnResponses();
    const res = await syncKauflandReturns({ tenantId: 'default', lookbackDays: 30 });
    expect(res.synced).toBe(1);

    const doc = savedReturns.get('kaufland__9001');
    expect(doc).toBeTruthy();
    expect(() => assertNoUndefined(doc)).not.toThrow();
    expect(doc.refundAmount).toBe(21.83);
    expect(doc.currency).toBe('EUR');
    expect(doc.amountBasis).toBe('kaufland_order_unit_price');
    expect(doc.originalCurrency).toBe('CZK');
    expect(doc.originalRefundAmount).toBe(534.14);
    expect(doc.exchangeRate).toBe(24.47);
    expect(doc.exchangeRateDate).toBe('2026-10-02');
    expect(doc.exchangeRateSource).toBe('ecb');
    expect(doc.exchangeRatePending).toBe(false);
    expect(doc.revenueGross).toBe(18.45);
    expect(doc.revenueNet).toBe(15.2);
    expect(doc.positions[0]).toMatchObject({ priceGross: 21.83, originalPriceGross: 534.14, originalCurrency: 'CZK' });
    // Ohne verknuepften Auftrag gilt der Kurs des Retouren-Datums — und das steht dran.
    expect(doc.exchangeRateBasis).toBe('return_date');
    // product.price haengt am selben Kurs wie alles andere; nie zwei Waehrungen in einem Dokument.
    expect(doc.product).toMatchObject({ price: 21.83, originalPrice: 534.14, originalCurrency: 'CZK' });
  });

  it('nutzt den Kurs des verknuepften Auftrags — eine Vollretoure ist dann cent-genau der Auftragsbetrag', async () => {
    linkedOrders.set('kaufland__M53KUW5', linkedCzOrder());
    kauflandResponses = czReturnResponses();
    await syncKauflandReturns({ tenantId: 'default', lookbackDays: 30 });

    const doc = savedReturns.get('kaufland__9001');
    expect(doc.orderId).toBe('kaufland__M53KUW5');
    expect(doc.orderAmount).toBe(21.88);
    expect(doc.refundAmount).toBe(21.88); // 534.14 / 24.41 — NICHT 24.47 aus der EZB-Tabelle
    expect(doc.exchangeRate).toBe(24.41);
    expect(doc.exchangeRateDate).toBe('2026-10-01');
    expect(doc.exchangeRateBasis).toBe('order');
    expect(doc.exchangeRatePending).toBe(false);
    expect(doc.product.price).toBe(21.88);
    expect(() => assertNoUndefined(doc)).not.toThrow();
  });

  it('Notkurs am Auftrag → Retoure uebernimmt ihn samt pending (ein Kurs fuer beide)', async () => {
    linkedOrders.set('kaufland__M53KUW5', linkedCzOrder({ totalAmount: 21.8, exchangeRate: 24.5, exchangeRateDate: '2026-10-05', exchangeRateSource: 'static_fallback', exchangeRatePending: true }));
    kauflandResponses = czReturnResponses();
    await syncKauflandReturns({ tenantId: 'default', lookbackDays: 30 });
    const doc = savedReturns.get('kaufland__9001');
    expect(doc.refundAmount).toBe(21.8);
    expect(doc.exchangeRateSource).toBe('static_fallback');
    expect(doc.exchangeRatePending).toBe(true);
    expect(doc.exchangeRateBasis).toBe('order');
  });

  it('Euro-Retoure bleibt wie bisher — ohne Original-Felder', async () => {
    kauflandResponses = deReturnResponses();
    await syncKauflandReturns({ tenantId: 'default', lookbackDays: 30 });
    const doc = savedReturns.get('kaufland__9001');
    expect(doc.refundAmount).toBe(19.99);
    expect(doc.currency).toBe('EUR');
    expect('originalCurrency' in doc).toBe(false);
    expect('exchangeRate' in doc).toBe(false);
  });

  it('zieht eine bereits gespeicherte CZK-Retoure nach (Altbestand)', async () => {
    existingReturns.set('9001', {
      marketplace: 'kaufland', marketplaceReturnId: '9001', marketplaceStatus: 'label_generated',
      reason: 'sonstiges', reasonRaw: 'dislike',
      refundAmount: 534.14, currency: 'CZK', amountBasis: 'kaufland_order_unit_price', positionCount: 1,
      revenueGross: 451.51, revenueNet: 372, warePending: true, orderUnitId: '314568017759588', returnUnitId: '77001',
    });
    kauflandResponses = czReturnResponses();
    const res = await syncKauflandReturns({ tenantId: 'default', lookbackDays: 30 });
    expect(res.skipped).toBe(1);

    const call = updateSpy.mock.calls.find((c) => c[0] && c[0].refundAmount != null);
    expect(call).toBeTruthy();
    expect(call[0]).toMatchObject({ refundAmount: 21.83, currency: 'EUR', originalCurrency: 'CZK', originalRefundAmount: 534.14, exchangeRate: 24.47 });
    expect(() => assertNoUndefined(call[0])).not.toThrow();
  });

  it('verknuepfte Alt-Retoure folgt dem geheilten Auftrag: Betrag, Kurs und orderAmount in EINEM Update', async () => {
    linkedOrders.set('kaufland__M53KUW5', linkedCzOrder({ totalAmount: 21.83, exchangeRate: 24.47, exchangeRateDate: '2026-10-02' }));
    existingReturns.set('9001', {
      marketplace: 'kaufland', marketplaceReturnId: '9001', marketplaceStatus: 'label_generated',
      reason: 'sonstiges', reasonRaw: 'dislike', orderId: 'kaufland__M53KUW5', orderAmount: 534.14,
      refundAmount: 534.14, currency: 'CZK', amountBasis: 'kaufland_order_unit_price', positionCount: 1,
      revenueGross: 451.51, revenueNet: 372, warePending: true, orderUnitId: '314568017759588', returnUnitId: '77001',
      product: { name: 'Primewire Antennenkabel', sku: 'SKU-7350795017', price: 534.14 },
    });
    kauflandResponses = czReturnResponses();
    await syncKauflandReturns({ tenantId: 'default', lookbackDays: 30 });

    const call = updateSpy.mock.calls.find((c) => c[0] && c[0].refundAmount != null);
    expect(call).toBeTruthy();
    expect(call[0]).toMatchObject({ refundAmount: 21.83, currency: 'EUR', exchangeRate: 24.47, exchangeRateBasis: 'order', orderAmount: 21.83 });
    expect(call[0]['product.price']).toBe(21.83);
    expect(() => assertNoUndefined(call[0])).not.toThrow();
  });

  it('bereits mit dem Auftragskurs umgerechnete Retoure wird nicht erneut angefasst (kein Flip-Flop)', async () => {
    linkedOrders.set('kaufland__M53KUW5', linkedCzOrder());
    existingReturns.set('9001', {
      marketplace: 'kaufland', marketplaceReturnId: '9001', marketplaceStatus: 'label_generated',
      reason: 'sonstiges', reasonRaw: 'dislike', orderId: 'kaufland__M53KUW5', orderAmount: 21.88,
      refundAmount: 21.88, currency: 'EUR', originalCurrency: 'CZK', originalRefundAmount: 534.14,
      exchangeRate: 24.41, exchangeRateDate: '2026-10-01', exchangeRateSource: 'ecb', exchangeRatePending: false, exchangeRateBasis: 'order',
      amountBasis: 'kaufland_order_unit_price', positionCount: 1, revenueGross: 18.5, revenueNet: 15.24,
      warePending: true, orderUnitId: '314568017759588', returnUnitId: '77001',
    });
    kauflandResponses = czReturnResponses();
    await syncKauflandReturns({ tenantId: 'default', lookbackDays: 30 });

    const touched = updateSpy.mock.calls.find((c) => c[0] && (c[0].refundAmount != null || c[0].exchangeRate != null || c[0].orderAmount != null));
    expect(touched).toBeUndefined();
  });

  it('Notbremse ORDER_CURRENCY_CONVERSION=off: Betrag bleibt in CZK, Waehrung ehrlich', async () => {
    process.env.ORDER_CURRENCY_CONVERSION = 'off';
    kauflandResponses = czReturnResponses();
    await syncKauflandReturns({ tenantId: 'default', lookbackDays: 30 });
    const doc = savedReturns.get('kaufland__9001');
    expect(doc.refundAmount).toBe(534.14);
    expect(doc.currency).toBe('CZK');
  });
});
