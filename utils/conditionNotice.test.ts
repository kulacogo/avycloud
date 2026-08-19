import test from "node:test";
import assert from "node:assert/strict";

import { rejectedConditionNotice, catalogAgeNotice, conditionName } from "./conditionNotice.ts";

test("nennt den Zustand beim Namen", () => {
  assert.equal(conditionName("2500"), "Vom Verkäufer generalüberholt");
  assert.equal(conditionName("1500"), "Neu: Sonstige");
});

test("unbekannte Kennung bleibt stehen statt zu verschwinden", () => {
  assert.equal(conditionName("9999"), "9999");
});

test("erklaert den zurueckgewiesenen Zustand — der gemeldete Fall", () => {
  // Kategorie 185112: eBay lehnte 2500 am 10.08.2026 ab (Fehler 21555).
  // Ohne diesen Hinweis sucht der Bediener den Fehler bei sich.
  const text = rejectedConditionNotice(["2500"]);
  assert.match(text, /Vom Verkäufer generalüberholt/);
  assert.match(text, /abgelehnt/);
  assert.match(text, /steht/);
});

test("mehrere Zustaende werden aufgezaehlt", () => {
  const text = rejectedConditionNotice(["2500", "1750"]);
  assert.match(text, /Vom Verkäufer generalüberholt/);
  assert.match(text, /Neu mit Fehlern/);
  assert.match(text, /stehen/);
});

test("ohne Zurueckweisung kein Hinweis", () => {
  assert.equal(rejectedConditionNotice([]), "");
  assert.equal(rejectedConditionNotice(null), "");
  assert.equal(rejectedConditionNotice(undefined), "");
});

test("der Hinweis nennt keine Fehlernummern", () => {
  // "21555" sagt einem Kaufmann nichts.
  const text = rejectedConditionNotice(["2500"]);
  assert.equal(text.includes("21555"), false);
  assert.equal(text.includes("2500"), false);
});

const JETZT = new Date("2026-08-20T12:00:00Z").getTime();

test("sagt, wie alt die Liste ist", () => {
  assert.equal(catalogAgeNotice("2026-08-20T01:00:00Z", JETZT), "Liste heute von eBay geholt.");
  assert.equal(catalogAgeNotice("2026-08-19T01:00:00Z", JETZT), "Liste gestern von eBay geholt.");
  assert.equal(catalogAgeNotice("2026-08-10T01:00:00Z", JETZT), "Liste vor 10 Tagen von eBay geholt.");
});

test("ohne Zeitstempel kein Hinweis", () => {
  assert.equal(catalogAgeNotice(null, JETZT), "");
  assert.equal(catalogAgeNotice("", JETZT), "");
  assert.equal(catalogAgeNotice("kein Datum", JETZT), "");
});
