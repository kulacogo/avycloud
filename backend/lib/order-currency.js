'use strict';

/**
 * order-currency.js — Marktplatz-Bestellungen in Fremdwaehrung in Euro fuehren.
 *
 * VORFALL 2026-10-05 (Kaufland.cz, Bestellung M53KUW5): der Kaeufer zahlte 534,14 CZK.
 * `mapKauflandOrder` setzte `currency: 'EUR'` fest und nahm `unit.price / 100` als Euro —
 * Bestellliste, Dashboard-Umsatz, Finanzbericht, Tracking-Pflicht ab 10 € und Rechnung sahen
 * einen Auftrag ueber 534,14 Euro (richtig: ≈ 21,83 €, EZB-Kurs 24,470 vom 02.10.2026).
 * Kaufland liefert je Position `currency` (EUR|CZK|PLN) und `storefront`; `price`,
 * `revenue_gross`, `revenue_net`, `shipping_rate` sind Minor Units der Positionswaehrung.
 *
 * ENTSCHEIDUNG: `totalAmount`, `items[].priceBrutto` und `currency` sind IMMER Euro.
 * Rund 25 Lesepfade summieren `totalAmount` blind als Euro — sie alle auf Mehrwaehrung
 * umzubauen waere ein Breitband-Eingriff in Yellow-Zone-Dateien. Der Originalbetrag bleibt
 * ADDITIV erhalten (`originalCurrency`, `originalTotalAmount`, `exchangeRate`,
 * `exchangeRateDate`, `exchangeRateSource`, `exchangeRatePending`, `currencyConvertedAt`;
 * je Position `originalPrice`, `originalCurrency`). Euro-Auftraege bekommen nur `storefront`
 * dazu — sonst Byte fuer Byte wie bisher.
 *
 * Diese Datei ist REIN — kein Firestore, kein Netz. Den Kurs liefert lib/fx-rates.js.
 */

const { convertToEur } = require('./fx-rates');
const { computeOrderFinancials } = require('./order-financials');

/** Waehrung je Kaufland-Storefront (swagger Storefront-Enum). Slowakei und Oesterreich zahlen in Euro. */
const STOREFRONT_CURRENCY = Object.freeze({
  de: 'EUR', at: 'EUR', sk: 'EUR', fr: 'EUR', it: 'EUR', es: 'EUR', nl: 'EUR',
  cz: 'CZK', pl: 'PLN',
});

const CANCELLED_STATUSES = new Set(['cancelled', 'storniert']);

function normCurrency(value) {
  const s = String(value == null ? '' : value).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : '';
}

function isMoney(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Notbremse: nur EXAKT 'off' schaltet ab — ein Tippfehler darf keine CZK als Euro speichern. */
function currencyConversionEnabled() {
  return String(process.env.ORDER_CURRENCY_CONVERSION || '').trim() !== 'off';
}

/**
 * Waehrung einer Kaufland-Bestellposition: das Feld `currency` der Position, sonst die
 * Storefront (Position, dann Bestellung), sonst Euro — exakt das bisherige Verhalten
 * fuer kaufland.de.
 */
function resolveUnitCurrency(unit, order) {
  const direct = normCurrency(unit && unit.currency);
  if (direct) return direct;
  const storefront = String((unit && unit.storefront) || (order && order.storefront) || '').trim().toLowerCase();
  return STOREFRONT_CURRENCY[storefront] || 'EUR';
}

/**
 * Rechnet eine zugeordnete Bestellung (mapKauflandOrder-Format) in Euro um.
 * Euro-Bestellungen kommen UNVERAENDERT zurueck (dieselbe Referenz).
 * Ohne brauchbaren Kurs bleiben die Betraege in Fremdwaehrung — sichtbar als
 * `exchangeRateSource: 'none'` + `exchangeRatePending: true`, nie still als Euro.
 *
 * @param {object} order
 * @param {{rate: number|null, rateDate?: string|null, source?: string, pending?: boolean}} rateInfo
 */
function convertOrderToEur(order, rateInfo, { now = () => new Date() } = {}) {
  if (!order || typeof order !== 'object') return order;
  const ccy = normCurrency(order.currency) || 'EUR';
  if (ccy === 'EUR') return order;

  const rate = rateInfo ? Number(rateInfo.rate) : NaN;
  const haveRate = Number.isFinite(rate) && rate > 0;
  const items = Array.isArray(order.items) ? order.items : [];

  if (!haveRate) {
    return {
      ...order,
      originalCurrency: ccy,
      originalTotalAmount: isMoney(order.totalAmount) ? order.totalAmount : null,
      exchangeRate: null,
      exchangeRateDate: null,
      exchangeRateSource: 'none',
      exchangeRatePending: true,
      currencyConvertedAt: null,
    };
  }

  const convertedItems = items.map((item) => {
    const price = item ? item.priceBrutto : null;
    const hasPrice = isMoney(price);
    return {
      ...item,
      priceBrutto: hasPrice ? convertToEur(price, rate) : (price ?? null),
      currency: 'EUR',
      originalPrice: hasPrice ? price : (price ?? null),
      originalCurrency: ccy,
    };
  });

  return {
    ...order,
    items: convertedItems,
    totalAmount: isMoney(order.totalAmount) ? convertToEur(order.totalAmount, rate) : (order.totalAmount ?? null),
    shippingCost: isMoney(order.shippingCost) ? convertToEur(order.shippingCost, rate) : (order.shippingCost ?? null),
    currency: 'EUR',
    originalCurrency: ccy,
    originalTotalAmount: isMoney(order.totalAmount) ? order.totalAmount : null,
    exchangeRate: rate,
    exchangeRateDate: rateInfo.rateDate || null,
    exchangeRateSource: rateInfo.source || 'ecb',
    exchangeRatePending: Boolean(rateInfo.pending),
    currencyConvertedAt: now().toISOString(),
  };
}

/**
 * Die Zusatzfelder fuer das Auftragsdokument — nie `undefined` (der Firestore-Client laeuft
 * ohne ignoreUndefinedProperties; EIN undefined-Feld laesst den ganzen Schreibvorgang scheitern).
 * Euro-Auftraege liefern hoechstens `storefront`.
 */
function currencyFieldsOf(order) {
  const out = {};
  if (!order || typeof order !== 'object') return out;
  if (order.storefront) out.storefront = String(order.storefront);
  if (order.originalCurrency) {
    out.originalCurrency = String(order.originalCurrency);
    out.originalTotalAmount = isMoney(order.originalTotalAmount) ? order.originalTotalAmount : null;
    out.exchangeRate = isMoney(order.exchangeRate) ? order.exchangeRate : null;
    out.exchangeRateDate = order.exchangeRateDate || null;
    out.exchangeRateSource = order.exchangeRateSource || null;
    out.exchangeRatePending = Boolean(order.exchangeRatePending);
    out.currencyConvertedAt = order.currencyConvertedAt || null;
  }
  return out;
}

/**
 * Muss der 30-Tage-Abgleich die Betraege eines vorhandenen Auftrags nachziehen?
 *  - Altbestand (nie umgerechnet: kein `originalCurrency`, CZK als EUR gespeichert) → ja,
 *    auch mit Notkurs (21,80 € pending ist besser als 534,14 €).
 *  - Mit Notkurs gespeichert (`exchangeRatePending`) → ja, sobald ein ECHTER Kurs da ist;
 *    nicht, wenn wieder nur der Notkurs kommt (kein Flip-Flop).
 *  - Bereits echt umgerechnet → nie (Betraege bleiben stabil, auch wenn die EZB den
 *    Montagskurs nachreicht).
 *  - Die frische Zuordnung hat KEINEN Kurs (`currency` noch Fremdwaehrung) → nie: niemals
 *    Fremdwaehrung als Euro schreiben.
 */
function needsCurrencyHeal(existing, fresh) {
  if (!existing || typeof existing !== 'object' || !fresh || typeof fresh !== 'object') return false;
  const original = normCurrency(fresh.originalCurrency);
  if (!original || original === 'EUR') return false;
  if (normCurrency(fresh.currency) !== 'EUR') return false;
  if (!(Number(fresh.exchangeRate) > 0) || fresh.exchangeRateSource === 'none') return false;

  // "Nie umgerechnet" heisst: kein originalCurrency (Altbestand vor dem 05.10.2026) ODER das
  // Dokument fuehrt noch die Fremdwaehrung selbst (gespeichert ohne jeden Kurs, source 'none').
  // Beide fuehren Fremdwaehrungsbetraege, die alle Lesepfade als Euro lesen — jeder
  // brauchbare Kurs (auch der Notkurs) ist besser als das.
  const legacy = !existing.originalCurrency || normCurrency(existing.currency) !== 'EUR';
  const pending = existing.exchangeRatePending === true;
  if (legacy) return true;
  if (!pending) return false;
  return !fresh.exchangeRatePending;
}

/**
 * Der Nachzieh-Patch (fuer `ref.update()` — dotted keys!): Betrag, Waehrung, Zusatzfelder,
 * Positionspreise (Zuordnung ueber unitId, Rest der Position bleibt), Netto-Stand bei
 * Erstattungen, Nachvollziehbarkeit unter `ops.currencyHeal`.
 */
function buildCurrencyHealPatch(existing, fresh, { now = () => new Date() } = {}) {
  const at = now().toISOString();
  const reason = existing && existing.originalCurrency ? 'pending_rate_replaced' : 'legacy_unconverted';
  const totalAmount = isMoney(fresh.totalAmount) ? fresh.totalAmount : null;

  const patch = {
    totalAmount,
    currency: 'EUR',
    ...currencyFieldsOf(fresh),
    updatedAt: at,
  };

  const existingItems = Array.isArray(existing && existing.items) ? existing.items : [];
  if (existingItems.length) {
    const freshItems = Array.isArray(fresh.items) ? fresh.items : [];
    const byUnit = new Map();
    for (const fi of freshItems) {
      if (fi && fi.unitId != null) byUnit.set(String(fi.unitId), fi);
    }
    patch.items = existingItems.map((item, idx) => {
      const key = item && item.unitId != null ? String(item.unitId) : null;
      let match = key && byUnit.has(key) ? byUnit.get(key) : null;
      // Alt-Positionen ohne unitId: nur ueber die Position, wenn auch die frische keine traegt.
      if (!match && !key && freshItems[idx] && freshItems[idx].unitId == null) match = freshItems[idx];
      if (!match) return item;
      return {
        ...item,
        priceBrutto: isMoney(match.priceBrutto) ? match.priceBrutto : null,
        currency: 'EUR',
        originalPrice: isMoney(match.originalPrice) ? match.originalPrice : null,
        originalCurrency: match.originalCurrency || fresh.originalCurrency,
      };
    });
  }

  const refunds = Array.isArray(existing && existing.marketplaceRefunds) ? existing.marketplaceRefunds : [];
  if (refunds.length) {
    const f = computeOrderFinancials({
      totalAmount,
      refunds,
      cancelled: CANCELLED_STATUSES.has(String(existing.omsStatus || '')),
    });
    patch.grossAmount = f.grossAmount;
    patch.refundedTotal = f.refundedTotal;
    patch.netAmount = f.netAmount;
    patch.financialsUpdatedAt = at;
    if (f.overRefunded) patch.financialsOverRefunded = true;
  }

  patch['ops.currencyHeal'] = {
    at,
    reason,
    from: {
      totalAmount: isMoney(existing && existing.totalAmount) ? existing.totalAmount : null,
      currency: (existing && existing.currency) || null,
    },
    to: { totalAmount, currency: 'EUR' },
    rate: isMoney(fresh.exchangeRate) ? fresh.exchangeRate : null,
    rateDate: fresh.exchangeRateDate || null,
    source: fresh.exchangeRateSource || null,
  };

  assertNoUndefined(patch);
  return patch;
}

/**
 * Kaufland-Retoure (lib/kaufland-return-detail.js) in Euro: `refundAmount` kommt aus
 * `order_unit.price` (Positionswaehrung). Buchungsbasierte Betraege sind schon Euro —
 * dann werden nur die Erloese umgerechnet.
 */
function convertReturnDetailToEur(detail, rateInfo) {
  if (!detail || typeof detail !== 'object') return detail;
  const ccy = normCurrency(detail.currency);
  if (!ccy || ccy === 'EUR') return detail;

  const rate = rateInfo ? Number(rateInfo.rate) : NaN;
  const haveRate = Number.isFinite(rate) && rate > 0;
  const bookingBased = detail.amountBasis === 'kaufland_booking_refund';
  const originalRefund = bookingBased ? null : (isMoney(detail.refundAmount) ? detail.refundAmount : null);

  // 'order' = Kurs des verknuepften Auftrags, 'return_date' = EZB-Kurs des Retouren-Tages.
  const basis = (rateInfo && rateInfo.basis) || 'return_date';

  if (!haveRate) {
    return {
      ...detail,
      originalCurrency: ccy,
      originalRefundAmount: originalRefund,
      exchangeRate: null,
      exchangeRateDate: null,
      exchangeRateSource: 'none',
      exchangeRatePending: true,
      exchangeRateBasis: basis,
    };
  }

  const conv = (v) => (isMoney(v) ? convertToEur(v, rate) : (v ?? null));
  const positionen = (Array.isArray(detail.positionen) ? detail.positionen : []).map((p) => ({
    ...p,
    priceGross: conv(p && p.priceGross),
    revenueGross: conv(p && p.revenueGross),
    revenueNet: conv(p && p.revenueNet),
    originalPriceGross: isMoney(p && p.priceGross) ? p.priceGross : null,
    originalCurrency: ccy,
  }));

  return {
    ...detail,
    refundAmount: bookingBased ? detail.refundAmount : conv(detail.refundAmount),
    revenueGross: conv(detail.revenueGross),
    revenueNet: conv(detail.revenueNet),
    positionen,
    currency: 'EUR',
    originalCurrency: ccy,
    originalRefundAmount: originalRefund,
    exchangeRate: rate,
    exchangeRateDate: rateInfo.rateDate || null,
    exchangeRateSource: rateInfo.source || 'ecb',
    exchangeRatePending: Boolean(rateInfo.pending),
    exchangeRateBasis: basis,
  };
}

/** Wirft, wenn irgendwo `undefined` steckt — ein solches Feld kippt jeden Firestore-Schreibvorgang. */
function assertNoUndefined(value, path = '') {
  if (value === undefined) throw new Error(`undefined at ${path || '<root>'}`);
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUndefined(v, path ? `${path}.${i}` : String(i)));
    return;
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) assertNoUndefined(v, path ? `${path}.${k}` : k);
  }
}

module.exports = {
  STOREFRONT_CURRENCY,
  resolveUnitCurrency,
  currencyConversionEnabled,
  convertOrderToEur,
  currencyFieldsOf,
  needsCurrencyHeal,
  buildCurrencyHealPatch,
  convertReturnDetailToEur,
  assertNoUndefined,
};
