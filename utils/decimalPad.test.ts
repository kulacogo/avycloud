import test from "node:test";
import assert from "node:assert";
import {
  appendDigit,
  appendSeparator,
  dropLast,
  parseWeight,
  formatWeight,
  MAX_WEIGHT_KG,
} from "./decimalPad.ts";

test("Ziffern hängen an", () => {
  assert.strictEqual(appendDigit("", "2"), "2");
  assert.strictEqual(appendDigit("2", "5"), "25");
});

test("erster Tipp ersetzt den Vorschlag", () => {
  // Vorbelegt mit geschätzten 2 kg, Bediener tippt 3 -> 3, nicht 23.
  assert.strictEqual(appendDigit("2", "3", true), "3");
  assert.strictEqual(appendDigit("2", "3", false), "23");
});

test("keine führende Null", () => {
  assert.strictEqual(appendDigit("0", "5"), "5");
});

test("Nachkommastellen sind auf drei begrenzt", () => {
  assert.strictEqual(appendDigit("2,555", "9"), "2,555");
  assert.strictEqual(appendDigit("2,55", "9"), "2,559");
});

test("Vorkommastellen sind begrenzt", () => {
  assert.strictEqual(appendDigit("1234", "5"), "1234");
});

test("höchstens ein Komma", () => {
  assert.strictEqual(appendSeparator("2"), "2,");
  assert.strictEqual(appendSeparator("2,"), "2,");
  assert.strictEqual(appendSeparator("2,5"), "2,5");
});

test("Komma als erstes Zeichen bekommt eine führende Null", () => {
  assert.strictEqual(appendSeparator(""), "0,");
});

test("Komma nach Vorschlag ersetzt diesen", () => {
  assert.strictEqual(appendSeparator("2", true), "0,");
});

test("Löschen entfernt ein Zeichen", () => {
  assert.strictEqual(dropLast("2,5"), "2,");
  assert.strictEqual(dropLast("2"), "");
  assert.strictEqual(dropLast(""), "");
});

test("parseWeight rechnet Komma in Kilogramm", () => {
  assert.strictEqual(parseWeight("2,5"), 2.5);
  assert.strictEqual(parseWeight("2.5"), 2.5);
  assert.strictEqual(parseWeight("0,125"), 0.125);
});

test("parseWeight lehnt Unsinn ab statt zu raten", () => {
  // Ein Label mit falschem Gewicht kostet echtes Geld (Nachberechnung).
  assert.strictEqual(parseWeight(""), null);
  assert.strictEqual(parseWeight(","), null);
  assert.strictEqual(parseWeight("0"), null);
  assert.strictEqual(parseWeight("-3"), null);
  assert.strictEqual(parseWeight("abc"), null);
});

test("parseWeight deckelt bei 100 kg", () => {
  assert.strictEqual(parseWeight(String(MAX_WEIGHT_KG)), MAX_WEIGHT_KG);
  // "350" statt "3,5" ist der klassische Vertipper — der darf nicht durch.
  assert.strictEqual(parseWeight("350"), null);
});

test("ein halb getipptes Komma ist noch kein Gewicht, aber auch kein Fehler", () => {
  // "2," ist ein gültiger Zwischenzustand: die Anzeige behält ihn, das
  // Bestätigen bleibt möglich (2 kg). Genau dafür wird der Wert als
  // Zeichenkette geführt.
  assert.strictEqual(parseWeight("2,"), 2);
});

test("formatWeight zeigt deutsches Komma", () => {
  assert.strictEqual(formatWeight(2.5), "2,5");
  assert.strictEqual(formatWeight(0), "");
  assert.strictEqual(formatWeight(null), "");
});
