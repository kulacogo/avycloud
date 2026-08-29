import { describe, test } from "node:test";
import assert from "node:assert";
import type { Product } from "../types.ts";
import { resolveSellPrice, effectiveSellPrice } from "./sellPrice.ts";

// Der Unterschied zwischen "entschiedener Preis" und "recherchierter Preis"
// verschwindet, sobald ihn jemand nicht mehr mitfuehrt — im CSV genauso wie im
// Filter. Deshalb steht die Kette hier einmal und wird hier einmal geprueft.

const makeProduct = (overrides: any = {}): Product =>
  ({
    id: "p1",
    identification: { name: "Test", brand: "", sku: "SKU-1", category: "", confidence: 1, method: "manual" },
    details: {},
    ops: {},
    ...overrides,
  }) as unknown as Product;

describe("resolveSellPrice — Preis UND Herkunft", () => {
  test("gepflegter sellPrice gilt als bestaetigt", () => {
    assert.deepEqual(
      resolveSellPrice(makeProduct({ details: { pricing: { sellPrice: 24.9, lowest_price: { amount: 19.99, currency: "EUR", sources: [] } } } })),
      { amount: 24.9, source: "confirmed" }
    );
  });

  test("ohne sellPrice ist der Marktpreis der Angebotspreis — aber als solcher benannt", () => {
    // Genau mit diesem Wert geht der Artikel online
    // (backend/lib/listing-price-source.js resolveListingPrice).
    assert.deepEqual(
      resolveSellPrice(makeProduct({ details: { pricing: { lowest_price: { amount: 18.99, currency: "EUR", sources: [] } } } })),
      { amount: 18.99, source: "market" }
    );
  });

  test("gar kein Preis meldet 'missing' statt 0", () => {
    assert.deepEqual(resolveSellPrice(makeProduct({ details: {} })), { amount: null, source: "missing" });
  });

  test("sellPrice 0 ist kein Preis", () => {
    assert.deepEqual(
      resolveSellPrice(makeProduct({ details: { pricing: { sellPrice: 0, lowest_price: { amount: 25, currency: "EUR", sources: [] } } } })),
      { amount: 25, source: "market" }
    );
  });
});

describe("effectiveSellPrice", () => {
  test("liefert genau den Betrag der Kette", () => {
    const p = makeProduct({ details: { pricing: { lowest_price: { amount: 25 } } } });
    assert.equal(effectiveSellPrice(p), 25);
    assert.equal(effectiveSellPrice(makeProduct({ details: {} })), null);
  });
});
