import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveOrderProduct } from "./orderProduct.ts";

const a = { id: "a", identification: { sku: "SKU-001" } };
const b = { id: "b", identification: { sku: "SKU-002" } };
const item = (extra: object) => ({ id: "line", name: "Historischer Name", quantity: 1, ...extra });
const deps = (products = [a, b]) => ({ products, loadProducts: async () => [a, b], loadProduct: async (id: string) => ({ ...[a, b].find(p => p.id === id)!, fresh: true }) });

test("öffnet genau die gewählte Position und lädt den aktuellen Datensatz", async () => {
  assert.equal((await resolveOrderProduct(item({ productId: "b" }), deps())).id, "b");
  assert.equal((await resolveOrderProduct(item({ pickHint: { productId: "a" } }), deps()) as any).fresh, true);
});
test("holt fehlende Produkte über die berechtigte Produktliste nach", async () => {
  assert.equal((await resolveOrderProduct(item({ productId: "b" }), deps([a]))).id, "b");
});
test("rät bei fehlender oder widersprüchlicher ID nicht anhand des Titels/SKU", async () => {
  await assert.rejects(resolveOrderProduct(item({ productId: "fremd", sku: "SKU-001" }), deps()), /nicht verfügbar/);
  await assert.rejects(resolveOrderProduct(item({ productId: "a", pickHint: { productId: "b" } }), deps()), /widersprüchlich/);
});
test("SKU-Fallback lehnt mehrdeutige Treffer ab", async () => {
  const duplicate = { id: "duplicate", identification: { sku: "SKU-001" } };
  await assert.rejects(resolveOrderProduct(item({ sku: "SKU-001" }), { ...deps(), products: [a, duplicate] }), /mehrdeutig/);
  assert.equal((await resolveOrderProduct(item({ sku: " sku-002 " }), deps())).id, "b");
});
test("gleicher Titel ist kein Identitätsbeleg; Ladefehler bleiben Fehler", async () => {
  await assert.rejects(resolveOrderProduct(item({}), deps()), /Produktzuordnung/);
  await assert.rejects(resolveOrderProduct(item({ productId: "a" }), { ...deps(), loadProduct: async () => { throw new Error("Zugriff verweigert"); } }), /Zugriff verweigert/);
});
