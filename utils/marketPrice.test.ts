import { describe, test } from "node:test";
import assert from "node:assert";
import { applyManualMarketPrice, MANUAL_SOURCE_URL } from "./marketPrice.ts";
import type { LowestPrice } from "../types.ts";

/**
 * Das Feld "Marktpreis (niedrigster)" schrieb bei JEDEM Fokusverlust — auch
 * ohne Eingabe — die komplette Quellenliste neu und ersetzte die recherchierten
 * Belege durch einen einzigen Eintrag "Manuell". Ein Tab-Sprung durchs Feld
 * genügte, um die Preisrecherche zu vernichten.
 */
const recherchiert: LowestPrice = {
  amount: 14.38,
  currency: "EUR",
  sources: [
    { name: "idealo", url: "https://www.idealo.de/x", price: 14.38, checked_at: "2026-07-01T10:00:00.000Z" },
    { name: "Amazon", url: "https://www.amazon.de/y", price: 15.9, checked_at: "2026-07-01T10:00:00.000Z" },
  ],
  last_checked_iso: "2026-07-01T10:00:00.000Z",
};

describe("applyManualMarketPrice", () => {
  test("unveränderter Wert schreibt gar nichts", () => {
    assert.strictEqual(applyManualMarketPrice(recherchiert, "14.38"), null);
  });

  test("unveränderter Wert in deutscher Schreibweise schreibt ebenfalls nichts", () => {
    assert.strictEqual(applyManualMarketPrice(recherchiert, "14,38"), null);
  });

  test("leeres Feld bei bestehendem Preis ist keine Änderung auf 0", () => {
    assert.strictEqual(applyManualMarketPrice(recherchiert, ""), null);
  });

  test("echte Änderung behält die recherchierten Belege", () => {
    const next = applyManualMarketPrice(recherchiert, "18,90");
    assert.ok(next);
    assert.strictEqual(next!.amount, 18.9);
    const namen = next!.sources.map((s) => s.name);
    assert.deepStrictEqual(namen, ["Manuell", "idealo", "Amazon"]);
  });

  test("echte Änderung rührt das Prüfdatum der Recherche nicht an", () => {
    const next = applyManualMarketPrice(recherchiert, "18,90");
    assert.strictEqual(next!.last_checked_iso, "2026-07-01T10:00:00.000Z");
  });

  test("wiederholte manuelle Eingabe häuft keine Manuell-Einträge an", () => {
    const einmal = applyManualMarketPrice(recherchiert, "18,90")!;
    const zweimal = applyManualMarketPrice(einmal, "19,90")!;
    assert.strictEqual(zweimal.sources.filter((s) => s.url === MANUAL_SOURCE_URL).length, 1);
    assert.strictEqual(zweimal.sources.length, 3);
  });

  test("Währung bleibt erhalten", () => {
    const next = applyManualMarketPrice({ ...recherchiert, currency: "CHF" }, "20");
    assert.strictEqual(next!.currency, "CHF");
  });

  test("kaputte Währung fällt auf EUR zurück", () => {
    const next = applyManualMarketPrice({ ...recherchiert, currency: "eur-x" as string }, "20");
    assert.strictEqual(next!.currency, "EUR");
  });
});
