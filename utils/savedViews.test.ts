import { describe, test } from "node:test";
import assert from "node:assert";
import {
  VIEWS_STORAGE_KEY,
  loadSavedViews,
  upsertSavedView,
  deleteSavedView,
  serializeSavedViews,
  type SavedView,
} from "./savedViews.ts";

/**
 * Gespeicherte Ansichten = benannte Filter+Sortier-Kombinationen (Muster aus
 * Linear/Airtable/Shopify-Admin). Bewusst lokal je Geraet (localStorage):
 * eine Server-Persistenz waere eine Routen-Aenderung und braucht eine eigene
 * Owner-Entscheidung.
 */

const beispielFilter = [{ id: "menge", value: { op: "gt" as const, a: 5, b: null } }];
const beispielSort = [{ key: "details.pricing.sellPrice", direction: "desc" as const }];

describe("upsertSavedView", () => {
  test("legt eine Ansicht mit stabiler, lesbarer ID an", () => {
    const views = upsertSavedView([], "Ohne Preis", beispielFilter, beispielSort);
    assert.equal(views.length, 1);
    assert.equal(views[0].name, "Ohne Preis");
    assert.equal(views[0].id, "ohne-preis");
    assert.deepEqual(views[0].filters, beispielFilter);
    assert.deepEqual(views[0].sort, beispielSort);
  });

  test("gleicher Name ueberschreibt statt zu doppeln", () => {
    const einmal = upsertSavedView([], "Meine Sicht", beispielFilter, beispielSort);
    const zweimal = upsertSavedView(einmal, "Meine Sicht", [], []);
    assert.equal(zweimal.length, 1);
    assert.deepEqual(zweimal[0].filters, []);
  });

  test("Namenskollision der IDs bekommt ein Suffix", () => {
    const eins = upsertSavedView([], "Test!", beispielFilter, beispielSort);
    const zwei = upsertSavedView(eins, "Test?", [], []);
    assert.equal(zwei.length, 2);
    assert.notEqual(zwei[0].id, zwei[1].id);
  });

  test("leerer Name wird abgelehnt (Liste unveraendert)", () => {
    assert.deepEqual(upsertSavedView([], "   ", beispielFilter, beispielSort), []);
  });
});

describe("deleteSavedView", () => {
  test("entfernt genau die eine Ansicht", () => {
    const views = upsertSavedView(upsertSavedView([], "A", [], []), "B", [], []);
    const rest = deleteSavedView(views, "a");
    assert.deepEqual(rest.map((v: SavedView) => v.name), ["B"]);
  });
});

describe("loadSavedViews", () => {
  function fakeStorage(seed: Record<string, string>) {
    const daten = new Map(Object.entries(seed));
    return { getItem: (k: string) => (daten.has(k) ? daten.get(k)! : null) };
  }

  test("Roundtrip ueber serialize", () => {
    const views = upsertSavedView([], "Ohne Preis", beispielFilter, beispielSort);
    const storage = fakeStorage({ [VIEWS_STORAGE_KEY]: serializeSavedViews(views) });
    assert.deepEqual(loadSavedViews(storage), views);
  });

  test("kaputte Zeilen werden verworfen, intakte Ansichten BLEIBEN", () => {
    // All-or-nothing waere Datenverlust: der Persist-Effekt schriebe die
    // leere Liste sofort zurueck und loeschte auch die intakten Ansichten.
    const views = upsertSavedView([], "Ohne Preis", beispielFilter, beispielSort);
    const gemischt = JSON.stringify({ v: 1, views: [{ ohneName: true }, ...views, 42] });
    assert.deepEqual(loadSavedViews(fakeStorage({ [VIEWS_STORAGE_KEY]: gemischt })), views);
  });

  test("fehlt / kaputt / Muell → leere Liste", () => {
    assert.deepEqual(loadSavedViews(fakeStorage({})), []);
    assert.deepEqual(loadSavedViews(fakeStorage({ [VIEWS_STORAGE_KEY]: "{kaputt" })), []);
    assert.deepEqual(
      loadSavedViews(fakeStorage({ [VIEWS_STORAGE_KEY]: JSON.stringify([{ ohneName: true }, 42]) })),
      []
    );
    assert.deepEqual(loadSavedViews(null), []);
  });
});
