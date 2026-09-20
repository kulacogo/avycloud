import { test } from "node:test";
import assert from "node:assert/strict";
import { activityDetails, supportChannelView } from "./performancePresentation.ts";
import type { PerformanceRow, PerformanceDataQuality } from "../../api/client";
const row: PerformanceRow = { uid: "u", name: "Test", erfasst: 57, eingelagert: 129, kommissioniert: 86, verpackt: 103, angereichert: 61, productCareEdited: 1 };
const quality: PerformanceDataQuality = { complete: true, sources: { audit: "complete", warehouse: "complete", orders: "complete" } };

test("kompakte Tabelle behält belegte Pflege und alle operativen Beiträge unverändert", () => {
  const items = activityDetails(row, quality, 3, true);
  assert.deepEqual(items.map(x => [x.count, x.points]), [[57,171], [129,129], [86,86], [103,206], [1,4]]);
  assert.equal(items.reduce((sum, x) => sum + (x.points || 0), 0), 596);
});
test("fehlende Quellen und altes Pflegeschema bleiben Striche statt Nullarbeit", () => {
  const items = activityDetails(row, { complete: false, sources: { audit: "unavailable", warehouse: "complete", orders: "complete" } }, 3);
  assert.equal(items[0].count, null);
  assert.equal(items[4].count, null);
  assert.equal(items[1].count, 129);
  assert.ok(items.every(x => x.points === null));
  assert.equal(activityDetails(row, quality, 2, true)[4].count, null);
});
test("kompakter Support zeigt Anliegen, Antworten und unveränderte Punkte", () => {
  assert.deepEqual(supportChannelView({ status: "complete", cases: 13, replies: 20 }), { count: 13, replies: 20, points: 39, partial: false, label: "Verbunden" });
  const partial = supportChannelView({ status: "limited", cases: 4, replies: 9 });
  assert.equal(partial.points, 12);
  assert.equal(partial.partial, true);
  assert.equal(partial.label, "Unvollständig");
});
test("fehlende Supportdaten bleiben auch in kurzen Statusanzeigen sichtbar", () => {
  for (const status of ["connection_required", "unavailable"] as const) {
    const value = supportChannelView({ status, cases: null, replies: null });
    assert.equal(value.count, null);
    assert.equal(value.points, null);
    assert.notEqual(value.label, "Verbunden");
  }
  assert.equal(supportChannelView({ status: "complete", cases: 0, replies: 0 }).count, 0);
});
