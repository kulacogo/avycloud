import { describe, test } from "node:test";
import assert from "node:assert";
import { chooseLabelPrintPath } from "./labelPrint.ts";

/**
 * Auf dem Handscanner war Drucken sechs Schritte weit weg: Fenster in den
 * Hintergrund, wieder öffnen, Drei-Punkte-Menü, Teilen, Drucken, Druck-Symbol.
 * Die Teilen-Funktion des Browsers führt direkt zur Druck-App — deshalb
 * gewinnt sie immer, wenn es sie gibt.
 */
describe("chooseLabelPrintPath", () => {
  test("Handscanner (Teilen vorhanden) nutzt Teilen", () => {
    assert.strictEqual(
      chooseLabelPrintPath({ canShareFiles: true, canPrintPdfInFrame: false }),
      "share"
    );
  });

  test("Teilen gewinnt auch dann, wenn der eingebettete Druck möglich wäre", () => {
    assert.strictEqual(
      chooseLabelPrintPath({ canShareFiles: true, canPrintPdfInFrame: true }),
      "share"
    );
  });

  test("Schreibtisch ohne Teilen druckt eingebettet", () => {
    assert.strictEqual(
      chooseLabelPrintPath({ canShareFiles: false, canPrintPdfInFrame: true }),
      "iframe"
    );
  });

  test("kann der Browser beides nicht, bleibt nur der Tab", () => {
    // Android ohne Teilen-Funktion: ein eingebetteter Rahmen zeigt dort kein
    // PDF, der Druckbefehl liefe auf eine leere Seite.
    assert.strictEqual(
      chooseLabelPrintPath({ canShareFiles: false, canPrintPdfInFrame: false }),
      "tab"
    );
  });
});
