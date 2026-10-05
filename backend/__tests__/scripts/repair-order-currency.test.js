'use strict';

/**
 * Tests fuer scripts/repair-order-currency.js — Nachziehen von Kaufland-Auftraegen,
 * die CZK/PLN als Euro gespeichert haben (Vorfall M53KUW5, 2026-10-05).
 *
 * Die schweren Abhaengigkeiten (Firestore, Kaufland-API) laedt das Script erst in
 * main(); die Entscheidungen sind rein und hier ohne Netz testbar.
 */

const { parseArgs, assertConfirm, isCandidate, planRepair, CONFIRM_TOKEN } = require('../../scripts/repair-order-currency');
const { convertOrderToEur, needsCurrencyHeal, buildCurrencyHealPatch, STOREFRONT_CURRENCY } = require('../../lib/order-currency');

const RATE = { currency: 'CZK', rate: 24.47, rateDate: '2026-10-02', source: 'ecb', pending: false };

describe('parseArgs', () => {
  it('Trockenlauf ist Default, Auftraege werden gross geschrieben gesammelt', () => {
    const a = parseArgs(['--order', 'm53kuw5', '--order=MABC123', '--days', '30']);
    expect(a.apply).toBe(false);
    expect(a.orders).toEqual(['M53KUW5', 'MABC123']);
    expect(a.days).toBe(30);
    expect(a.tenant).toBe('default');
  });
});

describe('assertConfirm — Schreiben nur mit Bestaetigung', () => {
  it('ohne --apply nie ein Problem', () => {
    expect(() => assertConfirm(parseArgs([]))).not.toThrow();
  });
  it('--apply ohne/mit falschem Token wird abgelehnt', () => {
    expect(() => assertConfirm(parseArgs(['--apply']))).toThrow(/--confirm/);
    expect(() => assertConfirm(parseArgs(['--apply', '--confirm', 'JA']))).toThrow(/--confirm/);
    expect(() => assertConfirm(parseArgs(['--apply', '--confirm', CONFIRM_TOKEN]))).not.toThrow();
  });
});

describe('isCandidate — welche Dokumente ueberhaupt bei Kaufland nachgeschlagen werden', () => {
  const legacyCz = { marketplace: 'kaufland', marketplaceOrderId: 'M53KUW5', totalAmount: 534.14, currency: 'EUR', customer: { country: 'CZ' } };

  it('Altbestand mit tschechischem Kunden → ja', () => {
    expect(isCandidate(legacyCz)).toBe(true);
  });
  it('deutscher Kunde ohne Storefront → nein (spart API-Aufrufe), mit --all → ja', () => {
    const de = { ...legacyCz, customer: { country: 'DE' } };
    expect(isCandidate(de)).toBe(false);
    expect(isCandidate(de, { all: true })).toBe(true);
  });
  it('Storefront entscheidet, wenn vorhanden', () => {
    expect(isCandidate({ ...legacyCz, storefront: 'de', customer: { country: 'CZ' } }, { storefrontCurrency: STOREFRONT_CURRENCY })).toBe(false);
    expect(isCandidate({ ...legacyCz, storefront: 'pl', customer: { country: 'DE' } }, { storefrontCurrency: STOREFRONT_CURRENCY })).toBe(true);
  });
  it('bereits umgerechnet → nie; Notkurs (pending) → ja', () => {
    expect(isCandidate({ ...legacyCz, originalCurrency: 'CZK', exchangeRatePending: false })).toBe(false);
    expect(isCandidate({ ...legacyCz, originalCurrency: 'CZK', exchangeRatePending: true, customer: { country: 'DE' } })).toBe(true);
  });
  it('eBay-Auftraege nie; --order waehlt gezielt', () => {
    expect(isCandidate({ ...legacyCz, marketplace: 'ebay' })).toBe(false);
    expect(isCandidate(legacyCz, { orderIds: new Set(['MXYZ']) })).toBe(false);
    expect(isCandidate(legacyCz, { orderIds: new Set(['M53KUW5']) })).toBe(true);
  });
});

describe('planRepair — derselbe Heil-Pfad wie der Intake-Abgleich', () => {
  const existing = {
    marketplace: 'kaufland', marketplaceOrderId: 'M53KUW5', omsStatus: 'confirmed', totalAmount: 534.14, currency: 'EUR',
    items: [{ id: 'AVY-2026-1559-1', unitId: 314568017759588, priceBrutto: 534.14, currency: 'EUR', quantity: 1, weight: 0.5 }],
  };
  const klOrder = { id_order: 'M53KUW5', ts_created_iso: '2026-10-03T15:09:12Z', storefront: 'cz', order_units: [{ id_order_unit: 314568017759588, price: 53414, currency: 'CZK', storefront: 'cz', status: 'need_to_be_sent', product: { title: 'Kabel' } }] };

  function deps(rate = RATE) {
    return {
      mapKauflandOrder: (kl) => ({
        marketplaceOrderId: kl.id_order,
        createdAt: kl.ts_created_iso,
        storefront: kl.storefront,
        currency: kl.order_units[0].currency,
        totalAmount: kl.order_units[0].price / 100,
        items: [{ unitId: kl.order_units[0].id_order_unit, priceBrutto: kl.order_units[0].price / 100, currency: kl.order_units[0].currency, quantity: 1 }],
      }),
      convertOrderCurrency: async (o) => convertOrderToEur(o, rate, { now: () => new Date('2026-10-05T12:00:00Z') }),
      needsCurrencyHeal,
      buildCurrencyHealPatch,
    };
  }

  it('Altbestand → heilen, Patch wie im Intake', async () => {
    const plan = await planRepair({ existing, klOrder, deps: deps(), now: () => new Date('2026-10-05T12:00:00Z') });
    expect(plan.action).toBe('heal');
    expect(plan.patch.totalAmount).toBe(21.83);
    expect(plan.patch.originalTotalAmount).toBe(534.14);
    expect(plan.patch.items[0]).toMatchObject({ id: 'AVY-2026-1559-1', weight: 0.5, priceBrutto: 21.83, originalPrice: 534.14 });
    expect(plan.patch['ops.currencyHeal'].reason).toBe('legacy_unconverted');
  });

  it('Euro-Auftrag → uebersprungen', async () => {
    const kl = { ...klOrder, storefront: 'de', order_units: [{ ...klOrder.order_units[0], currency: 'EUR', storefront: 'de', price: 1999 }] };
    const plan = await planRepair({ existing, klOrder: kl, deps: deps() });
    expect(plan).toMatchObject({ action: 'skip', reason: 'euro' });
  });

  it('bereits umgerechnet → uebersprungen', async () => {
    const done = { ...existing, totalAmount: 21.83, originalCurrency: 'CZK', exchangeRatePending: false };
    const plan = await planRepair({ existing: done, klOrder, deps: deps() });
    expect(plan).toMatchObject({ action: 'skip', reason: 'bereits_umgerechnet' });
  });

  it('kein Kurs → uebersprungen, nie CZK als Euro schreiben', async () => {
    const plan = await planRepair({ existing, klOrder, deps: deps({ currency: 'CZK', rate: null, rateDate: null, source: 'none', pending: true }) });
    expect(plan).toMatchObject({ action: 'skip', reason: 'kein_kurs' });
  });
});
