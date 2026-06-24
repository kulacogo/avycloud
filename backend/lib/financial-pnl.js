'use strict';

/**
 * Reine P&L-Assembly für den Admin-Finanzbericht — KEIN Doppelzählen.
 *
 * Formeln gespiegelt aus routes/orders.js (/dashboard/metrics), aber an EINEM Ort,
 * aus rohen Primitiven, damit die Reihenfolge-Mutation der Route uns nicht trifft:
 *
 *   Umsatz brutto        = grossRevenue (ROH, vor Retouren)
 *   eBay-Payout          = ebayNetWindow (Finances API, exakt)  ODER  max(0, gross−kauflandGross) × 0.75
 *   Auszahlung           = eBay-Payout + Kaufland-Payout
 *   Marktplatz-Gebühren  = Umsatz − Auszahlung
 *   Versand brutto       = shippingNetto × 1.19
 *   Rohgewinn            = Auszahlung − Versand − COGS − Retouren
 *   Marge %              = Rohgewinn / Umsatz × 100
 *
 * Jede Größe genau einmal: Gebühren stecken in der Auszahlung, Retouren/Versand/COGS
 * sind getrennte Abzüge. Retouren werden NIE vom Umsatz abgezogen (eigene Zeile).
 */

const EBAY_FALLBACK_FEE_PCT = 0.25; // ~14% Transaktion + ~11% Anzeigen (siehe orders.js)

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}
function round2(x) {
  return Math.round((num(x) + Number.EPSILON) * 100) / 100;
}
function round1(x) {
  return Math.round((num(x) + Number.EPSILON) * 10) / 10;
}

const DEFAULT_FEE_RATE_EBAY = 0.11; // eBay.de Verkaufsprovision (Basis, ohne Promoted Listings)
const DEFAULT_FEE_RATE_KAUFLAND = 0.1666; // 14 % Provision × 1,19 MwSt

function buildPnl({
  grossRevenue = 0,
  ebayGross = null,
  kauflandGross = 0,
  feeRateEbay = DEFAULT_FEE_RATE_EBAY,
  feeRateKaufland = DEFAULT_FEE_RATE_KAUFLAND,
  realPayout = null,
  realPayoutSource = null,
  returnsValue = 0,
  shippingNetto = null,
  cogs = 0,
} = {}) {
  const umsatzBrutto = round2(grossRevenue);
  const kGross = num(kauflandGross);
  const eGross = ebayGross != null ? num(ebayGross) : Math.max(0, num(grossRevenue) - kGross);

  // Gebühren aus recherchierten Sätzen (accrual, bestelldatum-konsistent) — NICHT aus der
  // Auszahlung abgeleitet (die hinkt per Settlement-Datum hinterher → kurze Fenster ergäben
  // negative Gebühren). Die echte SevDesk-Auszahlung dient als exakter Cross-Check.
  const fees = round2(eGross * num(feeRateEbay) + kGross * num(feeRateKaufland));
  const expectedPayout = round2(umsatzBrutto - fees);

  const auszahlungReal = realPayout != null ? round2(realPayout) : null;
  const auszahlung = auszahlungReal != null ? auszahlungReal : expectedPayout;
  const auszahlungSource = auszahlungReal != null ? (realPayoutSource || 'sevdesk') : 'rates';
  const payoutVariance = auszahlungReal != null ? round2(auszahlungReal - expectedPayout) : null;

  const versandBrutto = shippingNetto != null ? round2(num(shippingNetto) * 1.19) : null;
  const retouren = round2(returnsValue);
  const cogsValue = round2(cogs);

  const rohgewinn = round2(umsatzBrutto - fees - cogsValue - num(versandBrutto) - retouren);
  const margePct = umsatzBrutto > 0 ? round1((rohgewinn / umsatzBrutto) * 100) : null;

  return {
    umsatzBrutto,
    marketplaceFees: fees,
    feeSource: 'rates',
    auszahlung, // shown figure: real SevDesk if available, else expected (rates)
    auszahlungReal, // exact SevDesk bank credits, or null
    auszahlungSource, // 'sevdesk' | 'rates'
    expectedPayout, // Umsatz − Gebühren (accrual)
    payoutVariance, // real − expected (settlement timing / data gap), or null
    versandBrutto,
    retouren,
    cogs: cogsValue,
    rohgewinn,
    margePct,
  };
}

module.exports = { buildPnl, EBAY_FALLBACK_FEE_PCT, DEFAULT_FEE_RATE_EBAY, DEFAULT_FEE_RATE_KAUFLAND };
