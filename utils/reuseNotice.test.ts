import { test } from "node:test";
import assert from "node:assert";
import { buildReuseNotice } from "./reuseNotice.ts";

// Seit 2026-08-18 findet die Erfassung ein bereits vorhandenes Produkt auch
// ohne Barcode (services/duplicate-search.js). Dann wird KEIN neues Datenblatt
// und keine neue SKU angelegt — der Bediener sieht stattdessen das
// Bestandsprodukt. Ohne Hinweis waere das eine stille Aenderung: er haelt die
// alten Daten fuer das Ergebnis der frischen Erkennung.

test("meldet nichts, wenn regulaer neu angelegt wurde", () => {
  assert.strictEqual(buildReuseNotice({ reused_existing: false }), null);
  assert.strictEqual(buildReuseNotice(undefined), null);
  assert.strictEqual(buildReuseNotice({}), null);
});

test("meldet die Wiederverwendung mit dem Namen des Bestandsprodukts", () => {
  const notice = buildReuseNotice(
    { reused_existing: true },
    { label: "Gruppe 2", productName: "ATE Bremsbelagsatz", productId: "alt-1" },
  );

  assert.ok(notice);
  assert.match(notice!.detail, /ATE Bremsbelagsatz/);
  assert.strictEqual(notice!.productId, "alt-1");
  assert.strictEqual(notice!.label, "Gruppe 2");
});

test("sagt ausdruecklich, dass nichts Neues angelegt wurde", () => {
  // Das ist die eigentliche Information: kein zweites Datenblatt, keine zweite SKU.
  const notice = buildReuseNotice({ reused_existing: true }, { productName: "X" });
  assert.match(notice!.title, /bereits/i);
  assert.match(notice!.detail, /kein (neues|zweites)/i);
});

test("kommt ohne Produktnamen aus", () => {
  const notice = buildReuseNotice({ reused_existing: true });
  assert.ok(notice);
  assert.ok(notice!.detail.length > 0);
});
