import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPhotoChanges, assertPhotoEditorBackend, createPhotoHistory, pushPhotoHistory } from "./photoEditorSession.ts";
import type { ProductImage } from "../types.ts";

const photo = (url: string): ProductImage => ({ source: "upload", url_or_base64: url });
test("undo then edit discards redo and keeps the original state immutable", () => {
  const start = createPhotoHistory({ exposure: 0 });
  const first = pushPhotoHistory(start, { exposure: 1 }, "Heller");
  const second = pushPhotoHistory({ ...first, position: 0 }, { exposure: -1 }, "Dunkler");
  assert.equal(start.entries.length, 1);
  assert.deepEqual(second.entries.map(e => e.value.exposure), [0, -1]);
});
test("duplicate state does not consume undo; history is bounded", () => {
  let history = createPhotoHistory(0);
  assert.equal(pushPhotoHistory(history, 0, "Nichts"), history);
  for (let i = 1; i < 100; i++) history = pushPhotoHistory(history, i, String(i));
  assert.equal(history.entries.length, 60);
  assert.equal(history.entries[history.position].value, 99);
});
test("a stale batch is rejected entirely after deletion/reorder or metadata change", () => {
  const a = photo("a"), b = photo("b");
  const changes = [{ index: 0, expected: a, image: photo("edited-a") }, { index: 1, expected: b, image: photo("edited-b") }];
  assert.equal(applyPhotoChanges([b, a], changes), null);
  assert.equal(applyPhotoChanges([a, { ...b, notes: "changed" }], changes), null);
  assert.equal(applyPhotoChanges([a], changes), null);
  assert.deepEqual(applyPhotoChanges([a, b], changes)?.map(i => i.url_or_base64), ["edited-a", "edited-b"]);
  assert.equal(a.url_or_base64, "a");
});
test("duplicate batch targets are rejected", () => {
  const a = photo("a");
  const c = { index: 0, expected: a, image: photo("new") };
  assert.equal(applyPhotoChanges([a], [c, c]), null);
});

test("legacy products do not require the new backend capability", async () => {
  let calls = 0;
  await assertPhotoEditorBackend([photo("legacy")], async () => { calls++; return { ok: false }; });
  assert.equal(calls, 0);
});
test("mixed deployments, network errors and unsupported versions cannot reach the product write", async () => {
  const edited = { ...photo("edited"), photoEditor: { version: 1 } } as ProductImage;
  for (const response of [{ ok: false }, { ok: true }, { ok: true, version: 2 }]) {
    await assert.rejects(assertPhotoEditorBackend([edited], async () => response), /Änderungen bleiben/);
  }
  await assert.rejects(assertPhotoEditorBackend([edited], async () => { throw new Error("network"); }), /Änderungen bleiben/);
  await assert.doesNotReject(assertPhotoEditorBackend([edited], async () => ({ ok: true, version: 1 })));
});
