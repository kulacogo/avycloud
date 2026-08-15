import { describe, test } from "node:test";
import assert from "node:assert";
import {
  enrichDuplicateGroups,
  filterAndSortGroups,
  scoreGroup,
  summarizeGroups,
  DUPLICATE_FILTER_DEFAULTS,
} from "./duplicates.ts";

/**
 * Die Duplikate-Seite bekam vom Server nur Typ, Schlüssel und Produkt-IDs. Man
 * musste jeden Eintrag einzeln öffnen, um überhaupt zu sehen, ob er Bestand hat
 * oder online steht — sortieren und filtern ging gar nicht.
 *
 * Diese Tests nageln die Reihenfolge fest, in der abgearbeitet werden soll.
 */
const produkt = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    identification: { name: `Artikel ${id}`, sku: `SKU-${id}`, barcodes: [] },
    details: { identifiers: {}, images: [], pricing: {} },
    inventory: { quantity: 0 },
    ops: {},
    ...over,
  }) as any;

const mitBestand = (id: string, menge: number) =>
  produkt(id, { inventory: { quantity: menge, availableQuantity: menge } });

const online = (id: string, menge = 1) =>
  produkt(id, {
    inventory: { quantity: menge, availableQuantity: menge },
    ops: { listingStatus: { ebay: "active" } },
  });

describe("Dringlichkeit einer Duplikat-Gruppe", () => {
  test("mehrfach online ist der schwerste Fall", () => {
    const r = scoreGroup({ members: [], multipleListed: true, membersWithStock: 2, totalStock: 4 });
    assert.strictEqual(r.priority, 100);
    assert.match(r.priorityReason, /online/i);
  });

  test("Bestand auf mehreren Einträgen wiegt schwerer als Bestand insgesamt", () => {
    const mehrere = scoreGroup({ members: [], multipleListed: false, membersWithStock: 2, totalStock: 3 });
    const einer = scoreGroup({ members: [], multipleListed: false, membersWithStock: 1, totalStock: 9 });
    assert.ok(mehrere.priority > einer.priority);
  });

  test("ohne Bestand ist reine Aufräumarbeit", () => {
    const r = scoreGroup({ members: [], multipleListed: false, membersWithStock: 0, totalStock: 0 });
    assert.strictEqual(r.priority, 10);
  });
});

describe("Anreicherung", () => {
  test("holt Name, Bestand und Online-Status aus den geladenen Produkten", () => {
    const [g] = enrichDuplicateGroups(
      [{ type: "ean", key: "400123", productIds: ["a", "b"] }],
      [mitBestand("a", 3), online("b", 2)]
    );
    assert.strictEqual(g.members.length, 2);
    assert.strictEqual(g.totalStock, 5);
    assert.strictEqual(g.membersWithStock, 2);
    assert.strictEqual(g.members[1].listedEbay, true);
    assert.strictEqual(g.members[0].name, "Artikel a");
  });

  test("ein nicht mehr vorhandenes Produkt wird als fehlend markiert statt zu stürzen", () => {
    const [g] = enrichDuplicateGroups(
      [{ type: "ean", key: "x", productIds: ["a", "weg"] }],
      [mitBestand("a", 1)]
    );
    assert.strictEqual(g.members[1].missing, true);
    assert.strictEqual(g.totalStock, 1);
  });

  test("zwei Online-Einträge ergeben den Höchstwert", () => {
    const [g] = enrichDuplicateGroups(
      [{ type: "ean", key: "x", productIds: ["a", "b"] }],
      [online("a"), online("b")]
    );
    assert.strictEqual(g.multipleListed, true);
    assert.strictEqual(g.priority, 100);
  });
});

describe("Filtern und Sortieren", () => {
  const gruppen = enrichDuplicateGroups(
    [
      { type: "ean", key: "leer", productIds: ["l1", "l2"] },
      { type: "brand_name", key: "bestand", productIds: ["b1", "b2"] },
      { type: "ean", key: "doppelt-online", productIds: ["o1", "o2"] },
    ],
    [produkt("l1"), produkt("l2"), mitBestand("b1", 2), mitBestand("b2", 1), online("o1"), online("o2")]
  );

  test("Vorgabe-Sortierung stellt die gefährlichste Gruppe nach oben", () => {
    const s = filterAndSortGroups(gruppen, DUPLICATE_FILTER_DEFAULTS, "prioritaet");
    assert.strictEqual(s[0].key, "doppelt-online");
    assert.strictEqual(s[s.length - 1].key, "leer");
  });

  test("nur mit Bestand blendet die reine Aufräumarbeit aus", () => {
    const s = filterAndSortGroups(gruppen, { ...DUPLICATE_FILTER_DEFAULTS, bestand: "mit" }, "prioritaet");
    assert.deepStrictEqual(s.map((g) => g.key).sort(), ["bestand", "doppelt-online"]);
  });

  test("nur gelistete zeigt genau die Online-Gruppe", () => {
    const s = filterAndSortGroups(gruppen, { ...DUPLICATE_FILTER_DEFAULTS, online: "gelistet" }, "prioritaet");
    assert.deepStrictEqual(s.map((g) => g.key), ["doppelt-online"]);
  });

  test("Typ-Filter greift", () => {
    const s = filterAndSortGroups(gruppen, { ...DUPLICATE_FILTER_DEFAULTS, typ: "brand_name" }, "prioritaet");
    assert.deepStrictEqual(s.map((g) => g.key), ["bestand"]);
  });

  test("Suche findet über SKU", () => {
    const s = filterAndSortGroups(gruppen, { ...DUPLICATE_FILTER_DEFAULTS, suche: "SKU-b1" }, "prioritaet");
    assert.deepStrictEqual(s.map((g) => g.key), ["bestand"]);
  });

  test("Sortierung nach Bestand stellt die größte Menge nach oben", () => {
    const s = filterAndSortGroups(gruppen, DUPLICATE_FILTER_DEFAULTS, "bestand");
    assert.strictEqual(s[0].key, "bestand");
  });

  test("die Reihenfolge ist bei Gleichstand stabil", () => {
    // Ohne festes Zweitkriterium entschiede die zufällige Server-Reihenfolge —
    // die Liste würde bei jedem Laden springen.
    const a = filterAndSortGroups(gruppen, DUPLICATE_FILTER_DEFAULTS, "prioritaet").map((g) => g.key);
    const b = filterAndSortGroups([...gruppen].reverse(), DUPLICATE_FILTER_DEFAULTS, "prioritaet").map((g) => g.key);
    assert.deepStrictEqual(a, b);
  });

  test("Kopfzahlen beantworten womit man anfängt", () => {
    const s = summarizeGroups(gruppen);
    assert.strictEqual(s.gruppen, 3);
    assert.strictEqual(s.mehrfachOnline, 1);
    assert.strictEqual(s.mitBestand, 2);
    assert.strictEqual(s.artikel, 6);
  });
});
