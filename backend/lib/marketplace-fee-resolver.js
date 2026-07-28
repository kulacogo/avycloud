'use strict';

/**
 * Marktplatz-Gebühren — EINE Auflösung für die Gesamt-P&L und die Marktplatz-Zeilen.
 *
 * WARUM ES DIESES MODUL GIBT (Incident 2026-07-28):
 * Vorher wurden Gebühren als Residuum gerechnet: `Umsatz − Retouren − Auszahlung`.
 * `Umsatz` ist aber ACCRUAL (Bestelldatum, lib/firestore.js), `Auszahlung` ist CASH
 * (Bank-Wertstellung, lib/sevdesk.js:251 — dort im Docstring selbst vermerkt). Über ein
 * offenes Fenster rechnet diese Differenz nicht Gebühren aus, sondern den Settlement-Lag.
 * Produktion zeigte dadurch 8.121 € Gebühren auf 10.796 € Umsatz (75 %) und einen
 * Scheinverlust von −761 €, obwohl real ~1.338 € Gebühren und ~+6.022 € Gewinn anlagen.
 *
 * LEITER pro Marktplatz (unabhängig voneinander ausgewertet):
 *   1. 'measured' — echte Gebührenpositionen des Marktplatzes (bester Wert)
 *   2. 'flow'     — Umsatz − Retouren − Auszahlung, NUR wenn das Fenster nachweislich
 *                   abgerechnet ist. Bewahrt den Owner-Entscheid aus 4971fba9
 *                   (period-specific, inkl. Ads/Promoted Listings/Store-Fees).
 *   3. 'rates'    — konfigurierte Sätze (accrual, immer definiert)
 *
 * Das Plausibilitätsband ist ein HARTES Gate in BEIDE Richtungen. Es fängt den
 * Settlement-Lag (Quote zu hoch) genauso wie den in 4971fba9 dokumentierten
 * Kaufland-Undercount (negative Gebühren). Es darf durch kein UI-Redesign entfernt
 * werden — es ist die einzige Stelle, die eine absurde Gebührenquote stoppt.
 */

const FEE_PCT_MIN = 0.02; // < 2 % vom Umsatz: kein Marktplatz arbeitet gratis
const FEE_PCT_MAX = 0.40; // > 40 %: Datenfehler, keine Gebühr
const SETTLEMENT_LAG_DAYS = 14;
const MARKETS = ['ebay', 'kaufland', 'other'];

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

/**
 * Ist das Fenster alt genug, dass seine Verkäufe ausgezahlt sein MÜSSEN?
 * Fail-closed: ohne verwertbares Fensterende gilt „nicht abgerechnet", damit der
 * Flow-Pfad im Zweifel NICHT greift.
 *
 * @param {string|null} windowEndIso - Ende des Berichtsfensters (exklusiv)
 * @returns {boolean}
 */
function isWindowSettled(windowEndIso, { nowMs = Date.now(), settlementLagDays = SETTLEMENT_LAG_DAYS } = {}) {
  const end = windowEndIso ? Date.parse(windowEndIso) : NaN;
  if (!Number.isFinite(end)) return false;
  return end + num(settlementLagDays) * 86400000 <= num(nowMs);
}

/**
 * Gebühren für EINEN Marktplatz auflösen.
 * @returns {{fees:number, feeSource:'measured'|'flow'|'rates', warning:string|null}}
 */
function resolveOne({
  key = 'unknown',
  gross = 0,
  retouren = 0,
  payout = null,
  measured = null,
  rate = 0,
  windowSettled = false,
} = {}) {
  const g = num(gross);
  const rateFees = round2(g * num(rate));
  const pctOf = (f) => (g > 0 ? num(f) / g : null);
  const plausible = (f) => {
    const p = pctOf(f);
    return p != null && p >= FEE_PCT_MIN && p <= FEE_PCT_MAX;
  };
  const label = { ebay: 'eBay', kaufland: 'Kaufland', other: 'Sonstige', all: 'Gesamt' }[key] || key;

  // 1. Gemessen — echte Gebührenbuchungen des Marktplatzes.
  if (measured != null && Number.isFinite(Number(measured))) {
    const f = round2(Math.abs(Number(measured)));
    if (plausible(f)) return { fees: f, feeSource: 'measured', warning: null };
    return {
      fees: rateFees,
      feeSource: 'rates',
      warning: `${label}: gemessene Gebühren unplausibel (${round1((pctOf(f) || 0) * 100)} % vom Umsatz) — Satz genutzt.`,
    };
  }

  // 2. Flow — nur über einem abgerechneten Fenster aussagekräftig.
  if (windowSettled && payout != null) {
    const f = round2(g - num(retouren) - num(payout));
    if (plausible(f)) return { fees: f, feeSource: 'flow', warning: null };
    return {
      fees: rateFees,
      feeSource: 'rates',
      warning: `${label}: Auszahlung passt nicht zum Umsatz (${round1((pctOf(f) || 0) * 100)} % Gebührenquote) — Satz genutzt.`,
    };
  }

  // 3. Sätze — immer definiert, immer accrual-konsistent.
  return { fees: rateFees, feeSource: 'rates', warning: null };
}

/**
 * Gebühren für alle Marktplätze auflösen.
 *
 * @param {object} opts
 * @param {object} opts.marketplaces - { ebay:{gross,retouren,payout,measured,rate}, kaufland:{…}, other:{…} }
 * @param {string} opts.windowEndIso - Ende des Berichtsfensters (exklusiv)
 * @returns {{total:number, byMarketplace:object, feeSource:string, warnings:string[], windowSettled:boolean}}
 */
function resolveFees({
  marketplaces = {},
  windowEndIso = null,
  nowMs = Date.now(),
  settlementLagDays = SETTLEMENT_LAG_DAYS,
} = {}) {
  const windowSettled = isWindowSettled(windowEndIso, { nowMs, settlementLagDays });
  const byMarketplace = {};
  const warnings = [];
  const sources = new Set();
  let total = 0;

  for (const key of MARKETS) {
    const m = marketplaces[key] || {};
    const r = resolveOne({ ...m, key, windowSettled });
    const gross = num(m.gross);
    byMarketplace[key] = {
      fees: r.fees,
      feeSource: r.feeSource,
      feePct: gross > 0 ? round1((r.fees / gross) * 100) : null,
    };
    if (r.warning) warnings.push(r.warning);
    // Nur Marktplätze mit Umsatz prägen die Gesamtquelle — sonst meldet ein
    // leerer Marktplatz 'rates' und verwässert ein sauberes 'flow'.
    if (gross > 0) sources.add(r.feeSource);
    total += r.fees;
  }

  const feeSource = sources.size === 0 ? 'rates' : sources.size === 1 ? [...sources][0] : 'mixed';
  return { total: round2(total), byMarketplace, feeSource, warnings, windowSettled };
}

module.exports = {
  resolveFees,
  resolveOne,
  isWindowSettled,
  FEE_PCT_MIN,
  FEE_PCT_MAX,
  SETTLEMENT_LAG_DAYS,
  MARKETS,
};
