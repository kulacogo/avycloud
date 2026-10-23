/**
 * Sprachwähler: alle drei Oberflächensprachen sind wählbar, das Kurzlabel
 * stimmt und ein unbekannter Wert wird nicht zu einem leeren Knopf.
 */
import { describe, test } from "node:test";
import assert from "node:assert";
import { LOCALE_OPTIONS, localeShortLabel } from "./localeOptions.ts";

describe("LOCALE_OPTIONS", () => {
  test("führt en, de, tr genau einmal", () => {
    assert.deepStrictEqual(LOCALE_OPTIONS.map((o) => o.code), ["en", "de", "tr"]);
  });

  test("jede Sprache hat Kurzlabel und Eigennamen", () => {
    for (const o of LOCALE_OPTIONS) {
      assert.strictEqual(o.short, o.code.toUpperCase());
      assert.ok(o.nativeName.length > 0);
    }
  });
});

describe("localeShortLabel", () => {
  test("bekannte Sprachen", () => {
    assert.strictEqual(localeShortLabel("en"), "EN");
    assert.strictEqual(localeShortLabel("de"), "DE");
    assert.strictEqual(localeShortLabel("tr"), "TR");
  });

  test("unbekannter oder leerer Wert", () => {
    assert.strictEqual(localeShortLabel("fr"), "FR");
    assert.strictEqual(localeShortLabel(""), "");
  });
});
