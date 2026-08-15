import { describe, test } from "node:test";
import assert from "node:assert";
import {
  BULK_TRANSITION_LIMIT,
  ADDRESS_LABEL_LIMIT,
  checkBulkLimit,
} from "./bulkLimits.ts";

/**
 * Das Häkchen in der Kopfzeile wählte ALLE gefilterten Aufträge (481), nicht
 * die sichtbare Seite. Jeder Statusknopf danach lief in die Server-Grenze und
 * brach komplett ab — kein einziger Auftrag wurde umgestellt, die Auswahl blieb
 * stehen, jeder weitere Versuch scheiterte identisch.
 *
 * Die Grenze wird jetzt VOR dem Absenden geprüft. Bewusst kein automatisches
 * Stückeln: ein Statuswechsel löst Bestands- und Marktplatz-Wirkung aus
 * (CLAUDE.md Punkt 10). Ein zur Hälfte gelaufener Massenlauf wäre schlimmer als
 * eine klare Absage.
 */
describe("checkBulkLimit", () => {
  test("innerhalb der Grenze gibt es nichts zu melden", () => {
    assert.strictEqual(checkBulkLimit(50, BULK_TRANSITION_LIMIT, "Statuswechsel"), null);
  });

  test("über der Grenze kommt eine Meldung mit beiden Zahlen", () => {
    const meldung = checkBulkLimit(87, BULK_TRANSITION_LIMIT, "Statuswechsel");
    assert.ok(meldung);
    assert.match(meldung!, /87/);
    assert.match(meldung!, /50/);
  });

  test("die Meldung nennt die Aktion, damit klar ist welcher Knopf gemeint ist", () => {
    const meldung = checkBulkLimit(150, ADDRESS_LABEL_LIMIT, "Empfänger drucken");
    assert.match(meldung!, /Empfänger drucken/);
  });

  test("leere Auswahl ist kein Grenzverstoß", () => {
    assert.strictEqual(checkBulkLimit(0, BULK_TRANSITION_LIMIT, "Statuswechsel"), null);
  });

  test("die Grenzen entsprechen den Server-Schranken", () => {
    assert.strictEqual(BULK_TRANSITION_LIMIT, 50);
    assert.strictEqual(ADDRESS_LABEL_LIMIT, 100);
  });
});
