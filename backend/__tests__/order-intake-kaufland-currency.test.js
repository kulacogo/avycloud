'use strict';
// globals: true in vitest.config.js — describe/it/expect/vi sind global
//
// REGRESSION — Kaufland.cz-Bestellung M53KUW5 (03.10.2026): der Kaeufer zahlte
// 534,14 CZK, AvyCloud speicherte totalAmount 534.14 mit currency 'EUR'.
// mapKauflandOrder setzte 'EUR' fest und nahm unit.price/100 als Euro — die
// Kaufland-API liefert aber je Position `currency: "CZK"` und `storefront: "cz"`
// (live gemessen 05.10.2026, Payload unten anonymisiert uebernommen).
//
// Erwartung: totalAmount/priceBrutto IMMER in Euro (EZB-Kurs des Bestelltages,
// Samstag → Freitagskurs 24,470 vom 02.10.), das Original additiv daneben; ein
// Altdokument wird vom 30-Tage-Abgleich nachgezogen.

function patchCjsModule(modulePath, mockExports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath, filename: resolvedPath, loaded: true,
    exports: mockExports, children: [], paths: [],
  };
}

// ─── Stateful Orders-Mock ────────────────────────────────────────────────────
const savedDocs = new Map();     // doc.set() → neu angelegte Auftraege
const existingDocs = new Map();  // vorab eingespielter Altbestand (marketplaceKey → data)
const updateSpy = vi.fn(async () => {});

function makeOrdersQuery(filters) {
  return {
    where: (field, _op, value) => makeOrdersQuery([...filters, { field, value }]),
    limit: () => makeOrdersQuery(filters),
    get: async () => {
      const keyFilter = filters.find((f) => f.field === 'marketplaceKey');
      if (keyFilter && existingDocs.has(keyFilter.value)) {
        const data = existingDocs.get(keyFilter.value);
        return { empty: false, docs: [{ id: keyFilter.value, data: () => data, ref: { update: updateSpy } }] };
      }
      return { empty: true, docs: [] };
    },
  };
}

function MockFirestore() {
  return {
    collection: () => ({
      where: (field, op, value) => makeOrdersQuery([{ field, value }]),
      doc: (id) => ({
        set: async (data) => { savedDocs.set(id, data); },
        get: async () => ({ exists: false, data: () => ({}) }),
        update: updateSpy,
      }),
    }),
  };
}
MockFirestore.FieldValue = { serverTimestamp: () => null, increment: (n) => n };
patchCjsModule('@google-cloud/firestore', { Firestore: MockFirestore, FieldValue: MockFirestore.FieldValue });

// ─── Kaufland-API-Stub ───────────────────────────────────────────────────────
let kauflandResponses = {};
const kauflandRequest = vi.fn(async (method, path) => {
  if (!(path in kauflandResponses)) throw new Error(`unerwarteter Kaufland-Aufruf ${method} ${path}`);
  return { status: 200, data: kauflandResponses[path] };
});
patchCjsModule('../lib/kaufland-api', { kauflandRequest });

// ─── uebrige Abhaengigkeiten ─────────────────────────────────────────────────
patchCjsModule('../services/stock-reservation', { reserveStock: vi.fn(async () => ({})), confirmReservation: vi.fn(), releaseReservation: vi.fn() });
patchCjsModule('../services/order-state-machine', { transitionOrder: vi.fn(async () => ({ ok: true })), processShippedOrder: vi.fn(async () => ({})), ORDER_STATUSES: {} });
patchCjsModule('../services/stock-sync-dispatcher', { syncStockWithRetry: vi.fn(async () => ({})), findProductsBySkuChunk: vi.fn(async () => []) });
patchCjsModule('../services/sync-event-bus', { emitSyncEvent: vi.fn() });
patchCjsModule('../services/number-sequence', { getNextNumber: vi.fn(async () => ({ formatted: 'AVY-2026-1559', number: 1559 })) });
const sendOpsAlertSpy = vi.fn(async () => {});
patchCjsModule('../lib/ops-alert', { sendOpsAlert: sendOpsAlertSpy });
patchCjsModule('../lib/product-store', { getProductWeightBySku: vi.fn(async () => 0.5) });

const { createFxRateResolver, setDefaultFxResolver } = require('../lib/fx-rates');
const { assertNoUndefined } = require('../lib/order-currency');
const { mapKauflandOrder, fetchKauflandOrders, saveOrderIfNew } = require('../services/order-intake-kaufland');

const ECB_XML = `<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"><Cube>
  <Cube time='2026-10-02'><Cube currency='CZK' rate='24.470'/><Cube currency='PLN' rate='4.3775'/></Cube>
  <Cube time='2026-10-01'><Cube currency='CZK' rate='24.410'/><Cube currency='PLN' rate='4.3700'/></Cube>
</Cube></gesmes:Envelope>`;

function fxOnline() {
  const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => ECB_XML }));
  return { fetchImpl, resolver: createFxRateResolver({ fetchImpl, store: null, now: () => new Date('2026-10-05T10:00:00Z') }) };
}
function fxOffline() {
  const fetchImpl = vi.fn(async () => { throw new Error('ENOTFOUND www.ecb.europa.eu'); });
  return { fetchImpl, resolver: createFxRateResolver({ fetchImpl, store: null, now: () => new Date('2026-10-05T10:00:00Z') }) };
}

/** Echte Kaufland-Antwort GET /orders/M53KUW5 vom 05.10.2026 (Kaeuferdaten anonymisiert). */
function kauflandCzOrder() {
  return {
    id_order: 'M53KUW5',
    ts_created_iso: '2026-10-03T15:09:12Z',
    is_marketplace_deemed_supplier: false,
    storefront: 'cz',
    fulfillment_type: 'fulfilled_by_merchant',
    buyer: { id_buyer: 92572440, email: 'kaeufer@kaufland-marktplatz.de' },
    billing_address: { first_name: 'Martin', last_name: 'Medek', company_name: '', street: 'Strasse', house_number: '1', postcode: '76701', additional_field: '', city: 'Kroměříž', phone: '+420000000000', country: 'CZ' },
    shipping_address: { first_name: 'Martin', last_name: 'Medek', company_name: '', street: 'Strasse', house_number: '1', postcode: '76701', additional_field: '', city: 'Kroměříž', phone: '+420000000000', country: 'CZ' },
    order_units: [{
      id_order_unit: 314568017759588,
      id_order: 'M53KUW5',
      ts_created_iso: '2026-10-03T15:09:12Z',
      ts_updated_iso: '2026-10-03T15:24:16Z',
      status: 'need_to_be_sent',
      price: 53414,
      id_offer: 'SKU-7350795017',
      revenue_gross: 45151,
      revenue_net: 37200,
      note: null,
      unit_condition: 'new',
      storefront: 'cz',
      currency: 'CZK',
      shipping_rate: 0,
      cancel_reason: null,
      product: { id_product: 438938232, title: 'Primewire úhlový anténní kabel - 10 m', eans: ['4061474124438'], manufacturer: 'Primewire' },
      vat: 21,
    }],
  };
}

function kauflandDeOrder() {
  const o = kauflandCzOrder();
  o.id_order = 'MDE0001';
  o.storefront = 'de';
  o.billing_address.country = 'DE';
  o.shipping_address.country = 'DE';
  o.order_units[0].id_order = 'MDE0001';
  o.order_units[0].id_order_unit = 1;
  o.order_units[0].storefront = 'de';
  o.order_units[0].currency = 'EUR';
  o.order_units[0].price = 1999;
  return o;
}

/** Das echte Firestore-Dokument orders/kaufland__M53KUW5 (Stand 05.10.2026, anonymisiert). */
function legacyStoredDoc() {
  return {
    tenantId: 'default',
    orderId: 'AVY-2026-1559',
    marketplaceKey: 'kaufland__M53KUW5',
    marketplaceOrderId: 'M53KUW5',
    marketplace: 'kaufland',
    source: 'kaufland',
    omsStatus: 'confirmed',
    status: 'pending',
    createdAt: '2026-10-03T15:09:12Z',
    totalAmount: 534.14,
    currency: 'EUR',
    customer: { name: 'Martin Medek', country: 'CZ' },
    items: [{ id: 'AVY-2026-1559-1', name: 'Primewire úhlový anténní kabel - 10 m', sku: 'SKU-7350795017', quantity: 1, priceBrutto: 534.14, currency: 'EUR', unitId: 314568017759588, ean: null, status: 'open', weight: 0.5 }],
    weight: 0.5,
  };
}

beforeEach(() => {
  savedDocs.clear();
  existingDocs.clear();
  updateSpy.mockClear();
  kauflandRequest.mockClear();
  kauflandResponses = {};
  delete process.env.ORDER_CURRENCY_CONVERSION;
});
afterEach(() => {
  setDefaultFxResolver(null);
});

describe('mapKauflandOrder — Waehrung und Storefront aus der Kaufland-Antwort', () => {
  it('liest CZK + Storefront cz; Betraege bleiben in CZK (die Umrechnung folgt danach)', () => {
    const mapped = mapKauflandOrder(kauflandCzOrder());
    expect(mapped.currency).toBe('CZK');
    expect(mapped.storefront).toBe('cz');
    expect(mapped.totalAmount).toBe(534.14);
    expect(mapped.items[0].priceBrutto).toBe(534.14);
    expect(mapped.items[0].currency).toBe('CZK');
    expect(mapped.customer.country).toBe('CZ');
  });

  it('kaufland.de bleibt Euro — wie bisher, plus storefront de', () => {
    const mapped = mapKauflandOrder(kauflandDeOrder());
    expect(mapped.currency).toBe('EUR');
    expect(mapped.storefront).toBe('de');
    expect(mapped.totalAmount).toBe(19.99);
    expect(mapped.items[0].currency).toBe('EUR');
  });

  it('ohne currency-Feld entscheidet die Storefront (pl → PLN)', () => {
    const o = kauflandCzOrder();
    o.storefront = 'pl';
    delete o.order_units[0].currency;
    delete o.order_units[0].storefront;
    expect(mapKauflandOrder(o).currency).toBe('PLN');
  });

  it('ohne Storefront und ohne currency gilt Euro (Altverhalten)', () => {
    const o = kauflandCzOrder();
    delete o.storefront;
    delete o.order_units[0].currency;
    delete o.order_units[0].storefront;
    const mapped = mapKauflandOrder(o);
    expect(mapped.currency).toBe('EUR');
    expect(mapped.storefront).toBeNull();
  });
});

describe('fetchKauflandOrders — rechnet Fremdwaehrung in Euro um', () => {
  it('M53KUW5: 534,14 CZK → 21,83 €, Original und Kurs bleiben daneben', async () => {
    kauflandResponses = { '/orders': { data: [kauflandCzOrder()], pagination: { total: 1 } } };
    setDefaultFxResolver(fxOnline().resolver);

    const { orders } = await fetchKauflandOrders({ limit: 100 });
    const o = orders[0];
    expect(o.totalAmount).toBe(21.83);
    expect(o.currency).toBe('EUR');
    expect(o.originalCurrency).toBe('CZK');
    expect(o.originalTotalAmount).toBe(534.14);
    expect(o.exchangeRate).toBe(24.47);
    expect(o.exchangeRateDate).toBe('2026-10-02');
    expect(o.exchangeRateSource).toBe('ecb');
    expect(o.exchangeRatePending).toBe(false);
    expect(o.storefront).toBe('cz');
    expect(o.items[0].priceBrutto).toBe(21.83);
    expect(o.items[0].currency).toBe('EUR');
    expect(o.items[0].originalPrice).toBe(534.14);
    expect(o.items[0].originalCurrency).toBe('CZK');
  });

  it('Euro-Bestellung bleibt unveraendert und loest keinen Kursabruf aus', async () => {
    kauflandResponses = { '/orders': { data: [kauflandDeOrder()], pagination: { total: 1 } } };
    const fx = fxOnline();
    setDefaultFxResolver(fx.resolver);

    const { orders } = await fetchKauflandOrders({ limit: 100 });
    expect(orders[0].totalAmount).toBe(19.99);
    expect(orders[0].currency).toBe('EUR');
    expect(orders[0].originalCurrency).toBeUndefined();
    expect(fx.fetchImpl).not.toHaveBeenCalled();
  });

  it('EZB nicht erreichbar → Notkurs, als pending markiert, Bestellung kommt trotzdem an', async () => {
    kauflandResponses = { '/orders': { data: [kauflandCzOrder()], pagination: { total: 1 } } };
    setDefaultFxResolver(fxOffline().resolver);

    const { orders } = await fetchKauflandOrders({ limit: 100 });
    expect(orders[0].totalAmount).toBe(21.8); // 534.14 / 24.5
    expect(orders[0].currency).toBe('EUR');
    expect(orders[0].exchangeRateSource).toBe('static_fallback');
    expect(orders[0].exchangeRatePending).toBe(true);
  });

  it('Waehrung ohne jeden Kurs (weder EZB noch Notkurs) → Betraege bleiben ehrlich, Alarm an den Betrieb', async () => {
    const o = kauflandCzOrder();
    o.order_units[0].currency = 'HUF';
    kauflandResponses = { '/orders': { data: [o], pagination: { total: 1 } } };
    setDefaultFxResolver(fxOffline().resolver);
    sendOpsAlertSpy.mockClear();

    const { orders } = await fetchKauflandOrders({ limit: 100 });
    expect(orders[0].currency).toBe('HUF');
    expect(orders[0].totalAmount).toBe(534.14);
    expect(orders[0].exchangeRateSource).toBe('none');
    expect(orders[0].exchangeRatePending).toBe(true);
    expect(sendOpsAlertSpy).toHaveBeenCalledTimes(1);
    expect(sendOpsAlertSpy.mock.calls[0][0]).toMatchObject({ source: 'order-intake-kaufland', severity: 'warning' });
  });

  it('Notbremse ORDER_CURRENCY_CONVERSION=off: keine Umrechnung, Waehrung bleibt ehrlich CZK', async () => {
    process.env.ORDER_CURRENCY_CONVERSION = 'off';
    kauflandResponses = { '/orders': { data: [kauflandCzOrder()], pagination: { total: 1 } } };
    const fx = fxOnline();
    setDefaultFxResolver(fx.resolver);

    const { orders } = await fetchKauflandOrders({ limit: 100 });
    expect(orders[0].totalAmount).toBe(534.14);
    expect(orders[0].currency).toBe('CZK');
    expect(orders[0].originalCurrency).toBeUndefined();
    expect(fx.fetchImpl).not.toHaveBeenCalled();
  });
});

describe('saveOrderIfNew — neues Dokument', () => {
  it('traegt Euro-Betrag, Original, Kurs und Storefront — und kein undefined', async () => {
    kauflandResponses = { '/orders': { data: [kauflandCzOrder()], pagination: { total: 1 } } };
    setDefaultFxResolver(fxOnline().resolver);
    const { orders } = await fetchKauflandOrders({ limit: 100 });

    const saved = await saveOrderIfNew({ tenantId: 'default', order: orders[0] });
    expect(saved).toBe(true);
    const doc = savedDocs.get('kaufland__M53KUW5');
    expect(doc).toBeTruthy();
    expect(() => assertNoUndefined(doc)).not.toThrow();
    expect(doc.totalAmount).toBe(21.83);
    expect(doc.currency).toBe('EUR');
    expect(doc.storefront).toBe('cz');
    expect(doc.originalCurrency).toBe('CZK');
    expect(doc.originalTotalAmount).toBe(534.14);
    expect(doc.exchangeRate).toBe(24.47);
    expect(doc.exchangeRateDate).toBe('2026-10-02');
    expect(doc.exchangeRateSource).toBe('ecb');
    expect(doc.exchangeRatePending).toBe(false);
    expect(typeof doc.currencyConvertedAt).toBe('string');
    expect(doc.items[0]).toMatchObject({ id: 'AVY-2026-1559-1', priceBrutto: 21.83, currency: 'EUR', originalPrice: 534.14, originalCurrency: 'CZK', weight: 0.5 });
  });

  it('kaufland.de-Dokument bekommt nur storefront dazu — keine Original-Felder', async () => {
    kauflandResponses = { '/orders': { data: [kauflandDeOrder()], pagination: { total: 1 } } };
    setDefaultFxResolver(fxOnline().resolver);
    const { orders } = await fetchKauflandOrders({ limit: 100 });

    await saveOrderIfNew({ tenantId: 'default', order: orders[0] });
    const doc = savedDocs.get('kaufland__MDE0001');
    expect(doc.storefront).toBe('de');
    expect(doc.totalAmount).toBe(19.99);
    expect(doc.currency).toBe('EUR');
    expect('originalCurrency' in doc).toBe(false);
    expect('exchangeRate' in doc).toBe(false);
    expect(() => assertNoUndefined(doc)).not.toThrow();
  });
});

describe('saveOrderIfNew — Altbestand heilen (laeuft im 30-Tage-Abgleich mit)', () => {
  it('CZK-als-EUR-Altdokument wird auf Euro nachgezogen, Positionsfelder bleiben', async () => {
    existingDocs.set('kaufland__M53KUW5', legacyStoredDoc());
    kauflandResponses = { '/orders': { data: [kauflandCzOrder()], pagination: { total: 1 } } };
    setDefaultFxResolver(fxOnline().resolver);
    const { orders } = await fetchKauflandOrders({ limit: 100 });

    const saved = await saveOrderIfNew({ tenantId: 'default', order: orders[0] });
    expect(saved).toBe(false);

    const healCall = updateSpy.mock.calls.find((c) => c[0] && c[0]['ops.currencyHeal']);
    expect(healCall).toBeTruthy();
    const patch = healCall[0];
    expect(patch.totalAmount).toBe(21.83);
    expect(patch.currency).toBe('EUR');
    expect(patch.originalCurrency).toBe('CZK');
    expect(patch.originalTotalAmount).toBe(534.14);
    expect(patch.exchangeRate).toBe(24.47);
    expect(patch.storefront).toBe('cz');
    expect(patch.items[0]).toMatchObject({ id: 'AVY-2026-1559-1', weight: 0.5, status: 'open', priceBrutto: 21.83, originalPrice: 534.14, originalCurrency: 'CZK' });
    expect(patch['ops.currencyHeal'].reason).toBe('legacy_unconverted');
    expect(() => assertNoUndefined(patch)).not.toThrow();
  });

  it('bereits umgerechnetes Dokument wird nicht noch einmal angefasst', async () => {
    existingDocs.set('kaufland__M53KUW5', {
      ...legacyStoredDoc(),
      totalAmount: 21.83,
      originalCurrency: 'CZK',
      originalTotalAmount: 534.14,
      exchangeRate: 24.47,
      exchangeRatePending: false,
    });
    kauflandResponses = { '/orders': { data: [kauflandCzOrder()], pagination: { total: 1 } } };
    setDefaultFxResolver(fxOnline().resolver);
    const { orders } = await fetchKauflandOrders({ limit: 100 });

    await saveOrderIfNew({ tenantId: 'default', order: orders[0] });
    const healCall = updateSpy.mock.calls.find((c) => c[0] && c[0]['ops.currencyHeal']);
    expect(healCall).toBeUndefined();
  });

  it('Notkurs-Dokument wird ersetzt, sobald der echte EZB-Kurs da ist', async () => {
    existingDocs.set('kaufland__M53KUW5', {
      ...legacyStoredDoc(),
      totalAmount: 21.8,
      originalCurrency: 'CZK',
      originalTotalAmount: 534.14,
      exchangeRate: 24.5,
      exchangeRateSource: 'static_fallback',
      exchangeRatePending: true,
    });
    kauflandResponses = { '/orders': { data: [kauflandCzOrder()], pagination: { total: 1 } } };
    setDefaultFxResolver(fxOnline().resolver);
    const { orders } = await fetchKauflandOrders({ limit: 100 });

    await saveOrderIfNew({ tenantId: 'default', order: orders[0] });
    const healCall = updateSpy.mock.calls.find((c) => c[0] && c[0]['ops.currencyHeal']);
    expect(healCall).toBeTruthy();
    expect(healCall[0].totalAmount).toBe(21.83);
    expect(healCall[0].exchangeRatePending).toBe(false);
    expect(healCall[0]['ops.currencyHeal'].reason).toBe('pending_rate_replaced');
  });
});
