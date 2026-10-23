/**
 * Scan rule for stowing on the handheld scanner (`components/MobileOperationsView.tsx`).
 *
 * The order is FIXED: SKU → BIN → quantity. A scan is classified only by its
 * position in the flow and by whether it consists of digits only.
 *
 * Two incidents made this rule necessary (TASKS.md BUG-096 / BUG-097):
 *
 * 1. Every digits-only scan counted as a quantity — even BEFORE SKU and BIN. An
 *    accidentally scanned EAN (e.g. 4006381333931) then sat in the number pad
 *    as the quantity and was booked with a single tap. Now a numeric scan only
 *    counts as a quantity once SKU and BIN are set, and only from 1 to
 *    `STOW_MAX_QTY`. Everything else is dropped SILENTLY.
 *
 * 2. With SKU and BIN set, scanning the next item without confirming made that
 *    scan vanish without a trace — the operator assumed it was accepted. Now
 *    the rule returns `blocked`; the UI must make that VISIBLE, otherwise it is
 *    the same bug again.
 *
 * The order is enforced by the `SKU` prefix: product labels always encode
 * `SKU-…` (backend/routes/products.js adds it), BIN labels never do. So a BIN
 * scanned into the SKU slot, or a SKU scanned into the BIN slot, is `rejected`.
 * Only "SKU" itself is required, not the dash: picking already accepts
 * "SKU_…", "SKU …" and "SKU…" (normalizeSkuScan), e.g. from a scanner with a
 * different keyboard layout. No BIN can start with "SKU" — zones are
 * X/XS/S/M/L/XL/XQ followed by GA/UG/EG (backend/lib/warehouse.js).
 * BIN codes are deliberately NOT matched against a strict pattern — older or
 * unusual BIN codes must keep working.
 *
 * Deliberately a pure function without React state: every combination of flow
 * state and scan is testable on its own, and later checks (e.g. "does this BIN
 * exist?", TASKS.md WH-003) build on the result instead of growing inside the
 * view's scan handler.
 */

/** Highest quantity that can be booked in a single stow. */
export const STOW_MAX_QTY = 999;

/** No allowed quantity has more digits — a longer numeric scan is a barcode. */
const MAX_QTY_DIGITS = String(STOW_MAX_QTY).length;

const DIGITS_ONLY = /^\d+$/;

/** Product labels always encode this prefix; BIN labels never do. */
const SKU_PREFIX = /^SKU/i;

export type StowScanState = {
  sku: string;
  bin: string;
};

export type StowScanAction =
  | { type: "sku"; value: string }
  | { type: "bin"; value: string }
  | { type: "quantity"; qty: number }
  | { type: "rejected"; expected: "sku" | "bin" }
  | { type: "blocked" }
  | { type: "ignore" };

/** The step the stow flow is waiting for — drives which box is shown as active. */
export type StowStep = "sku" | "bin" | "quantity";

export function stowStep(state: StowScanState): StowStep {
  if (String(state.sku ?? "").trim() === "") return "sku";
  if (String(state.bin ?? "").trim() === "") return "bin";
  return "quantity";
}

/** Quantity rule for the mobile stow flow: scan route and final booking guard. */
export function isValidStowQuantity(qty: number): boolean {
  return Number.isInteger(qty) && qty >= 1 && qty <= STOW_MAX_QTY;
}

/** What does this scan mean in the current flow state? */
export function routeStowScan(state: StowScanState, raw: string): StowScanAction {
  const value = String(raw ?? "").trim();
  if (!value) return { type: "ignore" };

  const hasSku = String(state.sku ?? "").trim() !== "";
  const hasBin = String(state.bin ?? "").trim() !== "";

  if (DIGITS_ONLY.test(value)) {
    // Before SKU and BIN there is nothing a quantity could refer to.
    if (!hasSku || !hasBin) return { type: "ignore" };
    // Checked by digit count, not just by value: "00000012" is a short barcode
    // with leading zeros, not a quantity of 12.
    if (value.length > MAX_QTY_DIGITS) return { type: "ignore" };
    const qty = Number(value);
    return isValidStowQuantity(qty) ? { type: "quantity", qty } : { type: "ignore" };
  }

  if (!hasSku) {
    // Wrong order (e.g. BIN first): keep the SKU slot empty.
    return SKU_PREFIX.test(value) ? { type: "sku", value } : { type: "rejected", expected: "sku" };
  }
  if (!hasBin) {
    // A second product label is not a BIN.
    return SKU_PREFIX.test(value) ? { type: "rejected", expected: "bin" } : { type: "bin", value };
  }
  // SKU and BIN are set, the quantity is not confirmed: overwrite nothing.
  return { type: "blocked" };
}
