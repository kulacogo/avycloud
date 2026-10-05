'use strict';

/**
 * Fremdwaehrungs-Bestellungen in Euro fuehren — das Original bleibt additiv erhalten.
 *
 * Vorfall 2026-10-05: Kaufland.cz-Bestellung M53KUW5, Kaeufer zahlte 534,14 CZK.
 * AvyCloud speicherte totalAmount 534.14 mit currency 'EUR'. Rund 25 Lesepfade
 * (Dashboard, Finanzbericht, Rechnung, Tracking-Pflicht ab 10 €, Retouren) summieren
 * totalAmount blind als Euro. Deshalb bleibt totalAmount IMMER Euro; der
 * Originalbetrag kommt als Zusatzfeld dazu.
 */

const {
  STOREFRONT_CURRENCY,
  resolveUnitCurrency,
  convertOrderToEur,
  currencyFieldsOf,
  needsCurrencyHeal,
  buildCurrencyHealPatch,
  convertReturnDetailToEur,
  currencyConversionEnabled,
  assertNoUndefined,
} = require('../lib/order-currency');

const RATE_CZK = { currency: 'CZK', rate: 24.47, rateDate: '2026-10-02', source: 'ecb', pending: false };
const RATE_FALLBACK = { currency: 'CZK', rate: 24.5, rateDate: '2026-10-05', source: 'static_fallback', pending: true };
const NOW = () => new Date('2026-10-05T12:00:00Z');

/** Zuordnung, wie mapKauflandOrder sie fuer M53KUW5 liefert (vor der Umrechnung). */
function mappedCzOrder() {
  return {
    marketplaceOrderId: 'M53KUW5',
    source: 'kaufland',
    marketplace: 'kaufland',
    createdAt: '2026-10-03T15:09:12Z',
    storefront: 'cz',
    currency: 'CZK',
    totalAmount: 534.14,
    shippingCost: null,
    items: [
      { name: 'Primewire Antennenkabel', sku: 'SKU-7350795017', quantity: 1, priceBrutto: 534.14, currency: 'CZK', unitId: 314568017759588, ean: null, status: 'need_to_be_sent' },
    ],
  };
}

/** Das echte Firestore-Dokument orders/kaufland__M53KUW5 (Stand 05.10.2026, anonymisiert). */
function legacyStoredDoc() {
  return {
    tenantId: 'default',
    orderId: 'AVY-2026-1559',
    marketplaceKey: 'kaufland__M53KUW5',
    marketplaceOrderId: 'M53KUW5',
    marketplace: 'kaufland',
    omsStatus: 'confirmed',
    createdAt: '2026-10-03T15:09:12Z',
    totalAmount: 534.14,
    currency: 'EUR',
    items: [
      { id: 'AVY-2026-1559-1', name: 'Primewire Antennenkabel', sku: 'SKU-7350795017', quantity: 1, priceBrutto: 534.14, currency: 'EUR', unitId: 314568017759588, ean: null, status: 'open', weight: 0.5 },
    ],
    customer: { name: 'Kunde', country: 'CZ' },
    weight: 0.5,
  };
}

describe('resolveUnitCurrency — Waehrung je Position', () => {
  it('nimmt das Feld currency der Position (Kaufland liefert es seit der Internationalisierung)', () => {
    expect(resolveUnitCurrency({ currency: 'CZK', storefront: 'cz' }, { storefront: 'cz' })).toBe('CZK');
    expect(resolveUnitCurrency({ currency: 'czk' }, {})).toBe('CZK');
  });

  it('faellt auf die Storefront zurueck, wenn currency fehlt', () => {
    expect(resolveUnitCurrency({ storefront: 'pl' }, {})).toBe('PLN');
    expect(resolveUnitCurrency({}, { storefront: 'cz' })).toBe('CZK');
    expect(resolveUnitCurrency({}, { storefront: 'sk' })).toBe('EUR'); // Slowakei zahlt in Euro
  });

  it('ohne beides gilt Euro — exakt das heutige Verhalten fuer kaufland.de', () => {
    expect(resolveUnitCurrency({}, {})).toBe('EUR');
    expect(resolveUnitCurrency(null, null)).toBe('EUR');
  });

  it('kennt alle Storefronts aus dem Kaufland-Schema', () => {
    expect(STOREFRONT_CURRENCY).toEqual({ de: 'EUR', at: 'EUR', sk: 'EUR', fr: 'EUR', it: 'EUR', es: 'EUR', nl: 'EUR', cz: 'CZK', pl: 'PLN' });
  });
});

describe('convertOrderToEur — Euro als Hauptbetrag, Original additiv', () => {
  it('rechnet M53KUW5 auf 21,83 € um und behaelt 534,14 CZK als Original', () => {
    const out = convertOrderToEur(mappedCzOrder(), RATE_CZK, { now: NOW });
    expect(out.totalAmount).toBe(21.83);
    expect(out.currency).toBe('EUR');
    expect(out.originalCurrency).toBe('CZK');
    expect(out.originalTotalAmount).toBe(534.14);
    expect(out.exchangeRate).toBe(24.47);
    expect(out.exchangeRateDate).toBe('2026-10-02');
    expect(out.exchangeRateSource).toBe('ecb');
    expect(out.exchangeRatePending).toBe(false);
    expect(out.currencyConvertedAt).toBe('2026-10-05T12:00:00.000Z');
    expect(out.storefront).toBe('cz');
    expect(out.items[0].priceBrutto).toBe(21.83);
    expect(out.items[0].currency).toBe('EUR');
    expect(out.items[0].originalPrice).toBe(534.14);
    expect(out.items[0].originalCurrency).toBe('CZK');
    // uebrige Positionsfelder bleiben
    expect(out.items[0].unitId).toBe(314568017759588);
    expect(out.items[0].sku).toBe('SKU-7350795017');
  });

  it('veraendert die Eingabe nicht (kein Mutieren der Zuordnung)', () => {
    const input = mappedCzOrder();
    convertOrderToEur(input, RATE_CZK, { now: NOW });
    expect(input.totalAmount).toBe(534.14);
    expect(input.currency).toBe('CZK');
    expect(input.items[0].priceBrutto).toBe(534.14);
  });

  it('rechnet Versandkosten mit um, wenn vorhanden', () => {
    const out = convertOrderToEur({ ...mappedCzOrder(), shippingCost: 99 }, RATE_CZK, { now: NOW });
    expect(out.shippingCost).toBe(4.05); // 99 / 24.47 = 4.0457
  });

  it('Euro-Bestellung bleibt unveraendert — dieselbe Referenz, kein Zusatzfeld', () => {
    const input = { ...mappedCzOrder(), currency: 'EUR', storefront: 'de', items: [{ priceBrutto: 10, quantity: 1, currency: 'EUR' }] };
    const out = convertOrderToEur(input, RATE_CZK, { now: NOW });
    expect(out).toBe(input);
    expect(out.originalCurrency).toBeUndefined();
  });

  it('Notkurs → pending markiert, Betrag trotzdem in der richtigen Groessenordnung', () => {
    const out = convertOrderToEur(mappedCzOrder(), RATE_FALLBACK, { now: NOW });
    expect(out.totalAmount).toBe(21.8); // 534.14 / 24.5
    expect(out.exchangeRatePending).toBe(true);
    expect(out.exchangeRateSource).toBe('static_fallback');
  });

  it('gar kein Kurs → Betraege bleiben in Fremdwaehrung, Waehrung bleibt CZK, sichtbar als pending', () => {
    const out = convertOrderToEur(mappedCzOrder(), { currency: 'CZK', rate: null, rateDate: null, source: 'none', pending: true }, { now: NOW });
    expect(out.currency).toBe('CZK');
    expect(out.totalAmount).toBe(534.14);
    expect(out.originalCurrency).toBe('CZK');
    expect(out.originalTotalAmount).toBe(534.14);
    expect(out.exchangeRate).toBeNull();
    expect(out.exchangeRateSource).toBe('none');
    expect(out.exchangeRatePending).toBe(true);
    expect(out.items[0].priceBrutto).toBe(534.14);
    expect(out.items[0].currency).toBe('CZK');
  });

  it('Positionspreis null bleibt null, wird nie zu 0 €', () => {
    const o = mappedCzOrder();
    o.items[0].priceBrutto = null;
    const out = convertOrderToEur(o, RATE_CZK, { now: NOW });
    expect(out.items[0].priceBrutto).toBeNull();
    expect(out.items[0].originalPrice).toBeNull();
  });
});

describe('currencyFieldsOf — die Zusatzfelder fuer das Auftragsdokument', () => {
  it('Euro-Auftrag: nur storefront, nie undefined', () => {
    const fields = currencyFieldsOf({ currency: 'EUR', storefront: 'de' });
    expect(fields).toEqual({ storefront: 'de' });
    expect(() => assertNoUndefined(fields)).not.toThrow();
  });

  it('Euro-Auftrag ohne Storefront (eBay) → leeres Objekt', () => {
    expect(currencyFieldsOf({ currency: 'EUR' })).toEqual({});
  });

  it('umgerechneter Auftrag: alle Felder, Fehlendes als null', () => {
    const out = convertOrderToEur(mappedCzOrder(), RATE_CZK, { now: NOW });
    expect(currencyFieldsOf(out)).toEqual({
      storefront: 'cz',
      originalCurrency: 'CZK',
      originalTotalAmount: 534.14,
      exchangeRate: 24.47,
      exchangeRateDate: '2026-10-02',
      exchangeRateSource: 'ecb',
      exchangeRatePending: false,
      currencyConvertedAt: '2026-10-05T12:00:00.000Z',
    });
  });
});

describe('needsCurrencyHeal — wann der 30-Tage-Abgleich Betraege nachzieht', () => {
  const fresh = () => convertOrderToEur(mappedCzOrder(), RATE_CZK, { now: NOW });

  it('Altbestand (nie umgerechnet, CZK als EUR gespeichert) → heilen', () => {
    expect(needsCurrencyHeal(legacyStoredDoc(), fresh())).toBe(true);
  });

  it('bereits umgerechnet → nicht nochmal (Betraege bleiben stabil)', () => {
    const stored = { ...legacyStoredDoc(), totalAmount: 21.83, originalCurrency: 'CZK', exchangeRatePending: false };
    expect(needsCurrencyHeal(stored, fresh())).toBe(false);
  });

  it('mit Notkurs gespeichert → heilen, sobald ein echter Kurs da ist', () => {
    const stored = { ...legacyStoredDoc(), totalAmount: 21.8, originalCurrency: 'CZK', exchangeRatePending: true, exchangeRateSource: 'static_fallback' };
    expect(needsCurrencyHeal(stored, fresh())).toBe(true);
  });

  it('mit Notkurs gespeichert und wieder nur Notkurs → nicht heilen (kein Flip-Flop)', () => {
    const stored = { ...legacyStoredDoc(), totalAmount: 21.8, originalCurrency: 'CZK', exchangeRatePending: true };
    const freshFallback = convertOrderToEur(mappedCzOrder(), RATE_FALLBACK, { now: NOW });
    expect(needsCurrencyHeal(stored, freshFallback)).toBe(false);
  });

  it('Dokument ohne jeden Kurs gespeichert (currency noch CZK) → heilen, auch mit Notkurs', () => {
    // Ein solches Dokument fuehrt CZK-Betraege, die alle Lesepfade als Euro lesen —
    // der Notkurs (21,80 € pending) ist besser als 534,14 "€".
    const stored = { ...legacyStoredDoc(), currency: 'CZK', originalCurrency: 'CZK', exchangeRateSource: 'none', exchangeRatePending: true };
    const freshFallback = convertOrderToEur(mappedCzOrder(), RATE_FALLBACK, { now: NOW });
    expect(needsCurrencyHeal(stored, freshFallback)).toBe(true);
    expect(needsCurrencyHeal(stored, fresh())).toBe(true);
  });

  it('Altbestand, aber die frische Zuordnung hat KEINEN Kurs → nie CZK als EUR schreiben', () => {
    const freshNone = convertOrderToEur(mappedCzOrder(), { currency: 'CZK', rate: null, rateDate: null, source: 'none', pending: true }, { now: NOW });
    expect(needsCurrencyHeal(legacyStoredDoc(), freshNone)).toBe(false);
  });

  it('Euro-Bestellung → nie', () => {
    const eur = { ...mappedCzOrder(), currency: 'EUR', storefront: 'de' };
    expect(needsCurrencyHeal({ ...legacyStoredDoc(), totalAmount: 10 }, eur)).toBe(false);
    expect(needsCurrencyHeal(null, fresh())).toBe(false);
    expect(needsCurrencyHeal(legacyStoredDoc(), null)).toBe(false);
  });
});

describe('buildCurrencyHealPatch — der Nachzieh-Patch fuer Altbestand', () => {
  it('zieht Betrag, Positionen und Zusatzfelder nach und laesst alles andere stehen', () => {
    const fresh = convertOrderToEur(mappedCzOrder(), RATE_CZK, { now: NOW });
    const patch = buildCurrencyHealPatch(legacyStoredDoc(), fresh, { now: NOW });

    expect(patch.totalAmount).toBe(21.83);
    expect(patch.currency).toBe('EUR');
    expect(patch.originalCurrency).toBe('CZK');
    expect(patch.originalTotalAmount).toBe(534.14);
    expect(patch.exchangeRate).toBe(24.47);
    expect(patch.exchangeRateDate).toBe('2026-10-02');
    expect(patch.exchangeRateSource).toBe('ecb');
    expect(patch.exchangeRatePending).toBe(false);
    expect(patch.storefront).toBe('cz');
    expect(patch.updatedAt).toBe('2026-10-05T12:00:00.000Z');

    // Positionen: Preis umgerechnet, Rest (id, weight, status) unangetastet
    expect(patch.items).toHaveLength(1);
    expect(patch.items[0]).toMatchObject({
      id: 'AVY-2026-1559-1', weight: 0.5, status: 'open', unitId: 314568017759588,
      priceBrutto: 21.83, currency: 'EUR', originalPrice: 534.14, originalCurrency: 'CZK',
    });

    // Nachvollziehbarkeit
    expect(patch['ops.currencyHeal']).toMatchObject({
      reason: 'legacy_unconverted',
      from: { totalAmount: 534.14, currency: 'EUR' },
      to: { totalAmount: 21.83, currency: 'EUR' },
      rate: 24.47, rateDate: '2026-10-02', source: 'ecb',
    });

    // Firestore-Client ohne ignoreUndefinedProperties: ein undefined kippt den Schreibvorgang
    expect(() => assertNoUndefined(patch)).not.toThrow();
    expect(patch.omsStatus).toBeUndefined();
    expect(patch.customer).toBeUndefined();
  });

  it('ordnet Positionen ueber unitId zu, nicht ueber die Reihenfolge', () => {
    const stored = legacyStoredDoc();
    stored.items = [
      { id: 'x-1', unitId: 2, priceBrutto: 100, quantity: 1, currency: 'EUR' },
      { id: 'x-2', unitId: 1, priceBrutto: 534.14, quantity: 1, currency: 'EUR' },
    ];
    const fresh = convertOrderToEur({
      ...mappedCzOrder(),
      items: [
        { unitId: 1, priceBrutto: 534.14, quantity: 1, currency: 'CZK' },
        { unitId: 2, priceBrutto: 100, quantity: 1, currency: 'CZK' },
      ],
    }, RATE_CZK, { now: NOW });
    const patch = buildCurrencyHealPatch(stored, fresh, { now: NOW });
    expect(patch.items[0]).toMatchObject({ id: 'x-1', priceBrutto: 4.09, originalPrice: 100 });
    expect(patch.items[1]).toMatchObject({ id: 'x-2', priceBrutto: 21.83, originalPrice: 534.14 });
  });

  it('Position ohne Gegenstueck bleibt unveraendert', () => {
    const stored = legacyStoredDoc();
    stored.items.push({ id: 'manuell', priceBrutto: 5, quantity: 1 });
    const fresh = convertOrderToEur(mappedCzOrder(), RATE_CZK, { now: NOW });
    const patch = buildCurrencyHealPatch(stored, fresh, { now: NOW });
    expect(patch.items[1]).toEqual({ id: 'manuell', priceBrutto: 5, quantity: 1 });
  });

  it('ohne gespeicherte Positionen wird items nicht angefasst', () => {
    const stored = { ...legacyStoredDoc(), items: [] };
    const fresh = convertOrderToEur(mappedCzOrder(), RATE_CZK, { now: NOW });
    const patch = buildCurrencyHealPatch(stored, fresh, { now: NOW });
    expect(patch.items).toBeUndefined();
  });

  it('rechnet den Netto-Stand neu, wenn Erstattungen am Auftrag haengen', () => {
    const stored = { ...legacyStoredDoc(), marketplaceRefunds: [{ refundId: 'r1', amount: 5 }], refundedTotal: 5, netAmount: 529.14, grossAmount: 534.14 };
    const fresh = convertOrderToEur(mappedCzOrder(), RATE_CZK, { now: NOW });
    const patch = buildCurrencyHealPatch(stored, fresh, { now: NOW });
    expect(patch.grossAmount).toBe(21.83);
    expect(patch.refundedTotal).toBe(5);
    expect(patch.netAmount).toBe(16.83);
  });

  it('Notkurs-Heilung traegt den Grund pending', () => {
    const stored = { ...legacyStoredDoc(), totalAmount: 21.8, originalCurrency: 'CZK', exchangeRatePending: true, exchangeRateSource: 'static_fallback' };
    const fresh = convertOrderToEur(mappedCzOrder(), RATE_CZK, { now: NOW });
    const patch = buildCurrencyHealPatch(stored, fresh, { now: NOW });
    expect(patch['ops.currencyHeal'].reason).toBe('pending_rate_replaced');
    expect(patch['ops.currencyHeal'].from.totalAmount).toBe(21.8);
  });
});

describe('convertReturnDetailToEur — Kaufland-Retoure in Positionswaehrung', () => {
  const detail = () => ({
    refundAmount: 534.14,
    amountBasis: 'kaufland_order_unit_price',
    refundBookingCount: 0,
    currency: 'CZK',
    positionen: [{ orderUnitId: '1', priceGross: 534.14, revenueGross: 451.51, revenueNet: 372 }],
    positionCount: 1,
    revenueGross: 451.51,
    revenueNet: 372,
  });

  it('rechnet Erstattung und Erloese um, Original bleibt', () => {
    const out = convertReturnDetailToEur(detail(), RATE_CZK);
    expect(out.refundAmount).toBe(21.83);
    expect(out.revenueGross).toBe(18.45);
    expect(out.revenueNet).toBe(15.2);
    expect(out.currency).toBe('EUR');
    expect(out.originalCurrency).toBe('CZK');
    expect(out.originalRefundAmount).toBe(534.14);
    expect(out.exchangeRate).toBe(24.47);
    expect(out.exchangeRateSource).toBe('ecb');
    expect(out.exchangeRatePending).toBe(false);
    expect(out.positionen[0]).toMatchObject({ priceGross: 21.83, originalPriceGross: 534.14, originalCurrency: 'CZK' });
  });

  it('Euro-Retoure bleibt unveraendert', () => {
    const d = { ...detail(), currency: 'EUR' };
    expect(convertReturnDetailToEur(d, RATE_CZK)).toBe(d);
  });

  it('traegt die Kursbasis: Auftragskurs wenn uebergeben, sonst Retouren-Datum', () => {
    expect(convertReturnDetailToEur(detail(), RATE_CZK).exchangeRateBasis).toBe('return_date');
    expect(convertReturnDetailToEur(detail(), { ...RATE_CZK, basis: 'order' }).exchangeRateBasis).toBe('order');
    expect(convertReturnDetailToEur(detail(), { currency: 'CZK', rate: null, source: 'none', pending: true }).exchangeRateBasis).toBe('return_date');
  });

  it('buchungsbasierter Betrag ist schon Euro — nur Erloese umrechnen, Erstattung nicht', () => {
    const d = { ...detail(), amountBasis: 'kaufland_booking_refund', refundAmount: 20 };
    const out = convertReturnDetailToEur(d, RATE_CZK);
    expect(out.refundAmount).toBe(20);
    expect(out.currency).toBe('EUR');
    expect(out.revenueGross).toBe(18.45);
    expect(out.originalRefundAmount).toBeNull();
  });

  it('ohne Kurs bleibt alles stehen, aber sichtbar pending', () => {
    const out = convertReturnDetailToEur(detail(), { currency: 'CZK', rate: null, rateDate: null, source: 'none', pending: true });
    expect(out.refundAmount).toBe(534.14);
    expect(out.currency).toBe('CZK');
    expect(out.exchangeRatePending).toBe(true);
    expect(out.exchangeRateSource).toBe('none');
  });
});

describe('currencyConversionEnabled — Notbremse', () => {
  const prev = process.env.ORDER_CURRENCY_CONVERSION;
  afterEach(() => {
    if (prev === undefined) delete process.env.ORDER_CURRENCY_CONVERSION;
    else process.env.ORDER_CURRENCY_CONVERSION = prev;
  });

  it('ist standardmaessig an', () => {
    delete process.env.ORDER_CURRENCY_CONVERSION;
    expect(currencyConversionEnabled()).toBe(true);
  });

  it('nur exakt off schaltet ab — ein Tippfehler darf keine CZK als Euro speichern', () => {
    process.env.ORDER_CURRENCY_CONVERSION = 'off';
    expect(currencyConversionEnabled()).toBe(false);
    process.env.ORDER_CURRENCY_CONVERSION = 'false';
    expect(currencyConversionEnabled()).toBe(true);
    process.env.ORDER_CURRENCY_CONVERSION = '0';
    expect(currencyConversionEnabled()).toBe(true);
  });
});

describe('assertNoUndefined', () => {
  it('findet undefined auch tief verschachtelt und in Arrays', () => {
    expect(() => assertNoUndefined({ a: 1, b: { c: null } })).not.toThrow();
    expect(() => assertNoUndefined({ a: { b: undefined } })).toThrow(/a\.b/);
    expect(() => assertNoUndefined({ items: [{ x: 1 }, { y: undefined }] })).toThrow(/items\.1\.y/);
  });
});
