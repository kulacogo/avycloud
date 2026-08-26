import test from "node:test";
import assert from "node:assert";
import { baueBulkUpdateMeldung } from "./bulkUpdateMessage.ts";

// Vorfall 2026-08-26 (itemId 800315409133): eBay lehnte den Revise ab, weil
// der Artikel in einer Sonderaktion steckte — der Grund stand in
// results[].message, die Oberfläche zeigte aber nur "0/1 · 1 fehlgeschlagen".
// Ohne sichtbaren Grund ist eine eBay-Regel vom Systemausfall nicht zu
// unterscheiden.

test("sauberer Erfolg: nur die Zähler", () => {
  const m = baueBulkUpdateMeldung({ total: 3, success: 3, failed: 0, skipped: 0 }, []);
  assert.strictEqual(m, "Aktualisiert: 3/3");
});

test("Fehlgrund aus results[].message wird angezeigt", () => {
  const m = baueBulkUpdateMeldung(
    { total: 1, success: 0, failed: 1, skipped: 0 },
    [{ ok: false, message: "Der Preis für diesen Artikel kann nicht aktualisiert werden, da der Artikel Teil einer Sonderaktion ist." }]
  );
  assert.ok(m.includes("1 fehlgeschlagen"), m);
  assert.ok(m.includes("Sonderaktion"), m);
});

test("Warnhinweise erfolgreicher Updates werden angezeigt", () => {
  const m = baueBulkUpdateMeldung(
    { total: 1, success: 1, failed: 0, skipped: 0 },
    [{ ok: true, warnings: ["Preis nicht aktualisiert: Artikel ist Teil einer eBay-Sonderaktion (eBay-Fehler 21919248). Alle übrigen Felder wurden aktualisiert."] }]
  );
  assert.ok(m.includes("Aktualisiert: 1/1"), m);
  assert.ok(m.includes("Sonderaktion"), m);
});

test("übersprungen zählt als Zähler, nicht als Fehlgrund-Detail", () => {
  const m = baueBulkUpdateMeldung(
    { total: 2, success: 1, failed: 0, skipped: 1 },
    [{ ok: true }, { ok: false, skipped: true, message: "Kein Produkt verknuepft." }]
  );
  assert.ok(m.includes("1 übersprungen"), m);
  assert.ok(!m.includes("Kein Produkt verknuepft"), m);
});

test("doppelte Gründe erscheinen nur einmal, Überhang wird gezählt", () => {
  const rows = [
    { ok: false, message: "Grund A" },
    { ok: false, message: "Grund A" },
    { ok: false, message: "Grund B" },
    { ok: false, message: "Grund C" },
  ];
  const m = baueBulkUpdateMeldung({ total: 4, success: 0, failed: 4, skipped: 0 }, rows);
  assert.strictEqual(m.split("Grund A").length - 1, 1, m);
  assert.ok(m.includes("(+1 weitere)"), m);
});

test("überlange Meldungen werden gekürzt", () => {
  const lang = "X".repeat(300);
  const m = baueBulkUpdateMeldung({ total: 1, success: 0, failed: 1, skipped: 0 }, [{ ok: false, message: lang }]);
  assert.ok(m.includes("…"), m);
  assert.ok(m.length < 300, `Meldung zu lang: ${m.length}`);
});

test("robust gegen fehlende results", () => {
  const m = baueBulkUpdateMeldung({ total: 1, success: 0, failed: 1, skipped: 0 }, undefined);
  assert.strictEqual(m, "Aktualisiert: 0/1 · 1 fehlgeschlagen");
});
