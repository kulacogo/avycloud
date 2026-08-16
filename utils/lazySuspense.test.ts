import { describe, test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

/**
 * Nachgeladene Ansichten brauchen eine Wartestelle UND eine Klick-Markierung.
 *
 * Seit die Ansichten erst beim Öffnen geladen werden, gilt in React 18:
 * Wer als unmittelbare Folge eines Klicks etwas nachlädt, bekommt Fehler 426
 * ("A component suspended while responding to synchronous input") — der Nutzer
 * sieht "Etwas ist schiefgelaufen".
 *
 * Genau das passierte am 2026-08-16 beim Öffnen eines Produktdatenblatts: das
 * Overlay lag AUSSERHALB der Wartestelle, die nur den Hauptbereich umschloss.
 *
 * Zwei Dinge muessen zusammenkommen:
 *  1. eine <Suspense>-Wartestelle um jede nachgeladene Ansicht,
 *  2. `startTransition` an jeder Stelle, die sie per Klick oeffnet.
 */

const APP = fs.readFileSync(path.join(path.resolve(import.meta.dirname, ".."), "App.tsx"), "utf8");

describe("Nachgeladene Ansichten", () => {
  test("das Produktdatenblatt liegt in einer Wartestelle", () => {
    // Overlay-Block ab der Sichtbarkeits-Bedingung bis zum Ende des Panels.
    const start = APP.indexOf("isProductSheetBlockedView(view)");
    assert.ok(start > -1, "Overlay-Bedingung nicht gefunden");
    const block = APP.slice(start, start + 2500);
    assert.match(block, /<Suspense/, "ProductSheet-Overlay ohne <Suspense> — Öffnen stürzt mit React 426 ab");
    assert.ok(
      block.indexOf("<Suspense") < block.indexOf("<ProductSheet"),
      "Die Wartestelle muss das Datenblatt UMSCHLIESSEN"
    );
  });

  test("der Hauptbereich liegt ebenfalls in einer Wartestelle", () => {
    assert.match(APP, /<Suspense[\s\S]{0,400}\{renderView\(\)\}/);
  });

  test("das Öffnen per Klick ist als Übergang markiert", () => {
    assert.match(APP, /startTransition\(\(\) => \{\s*setCurrentProduct/);
  });

  test("startTransition ist überhaupt importiert", () => {
    assert.match(APP, /import React, \{[^}]*startTransition[^}]*\} from 'react';/);
  });

  test("jede nachgeladene Ansicht wird wirklich per lazy geholt (Selbstprüfung)", () => {
    const anzahl = (APP.match(/const \w+ = lazy\(/g) || []).length;
    assert.ok(anzahl > 20, `nur ${anzahl} nachgeladene Ansichten gefunden — Scanner kaputt?`);
  });
});
