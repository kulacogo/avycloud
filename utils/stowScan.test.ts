/**
 * Stowing on the handheld scanner: fixed order SKU → BIN → quantity.
 *
 * Covers both failure modes:
 *  - an accidentally scanned EAN became the quantity
 *  - the scan of the next item vanished without a trace
 */
import { describe, test } from "node:test";
import assert from "node:assert";
import { STOW_MAX_QTY, isValidStowQuantity, routeStowScan, stowStep } from "./stowScan.ts";

const EMPTY = { sku: "", bin: "" };
const SKU_ONLY = { sku: "SKU-4827710293", bin: "" };
const READY = { sku: "SKU-4827710293", bin: "MEG0102A" };

describe("routeStowScan — order SKU → BIN", () => {
  test("first text scan becomes the SKU", () => {
    assert.deepStrictEqual(routeStowScan(EMPTY, "SKU-4827710293"), { type: "sku", value: "SKU-4827710293" });
  });

  test("second text scan becomes the BIN", () => {
    assert.deepStrictEqual(routeStowScan(SKU_ONLY, "MEG0102A"), { type: "bin", value: "MEG0102A" });
  });

  test("scanner whitespace and line endings are trimmed", () => {
    assert.deepStrictEqual(routeStowScan(EMPTY, "  SKU-4827710293\n"), { type: "sku", value: "SKU-4827710293" });
  });

  test("empty scan is ignored", () => {
    assert.deepStrictEqual(routeStowScan(EMPTY, "   "), { type: "ignore" });
    assert.deepStrictEqual(routeStowScan(READY, ""), { type: "ignore" });
  });
});

describe("routeStowScan — wrong order is rejected by the SKU prefix", () => {
  test("BIN scanned first is rejected, the SKU slot stays empty", () => {
    assert.deepStrictEqual(routeStowScan(EMPTY, "TESTBIN"), { type: "rejected", expected: "sku" });
    assert.deepStrictEqual(routeStowScan(EMPTY, "MEG0102A"), { type: "rejected", expected: "sku" });
  });

  test("second product label in the BIN slot is rejected", () => {
    assert.deepStrictEqual(routeStowScan(SKU_ONLY, "SKU-1111111111"), { type: "rejected", expected: "bin" });
  });

  test("the prefix check ignores case", () => {
    assert.deepStrictEqual(routeStowScan(EMPTY, "sku-4827710293"), { type: "sku", value: "sku-4827710293" });
    assert.deepStrictEqual(routeStowScan(SKU_ONLY, "sku-1111111111"), { type: "rejected", expected: "bin" });
  });

  test("any non-SKU code is accepted as the BIN — no strict BIN pattern", () => {
    assert.deepStrictEqual(routeStowScan(SKU_ONLY, "TESTBIN"), { type: "bin", value: "TESTBIN" });
    assert.deepStrictEqual(routeStowScan(SKU_ONLY, "MEG0102A01"), { type: "bin", value: "MEG0102A01" });
  });

  test("SKU without a dash is still a SKU — same tolerance as picking", () => {
    for (const code of ["SKU_4827710293", "SKU 4827710293", "SKU4827710293"]) {
      assert.deepStrictEqual(routeStowScan(EMPTY, code), { type: "sku", value: code });
      assert.deepStrictEqual(routeStowScan(SKU_ONLY, code), { type: "rejected", expected: "bin" });
    }
  });

  test("real BIN codes never look like a SKU", () => {
    for (const bin of ["MEG0102A", "SUG0101B", "XSGA0102C", "XQEG1010E01"]) {
      assert.deepStrictEqual(routeStowScan(SKU_ONLY, bin), { type: "bin", value: bin });
    }
  });

  test("text without the prefix that merely contains SKU is not a SKU", () => {
    assert.deepStrictEqual(routeStowScan(EMPTY, "XSKU-123"), { type: "rejected", expected: "sku" });
  });
});

describe("stowStep", () => {
  test("waits for the SKU, then the BIN, then the quantity", () => {
    assert.strictEqual(stowStep(EMPTY), "sku");
    assert.strictEqual(stowStep(SKU_ONLY), "bin");
    assert.strictEqual(stowStep(READY), "quantity");
  });

  test("whitespace-only values count as empty", () => {
    assert.strictEqual(stowStep({ sku: "  ", bin: "" }), "sku");
    assert.strictEqual(stowStep({ sku: "SKU-4827710293", bin: " " }), "bin");
  });
});

describe("routeStowScan — numbers do not become a quantity while SKU/BIN are missing", () => {
  test("EAN before the SKU is ignored", () => {
    assert.deepStrictEqual(routeStowScan(EMPTY, "4006381333931"), { type: "ignore" });
  });

  test("small number before the SKU is ignored too", () => {
    assert.deepStrictEqual(routeStowScan(EMPTY, "5"), { type: "ignore" });
  });

  test("number after the SKU but before the BIN is ignored", () => {
    assert.deepStrictEqual(routeStowScan(SKU_ONLY, "5"), { type: "ignore" });
    assert.deepStrictEqual(routeStowScan(SKU_ONLY, "4006381333931"), { type: "ignore" });
  });
});

describe("routeStowScan — quantity after SKU and BIN", () => {
  test("valid quantity is accepted", () => {
    assert.deepStrictEqual(routeStowScan(READY, "5"), { type: "quantity", qty: 5 });
  });

  test("bounds: 1 and 999 are valid, 0 and 1000 are not", () => {
    assert.deepStrictEqual(routeStowScan(READY, "1"), { type: "quantity", qty: 1 });
    assert.deepStrictEqual(routeStowScan(READY, String(STOW_MAX_QTY)), { type: "quantity", qty: 999 });
    assert.deepStrictEqual(routeStowScan(READY, "0"), { type: "ignore" });
    assert.deepStrictEqual(routeStowScan(READY, "1000"), { type: "ignore" });
  });

  test("EAN after SKU and BIN does not become the quantity", () => {
    assert.deepStrictEqual(routeStowScan(READY, "4006381333931"), { type: "ignore" });
  });

  test("barcode with leading zeros is not a small quantity", () => {
    // Value 12 — but eight digits are a barcode, not a quantity scan.
    assert.deepStrictEqual(routeStowScan(READY, "00000012"), { type: "ignore" });
  });

  test("leading zero within three digits is allowed", () => {
    assert.deepStrictEqual(routeStowScan(READY, "007"), { type: "quantity", qty: 7 });
  });
});

describe("routeStowScan — an unconfirmed item stays in place", () => {
  test("text scan with SKU and BIN set is blocked", () => {
    assert.deepStrictEqual(routeStowScan(READY, "SKU-9999999999"), { type: "blocked" });
  });

  test("a second BIN scan overwrites nothing either", () => {
    assert.deepStrictEqual(routeStowScan(READY, "MEG0103B"), { type: "blocked" });
  });
});

describe("isValidStowQuantity", () => {
  test("whole numbers from 1 to 999", () => {
    assert.strictEqual(isValidStowQuantity(1), true);
    assert.strictEqual(isValidStowQuantity(999), true);
  });

  test("0, negative, above 999, decimal and NaN are invalid", () => {
    for (const qty of [0, -1, 1000, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.strictEqual(isValidStowQuantity(qty), false, String(qty));
    }
  });
});
