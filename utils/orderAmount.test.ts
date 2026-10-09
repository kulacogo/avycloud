import { describe, test } from "node:test";
import assert from "node:assert";
import {
  formatMoney,
  formatExchangeRate,
  orderAmountView,
  itemLineAmountView,
  orderAmountCsvCells,
} from "./orderAmount.ts";

// Vorfall M53KUW5 (kaufland.cz, 03.10.2026): 534,14 CZK wurden als 534,14 € angezeigt.
// Seit der Umrechnung traegt der Auftrag Euro als Hauptbetrag und das Original daneben.
const czOrder = {
  totalAmount: 21.83,
  currency: "EUR",
  originalCurrency: "CZK",
  originalTotalAmount: 534.14,
  exchangeRate: 24.47,
  exchangeRateDate: "2026-10-02",
  exchangeRateSource: "ecb",
  exchangeRatePending: false,
};

describe("formatMoney", () => {
  test("Euro wie bisher mit Eurozeichen, Fremdwaehrung mit Code", () => {
    assert.equal(formatMoney(21.83, "EUR"), "21.83 €");
    assert.equal(formatMoney(534.14, "CZK"), "534.14 CZK");
    assert.equal(formatMoney(5, undefined), "5.00 €");
  });

  test("ohne Betrag ein Strich, nie NaN", () => {
    assert.equal(formatMoney(null, "EUR"), "—");
    assert.equal(formatMoney(undefined, "CZK"), "—");
    assert.equal(formatMoney(Number.NaN, "EUR"), "—");
  });
});

describe("formatExchangeRate", () => {
  test("drei Nachkommastellen, deutsches Komma", () => {
    assert.equal(formatExchangeRate(24.47), "24,470");
    assert.equal(formatExchangeRate(4.3775), "4,3775");
    assert.equal(formatExchangeRate(null), "");
  });
});

describe("orderAmountView", () => {
  test("Fremdwaehrung: Euro als Hauptbetrag, Original daneben, Kurs als Hinweis", () => {
    const v = orderAmountView(czOrder);
    assert.equal(v.primary, "21.83 €");
    assert.equal(v.secondary, "534.14 CZK");
    assert.equal(v.hint, "EZB-Kurs 24,470 vom 02.10.2026");
    assert.equal(v.pending, false);
  });

  test("Euro-Auftrag: nur der Hauptbetrag, nichts daneben", () => {
    const v = orderAmountView({ totalAmount: 19.99, currency: "EUR" });
    assert.equal(v.primary, "19.99 €");
    assert.equal(v.secondary, null);
    assert.equal(v.hint, null);
  });

  test("Notkurs wird als vorlaeufig gekennzeichnet", () => {
    const v = orderAmountView({ ...czOrder, totalAmount: 21.8, exchangeRate: 24.5, exchangeRateDate: "2026-10-05", exchangeRateSource: "static_fallback", exchangeRatePending: true });
    assert.equal(v.primary, "21.80 €");
    assert.equal(v.pending, true);
    assert.match(v.hint ?? "", /vorläufig/);
    assert.match(v.hint ?? "", /24,500/);
  });

  test("ohne Kurs (noch nicht umgerechnet) bleibt die Fremdwaehrung sichtbar", () => {
    const v = orderAmountView({ totalAmount: 534.14, currency: "CZK", originalCurrency: "CZK", originalTotalAmount: 534.14, exchangeRateSource: "none", exchangeRatePending: true });
    assert.equal(v.primary, "534.14 CZK");
    assert.equal(v.secondary, null);
    assert.match(v.hint ?? "", /noch nicht/);
  });

  test("ohne Betrag ein Strich", () => {
    const v = orderAmountView({ currency: "EUR" });
    assert.equal(v.primary, "—");
    assert.equal(v.secondary, null);
  });
});

describe("itemLineAmountView", () => {
  test("Positionssumme in Euro plus Original je Position mal Menge", () => {
    const v = itemLineAmountView({ priceBrutto: 21.83, currency: "EUR", originalPrice: 534.14, originalCurrency: "CZK" }, 2);
    assert.equal(v.primary, "43.66 €");
    assert.equal(v.secondary, "1068.28 CZK");
  });

  test("Euro-Position ohne Original", () => {
    const v = itemLineAmountView({ priceBrutto: 10, currency: "EUR" }, 1);
    assert.equal(v.primary, "10.00 €");
    assert.equal(v.secondary, null);
  });

  test("ohne Preis ein Strich", () => {
    const v = itemLineAmountView({ currency: "EUR" }, 1);
    assert.equal(v.primary, "—");
    assert.equal(v.secondary, null);
  });
});

describe("orderAmountCsvCells", () => {
  test("Euro-Betrag wie bisher, dazu Originalbetrag, Originalwaehrung und Kurs", () => {
    assert.deepEqual(orderAmountCsvCells(czOrder), ["21.83", "534.14", "CZK", "24.47"]);
  });

  test("Euro-Auftrag: Zusatzspalten leer", () => {
    assert.deepEqual(orderAmountCsvCells({ totalAmount: 19.99, currency: "EUR" }), ["19.99", "", "", ""]);
  });

  test("noch nicht umgerechnet: Euro-Spalte leer statt CZK als Euro", () => {
    assert.deepEqual(
      orderAmountCsvCells({ totalAmount: 534.14, currency: "CZK", originalCurrency: "CZK", originalTotalAmount: 534.14, exchangeRateSource: "none", exchangeRatePending: true }),
      ["", "534.14", "CZK", ""],
    );
  });
});
