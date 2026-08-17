'use strict';

/**
 * Einkaufspreis je Einheit aus den Losen.
 *
 * Vorgabe des Betreibers: "Los Betrag / anzahl der artikel einheiten die dem
 * Los zugewiesen sind".
 *
 * Hintergrund: KEIN einziges der 1.833 Produkte hat einen eigenen
 * Einkaufspreis. Gerechnet wurde mit einer Paletten-Pauschale (8,51 € brutto je
 * Einheit) aus der Zeit vor der Los-Umstellung. Gemessen je Los:
 *   NL-0626 5,39 · L-072620 11,99 · L-072638 12,76 · L-072612 31,73 ·
 *   L-072693 33,23 · L-072643 129,65 (Euro brutto je Einheit)
 * Faktor 24 — die Pauschale ist im Mittel zufaellig richtig und im Einzelfall
 * grob falsch.
 */

const { buildLotUnitCosts, lotUnitCostForProduct } = require('../lib/lot-cost');

describe('Einkaufspreis je Einheit', () => {
  it('rechnet Los-Betrag durch Einheiten — die Formel des Betreibers', () => {
    const kosten = buildLotUnitCosts(
      [{ code: 'NL-0626', ekBrutto: 14000 }],
      new Map([['NL-0626', { bestand: 2597, verkauft: 0 }]]),
    );
    expect(kosten.get('NL-0626').brutto).toBe(5.39);
    expect(kosten.get('NL-0626').netto).toBe(4.53); // 5,39 / 1,19
  });

  it('teilt durch die URSPRUENGLICHE Menge, nicht den Restbestand', () => {
    // Sonst stiege der Stueckpreis mit jedem Verkauf, obwohl sich am Einkauf
    // nichts geaendert hat. Ein fast leergekauftes Los bekaeme absurde Werte.
    const nurBestand = buildLotUnitCosts(
      [{ code: 'L-1', ekBrutto: 1000 }],
      new Map([['L-1', { bestand: 10, verkauft: 0 }]]),
    );
    const mitVerkauft = buildLotUnitCosts(
      [{ code: 'L-1', ekBrutto: 1000 }],
      new Map([['L-1', { bestand: 10, verkauft: 90 }]]),
    );
    expect(nurBestand.get('L-1').brutto).toBe(100);
    expect(mitVerkauft.get('L-1').brutto).toBe(10);
    expect(mitVerkauft.get('L-1').basis).toBe(100);
  });

  it('bildet die gemessenen Lose korrekt ab', () => {
    const kosten = buildLotUnitCosts(
      [
        { code: 'L-072643', ekBrutto: 2463.3 },
        { code: 'L-072620', ekBrutto: 2326.45 },
      ],
      new Map([
        ['L-072643', { bestand: 19, verkauft: 0 }],
        ['L-072620', { bestand: 194, verkauft: 0 }],
      ]),
    );
    expect(kosten.get('L-072643').brutto).toBe(129.65);
    expect(kosten.get('L-072620').brutto).toBe(11.99);
  });

  it('ueberspringt Lose ohne Einkaufspreis oder ohne Menge', () => {
    const kosten = buildLotUnitCosts(
      [
        { code: 'L-leer', ekBrutto: 0 },
        { code: 'L-ohne-menge', ekBrutto: 500 },
      ],
      new Map([['L-ohne-menge', { bestand: 0, verkauft: 0 }]]),
    );
    expect(kosten.size).toBe(0);
  });

  it('vertraegt leere Eingaben', () => {
    expect(buildLotUnitCosts(null, null).size).toBe(0);
    expect(buildLotUnitCosts([], new Map()).size).toBe(0);
  });
});

describe('Zuordnung Produkt zu Los-Preis', () => {
  const kosten = buildLotUnitCosts(
    [{ code: 'NL-0626', ekBrutto: 14000 }],
    new Map([['NL-0626', { bestand: 2597, verkauft: 0 }]]),
  );

  it('findet den Preis ueber die Los-Zuordnung am Produkt', () => {
    const p = { ops: { sourceLot: 'NL-0626' } };
    expect(lotUnitCostForProduct(p, kosten)).toEqual({ netto: 4.53, brutto: 5.39, quelle: 'los' });
  });

  it('liefert nichts ohne Los-Zuordnung', () => {
    expect(lotUnitCostForProduct({ ops: {} }, kosten)).toBe(null);
    expect(lotUnitCostForProduct({}, kosten)).toBe(null);
    expect(lotUnitCostForProduct(null, kosten)).toBe(null);
  });

  it('liefert nichts fuer ein unbekanntes Los', () => {
    expect(lotUnitCostForProduct({ ops: { sourceLot: 'GIBT-ES-NICHT' } }, kosten)).toBe(null);
  });
});
