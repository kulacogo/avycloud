import { describe, test } from "node:test";
import assert from "node:assert";
import {
  DEFAULT_SORT,
  toggleSortLevel,
  buildProductComparator,
  migrateSortState,
  type SortLevel,
} from "./productSort.ts";

/**
 * Sortierung der Produkttabelle: eine Spalte per Klick, weitere Kriterien per
 * Shift-Klick (Airtable-/Handsontable-Konvention). Der Comparator sortiert
 * deutsch (Umlaute), zahlenbewusst ("BIN2" vor "BIN10") und schiebt leere
 * Werte IMMER ans Ende — egal in welcher Richtung.
 */

describe("toggleSortLevel", () => {
  test("normaler Klick ersetzt die Sortierung und startet aufsteigend", () => {
    assert.deepEqual(toggleSortLevel([], "price", false), [{ key: "price", direction: "asc" }]);
    assert.deepEqual(
      toggleSortLevel([{ key: "name", direction: "desc" }, { key: "price", direction: "asc" }], "price", false),
      [{ key: "price", direction: "asc" }]
    );
  });

  test("normaler Klick auf die aktive Einzel-Spalte dreht die Richtung", () => {
    const asc: SortLevel[] = [{ key: "price", direction: "asc" }];
    assert.deepEqual(toggleSortLevel(asc, "price", false), [{ key: "price", direction: "desc" }]);
    assert.deepEqual(toggleSortLevel(toggleSortLevel(asc, "price", false), "price", false), [
      { key: "price", direction: "asc" },
    ]);
  });

  test("Shift-Klick haengt ein weiteres Kriterium hinten an", () => {
    const levels = toggleSortLevel([{ key: "status", direction: "asc" }], "price", true);
    assert.deepEqual(levels, [
      { key: "status", direction: "asc" },
      { key: "price", direction: "asc" },
    ]);
  });

  test("Shift-Klick auf vorhandenes Kriterium: asc → desc → entfernen", () => {
    const start: SortLevel[] = [
      { key: "status", direction: "asc" },
      { key: "price", direction: "asc" },
    ];
    const step1 = toggleSortLevel(start, "price", true);
    assert.deepEqual(step1[1], { key: "price", direction: "desc" });
    const step2 = toggleSortLevel(step1, "price", true);
    assert.deepEqual(step2, [{ key: "status", direction: "asc" }]);
  });
});

describe("buildProductComparator", () => {
  type Row = { id: string; werte: Record<string, unknown> };
  const getValue = (row: Row, key: string) => row.werte[key];
  const sortiert = (rows: Row[], levels: SortLevel[]) =>
    [...rows].sort(buildProductComparator(levels, getValue)).map((r) => r.id);

  test("Zahlen numerisch, in beide Richtungen", () => {
    const rows: Row[] = [
      { id: "a", werte: { menge: 10 } },
      { id: "b", werte: { menge: 2 } },
      { id: "c", werte: { menge: 33 } },
    ];
    assert.deepEqual(sortiert(rows, [{ key: "menge", direction: "asc" }]), ["b", "a", "c"]);
    assert.deepEqual(sortiert(rows, [{ key: "menge", direction: "desc" }]), ["c", "a", "b"]);
  });

  test("Strings deutsch und zahlenbewusst (BIN2 vor BIN10)", () => {
    const rows: Row[] = [
      { id: "a", werte: { bin: "BIN10" } },
      { id: "b", werte: { bin: "BIN2" } },
      { id: "c", werte: { bin: "Äpfel" } },
      { id: "d", werte: { bin: "Zebra" } },
    ];
    assert.deepEqual(sortiert(rows, [{ key: "bin", direction: "asc" }]), ["c", "b", "a", "d"]);
  });

  test("leere Werte landen IMMER am Ende — auch absteigend", () => {
    const rows: Row[] = [
      { id: "leer", werte: { preis: null } },
      { id: "a", werte: { preis: 5 } },
      { id: "b", werte: { preis: 9 } },
      { id: "leer2", werte: { preis: "" } },
    ];
    assert.deepEqual(sortiert(rows, [{ key: "preis", direction: "asc" }]), ["a", "b", "leer", "leer2"]);
    assert.deepEqual(sortiert(rows, [{ key: "preis", direction: "desc" }]), ["b", "a", "leer", "leer2"]);
  });

  test("mehrere Kriterien: das zweite bricht Gleichstaende", () => {
    const rows: Row[] = [
      { id: "a", werte: { status: "ready", preis: 30 } },
      { id: "b", werte: { status: "pending", preis: 10 } },
      { id: "c", werte: { status: "ready", preis: 10 } },
    ];
    assert.deepEqual(
      sortiert(rows, [
        { key: "status", direction: "desc" },
        { key: "preis", direction: "asc" },
      ]),
      ["c", "a", "b"]
    );
  });

  test("ohne Kriterien bleibt die Reihenfolge stehen", () => {
    const rows: Row[] = [
      { id: "b", werte: {} },
      { id: "a", werte: {} },
    ];
    assert.deepEqual(sortiert(rows, []), ["b", "a"]);
  });
});

describe("migrateSortState", () => {
  test("fehlender / kaputter Stand liefert den Default (zuletzt gespeichert zuerst)", () => {
    assert.deepEqual(migrateSortState(null), DEFAULT_SORT);
    assert.deepEqual(migrateSortState("{kaputt"), DEFAULT_SORT);
    assert.deepEqual(migrateSortState(JSON.stringify({ nichts: true })), DEFAULT_SORT);
  });

  test("Alt-Format {key, direction} wird zum Ein-Element-Array", () => {
    assert.deepEqual(migrateSortState(JSON.stringify({ key: "details.pricing.sellPrice", direction: "desc" })), [
      { key: "details.pricing.sellPrice", direction: "desc" },
    ]);
  });

  test("Uralt-Key quality-gate wird weiter auf last_saved migriert", () => {
    assert.deepEqual(
      migrateSortState(JSON.stringify({ key: "ops.data_quality.last_quality_gate_iso", direction: "desc" })),
      [{ key: "ops.last_saved_iso", direction: "desc" }]
    );
  });

  test("neues Array-Format kommt unveraendert zurueck", () => {
    const levels: SortLevel[] = [
      { key: "ops.readiness", direction: "asc" },
      { key: "ops.last_saved_iso", direction: "desc" },
    ];
    assert.deepEqual(migrateSortState(JSON.stringify(levels)), levels);
  });

  test("leeres Array bleibt leer (bewusst unsortiert)", () => {
    assert.deepEqual(migrateSortState(JSON.stringify([])), []);
  });
});
