import { test } from "node:test";
import assert from "node:assert/strict";
import { previewImages } from "./previewImages.ts";

test("Vorschau erhält Original-URLs und zeigt alle zugehörigen Gruppen", () => {
  const images = [{ id: "a", url: "blob:original-a" }, { id: "b", url: "blob:original-b" }];
  const groups = [{ label: "Gerät", imageIds: ["a"] }, { label: "Zubehör", imageIds: ["a"] }];
  const before = JSON.stringify({ images, groups });
  assert.deepEqual(previewImages(images, groups), [
    { id: "a", url: "blob:original-a", label: "Foto 1 · Gerät / Zubehör" },
    { id: "b", url: "blob:original-b", label: "Foto 2 · Ohne Gruppe" },
  ]);
  assert.equal(JSON.stringify({ images, groups }), before);
});

test("manuelle Umgruppierung wird angezeigt, fehlende Gruppenfotos nicht erfunden", () => {
  assert.deepEqual(previewImages([{ id: "b", url: "blob:b" }], [
    { label: "Korrigiert", imageIds: ["b", "deleted"] },
  ]), [{ id: "b", url: "blob:b", label: "Foto 1 · Korrigiert" }]);
});
