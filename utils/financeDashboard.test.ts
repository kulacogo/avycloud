import test from "node:test";
import assert from "node:assert/strict";
import { financeSummary, financeMoney, validFinanceDates } from "./financeDashboard.ts";
import type { FinancialReport } from "../types.ts";
const report = (pnl = {}) => ({ costModel: { usable: false }, pnl: {
  pnlBasis: "netto", umsatzBrutto: 119, umsatzNetto: 100, retouren: 11.9, retourenNetto: 10,
  marketplaceFees: 11.9, gebuehrenNetto: 10, versandBrutto: 5.95, versandNetto: 5,
  cogs: 20, coveragePct: 100, rohgewinn: 55, margePct: 55,
  feeSource: "measured", estimatedItemCount: 0, unmatchedItemCount: 0, ...pnl,
} }) as FinancialReport;
test("P&L keeps the backend's net basis and supplied result", () => {
  const v = financeSummary(report());
  assert.equal(v.revenue, 100); assert.equal(v.refunds, 10); assert.equal(v.fees, 10);
  assert.equal(v.shipping, 5); assert.equal(v.result, 55); assert.equal(v.provisional, false);
});
test("unknown costs remain unknown; absent purchase costs cannot become a profit", () => {
  const v = financeSummary(report({ versandNetto: null, versandBrutto: null, coveragePct: 0 }));
  assert.equal(v.shipping, null); assert.equal(v.result, null); assert.equal(v.margin, null);
  assert.equal(v.costs[0].amount, null); assert.equal(v.provisional, true);
  assert.equal(financeMoney(null), "—"); assert.notEqual(financeMoney(0), "—");
});
test("losses and partial fee estimates remain visible without mixing settlement with costs", () => {
  const v = financeSummary(report({ rohgewinn: -20, margePct: -20, feeSource: "mixed", auszahlungIst: 0, auszahlungErwartet: 90 }));
  assert.equal(v.result, -20); assert.equal(v.estimatedFees, true); assert.equal(v.provisional, true);
  assert.equal(v.fees, 10); assert.match(financeMoney(v.result), /-20/);
});
test("legacy gross basis and invalid custom date windows are explicit", () => {
  assert.equal(financeSummary(report({ pnlBasis: "brutto" })).revenue, 119);
  assert.equal(validFinanceDates("2026-09-01", "2026-09-30"), true);
  assert.equal(validFinanceDates("2026-09-30", "2026-09-01"), false);
  assert.equal(validFinanceDates("2026-02-30", "2026-03-01"), false);
  assert.equal(validFinanceDates("", "2026-09-01"), false);
});

test("missing net fields never silently display gross values as net", () => {
  const result = financeSummary(report({ umsatzNetto: undefined, versandNetto: null }));
  assert.equal(result.revenue, null); assert.equal(result.shipping, null);
  assert.equal(result.result, null); assert.equal(result.provisional, true);
});
