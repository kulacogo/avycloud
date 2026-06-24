'use strict';

/**
 * Kostenmodell für den Wareneinsatz (COGS), wenn KEIN echter Einzel-Einkaufspreis
 * existiert — z. B. bei Paletten-/Lot-Einkauf (Mischpalette: ø N Artikel je Palette,
 * fester Palettenpreis). Jedem Artikel pauschal denselben Euro-Betrag zu geben wäre
 * falsch (Kugelschreiber ≠ Fernseher). Stattdessen:
 *
 *   Standard-Handelskalkulation (retail inventory method):
 *   - Ø-EK je Einheit  = Palettenpreis (netto/brutto) ÷ Einheiten je Palette
 *   - Kostenquote      = Ø-EK netto ÷ Ø-Verkaufspreis (aus dem Katalog)
 *   - Kosten je Artikel = Verkaufspreis × Kostenquote   (mode 'proportional')
 *       → teurere Artikel tragen mehr von den Palettenkosten, in Summe = echter Einkauf
 *   - mode 'flat'      = jeder Einheit der Ø-EK (einfach, aber pro Artikel ungenau)
 *
 * Ein echter `buyPrice` am Produkt schlägt das Modell immer (exakt statt Pauschale).
 * Reine Funktionen ohne Firestore — vollständig unit-getestet (cost-model.test.js).
 */

const VAT = 1.19;

const DEFAULT_COST_CONFIG = {
  mode: 'proportional', // 'proportional' | 'flat'
  vatMode: 'netto', // 'netto' (Vorsteuer abziehbar) | 'brutto'
  palletCostBrutto: 0,
  unitsPerPallet: 0,
  manualRatio: null, // optional: feste Kostenquote (0..1), überschreibt Paletten-Ableitung
  // Marktplatz-Gebührensätze (für die accrual-Gebühren der P&L; Auszahlung kommt exakt aus SevDesk).
  feeRateEbay: 0.11, // eBay.de Verkaufsprovision (Basis); bei Promoted Listings höher → anpassen
  feeRateKaufland: 0.1666, // 14 % × 1,19 MwSt
};

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}
function round2(x) {
  return Math.round((num(x) + Number.EPSILON) * 100) / 100;
}

/**
 * Leitet aus der Konfig + dem Ø-Verkaufspreis (brutto) ein anwendbares Modell ab.
 * @returns {{ mode, vatMode, avgUnitCostNetto, ratio, usable, source, avgSellPrice }}
 */
function deriveCostModel(config, avgSellPrice) {
  const cfg = { ...DEFAULT_COST_CONFIG, ...(config || {}) };
  const mode = cfg.mode === 'flat' ? 'flat' : 'proportional';
  const avgSell = num(avgSellPrice);

  // Ø-EK je Einheit aus Paletten-Eckdaten.
  const pallet = num(cfg.palletCostBrutto);
  const units = num(cfg.unitsPerPallet);
  const avgUnitCostNetto = pallet > 0 && units > 0
    ? round2((cfg.vatMode === 'brutto' ? pallet : pallet / VAT) / units)
    : 0;

  // Kostenquote: manueller Override gewinnt, sonst aus Ø-EK ÷ Ø-Verkaufspreis.
  let ratio = null;
  let source = 'none';
  if (cfg.manualRatio != null && num(cfg.manualRatio) > 0) {
    ratio = num(cfg.manualRatio);
    source = 'manual';
  } else if (avgUnitCostNetto > 0 && avgSell > 0) {
    ratio = avgUnitCostNetto / avgSell;
    source = 'pallet';
  } else if (avgUnitCostNetto > 0) {
    source = 'pallet'; // unit cost known, ratio not (no avg sell)
  }

  // Anwendbar? proportional braucht eine Quote; flat braucht nur den Ø-EK.
  const usable = mode === 'flat' ? avgUnitCostNetto > 0 : ratio != null;

  return {
    mode,
    vatMode: cfg.vatMode === 'brutto' ? 'brutto' : 'netto',
    avgUnitCostNetto,
    ratio: ratio != null ? Math.round(ratio * 10000) / 10000 : null,
    usable,
    source,
    avgSellPrice: round2(avgSell),
  };
}

/**
 * Geschätzte Stückkosten für einen Artikel mit gegebenem Verkaufspreis.
 * proportional: Verkaufspreis × Kostenquote ; flat: konstanter Ø-EK.
 */
function estimatedUnitCost(sellPrice, model) {
  if (!model || !model.usable) return 0;
  if (model.mode === 'flat') return round2(model.avgUnitCostNetto);
  if (model.ratio == null) return 0;
  return round2(num(sellPrice) * model.ratio);
}

module.exports = { deriveCostModel, estimatedUnitCost, DEFAULT_COST_CONFIG };
