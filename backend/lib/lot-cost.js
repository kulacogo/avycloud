'use strict';

/**
 * Einkaufspreis je Einheit aus der Los-Struktur.
 *
 * Vorgabe des Betreibers (17.08.2026): „Los Betrag / anzahl der artikel
 * einheiten die dem Los zugewiesen sind".
 *
 * Warum das nötig ist: KEIN einziges der 1.833 Produkte hat einen eigenen
 * Einkaufspreis. Gerechnet wurde bisher mit einer Paletten-Pauschale
 * (400 € je 47 Stück = 8,51 € brutto je Einheit) aus der Zeit vor der
 * Los-Umstellung. Im Mittel trifft sie zufällig ungefähr (8,09 €), je Los ist
 * sie aber grob falsch — gemessen:
 *
 *   NL-0626     5,39 €     L-072612   31,73 €
 *   L-072620   11,99 €     L-072693   33,23 €
 *   L-072638   12,76 €     L-072643  129,65 €
 *
 * Faktor 24 zwischen billigstem und teuerstem Los. Verkauft sich ein Artikel
 * aus L-072643, weist der Bericht 121 € zu viel Gewinn aus.
 *
 * WICHTIG — die Bezugsmenge: Teilt man nur durch den HEUTIGEN Bestand, steigt
 * der rechnerische Stückpreis mit jedem Verkauf, obwohl sich am Einkauf nichts
 * geändert hat. Ein Los, aus dem fast alles verkauft ist, bekäme absurde Werte.
 * Deshalb wird durch die URSPRÜNGLICHE Menge geteilt: heutiger Bestand plus
 * das, was aus diesem Los bereits verkauft wurde.
 */

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round(num(value) * 100) / 100;
}

/**
 * Rechnet je Los den Einkaufspreis pro Einheit aus.
 *
 * @param {Array<{code: string, ekBrutto: number}>} lose
 * @param {Map<string, {bestand: number, verkauft: number}>} mengen  Code → Mengen
 * @param {{vatRate?: number}} [opts]  Steuersatz für die Netto-Umrechnung (Standard 19 %).
 * @returns {Map<string, {brutto: number, netto: number, basis: number, bestand: number, verkauft: number}>}
 */
function buildLotUnitCosts(lose, mengen, { vatRate = 0.19 } = {}) {
  const out = new Map();
  if (!Array.isArray(lose)) return out;
  const m = mengen instanceof Map ? mengen : new Map();

  for (const los of lose) {
    const code = String(los?.code || '').trim();
    if (!code) continue;
    const ek = num(los.ekBrutto);
    if (ek <= 0) continue;

    const mengenEintrag = m.get(code) || {};
    const bestand = Math.max(0, num(mengenEintrag.bestand));
    const verkauft = Math.max(0, num(mengenEintrag.verkauft));
    // Ursprüngliche Menge — sonst wächst der Stückpreis mit jedem Verkauf.
    const basis = bestand + verkauft;
    if (basis <= 0) continue;

    const brutto = ek / basis;
    out.set(code, {
      brutto: round2(brutto),
      netto: round2(brutto / (1 + num(vatRate))),
      basis,
      bestand,
      verkauft,
    });
  }
  return out;
}

/**
 * Einkaufspreis eines Produkts — Los-Zuordnung schlägt jede Pauschale.
 *
 * @returns {{netto: number, brutto: number, quelle: 'los'}|null} null, wenn kein Los bekannt.
 */
function lotUnitCostForProduct(product, lotCosts) {
  const code = String(product?.ops?.sourceLot || '').trim();
  if (!code || !(lotCosts instanceof Map)) return null;
  const eintrag = lotCosts.get(code);
  if (!eintrag || !(eintrag.netto > 0)) return null;
  return { netto: eintrag.netto, brutto: eintrag.brutto, quelle: 'los' };
}

module.exports = { buildLotUnitCosts, lotUnitCostForProduct };
