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
    // Vom Datenblatt aus rueckwaerts: die zuletzt geoeffnete Wartestelle davor
    // muss noch offen sein. Der Anker sitzt am Element selbst, damit ein
    // Umbenennen der Sichtbarkeits-Bedingung den Test nicht falsch rot macht.
    const sheetIdx = APP.indexOf("<ProductSheet");
    assert.ok(sheetIdx > -1, "ProductSheet-Element nicht gefunden");
    const davor = APP.slice(0, sheetIdx);
    const offen = davor.lastIndexOf("<Suspense");
    const geschlossen = davor.lastIndexOf("</Suspense>");
    assert.ok(offen > -1, "ProductSheet-Overlay ohne <Suspense> — Öffnen stürzt mit React 426 ab");
    assert.ok(
      offen > geschlossen,
      "Die Wartestelle muss das Datenblatt UMSCHLIESSEN — sie ist davor schon wieder geschlossen"
    );
  });

  test("das Import-Fenster liegt in einer Wartestelle", () => {
    // Es stand bis 2026-08-17 bedingungslos und ausserhalb jeder Wartestelle im
    // Baum: damit forderte JEDE Seite beim Start seinen Programmteil an, auch
    // ohne einen einzigen Klick. Nach einer Veroeffentlichung war das der
    // haeufigste Ausloeser fuer "Unexpected token '<'".
    const idx = APP.indexOf("<ImportModal");
    assert.ok(idx > -1, "ImportModal-Element nicht gefunden");
    const davor = APP.slice(0, idx);
    const offen = davor.lastIndexOf("<Suspense");
    const geschlossen = davor.lastIndexOf("</Suspense>");
    assert.ok(offen > geschlossen, "ImportModal ohne offene <Suspense> — laedt auf jeder Route nach");
  });

  test("das Import-Fenster wird nur bei Bedarf eingehaengt", () => {
    // Ohne Bedingung nuetzt die Wartestelle nichts — der Programmteil wuerde
    // trotzdem sofort angefordert.
    assert.match(APP, /\{showImportModal && \(/);
  });

  test("das Oeffnen des Import-Fensters ist als Uebergang markiert", () => {
    // Sonst kehrt React-Fehler 426 zurueck: ein Klick ist eine sofortige
    // Eingabe, und React verweigert es, dafuer ohne Uebergang nachzuladen.
    assert.match(APP, /startTransition\(\(\) => setShowImportModal\(true\)\)/);
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
