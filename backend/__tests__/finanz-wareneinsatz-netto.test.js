'use strict';

/**
 * Wareneinsatz, Lagerwert und Gewinn nach der Umstellung vom 30.08.2026.
 *
 * Drei zusammenhaengende Korrekturen am Finanzbericht:
 *   a) die Bezugsmenge je Los kommt aus dem Lager-Journal statt aus 'orders'
 *   b) der Lagerwert nutzt DIESELBE Quelle wie der Wareneinsatz
 *   c) der Gewinn rechnet durchgaengig netto statt brutto/netto gemischt
 *
 * Die Zahlen stammen aus einer Messung gegen die Produktionsdaten
 * (read-only, 30.08.2026), nicht aus dem Kopf.
 */

const { losKostenFuerBericht, berechneLosKennzahlen } = require('../lib/lot-metrics');
const { buildProductCostIndex, computeOrderCogs, computeInventoryValue } = require('../lib/cogs');
const { buildPnl } = require('../lib/financial-pnl');

const kennzahlenFuer = (teil) =>
  berechneLosKennzahlen(
    { ekBrutto: teil.ekBrutto },
    {
      eingelagert: teil.eingelagert,
      rueckfuehrungen: 0,
      korrekturen: 0,
      verkauft: teil.verkauft || 0,
      sonstigeAbgaenge: teil.sonstige || 0,
      ausreisser: teil.ausreisser || 0,
    },
    { bestand: teil.bestand }
  );

describe('losKostenFuerBericht — die Bruecke zum Wareneinsatz', () => {
  it('liefert IMMER ein netto-Feld', () => {
    // lib/cogs.js liest ausschliesslich lot.netto. Fehlt es, faellt der
    // Wareneinsatz OHNE Fehlermeldung auf die Paletten-Pauschale zurueck.
    const proLos = new Map([['L-072643', kennzahlenFuer({ ekBrutto: 2463.3, eingelagert: 141, bestand: 119, verkauft: 20, sonstige: 2 })]]);
    const kosten = losKostenFuerBericht([{ code: 'L-072643', ekBrutto: 2463.3 }], proLos);

    const l = kosten.get('L-072643');
    expect(l.brutto).toBe(17.47);
    expect(l.netto).toBe(14.68); // 17,47 / 1,19 — gemessener Produktionswert
    expect(l.basis).toBe(141);
    expect(l.stimmig).toBe(true);
  });

  it('leitet netto aus dem UNGERUNDETEN brutto ab', () => {
    // Sonst summiert sich der Rundungsfehler ueber alle Positionen auf.
    const proLos = new Map([['X', kennzahlenFuer({ ekBrutto: 10, eingelagert: 3, bestand: 3 })]]);
    const l = losKostenFuerBericht([{ code: 'X', ekBrutto: 10 }], proLos).get('X');
    expect(l.brutto).toBe(3.33);
    expect(l.netto).toBe(2.8); // 3,3333/1,19 = 2,8011 → 2,80 (nicht 3,33/1,19 = 2,80)
  });

  it('reicht die Selbstauskunft eines unstimmigen Loses durch', () => {
    const proLos = new Map([['NL-0626', kennzahlenFuer({ ekBrutto: 14000, eingelagert: 4675, bestand: 2435, verkauft: 1776, sonstige: 490, ausreisser: 9 })]]);
    const l = losKostenFuerBericht([{ code: 'NL-0626', ekBrutto: 14000 }], proLos).get('NL-0626');
    expect(l.stimmig).toBe(false);
  });

  it('erfindet ohne Einkaufsbetrag oder ohne Bezugsmenge keinen Preis', () => {
    const proLos = new Map([
      ['A', kennzahlenFuer({ ekBrutto: 0, eingelagert: 10, bestand: 10 })],
      ['B', kennzahlenFuer({ ekBrutto: 100, eingelagert: 0, bestand: 0 })],
    ]);
    const kosten = losKostenFuerBericht([{ code: 'A', ekBrutto: 0 }, { code: 'B', ekBrutto: 100 }], proLos);
    expect(kosten.has('A')).toBe(false);
    expect(kosten.has('B')).toBe(false);
  });
});

describe('Wareneinsatz — unstimmiges Los gilt als geschaetzt', () => {
  const produkt = (sku, los) => ({
    identification: { sku },
    details: { identifiers: { sku } },
    ops: { sourceLot: los },
  });

  it('fuehrt ein stimmiges Los als exakt', () => {
    const lotCosts = new Map([['L-1', { netto: 10, stimmig: true }]]);
    const index = buildProductCostIndex([produkt('S1', 'L-1')], lotCosts);
    const r = computeOrderCogs({ items: [{ sku: 'S1', quantity: 2, priceBrutto: 50 }] }, index, null);
    expect(r.cogs).toBe(20);
    expect(r.exactItemCount).toBe(1);
    expect(r.estimatedItemCount).toBe(0);
  });

  it('fuehrt ein unstimmiges Los als geschaetzt — der Preis zaehlt trotzdem', () => {
    // Geht die Mengen-Bilanz nicht auf, ist die Bezugsmenge unsicher. Der Wert
    // bleibt die beste verfuegbare Schaetzung, darf aber nicht in derselben
    // Schublade landen wie ein am Produkt erfasster Einkaufspreis.
    const lotCosts = new Map([['NL-0626', { netto: 2.51, stimmig: false }]]);
    const index = buildProductCostIndex([produkt('S2', 'NL-0626')], lotCosts);
    const r = computeOrderCogs({ items: [{ sku: 'S2', quantity: 4, priceBrutto: 30 }] }, index, null);
    expect(r.cogs).toBe(10.04);
    expect(r.exactItemCount).toBe(0);
    expect(r.estimatedItemCount).toBe(1);
    expect(r.unmatchedItemCount).toBe(0);
  });

  it('laesst einen echten Einkaufspreis am Produkt weiterhin gewinnen', () => {
    const p = produkt('S3', 'NL-0626');
    p.details.pricing = { buyPrice: 7 };
    const index = buildProductCostIndex([p], new Map([['NL-0626', { netto: 2.51, stimmig: false }]]));
    const r = computeOrderCogs({ items: [{ sku: 'S3', quantity: 1, priceBrutto: 30 }] }, index, null);
    expect(r.cogs).toBe(7);
    expect(r.exactItemCount).toBe(1);
  });
});

describe('Lagerwert — dieselbe Quelle wie der Wareneinsatz', () => {
  const bestandsProdukt = (los, menge) => ({
    ops: { sourceLot: los },
    inventory: { quantity: menge },
    details: { pricing: { sellPrice: 40 } },
  });

  it('bewertet Bestand mit dem Los-Preis statt mit der Pauschale', () => {
    // Ohne diesen Weg bewertet der Bericht dieselbe Ware zweimal verschieden:
    // Wareneinsatz mit dem Los-Preis, gebundenes Kapital mit der Pauschale.
    const lotCosts = new Map([['NL-0626', { netto: 2.51, stimmig: false }]]);
    const pauschale = { avgUnitCostNetto: 7.15, usable: true };
    const v = computeInventoryValue([bestandsProdukt('NL-0626', 100)], pauschale, lotCosts);
    expect(v.capitalAtCost).toBe(251);
    expect(v.articlesFromLot).toBe(1);
    expect(v.articlesEstimated).toBe(0);
  });

  it('erfindet ohne Los-Preis KEINEN Wert mehr', () => {
    // Betreiber-Anweisung 31.08.2026: nur die erfassten Einheiten je Los sind
    // Rechengrundlage. Palettenpreis und Einheiten je Palette sind dem Betrieb
    // unbekannt — die daraus abgeleiteten 7,15 €/Einheit waren erfunden.
    const v = computeInventoryValue([bestandsProdukt('UNBEKANNT', 10)], { avgUnitCostNetto: 7.15, usable: true }, new Map());
    expect(v.capitalAtCost).toBe(0);
    expect(v.articlesFromLot).toBe(0);
    // Sichtbar als Artikel OHNE Kostenbasis, nicht stillschweigend bewertet.
    expect(v.articlesEstimated).toBe(1);
  });

  it('nutzt auch ohne Los-Argument keine Pauschale', () => {
    const v = computeInventoryValue([bestandsProdukt('NL-0626', 10)], { avgUnitCostNetto: 7.15, usable: true });
    expect(v.capitalAtCost).toBe(0);
    expect(v.articlesEstimated).toBe(1);
  });

  it('zaehlt einen Posten ohne jede Kostenbasis als NICHT bepreist', () => {
    const index = buildProductCostIndex([{ identification: { sku: 'S9' }, ops: { sourceLot: 'OHNE-EK' } }], new Map());
    const r = computeOrderCogs({ items: [{ sku: 'S9', quantity: 3, priceBrutto: 40 }] }, index, { avgUnitCostNetto: 7.15, usable: true });
    expect(r.cogs).toBe(0);
    expect(r.unmatchedItemCount).toBe(1);
    expect(r.estimatedItemCount).toBe(0);
    // matchedRevenue bleibt 0 -> die Abdeckungsquote faellt sichtbar.
    expect(r.matchedRevenue).toBe(0);
  });

  it('laesst einen echten Einkaufspreis am Produkt gewinnen', () => {
    const p = bestandsProdukt('NL-0626', 10);
    p.details.pricing.buyPrice = 5;
    const v = computeInventoryValue([p], { avgUnitCostNetto: 7.15, usable: true }, new Map([['NL-0626', { netto: 2.51 }]]));
    expect(v.capitalAtCost).toBe(50);
    expect(v.articlesWithCost).toBe(1);
  });
});

describe('Gewinn — durchgaengig netto', () => {
  // Produktionswerte laufendes Jahr 2026, gemessen 30.08.2026.
  const echt = {
    grossRevenue: 45469.94,
    returnsValue: 5777.19,
    realPayout: null,
    cogs: 4259.63,
    shippingBrutto: 5378.6,
    shippingNetto: 4519.83,
  };

  afterEach(() => {
    delete process.env.FINANCE_PNL_BASIS;
  });

  it('zieht die Umsatzsteuer aus allen Bestandteilen', () => {
    const p = buildPnl(echt);
    expect(p.pnlBasis).toBe('netto');
    expect(p.umsatzBrutto).toBe(45469.94);
    expect(p.umsatzNetto).toBe(38210.03);
    expect(p.umsatzsteuerAnteil).toBe(7259.91);
    expect(p.retourenNetto).toBe(4854.78);
    // Versand kommt aus shippingNetto, NICHT aus brutto/1,19 — Briefporto der
    // Post ist umsatzsteuerfrei.
    expect(p.versandNetto).toBe(4519.83);
  });

  it('weist einen niedrigeren, ehrlicheren Gewinn aus als die gemischte Rechnung', () => {
    const netto = buildPnl(echt);
    process.env.FINANCE_PNL_BASIS = 'brutto';
    const brutto = buildPnl(echt);
    expect(brutto.pnlBasis).toBe('brutto');
    expect(brutto.rohgewinn).toBeGreaterThan(netto.rohgewinn);

    // Die Luecke ist GENAU die Umsatzsteuer aller Bestandteile — nicht mehr und
    // nicht weniger. Absolute Betraege werden hier bewusst NICHT festgenagelt:
    // die Gebuehren haengen an der Auszahlungslage und wuerden den Test an einen
    // Tagesstand binden. Im echten Bericht (laufendes Jahr, 30.08.2026) betrug
    // die Luecke 4.476,77 € — Gewinn 23.779,10 € statt 19.302,33 €.
    const steuerAnteile = round2(
      (netto.umsatzBrutto - netto.umsatzNetto) -
      (netto.retouren - netto.retourenNetto) -
      (netto.marketplaceFees - netto.gebuehrenNetto) -
      (netto.versandBrutto - netto.versandNetto)
    );
    expect(round2(brutto.rohgewinn - netto.rohgewinn)).toBeCloseTo(steuerAnteile, 1);
  });

  it('rechnet die Marge gegen den Netto-Umsatz, nicht gegen brutto', () => {
    const p = buildPnl(echt);
    expect(p.margePct).toBe(round1((p.rohgewinn / p.umsatzNetto) * 100));
  });

  it('NUR der exakte Wert brutto schaltet zurueck — kein Tippfehler', () => {
    for (const wert of ['Brutto', ' brutto ', 'BRUTTO']) {
      process.env.FINANCE_PNL_BASIS = wert;
      expect(buildPnl(echt).pnlBasis).toBe('brutto');
    }
    for (const wert of ['bruto', 'true', '1', 'gross', '']) {
      process.env.FINANCE_PNL_BASIS = wert;
      expect(buildPnl(echt).pnlBasis).toBe('netto');
    }
  });

  it('laesst Umsatz, Gebuehren und Auszahlung als BRUTTO-Felder unangetastet', () => {
    // Die Auszahlung ist echtes Geld auf dem Konto — sie bleibt brutto.
    const p = buildPnl(echt);
    expect(p.umsatzBrutto).toBe(45469.94);
    expect(p.retouren).toBe(5777.19);
    expect(p.versandBrutto).toBe(5378.6);
    expect(p.auszahlungErwartet).toBe(round2(p.umsatzBrutto - p.retouren - p.marketplaceFees));
  });
});

function round2(x) {
  return Math.round((Number(x) + Number.EPSILON) * 100) / 100;
}
function round1(x) {
  return Math.round(Number(x) * 10) / 10;
}
