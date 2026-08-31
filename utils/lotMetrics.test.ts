import { describe, test } from "node:test";
import assert from "node:assert";
import type { WarehouseLotMetrics } from "../types.ts";
import {
  formatEinheiten,
  formatEuro,
  losWertGrund,
  losBilanzHinweis,
  losAbverkaufsquote,
  mitNeuemEinkaufsbetrag,
  vkWertHinweis,
} from "./lotMetrics.ts";

const kennzahlen = (teil: Partial<WarehouseLotMetrics> = {}): WarehouseLotMetrics => ({
  einheitenErfasst: 141,
  einheitenBestand: 119,
  einheitenVerkauft: 20,
  einheitenEingelagert: 141,
  rueckfuehrungen: 0,
  korrekturen: 0,
  sonstigeAbgaenge: 2,
  produkte: 64,
  ekJeEinheitBrutto: 17.47,
  restwertBrutto: 2078.96,
  abgangswertBrutto: 349.4,
  differenz: 0,
  stimmig: true,
  ausreisser: 0,
  vkVerkauft: 349.4,
  vkBestand: 2078.96,
  vkGesamt: 2428.36,
  einheitenOhnePreis: 0,
  einheitenMitPreis: 139,
  ...teil,
});

describe("formatEinheiten", () => {
  test("zeigt Zahlen deutsch mit Tausenderpunkt", () => {
    assert.equal(formatEinheiten(4675), "4.675");
    assert.equal(formatEinheiten(0), "0");
  });

  test("macht aus 'unbekannt' NIEMALS eine 0", () => {
    // productCount/Kennzahlen sind zur Laufzeit null, wenn die Zaehlung
    // fehlschlug. Ein '0' dort behauptet ein leeres Los.
    assert.equal(formatEinheiten(null), "—");
    assert.equal(formatEinheiten(undefined), "—");
    assert.equal(formatEinheiten(Number.NaN), "—");
    assert.equal(formatEinheiten(Number.POSITIVE_INFINITY), "—");
  });
});

describe("formatEuro", () => {
  test("formatiert Betraege als Euro", () => {
    assert.ok(formatEuro(2078.96).includes("2.078,96"));
    assert.ok(formatEuro(2078.96).includes("€"));
  });

  test("erfindet ohne Wert keinen Betrag", () => {
    assert.equal(formatEuro(null), "—");
    assert.equal(formatEuro(undefined), "—");
  });
});

describe("losWertGrund", () => {
  test("nennt keinen Grund, wenn ein Wert ausgewiesen wird", () => {
    assert.equal(losWertGrund(kennzahlen()), null);
  });

  test("erklaert ein Los ohne gepflegten Einkaufsbetrag", () => {
    // NL-0826 ist genau dieser Fall: 146 Einheiten, ekBrutto null.
    const grund = losWertGrund(kennzahlen({ ekJeEinheitBrutto: null, restwertBrutto: null }));
    assert.match(String(grund), /Einkaufsbetrag/);
  });

  test("erklaert ein Los ohne Einlagerung", () => {
    const grund = losWertGrund(kennzahlen({ einheitenErfasst: 0 }));
    assert.match(String(grund), /Lager-Journal/);
  });

  test("erklaert fehlende Kennzahlen", () => {
    assert.match(String(losWertGrund(null)), /nicht geladen/);
  });
});

describe("losBilanzHinweis", () => {
  test("schweigt, solange die Bilanz aufgeht", () => {
    assert.equal(losBilanzHinweis(kennzahlen()), null);
  });

  test("benennt eine offene Differenz mit Richtung", () => {
    // NL-0626 in Produktion: -26 Einheiten von 4.675.
    const hinweis = String(losBilanzHinweis(kennzahlen({ stimmig: false, differenz: -26 })));
    assert.match(hinweis, /26/);
    assert.match(hinweis, /weniger/);
    assert.match(hinweis, /Naeherungswert/);
  });

  test("unterscheidet die Richtung der Differenz", () => {
    const hinweis = String(losBilanzHinweis(kennzahlen({ stimmig: false, differenz: 26 })));
    assert.match(hinweis, /mehr/);
  });

  test("meldet verworfene Ausreisser auch bei aufgehender Differenz", () => {
    const hinweis = String(losBilanzHinweis(kennzahlen({ stimmig: false, differenz: 0, ausreisser: 9 })));
    assert.match(hinweis, /unplausible/);
    assert.match(hinweis, /9/);
  });

  test("schweigt ohne Kennzahlen", () => {
    assert.equal(losBilanzHinweis(null), null);
  });
});

describe("mitNeuemEinkaufsbetrag", () => {
  test("rechnet Stückpreis und Los-Wert neu, ohne die Mengen anzufassen", () => {
    const neu = mitNeuemEinkaufsbetrag(kennzahlen(), 1410);
    // 1410 € auf 141 erfasste Einheiten = 10,00 € je Einheit.
    assert.equal(neu?.ekJeEinheitBrutto, 10);
    assert.equal(neu?.restwertBrutto, 1190); // 119 auf Bestand
    assert.equal(neu?.abgangswertBrutto, 200); // 20 verkauft
    assert.equal(neu?.einheitenErfasst, 141);
    assert.equal(neu?.einheitenBestand, 119);
  });

  test("teilt durch die erfasste Menge, nicht durch den Bestand", () => {
    const neu = mitNeuemEinkaufsbetrag(kennzahlen({ einheitenErfasst: 100, einheitenBestand: 5 }), 1000);
    assert.equal(neu?.ekJeEinheitBrutto, 10);
  });

  test("löscht die Werte, wenn der Betrag geleert wird", () => {
    const neu = mitNeuemEinkaufsbetrag(kennzahlen(), null);
    assert.equal(neu?.ekJeEinheitBrutto, null);
    assert.equal(neu?.restwertBrutto, null);
    assert.equal(neu?.abgangswertBrutto, null);
  });

  test("erzeugt ohne Bezugsmenge kein Infinity", () => {
    const neu = mitNeuemEinkaufsbetrag(kennzahlen({ einheitenErfasst: 0 }), 500);
    assert.equal(neu?.ekJeEinheitBrutto, null);
    assert.equal(neu?.restwertBrutto, null);
  });

  test("verteilt den Betrag ohne Rundungsdrift", () => {
    const neu = mitNeuemEinkaufsbetrag(
      kennzahlen({ einheitenErfasst: 3, einheitenBestand: 2, einheitenVerkauft: 1 }),
      10
    );
    assert.equal(neu?.restwertBrutto! + neu?.abgangswertBrutto!, 10);
  });

  test("bleibt ohne Kennzahlen null", () => {
    assert.equal(mitNeuemEinkaufsbetrag(null, 100), null);
  });
});

describe("losAbverkaufsquote", () => {
  test("rechnet gegen die erfasste Menge, nicht gegen den Bestand", () => {
    assert.equal(losAbverkaufsquote(kennzahlen({ einheitenErfasst: 100, einheitenVerkauft: 25 })), 0.25);
  });

  test("liefert ohne Bezugsmenge null statt Division durch 0", () => {
    assert.equal(losAbverkaufsquote(kennzahlen({ einheitenErfasst: 0 })), null);
    assert.equal(losAbverkaufsquote(null), null);
  });

  test("bleibt zwischen 0 und 1", () => {
    assert.equal(losAbverkaufsquote(kennzahlen({ einheitenErfasst: 10, einheitenVerkauft: 12 })), 1);
    assert.equal(losAbverkaufsquote(kennzahlen({ einheitenErfasst: 10, einheitenVerkauft: -3 })), 0);
  });
});

describe("vkWertHinweis", () => {
  test("nennt immer, dass zu heutigen Preisen bewertet wird", () => {
    // Sonst wird die Zahl fuer erzielten Umsatz gehalten — sie ist es nicht.
    const hinweis = String(vkWertHinweis(kennzahlen({ einheitenOhnePreis: 0 })));
    assert.match(hinweis, /heutigen Verkaufspreisen/);
    assert.match(hinweis, /kein erzielter Erlös/);
  });

  test("warnt, wenn Einheiten ohne Preis mitzaehlen", () => {
    const hinweis = String(vkWertHinweis(kennzahlen({ einheitenOhnePreis: 4 })));
    assert.match(hinweis, /4 Einheit/);
    assert.match(hinweis, /zu niedrig/);
  });

  test("schweigt ohne Kennzahlen", () => {
    assert.equal(vkWertHinweis(null), null);
  });
});
