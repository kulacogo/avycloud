import test from "node:test";
import assert from "node:assert";
import {
  istEchterTastenanschlag,
  zaehleAnschlag,
  istTastenScanner,
  LEERER_BEWEIS,
  MASCHINEN_ABSTAND_MS,
} from "./scannerDetect.ts";

/** Einen Scanner nachbilden: N Zeichen mit gleichmäßigem Abstand. */
function scanne(zeichen: number, abstandMs: number) {
  let beweis = LEERER_BEWEIS;
  let t = 1_000;
  for (let i = 0; i < zeichen; i += 1) {
    beweis = zaehleAnschlag(beweis, t);
    t += abstandMs;
  }
  return beweis;
}

test("echte Zeichen zählen", () => {
  assert.strictEqual(istEchterTastenanschlag({ key: "7", keyCode: 55 }), true);
  assert.strictEqual(istEchterTastenanschlag({ key: "A", keyCode: 65 }), true);
});

test("keyCode 229 ist KEIN Beweis — das ist Androids Eingabemethode", () => {
  // 229 heißt „die IME arbeitet noch". Genau das Gegenteil des gesuchten
  // Beweises: es belegt, dass der Scanner die IME-Verbindung BRAUCHT.
  assert.strictEqual(istEchterTastenanschlag({ key: "Unidentified", keyCode: 229 }), false);
  assert.strictEqual(istEchterTastenanschlag({ key: "7", keyCode: 229 }), false);
});

test("Steuertasten und Kombinationen zählen nicht", () => {
  assert.strictEqual(istEchterTastenanschlag({ key: "Enter", keyCode: 13 }), false);
  assert.strictEqual(istEchterTastenanschlag({ key: "Shift", keyCode: 16 }), false);
  assert.strictEqual(istEchterTastenanschlag({ key: "Tab", keyCode: 9 }), false);
  assert.strictEqual(istEchterTastenanschlag({ key: "v", ctrlKey: true }), false);
  assert.strictEqual(istEchterTastenanschlag({ key: "a", metaKey: true }), false);
});

test("laufende Komposition zählt nicht", () => {
  assert.strictEqual(istEchterTastenanschlag({ key: "a", isComposing: true }), false);
});

test("ein Scanner erbringt den Beweis", () => {
  // 12 Zeichen mit 8 ms Abstand — typisches Scanner-Tempo.
  assert.strictEqual(istTastenScanner(scanne(12, 8)), true);
});

test("ein Mensch erbringt ihn NICHT", () => {
  // Selbst schnelles Tippen liegt bei ~120 ms je Zeichen. Ein Fehlalarm würde
  // die Tastatur bei einem IME-Scanner abschalten und das Scannen töten —
  // deshalb ist die Schranke bewusst weit weg vom menschlichen Tempo.
  assert.strictEqual(istTastenScanner(scanne(20, 120)), false);
  assert.strictEqual(istTastenScanner(scanne(20, 60)), false);
});

test("die Zählung beginnt nach einer Pause von vorn", () => {
  let beweis = scanne(5, 8);
  assert.strictEqual(beweis.zeichen, 5);
  // Lange Pause -> neuer Anlauf, nicht Fortsetzung.
  beweis = zaehleAnschlag(beweis, beweis.zuletzt + 500);
  assert.strictEqual(beweis.zeichen, 1);
});

test("genau an der Grenze zählt noch als Maschine", () => {
  const beweis = scanne(8, MASCHINEN_ABSTAND_MS);
  assert.strictEqual(istTastenScanner(beweis), true);
  // Einen Tick darüber nicht mehr.
  assert.strictEqual(istTastenScanner(scanne(8, MASCHINEN_ABSTAND_MS + 1)), false);
});

test("zu kurze Folgen reichen nicht", () => {
  // Fünf Zeichen könnten ein Zufall sein, sechs sind ein Barcode.
  assert.strictEqual(istTastenScanner(scanne(5, 8)), false);
  assert.strictEqual(istTastenScanner(scanne(6, 8)), true);
});

test("leerer Beweis ist kein Beweis", () => {
  assert.strictEqual(istTastenScanner(LEERER_BEWEIS), false);
});
