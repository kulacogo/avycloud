'use strict';

/**
 * Reine P&L-Assembly für den Admin-Finanzbericht — EINE Buchhaltungsbasis.
 *
 * GRUNDSATZ (seit Incident 2026-07-28):
 *   Der Bericht rechnet auf ACCRUAL. Cash ist eine EIGENE Größe. Gebühren sind
 *   gemessen oder modelliert — NIE ein Residuum. Die Differenz zwischen Erwartung
 *   und Bankeingang hat einen eigenen Namen: `offeneAuszahlung`.
 *
 *   Umsatz − Retouren − Gebühren                    = Erwartete Auszahlung  (accrual)
 *   Erwartete Auszahlung − Ist-Auszahlung (Bank)    = Offene Auszahlung     (Timing)
 *   Umsatz − Retouren − Gebühren − Ware − Versand   = Rohgewinn             (accrual)
 *
 * Damit schließt der Balken „Wohin geht der Umsatz?" per Konstruktion bei 100 %.
 *
 * VORHER war `marketplaceFees = umsatzBrutto − retouren − auszahlung`. Das subtrahiert
 * eine CASH-Größe (Bank-Wertstellung) von einer ACCRUAL-Größe (Bestelldatum) und bucht
 * jeden Settlement-Lag als Gebühr. Produktion zeigte 75 % Gebührenquote und einen
 * Scheinverlust. Ebenso war `rohgewinn = auszahlung − …` — der Gewinn hing am
 * Zahlungszyklus der Marktplätze statt am Verkauf. Beides ist hier behoben.
 *
 * Gebühren-Leiter + Plausibilitätsband: siehe lib/marketplace-fee-resolver.js
 */

const {
  resolveFees,
  resolveOne,
  isWindowSettled,
  SETTLEMENT_LAG_DAYS,
} = require('./marketplace-fee-resolver');

const EBAY_FALLBACK_FEE_PCT = 0.25; // ~14% Transaktion + ~11% Anzeigen (siehe orders.js)

/** Regelsteuersatz. Der Betrieb verkauft ausnahmslos mit 19 % (Owner-Aussage). */
const VAT_RATE = 0.19;

/**
 * Notbremse fuer die Netto-Gewinnrechnung.
 *
 * Nur der exakte Wert 'brutto' schaltet auf die alte, gemischte Rechnung
 * zurueck — bewusst streng (gleiche Haerte wie AUTO_INVOICE): ein Tippfehler in
 * der Konfiguration darf eine ausgewiesene Finanzzahl nicht still umstellen.
 */
function nettoPnlAktiv() {
  return String(process.env.FINANCE_PNL_BASIS || '').trim().toLowerCase() !== 'brutto';
}

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

// Ab dieser Deckung (Ist/Erwartet) gilt ein Fenster als abgerechnet.
const SETTLEMENT_FULL_PCT = 92;

/**
 * Cash-Seite bewerten: Ist, Lücke, Deckung, Status — strikt getrennt von der
 * Accrual-Rechnung. Ohne bekannte Auszahlung wird NICHTS behauptet ('unknown').
 */
function assessSettlement({ auszahlungErwartet, realPayout }) {
  if (realPayout == null) {
    return {
      auszahlungIst: null,
      offeneAuszahlung: null,
      settlementCoveragePct: null,
      settlementStatus: 'unknown',
    };
  }
  const ist = round2(realPayout);
  const erwartet = num(auszahlungErwartet);
  const cov = erwartet > 0 ? round1((ist / erwartet) * 100) : null;
  let settlementStatus;
  if (cov == null) settlementStatus = 'unknown';
  else if (cov >= SETTLEMENT_FULL_PCT) settlementStatus = 'settled';
  else if (ist <= 0) settlementStatus = 'pending';
  else settlementStatus = 'partial';
  return {
    auszahlungIst: ist,
    offeneAuszahlung: round2(erwartet - ist),
    settlementCoveragePct: cov,
    settlementStatus,
  };
}

/**
 * Gebühren aggregiert auflösen, wenn keine Marktplatz-Aufschlüsselung vorliegt.
 * Nutzt dieselbe Leiter und dasselbe Plausibilitätsband wie der Resolver, nur auf
 * dem Gesamtumsatz. Der Satz wird aus den bereits berechneten Satz-Gebühren
 * zurückgerechnet, damit die je-Marktplatz-Sätze erhalten bleiben.
 *
 * @returns {{total:number, byMarketplace:object, feeSource:string, warnings:string[], windowSettled:boolean}}
 */
function resolveAggregateFees({
  umsatzBrutto = 0,
  retouren = 0,
  realPayout = null,
  rateFees = 0,
  windowEndIso = null,
  nowMs = Date.now(),
  settlementLagDays = SETTLEMENT_LAG_DAYS,
} = {}) {
  const windowSettled = isWindowSettled(windowEndIso, { nowMs, settlementLagDays });
  const gross = num(umsatzBrutto);
  const blendedRate = gross > 0 ? num(rateFees) / gross : 0;
  const r = resolveOne({
    key: 'all',
    gross,
    retouren,
    payout: realPayout,
    rate: blendedRate,
    windowSettled,
  });
  return {
    total: r.fees,
    byMarketplace: {},
    feeSource: r.feeSource,
    warnings: r.warning ? [r.warning] : [],
    windowSettled,
  };
}

function buildPnl({
  grossRevenue = 0,
  ebayGross = null,
  kauflandGross = 0,
  otherGross = null,
  feeRateEbay = DEFAULT_FEE_RATE_EBAY,
  feeRateKaufland = DEFAULT_FEE_RATE_KAUFLAND,
  realPayout = null,
  realPayoutSource = null,
  returnsValue = 0,
  shippingNetto = null,
  // Direkt uebergebener Bruttowert (Bankabbuchung). Ist er gesetzt, wird NICHT
  // mehr gerechnet: der Umweg netto→brutto rundet, und Briefporto der Deutschen
  // Post ist umsatzsteuerfrei — ein pauschales x1,19 waere dort schlicht falsch.
  shippingBrutto = null,
  // Retouren, die zu STORNIERTEN Auftraegen gehoeren. Sie werden hier NICHT
  // abgezogen (ihr Umsatz war nie gebucht), muessen aber sichtbar bleiben —
  // sonst zeigt das Dashboard einen Retouren-Betrag, den der Bediener auf der
  // Retouren-Seite nirgends wiederfindet.
  returnsCancelledValue = 0,
  returnsCancelledCount = 0,
  cogs = 0,
  // NEU (alle optional — Alt-Aufrufe verhalten sich unverändert sinnvoll):
  feeResolution = null, // vorberechnetes Ergebnis aus resolveFees() (Report kennt die Payouts je Marktplatz)
  windowEndIso = null, // Fensterende → entscheidet, ob der Flow-Pfad überhaupt zulässig ist
  nowMs = Date.now(),
  settlementLagDays = SETTLEMENT_LAG_DAYS,
} = {}) {
  const umsatzBrutto = round2(grossRevenue);
  const versandBrutto = shippingBrutto != null
    ? round2(num(shippingBrutto))
    : (shippingNetto != null ? round2(num(shippingNetto) * 1.19) : null);
  const retouren = round2(returnsValue);
  const cogsValue = round2(cogs);

  const kGross = num(kauflandGross);
  const eGross = ebayGross != null ? num(ebayGross) : Math.max(0, num(grossRevenue) - kGross);
  const oGross = otherGross != null ? num(otherGross) : Math.max(0, round2(umsatzBrutto - eGross - kGross));

  // Gebühren: gemessen > (abgerechneter) Flow > Sätze — NIE ein Residuum.
  //
  // Bevorzugt kommt die Auflösung aus dem Report (kennt Auszahlung + gemessene Gebühren
  // JE Marktplatz). Fehlt sie, wird hier aggregiert aufgelöst: nur so bleibt die
  // Flow-Stufe über einem abgerechneten Fenster erreichbar. Ohne diesen Pfad würde ein
  // längst abgerechneter Monat still auf Sätze zurückfallen und die Gebühren
  // UNTERschätzen (Sätze kennen keine Promoted Listings/Store-Fees) — die stille
  // Gegenrichtung desselben Fehlers.
  const fr = feeResolution || resolveAggregateFees({
    umsatzBrutto,
    retouren,
    realPayout,
    rateFees: round2(eGross * num(feeRateEbay) + kGross * num(feeRateKaufland) + oGross * num(feeRateEbay)),
    windowEndIso,
    nowMs,
    settlementLagDays,
  });

  const marketplaceFees = round2(fr.total);
  const auszahlungErwartet = round2(umsatzBrutto - retouren - marketplaceFees);
  const st = assessSettlement({ auszahlungErwartet, realPayout });

  // ── Gewinn: durchgaengig NETTO ────────────────────────────────────────────
  //
  // Bis 30.08.2026 wurde hier gemischt: Umsatz, Retouren, Gebuehren und Versand
  // BRUTTO, die Ware dagegen NETTO (lot-cost/lot-metrics teilen durch 1,19).
  // Der Gewinn enthielt damit die Umsatzsteuer, die dem Finanzamt gehoert —
  // gemessen ueber das laufende Jahr 2026: 23.779,10 € statt 19.302,33 €,
  // also 4.476,77 € zu hoch.
  //
  // Warum netto und nicht brutto die richtige Richtung ist, ist BELEGT, nicht
  // angenommen: der Betrieb verkauft mit 19 % (Owner-Aussage, bestaetigt durch
  // die eigenen Erloes-Belege — eBay 8.755,85 € mit 1.397,99 € MwSt) und zieht
  // auf der Einkaufsseite Vorsteuer (Auktionshaus Weidler KG 10.811,15 € mit
  // 1.726,15 € MwSt). Beide Seiten sind also steuerbehaftet; die einzige
  // konsistente Betrachtung ist ohne Steuer.
  //
  // Versand: `shippingNetto` wird BEVORZUGT statt brutto/1,19 — Briefporto der
  // Deutschen Post ist umsatzsteuerfrei, ein pauschaler Abschlag waere dort
  // schlicht falsch (gleiche Begruendung wie oben bei versandBrutto).
  const nettoPnl = nettoPnlAktiv();
  const entsteuern = (wert) => round2(num(wert) / (1 + VAT_RATE));

  const umsatzNetto = entsteuern(umsatzBrutto);
  const retourenNetto = entsteuern(retouren);
  const gebuehrenNetto = entsteuern(marketplaceFees);
  const versandNettoWert = shippingNetto != null
    ? round2(num(shippingNetto))
    : (versandBrutto != null ? entsteuern(versandBrutto) : null);

  const rohgewinn = nettoPnl
    ? round2(umsatzNetto - retourenNetto - gebuehrenNetto - cogsValue - num(versandNettoWert))
    : round2(umsatzBrutto - retouren - marketplaceFees - cogsValue - num(versandBrutto));
  const margenBasis = nettoPnl ? umsatzNetto : umsatzBrutto;
  const margePct = margenBasis > 0 ? round1((rohgewinn / margenBasis) * 100) : null;

  return {
    umsatzBrutto,

    // ── Netto-Sicht (ohne Umsatzsteuer) ──
    // Immer mitgeliefert, damit die Oberflaeche den Unterschied erklaeren kann,
    // statt dass eine Zahl unerklaert springt.
    umsatzNetto,
    retourenNetto,
    gebuehrenNetto,
    versandNetto: versandNettoWert,
    umsatzsteuerAnteil: round2(umsatzBrutto - umsatzNetto),
    pnlBasis: nettoPnl ? 'netto' : 'brutto',

    // ── Gebühren (neue Semantik: gemessen/modelliert, nie Residuum) ──
    marketplaceFees,
    feeSource: fr.feeSource, // 'measured' | 'flow' | 'rates' | 'mixed'
    feePctOfRevenue: umsatzBrutto > 0 ? round1((marketplaceFees / umsatzBrutto) * 100) : null,
    feeWarnings: fr.warnings || [],

    // ── Auszahlung: Accrual-Erwartung, Cash-Ist, Lücke ──
    auszahlungErwartet,
    auszahlungIst: st.auszahlungIst,
    offeneAuszahlung: st.offeneAuszahlung,
    settlementCoveragePct: st.settlementCoveragePct,
    settlementStatus: st.settlementStatus, // 'settled' | 'partial' | 'pending' | 'unknown'
    windowSettled: fr.windowSettled === true,

    // ── Bestandsfelder: Bedeutung unverändert ──
    auszahlung: st.auszahlungIst != null ? st.auszahlungIst : auszahlungErwartet,
    auszahlungReal: st.auszahlungIst,
    auszahlungSource: st.auszahlungIst != null ? (realPayoutSource || 'sevdesk') : 'rates',
    versandBrutto,
    retouren,
    retourenStorno: round2(num(returnsCancelledValue)),
    retourenStornoAnzahl: Number(returnsCancelledCount) || 0,
    retourenGesamt: round2(retouren + num(returnsCancelledValue)),
    cogs: cogsValue,
    rohgewinn,
    margePct,
  };
}

module.exports = {
  buildPnl,
  assessSettlement,
  resolveAggregateFees,
  EBAY_FALLBACK_FEE_PCT,
  DEFAULT_FEE_RATE_EBAY,
  DEFAULT_FEE_RATE_KAUFLAND,
  SETTLEMENT_FULL_PCT,
};
