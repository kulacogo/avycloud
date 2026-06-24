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

function buildPnl({
  grossRevenue = 0,
  kauflandGross = 0,
  kauflandPayout = 0,
  ebayNetWindow = null,
  returnsValue = 0,
  shippingNetto = null,
  cogs = 0,
} = {}) {
  const umsatzBrutto = round2(grossRevenue);

  const ebayGross = Math.max(0, num(grossRevenue) - num(kauflandGross));
  const ebayPayout = ebayNetWindow != null
    ? round2(ebayNetWindow)
    : round2(ebayGross * (1 - EBAY_FALLBACK_FEE_PCT));
  const auszahlung = round2(ebayPayout + num(kauflandPayout));
  const auszahlungSource = ebayNetWindow != null ? 'ebay_finances' : 'estimated';

  const marketplaceFees = round2(umsatzBrutto - auszahlung);

  const versandBrutto = shippingNetto != null ? round2(num(shippingNetto) * 1.19) : null;
  const retouren = round2(returnsValue);
  const cogsValue = round2(cogs);

  const rohgewinn = round2(auszahlung - num(versandBrutto) - cogsValue - retouren);
  const margePct = umsatzBrutto > 0 ? round1((rohgewinn / umsatzBrutto) * 100) : null;

  return {
    umsatzBrutto,
    marketplaceFees,
    auszahlung,
    auszahlungSource,
    ebayPayout,
    kauflandPayout: round2(kauflandPayout),
    versandBrutto,
    retouren,
    cogs: cogsValue,
    rohgewinn,
    margePct,
  };
}

module.exports = { buildPnl, EBAY_FALLBACK_FEE_PCT };
