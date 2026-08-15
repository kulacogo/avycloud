import { describe, test } from "node:test";
import assert from "node:assert";
import { nextQuantityFromDigit, isReplacingEntry } from "./quantityPad.ts";

/**
 * Der Ziffernblock im mobilen Einlagern startet auf 1. Bis 2026-08-15 hängte
 * der erste Tastendruck an diesen Vorgabewert an: aus "3" wurde 13 — und ohne
 * Obergrenze buchte "Einlagern" auch 13 Stück in den Bestand.
 *
 * Regel jetzt (wie bei Taschenrechner- und Waagenfeldern): der erste Tipp nach
 * einer Wertänderung VON AUSSEN ersetzt, jeder weitere hängt an.
 */
describe("nextQuantityFromDigit", () => {
  test("erster Tipp ersetzt den von außen gesetzten Vorgabewert", () => {
    assert.strictEqual(
      nextQuantityFromDigit({ current: 1, digit: 3, isFirstEntry: true, min: 0 }),
      3
    );
  });

  test("zweiter Tipp hängt an — der Mensch tippt eine mehrstellige Zahl", () => {
    assert.strictEqual(
      nextQuantityFromDigit({ current: 3, digit: 0, isFirstEntry: false, min: 0 }),
      30
    );
  });

  test("erster Tipp einer 0 ergibt 0, nicht 10", () => {
    assert.strictEqual(
      nextQuantityFromDigit({ current: 1, digit: 0, isFirstEntry: true, min: 0 }),
      0
    );
  });

  test("Obergrenze wird eingehalten", () => {
    assert.strictEqual(
      nextQuantityFromDigit({ current: 4, digit: 9, isFirstEntry: false, min: 0, max: 12 }),
      12
    );
  });

  test("Untergrenze wird eingehalten", () => {
    assert.strictEqual(
      nextQuantityFromDigit({ current: 5, digit: 0, isFirstEntry: true, min: 1 }),
      1
    );
  });

  test("kaputter Ausgangswert kippt nicht in NaN", () => {
    assert.strictEqual(
      nextQuantityFromDigit({ current: Number.NaN, digit: 7, isFirstEntry: false, min: 0 }),
      7
    );
  });

  test("Nachkommastellen werden abgeschnitten statt angehängt", () => {
    assert.strictEqual(
      nextQuantityFromDigit({ current: 2.7, digit: 5, isFirstEntry: false, min: 0 }),
      25
    );
  });
});

// ---------------------------------------------------------------------------
// Regression 2026-08-16: React zeichnet bei gleichem Wert NICHT neu
// ---------------------------------------------------------------------------

/**
 * Der erste Fix (Erst-Tipp ersetzt) hatte einen Denkfehler: die Entscheidung
 * "ist das der erste Tipp?" wurde BEIM ZEICHNEN berechnet. Tippt der Mensch auf
 * die Ziffer, die ohnehin schon im Feld steht (Vorgabe 1, er will 15 und tippt
 * zuerst 1), dann meldet der Ziffernblock denselben Wert zurück — und React
 * zeichnet bei einem unveränderten Wert NICHT neu. Die Entscheidung blieb damit
 * auf "erster Tipp" stehen, und die nächste Ziffer ERSETZTE erneut:
 * aus 15 wurde 5, aus 11 wurde 1.
 *
 * Besonders heimtückisch: vor dem ersten Fix kam 115 heraus — offensichtlich
 * falsch. Danach kam 5 heraus: eine plausible Zahl, die niemandem auffällt.
 *
 * Deshalb wird die Entscheidung jetzt zur KLICK-Zeit getroffen und hängt nicht
 * mehr am Zeichnen.
 */
describe("isReplacingEntry", () => {
  test("ganz am Anfang ersetzt der Tipp den Vorgabewert", () => {
    assert.strictEqual(isReplacingEntry({ lastEmitted: null, current: 1, hasTyped: false }), true);
  });

  test("nach einem Tipp, der den Wert NICHT verändert hat, wird angehängt", () => {
    // Genau der Regressionsfall: Vorgabe 1, Tipp auf 1 → Wert bleibt 1,
    // React zeichnet nicht neu. Die 5 danach muss anhängen, nicht ersetzen.
    assert.strictEqual(isReplacingEntry({ lastEmitted: 1, current: 1, hasTyped: true }), false);
  });

  test("nach einer Wertänderung von außen wird wieder ersetzt", () => {
    assert.strictEqual(isReplacingEntry({ lastEmitted: 15, current: 1, hasTyped: true }), true);
  });

  test("von außen gesetzter Wert vor dem ersten Tipp ersetzt ebenfalls", () => {
    assert.strictEqual(isReplacingEntry({ lastEmitted: null, current: 7, hasTyped: false }), true);
  });

  test("die ganze Eingabe 1-5 ergibt 15", () => {
    // Ablauf wie am Gerät, inklusive des Zeichen-Aussetzers.
    let lastEmitted: number | null = null;
    let hasTyped = false;
    let current = 1;

    const tippe = (digit: number) => {
      const ersetzen = isReplacingEntry({ lastEmitted, current, hasTyped });
      const next = nextQuantityFromDigit({ current, digit, isFirstEntry: ersetzen, min: 0 });
      lastEmitted = next;
      hasTyped = true;
      current = next; // React übernimmt den Wert (oder er bleibt gleich)
    };

    tippe(1);
    tippe(5);
    assert.strictEqual(current, 15);
  });

  test("die Eingabe 1-1 ergibt 11", () => {
    let lastEmitted: number | null = null;
    let hasTyped = false;
    let current = 1;
    const tippe = (digit: number) => {
      const ersetzen = isReplacingEntry({ lastEmitted, current, hasTyped });
      const next = nextQuantityFromDigit({ current, digit, isFirstEntry: ersetzen, min: 0 });
      lastEmitted = next;
      hasTyped = true;
      current = next;
    };
    tippe(1);
    tippe(1);
    assert.strictEqual(current, 11);
  });
});
