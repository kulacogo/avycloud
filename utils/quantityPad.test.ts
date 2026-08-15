import { describe, test } from "node:test";
import assert from "node:assert";
import { nextQuantityFromDigit } from "./quantityPad.ts";

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
